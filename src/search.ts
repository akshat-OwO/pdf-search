import { cpus } from "node:os";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import type { SearchMatch, SearchQuery } from "./search-core.js";

export interface PageSearchResult {
  page: number;
  matches: SearchMatch[];
}

export interface SearchPdfResult {
  filePath: string;
  query: string;
  queryTerms: SearchQuery;
  pageCount: number;
  matchCount: number;
  results: PageSearchResult[];
}

export type { SearchMatch, SearchQuery } from "./search-core.js";
import {
  findPageMatches,
  formatQuerySummary,
  normalizeQuery,
  resolveContextChars,
} from "./search-core.js";
import {
  extractPageText,
  fetchPdfFromUrl,
  isRemotePdfUrl,
  loadPdfDocumentFromSource,
  normalizePdfFilesystemPath,
  type PdfSource,
  type RemoteFetchOptions,
} from "./pdf.js";

export interface SearchProgress {
  phase: "loading" | "scanning";
  processedPages: number;
  totalPages: number;
}

export interface SearchPdfOptions extends RemoteFetchOptions {
  /**
   * For local PDFs (when worker threads are used), caps how many workers scan
   * pages in parallel. For remote `http(s)` URLs the scan runs in-process, so
   * this rarely changes wall-clock time meaningfully.
   */
  concurrency?: number;
  contextChars?: number;
  onProgress?: (progress: SearchProgress) => void;
}

export async function searchPdf(
  pdfPath: string,
  query: string | SearchQuery,
  options: SearchPdfOptions = {},
): Promise<SearchPdfResult> {
  const normalizedQuery = normalizeQuery(query);
  options.onProgress?.({
    phase: "loading",
    processedPages: 0,
    totalPages: 0,
  });

  let pdfSource: PdfSource;
  if (isRemotePdfUrl(pdfPath)) {
    const data = await fetchPdfFromUrl(pdfPath, options);
    pdfSource = { kind: "bytes", data };
  } else {
    pdfSource = { kind: "path", path: normalizePdfFilesystemPath(pdfPath) };
  }

  const document = await loadPdfDocumentFromSource(pdfSource, { disableWorker: true });
  const pageCount = document.numPages;
  await document.destroy();
  const pageNumbers = Array.from({ length: pageCount }, (_, index) => index + 1);
  const concurrency = resolveConcurrency(options.concurrency, pageCount);
  const contextChars = resolveContextChars(options.contextChars);
  let processedPages = 0;

  options.onProgress?.({
    phase: "scanning",
    processedPages,
    totalPages: pageCount,
  });

  const pages = await searchPages({
    pdfSource,
    pageNumbers,
    query: normalizedQuery,
    contextChars,
    concurrency,
    onPageProcessed: () => {
      processedPages += 1;
      options.onProgress?.({
        phase: "scanning",
        processedPages,
        totalPages: pageCount,
      });
    },
  });

  const results = pages.filter((page) => page.matches.length > 0);
  const matchCount = results.reduce((total, page) => total + page.matches.length, 0);

  return {
    filePath: pdfPath,
    query: formatQuerySummary(normalizedQuery),
    queryTerms: normalizedQuery,
    pageCount,
    matchCount,
    results,
  };
}

function resolveConcurrency(requested: number | undefined, pageCount: number): number {
  const defaultConcurrency = Math.max(1, Math.min(cpus().length, 4));

  if (requested === undefined) {
    return Math.min(defaultConcurrency, pageCount);
  }

  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error("Concurrency must be a positive integer.");
  }

  return Math.min(requested, pageCount);
}

interface SearchPagesInput {
  pdfSource: PdfSource;
  pageNumbers: number[];
  query: SearchQuery;
  contextChars: number;
  concurrency: number;
  onPageProcessed: () => void;
}

function shouldSearchInProcessOnly(input: SearchPagesInput): boolean {
  return (
    !canUseBundledWorkerThreads() || input.concurrency <= 1 || input.pdfSource.kind === "bytes"
  );
}

async function searchPages(input: SearchPagesInput): Promise<PageSearchResult[]> {
  if (input.pageNumbers.length === 0) {
    return [];
  }

  if (shouldSearchInProcessOnly(input)) {
    return searchPagesInProcess(input);
  }

  const chunks = chunkItems(input.pageNumbers, input.concurrency);
  const workerResults = await Promise.all(
    chunks.map((pages) =>
      runSearchWorker(
        {
          pdfSource: input.pdfSource,
          pages,
          query: input.query,
          contextChars: input.contextChars,
        },
        input.onPageProcessed,
      ),
    ),
  );

  return workerResults.flat().sort((left, right) => left.page - right.page);
}

