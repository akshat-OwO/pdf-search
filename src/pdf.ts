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

export async function loadPdfDocument(
  pdfPath: string,
): Promise<PdfDocumentProxy> {
  try {
    await access(pdfPath, fsConstants.R_OK);
  } catch {
    throw new Error(`PDF file is not readable: ${pdfPath}`);
  }

  const data = new Uint8Array(await readFile(pdfPath));
  const loadingTask = getDocument({
    data,
    disableWorker: true,
    useSystemFonts: true,
  } as Parameters<typeof getDocument>[0]);

  try {
    return (await loadingTask.promise) as unknown as PdfDocumentProxy;
  } catch (error) {
    await loadingTask.destroy();

    const message =
      error instanceof Error ? error.message : "Unknown PDF parsing error";
    throw new Error(`Failed to read PDF file: ${message}`);
  }
}

export async function extractPageText(
  document: PdfDocumentProxy,
  pageNumber: number,
): Promise<string> {
  const page = await document.getPage(pageNumber);
  const textContent = await page.getTextContent();

  const segments = textContent.items
    .map((item: PdfTextItem) => normalizeTextItem(item))
    .filter(Boolean);

  return normalizePageText(segments);
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
