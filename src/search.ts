import { cpus } from "node:os";

import { extractPageText, loadPdfDocument } from "./pdf.js";

const DEFAULT_CONTEXT_CHARS = 40;

export interface SearchMatch {
  index: number;
  text: string;
  snippet: string;
}

export interface PageSearchResult {
  page: number;
  matches: SearchMatch[];
}

export interface SearchPdfResult {
  filePath: string;
  query: string;
  pageCount: number;
  matchCount: number;
  results: PageSearchResult[];
}

export interface SearchPdfOptions {
  concurrency?: number;
  contextChars?: number;
}

export async function searchPdf(
  pdfPath: string,
  query: string,
  options: SearchPdfOptions = {},
): Promise<SearchPdfResult> {
  const trimmedQuery = query.trim();

  if (trimmedQuery.length === 0) {
    throw new Error("Search query must not be empty.");
  }

  const document = await loadPdfDocument(pdfPath);
  const pageCount = document.numPages;
  const pageNumbers = Array.from(
    { length: pageCount },
    (_, index) => index + 1,
  );
  const concurrency = resolveConcurrency(options.concurrency, pageCount);
  const contextChars = resolveContextChars(options.contextChars);

  try {
    const pages = await mapConcurrent(
      pageNumbers,
      concurrency,
      async (page) => {
        const text = await extractPageText(document, page);
        const matches = findMatches(text, trimmedQuery, contextChars);

        return {
          page,
          matches,
        };
      },
    );

    const results = pages.filter((page) => page.matches.length > 0);
    const matchCount = results.reduce(
      (total, page) => total + page.matches.length,
      0,
    );

    return {
      filePath: pdfPath,
      query: trimmedQuery,
      pageCount,
      matchCount,
      results,
    };
  } finally {
    await document.destroy();
  }
}

function resolveConcurrency(
  requested: number | undefined,
  pageCount: number,
): number {
  const defaultConcurrency = Math.max(1, Math.min(cpus().length, 4));

  if (requested === undefined) {
    return Math.min(defaultConcurrency, pageCount);
  }

  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error("Concurrency must be a positive integer.");
  }

  return Math.min(requested, pageCount);
}

function resolveContextChars(requested: number | undefined): number {
  if (requested === undefined) {
    return DEFAULT_CONTEXT_CHARS;
  }

  if (!Number.isInteger(requested) || requested < 0) {
    throw new Error("Context characters must be a non-negative integer.");
  }

  return requested;
}

function findMatches(
  text: string,
  query: string,
  contextChars: number,
): SearchMatch[] {
  const queryLower = query.toLowerCase();
  const textLower = text.toLowerCase();
  const matches: SearchMatch[] = [];

  let searchStart = 0;

  while (searchStart < textLower.length) {
    const index = textLower.indexOf(queryLower, searchStart);

    if (index === -1) {
      break;
    }

    const end = index + query.length;
    matches.push({
      index,
      text: text.slice(index, end),
      snippet: buildSnippet(text, index, end, contextChars),
    });
    searchStart = end;
  }

  return matches;
}

function buildSnippet(
  text: string,
  start: number,
  end: number,
  contextChars: number,
): string {
  const snippetStart = Math.max(0, start - contextChars);
  const snippetEnd = Math.min(text.length, end + contextChars);
  const prefix = snippetStart > 0 ? "..." : "";
  const suffix = snippetEnd < text.length ? "..." : "";

  return `${prefix}${text.slice(snippetStart, snippetEnd).trim()}${suffix}`;
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

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => runWorker(),
  );

  await Promise.all(workers);

  return results;
}
