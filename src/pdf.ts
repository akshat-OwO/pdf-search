import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
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

export interface LoadPdfOptions {
  disableWorker?: boolean;
}

export type PageTextFormat = "compact" | "layout";

export interface ExtractPageTextOptions {
  format?: PageTextFormat;
}

export interface GetPdfPageTextOptions extends LoadPdfOptions {
  format?: PageTextFormat;
}

export async function loadPdfDocument(
  pdfPath: string,
  options: LoadPdfOptions = {},
): Promise<PdfDocumentProxy> {
  try {
    await access(pdfPath, fsConstants.R_OK);
  } catch {
    throw new Error(`PDF file is not readable: ${pdfPath}`);
  }

  const data = new Uint8Array(await readFile(pdfPath));
  const disableWorker = options.disableWorker ?? true;
  const loadingTask = getDocument({
    data,
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
