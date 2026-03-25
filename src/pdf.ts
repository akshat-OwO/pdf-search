import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { fileURLToPath } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export interface PdfTextItem {
  hasEOL?: boolean;
  str?: string;
}

export interface PdfTextContent {
  items: PdfTextItem[];
}

export interface PdfPageProxy {
  getTextContent(): Promise<PdfTextContent>;
}

export interface PdfDocumentProxy {
  destroy(): Promise<void>;
  getPage(pageNumber: number): Promise<PdfPageProxy>;
  numPages: number;
}

/** Options applied when loading PDF bytes from `http(s):` URLs. */
export interface RemoteFetchOptions {
  /**
   * Milliseconds before the request is aborted. Defaults to 120_000 (two minutes).
   * Pass `0` to disable the timeout.
   */
  fetchTimeoutMs?: number;
  /** When set, reject the response if the body exceeds this many bytes (checked while streaming). */
  maxFetchBytes?: number;
}

export interface LoadPdfOptions extends RemoteFetchOptions {
  disableWorker?: boolean;
}

export type PageTextFormat = "compact" | "layout";

export interface ExtractPageTextOptions {
  format?: PageTextFormat;
}

export interface GetPdfPageTextOptions extends LoadPdfOptions {
  format?: PageTextFormat;
}

const DEFAULT_FETCH_TIMEOUT_MS = 120_000;

/**
 * Resolved PDF bytes (remote) or a readable local filesystem path.
 * For `{ kind: "path" }`, `path` must be a local filesystem path (not `http(s):`).
 */
export type PdfSource = { kind: "path"; path: string } | { kind: "bytes"; data: Uint8Array };

export function isRemotePdfUrl(pdfPath: string): boolean {
  return pdfPath.startsWith("http://") || pdfPath.startsWith("https://");
}

export function normalizePdfFilesystemPath(pdfPath: string): string {
  if (pdfPath.startsWith("file:")) {
    return fileURLToPath(new URL(pdfPath));
  }
  return pdfPath;
}

function resolveFetchSignal(options: RemoteFetchOptions): AbortSignal | undefined {
  const milliseconds = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  if (milliseconds === 0) {
    return undefined;
  }
  return AbortSignal.timeout(milliseconds);
}

async function readResponseBodyWithByteLimit(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new Error(`Failed to fetch PDF from URL: response exceeds maxFetchBytes (${maxBytes})`);
    }
    return new Uint8Array(buffer);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value === undefined) {
        continue;
      }
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(
          `Failed to fetch PDF from URL: response exceeds maxFetchBytes (${maxBytes})`,
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
}

export async function fetchPdfFromUrl(
  url: string,
  options: RemoteFetchOptions = {},
): Promise<Uint8Array> {
  const signal = resolveFetchSignal(options);
  let response: Response;

  try {
    response = await fetch(url, signal ? { signal } : {});
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "AbortError" ||
        error.name === "TimeoutError" ||
        error.message === "The operation was aborted.")
    ) {
      throw new Error("Failed to fetch PDF from URL: request timed out");
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to fetch PDF from URL: ${message}`);
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch PDF from URL: HTTP ${response.status} ${response.statusText}`);
  }

  if (options.maxFetchBytes !== undefined) {
    return readResponseBodyWithByteLimit(response, options.maxFetchBytes);
  }

  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

async function readPdfBytesFromLocalPath(localPath: string): Promise<Uint8Array> {
  try {
    await access(localPath, fsConstants.R_OK);
  } catch {
    throw new Error(`PDF file is not readable: ${localPath}`);
  }

  return new Uint8Array(await readFile(localPath));
}

async function loadPdfDocumentFromData(
  data: Uint8Array,
  options: LoadPdfOptions = {},
): Promise<PdfDocumentProxy> {
  const dataCopy = new Uint8Array(data);
  const disableWorker = options.disableWorker ?? true;
  const loadingTask = getDocument({
    data: dataCopy,
    disableWorker,
    useSystemFonts: true,
    verbosity: 0,
  } as Parameters<typeof getDocument>[0]);

  try {
    return (await loadingTask.promise) as unknown as PdfDocumentProxy;
  } catch (error) {
    await loadingTask.destroy();

    const message = error instanceof Error ? error.message : "Unknown PDF parsing error";
    throw new Error(`Failed to read PDF file: ${message}`);
  }
}

export async function loadPdfDocumentFromSource(
  source: PdfSource,
  options: LoadPdfOptions = {},
): Promise<PdfDocumentProxy> {
  const data =
    source.kind === "bytes"
      ? source.data
      : await readPdfBytesFromLocalPath(normalizePdfFilesystemPath(source.path));

  return loadPdfDocumentFromData(data, options);
}

export async function loadPdfDocument(
  pdfPath: string,
  options: LoadPdfOptions = {},
): Promise<PdfDocumentProxy> {
  if (isRemotePdfUrl(pdfPath)) {
    const data = await fetchPdfFromUrl(pdfPath, options);
    return loadPdfDocumentFromData(data, options);
  }

  const localPath = normalizePdfFilesystemPath(pdfPath);
  const data = await readPdfBytesFromLocalPath(localPath);
  return loadPdfDocumentFromData(data, options);
}

export async function extractPageText(
  document: PdfDocumentProxy,
  pageNumber: number,
  options: ExtractPageTextOptions = {},
): Promise<string> {
  const page = await document.getPage(pageNumber);
  const textContent = await page.getTextContent();

  const segments = textContent.items
    .map((item: PdfTextItem) => normalizeTextItem(item))
    .filter(Boolean);

  const format = options.format ?? "compact";
  return format === "layout" ? layoutPageText(segments) : normalizePageText(segments);
}

export async function getPdfPageText(
  pdfPath: string,
  pageNumber: number,
  options: GetPdfPageTextOptions = {},
): Promise<string> {
  const { format, ...loadOptions } = options;
  const document = await loadPdfDocument(pdfPath, {
    disableWorker: true,
    ...loadOptions,
  });

  try {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > document.numPages) {
      throw new Error(
        `Page number must be an integer from 1 to ${document.numPages} (got ${pageNumber}).`,
      );
    }

    return await extractPageText(document, pageNumber, { format });
  } finally {
    await document.destroy();
  }
}

function normalizeTextItem(item: PdfTextItem): string {
  if (typeof item.str !== "string" || item.str.length === 0) {
    return "";
  }

  const suffix = item.hasEOL ? "\n" : " ";
  return `${item.str}${suffix}`;
}

function normalizePageText(textParts: string[]): string {
  return textParts.join("").replace(/\s+/g, " ").trim();
}

function layoutPageText(textParts: string[]): string {
  let text = textParts.join("");
  text = text.replace(/[^\S\n]+/g, " ");
  text = text.replace(/ *\n */g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}
