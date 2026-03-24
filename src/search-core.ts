const DEFAULT_CONTEXT_CHARS = 40;

export interface SearchMatch {
  term: string;
  index: number;
  text: string;
  snippet: string;
}

export interface SearchQuery {
  and: string[];
  or: string[];
}

export function resolveContextChars(requested: number | undefined): number {
  if (requested === undefined) {
    return DEFAULT_CONTEXT_CHARS;
  }

  if (!Number.isInteger(requested) || requested < 0) {
    throw new Error("Context characters must be a non-negative integer.");
  }

  return requested;
}

export function normalizeQuery(query: string | SearchQuery): SearchQuery {
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

export function findPageMatches(
  text: string,
  query: SearchQuery,
  contextChars: number,
): SearchMatch[] {
  const andMatches = query.and.map((term) => findMatches(text, term, contextChars));
  const orMatches = query.or.map((term) => findMatches(text, term, contextChars));
  const satisfiesAnd = andMatches.every((matches) => matches.length > 0);
  const satisfiesOr = orMatches.length === 0 || orMatches.some((matches) => matches.length > 0);

  if (!satisfiesAnd || !satisfiesOr) {
    return [];
  }

  return dedupeMatches([...andMatches, ...orMatches].flat());
}

export function formatQuerySummary(query: SearchQuery): string {
  const parts: string[] = [];

  if (query.and.length > 0) {
    parts.push(`all of ${formatTermList(query.and)}`);
  }

  if (query.or.length > 0) {
    parts.push(`any of ${formatTermList(query.or)}`);
  }

  return parts.join("; ");
}

function normalizeTerms(terms: string[], groupName: string): string[] {
  const normalized = terms.map((term) => term.trim());

  if (normalized.some((term) => term.length === 0)) {
    throw new Error(`${groupName} search terms must not be empty.`);
  }

  return Array.from(new Set(normalized));
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

function findMatches(text: string, query: string, contextChars: number): SearchMatch[] {
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

function buildSnippet(text: string, start: number, end: number, contextChars: number): string {
  const snippetStart = Math.max(0, start - contextChars);
  const snippetEnd = Math.min(text.length, end + contextChars);
  const prefix = snippetStart > 0 ? "..." : "";
  const suffix = snippetEnd < text.length ? "..." : "";

  return `${prefix}${text.slice(snippetStart, snippetEnd).trim()}${suffix}`;
}

function formatTermList(terms: string[]): string {
  return terms.map((term) => `"${term}"`).join(", ");
}
