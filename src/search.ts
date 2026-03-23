import { cpus } from "node:os";

import { extractPageText, loadPdfDocument } from "./pdf.js";

const DEFAULT_CONTEXT_CHARS = 40;

export interface SearchMatch {
  term: string;
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
  queryTerms: SearchQuery;
  pageCount: number;
  matchCount: number;
  results: PageSearchResult[];
}

export interface SearchQuery {
  and: string[];
  or: string[];
}

export interface SearchProgress {
  phase: "loading" | "scanning";
  processedPages: number;
  totalPages: number;
}

export interface SearchPdfOptions {
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

  const document = await loadPdfDocument(pdfPath);
  const pageCount = document.numPages;
  const pageNumbers = Array.from(
    { length: pageCount },
    (_, index) => index + 1,
  );
  const concurrency = resolveConcurrency(options.concurrency, pageCount);
  const contextChars = resolveContextChars(options.contextChars);
  let processedPages = 0;

  try {
    options.onProgress?.({
      phase: "scanning",
      processedPages,
      totalPages: pageCount,
    });
    const pages = await mapConcurrent(
      pageNumbers,
      concurrency,
      async (page) => {
        const text = await extractPageText(document, page);
        const matches = findPageMatches(text, normalizedQuery, contextChars);
        processedPages += 1;
        options.onProgress?.({
          phase: "scanning",
          processedPages,
          totalPages: pageCount,
        });

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
      query: formatQuerySummary(normalizedQuery),
      queryTerms: normalizedQuery,
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

function normalizeQuery(query: string | SearchQuery): SearchQuery {
  if (typeof query === "string") {
    const trimmedQuery = query.trim();

    if (trimmedQuery.length === 0) {
      throw new Error("Search query must not be empty.");
    }

    return {
      and: [trimmedQuery],
      or: [],
    };
  }

  const and = normalizeTerms(query.and, "AND");
  const or = normalizeTerms(query.or, "OR");

  if (and.length === 0 && or.length === 0) {
    throw new Error("At least one search term is required.");
  }

  return { and, or };
}

function normalizeTerms(terms: string[], groupName: string): string[] {
  const normalized = terms.map((term) => term.trim());

  if (normalized.some((term) => term.length === 0)) {
    throw new Error(`${groupName} search terms must not be empty.`);
  }

  return Array.from(new Set(normalized));
}

function findPageMatches(
  text: string,
  query: SearchQuery,
  contextChars: number,
): SearchMatch[] {
  const andMatches = query.and.map((term) =>
    findMatches(text, term, contextChars),
  );
  const orMatches = query.or.map((term) =>
    findMatches(text, term, contextChars),
  );
  const satisfiesAnd = andMatches.every((matches) => matches.length > 0);
  const satisfiesOr =
    orMatches.length === 0 || orMatches.some((matches) => matches.length > 0);

  if (!satisfiesAnd || !satisfiesOr) {
    return [];
  }

  return dedupeMatches([...andMatches, ...orMatches].flat());
}

function dedupeMatches(matches: SearchMatch[]): SearchMatch[] {
  const uniqueMatches = new Map<string, SearchMatch>();

  for (const match of matches) {
    uniqueMatches.set(`${match.term}:${match.index}`, match);
  }

  return Array.from(uniqueMatches.values()).sort((left, right) => {
    if (left.index !== right.index) {
      return left.index - right.index;
    }

    return left.term.localeCompare(right.term);
  });
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
      term: query,
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

function formatQuerySummary(query: SearchQuery): string {
  const parts: string[] = [];

  if (query.and.length > 0) {
    parts.push(`all of ${formatTermList(query.and)}`);
  }

  if (query.or.length > 0) {
    parts.push(`any of ${formatTermList(query.or)}`);
  }

  return parts.join("; ");
}

function formatTermList(terms: string[]): string {
  return terms.map((term) => `"${term}"`).join(", ");
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
