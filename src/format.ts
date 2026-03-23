import { basename } from "node:path";

import type { SearchPdfResult } from "./search.js";

export interface FormatSearchResultsOptions {
  showContext?: boolean;
}

export function formatSearchResults(
  result: SearchPdfResult,
  options: FormatSearchResultsOptions = {},
): string {
  const lines: string[] = [];
  const fileName = basename(result.filePath);

  lines.push(`PDF: ${fileName}`);
  lines.push(`Query: ${formatQueryDisplay(result)}`);
  lines.push(`Pages scanned: ${result.pageCount}`);
  lines.push(`Matches found: ${result.matchCount}`);

  if (result.results.length === 0) {
    lines.push("");
    lines.push("No matches found.");
    return `${lines.join("\n")}\n`;
  }

  lines.push("");

  if (options.showContext) {
    for (const page of result.results) {
      lines.push(`Page ${page.page}`);

      page.matches.forEach((match, index) => {
        const prefix = hasMultipleTerms(result) ? `[${match.term}] ` : "";
        lines.push(`  ${index + 1}. ${prefix}${match.snippet}`);
      });

      lines.push("");
    }

    lines.pop();
    return `${lines.join("\n")}\n`;
  }

  for (const page of result.results) {
    const label = page.matches.length === 1 ? "match" : "matches";
    lines.push(`Page ${page.page}: ${page.matches.length} ${label}`);
  }

  return `${lines.join("\n")}\n`;
}

function formatQueryDisplay(result: SearchPdfResult): string {
  if (result.queryTerms.or.length === 0 && result.queryTerms.and.length === 1) {
    return `"${result.queryTerms.and[0]}"`;
  }

  return result.query;
}

function hasMultipleTerms(result: SearchPdfResult): boolean {
  return result.queryTerms.and.length + result.queryTerms.or.length > 1;
}