interface SearchWorkerInput {
  pdfSource: PdfSource;
  pages: number[];
  query: SearchQuery;
  contextChars: number;
}

interface SearchWorkerExecutionData extends SearchWorkerInput {
  __pdfSearchWorker: true;
}

interface SearchWorkerProgressMessage {
  type: "progress";
  processedPages: number;
}

interface SearchWorkerResultMessage {
  type: "result";
  pages: PageSearchResult[];
}

interface SearchWorkerErrorMessage {
  type: "error";
  message: string;
}

type SearchWorkerMessage =
  | SearchWorkerProgressMessage
  | SearchWorkerResultMessage
  | SearchWorkerErrorMessage;

function canUseBundledWorkerThreads(): boolean {
  // Production: bundled `dist/index.mjs` is a real file path Node can load as a worker.
  // Tests: set `PDF_SEARCH_FORCE_WORKERS=1` to exercise the worker path from TS sources.
  if (process.env.PDF_SEARCH_FORCE_WORKERS === "1") {
    return true;
  }

  return import.meta.url.endsWith(".mjs");
}

async function runSearchWorker(
  workerInput: SearchWorkerInput,
  onPageProcessed: () => void,
): Promise<PageSearchResult[]> {
  return new Promise<PageSearchResult[]>((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: {
        __pdfSearchWorker: true,
        ...workerInput,
      } satisfies SearchWorkerExecutionData,
    });
    let settled = false;

    const rejectOnce = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    worker.on("message", (message: SearchWorkerMessage) => {
      if (message.type === "progress") {
        for (let index = 0; index < message.processedPages; index += 1) {
          onPageProcessed();
        }
        return;
      }

      if (message.type === "error") {
        rejectOnce(new Error(message.message));
        return;
      }

      settled = true;
      resolve(message.pages);
    });

    worker.on("error", (error: unknown) => {
      rejectOnce(error instanceof Error ? error : new Error(String(error)));
    });

    worker.on("exit", (code) => {
      if (!settled && code !== 0) {
        rejectOnce(new Error(`Search worker exited with code ${code}.`));
      }
    });
  });
}

async function searchPagesInProcess(input: SearchPagesInput): Promise<PageSearchResult[]> {
  const document = await loadPdfDocumentFromSource(input.pdfSource, {
    disableWorker: true,
  });

  try {
    return await mapConcurrent(input.pageNumbers, input.concurrency, async (page) => {
      const text = await extractPageText(document, page);
      const matches = findPageMatches(text, input.query, input.contextChars);
      input.onPageProcessed();
      return { page, matches };
    });
  } finally {
    await document.destroy();
  }
}

function chunkItems<T>(items: T[], chunkCount: number): T[][] {
  const normalizedChunkCount = Math.max(1, Math.min(chunkCount, items.length));
  const chunks = Array.from({ length: normalizedChunkCount }, () => [] as T[]);

  items.forEach((item, index) => {
    chunks[index % normalizedChunkCount].push(item);
  });

  return chunks.filter((chunk) => chunk.length > 0);
}

function isSearchWorkerExecutionData(value: unknown): value is SearchWorkerExecutionData {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return candidate.__pdfSearchWorker === true;
}

async function runSearchWorkerEntry(input: SearchWorkerExecutionData): Promise<void> {
  const pageResults = await searchPagesInProcess({
    pdfSource: input.pdfSource,
    pageNumbers: input.pages,
    query: input.query,
    contextChars: input.contextChars,
    concurrency: 1,
    onPageProcessed: () => {
      parentPort?.postMessage({
        type: "progress",
        processedPages: 1,
      } satisfies SearchWorkerProgressMessage);
    },
  });

  parentPort?.postMessage({
    type: "result",
    pages: pageResults,
  } satisfies SearchWorkerResultMessage);
}

if (!isMainThread && isSearchWorkerExecutionData(workerData)) {
  void runSearchWorkerEntry(workerData).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    parentPort?.postMessage({
      type: "error",
      message,
    } satisfies SearchWorkerErrorMessage);
  });
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = Array.from({ length: items.length }) as R[];
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker());

  await Promise.all(workers);

  return results;
}
