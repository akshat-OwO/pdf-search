import process from "node:process";

import { formatSearchResults } from "./format.js";
import { getPdfPageText, type PageTextFormat, type RemoteFetchOptions } from "./pdf.js";
import { searchPdf } from "./search.js";
import type { SearchProgress, SearchQuery } from "./search.js";

const DEFAULT_CONTEXT_CHARS = 40;

export interface CliIo {
  stdout: Pick<typeof process.stdout, "write">;
  stderr: Pick<typeof process.stderr, "write">;
}

type PageCliOutputFormat = PageTextFormat | "json";

type ParsedCliArgs =
  | {
      mode: "search";
      pdfPath: string;
      query: string | SearchQuery;
      showContext: boolean;
      contextChars: number;
      concurrency: number | undefined;
      remoteFetch: RemoteFetchOptions;
    }
  | {
      mode: "page";
      pdfPath: string;
      pageNumber: number;
      pageOutputFormat: PageCliOutputFormat;
      remoteFetch: RemoteFetchOptions;
    };

class CliUsageError extends Error {}

export async function runCli(
  argv: string[],
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  const progress = createProgressReporter(io.stderr);

  try {
    if (argv.includes("--help") || argv.includes("-h")) {
      io.stdout.write(`${getUsageText()}\n`);
      return 0;
    }

    const args = parseCliArgs(argv);

    if (args.mode === "page") {
      progress.clear();
      if (args.pageOutputFormat === "json") {
        const text = await getPdfPageText(args.pdfPath, args.pageNumber, {
          format: "layout",
          ...args.remoteFetch,
        });
        io.stdout.write(`${JSON.stringify({ page: args.pageNumber, text })}\n`);
      } else {
        const text = await getPdfPageText(args.pdfPath, args.pageNumber, {
          format: args.pageOutputFormat,
          ...args.remoteFetch,
        });
        io.stdout.write(`${text}\n`);
      }
      return 0;
    }

    const result = await searchPdf(args.pdfPath, args.query, {
      concurrency: args.concurrency,
      contextChars: args.contextChars,
      onProgress: progress.update,
      ...args.remoteFetch,
    });
    progress.clear();

    io.stdout.write(
      formatSearchResults(result, {
        showContext: args.showContext,
      }),
    );

    return 0;
  } catch (error) {
    progress.clear();
    const message = error instanceof Error ? error.message : "Unexpected CLI error";
    const output =
      error instanceof CliUsageError ? `${message}\n\n${getUsageText()}\n` : `${message}\n`;

    io.stderr.write(output);
    return 1;
  }
}

function parseCliArgs(argv: string[]): ParsedCliArgs {
  const positionals: string[] = [];
  const and: string[] = [];
  const or: string[] = [];
  let showContext = false;
  let contextChars = DEFAULT_CONTEXT_CHARS;
  let concurrency: number | undefined;
  let pageNumber: number | undefined;
  let pageOutputFormat: PageCliOutputFormat | undefined;
  let fetchTimeoutMs: number | undefined;
  let maxFetchBytes: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    switch (argument) {
      case "--page":
      case "-p":
        pageNumber = parsePositiveInteger(argv[index + 1], argument);
        index += 1;
        break;
      case "--page-format":
        pageOutputFormat = parsePageOutputFormat(argv[index + 1], argument);
        index += 1;
        break;
      case "--context":
      case "-c":
        showContext = true;
        break;
      case "--context-chars":
        contextChars = parsePositiveInteger(argv[index + 1], argument, true);
        index += 1;
        break;
      case "--concurrency":
        concurrency = parsePositiveInteger(argv[index + 1], argument);
        index += 1;
        break;
      case "--fetch-timeout-ms":
        fetchTimeoutMs = parseNonNegativeInteger(argv[index + 1], argument);
        index += 1;
        break;
      case "--max-fetch-bytes":
        maxFetchBytes = parsePositiveInteger(argv[index + 1], argument);
        index += 1;
        break;
      case "--and":
        and.push(parseQueryTerm(argv[index + 1], argument));
        index += 1;
        break;
      case "--or":
        or.push(parseQueryTerm(argv[index + 1], argument));
        index += 1;
        break;
      default:
        if (argument.startsWith("-")) {
          throw new CliUsageError(`Unknown flag: ${argument}`);
        }

        positionals.push(argument);
    }
  }

  if (positionals.length === 0) {
    throw new CliUsageError("Expected a PDF path or URL.");
  }

  const remoteFetch = buildRemoteFetchOptions(fetchTimeoutMs, maxFetchBytes);

  if (pageOutputFormat !== undefined && pageNumber === undefined) {
    throw new CliUsageError("--page-format is only valid with --page.");
  }

  if (pageNumber !== undefined) {
    if (positionals.length !== 1) {
      throw new CliUsageError("With --page, provide only <pdfPathOrUrl>.");
    }

    if (and.length > 0 || or.length > 0) {
      throw new CliUsageError("Cannot combine --page with --and/--or.");
    }

    if (showContext || contextChars !== DEFAULT_CONTEXT_CHARS) {
      throw new CliUsageError("Cannot combine --page with --context/--context-chars.");
    }

    if (concurrency !== undefined) {
      throw new CliUsageError("Cannot combine --page with --concurrency.");
    }

    return {
      mode: "page",
      pdfPath: positionals[0],
      pageNumber,
      pageOutputFormat: pageOutputFormat ?? "compact",
      remoteFetch,
    };
  }

  const [pdfPath, legacyQuery] = positionals;
  const hasFlagQuery = and.length > 0 || or.length > 0;

  if (hasFlagQuery && positionals.length !== 1) {
    throw new CliUsageError("Use either <pdfPath> <query> or <pdfPath> with --and/--or flags.");
  }

  if (!hasFlagQuery && positionals.length !== 2) {
    throw new CliUsageError("Provide either <pdfPath> <query> or at least one --and/--or term.");
  }

  return {
    mode: "search",
    pdfPath,
    query: hasFlagQuery
      ? {
          and,
          or,
        }
      : legacyQuery,
    showContext,
    contextChars,
    concurrency,
    remoteFetch,
  };
}

function buildRemoteFetchOptions(
  fetchTimeoutMs: number | undefined,
  maxFetchBytes: number | undefined,
): RemoteFetchOptions {
  const remoteFetch: RemoteFetchOptions = {};
  if (fetchTimeoutMs !== undefined) {
    remoteFetch.fetchTimeoutMs = fetchTimeoutMs;
  }
  if (maxFetchBytes !== undefined) {
    remoteFetch.maxFetchBytes = maxFetchBytes;
  }
  return remoteFetch;
}

function parseNonNegativeInteger(value: string | undefined, flagName: string): number {
  if (value === undefined) {
    throw new CliUsageError(`Missing value for ${flagName}.`);
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new CliUsageError(`${flagName} must be a non-negative integer.`);
  }

  return parsed;
}

function parsePositiveInteger(
  value: string | undefined,
  flagName: string,
  allowZero = false,
): number {
  if (value === undefined) {
    throw new CliUsageError(`Missing value for ${flagName}.`);
  }

  const parsed = Number(value);
  const minimum = allowZero ? 0 : 1;

  if (!Number.isInteger(parsed) || parsed < minimum) {
    const constraint = allowZero ? "a non-negative integer" : "a positive integer";
    throw new CliUsageError(`${flagName} must be ${constraint}.`);
  }

  return parsed;
}

function parsePageOutputFormat(value: string | undefined, flagName: string): PageCliOutputFormat {
  if (value === undefined || value.startsWith("-")) {
    throw new CliUsageError(`Missing value for ${flagName}.`);
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === "compact" || normalized === "layout" || normalized === "json") {
    return normalized;
  }

  throw new CliUsageError(`${flagName} must be compact, layout, or json (got ${value}).`);
}

function parseQueryTerm(value: string | undefined, flagName: string): string {
  if (value === undefined || value.startsWith("-")) {
    throw new CliUsageError(`Missing value for ${flagName}.`);
  }

  const term = value.trim();

  if (term.length === 0) {
    throw new CliUsageError(`${flagName} must not be empty.`);
  }

  return term;
}

function getUsageText(): string {
  return [
    "Usage:",
    "  pdf-search <pdfPathOrUrl> <query> [options]",
    "  pdf-search <pdfPathOrUrl> --and <term> [--and <term> ...] [--or <term> ...] [options]",
    "  pdf-search --page <number> <pdfPathOrUrl>",
    "",
    "<pdfPathOrUrl> may be a filesystem path, file:// URL, or http(s) URL to a PDF.",
    "",
    "Options:",
    "  -p, --page <number>          Print extracted text for a single page (1-based)",
    "  --page-format <mode>       With --page: compact (default), layout, or json",
    "  --and <term>                 Require a page to contain this term",
    "  --or <term>                  Require a page to contain at least one OR term",
    "  -c, --context                Show surrounding text for each match",
    "  --context-chars <number>     Characters of surrounding text to include",
    "  --concurrency <number>       Local PDFs: worker threads (default: min(CPU count, 4), capped by pages).",
    "                                Remote http(s) PDFs: scanned in-process; flag barely changes speed.",
    "  --fetch-timeout-ms <n>      For http(s) PDFs: abort after n ms (0 disables; default if omitted: 120000)",
    "  --max-fetch-bytes <n>        For http(s) PDFs: reject bodies larger than n bytes",
    "  -h, --help                   Show this help message",
  ].join("\n");
}

function createProgressReporter(stderr: CliIo["stderr"]): {
  update: (progress: SearchProgress) => void;
  clear: () => void;
} {
  let lastWidth = 0;
  let isVisible = false;

  return {
    update(progress) {
      const message = formatProgressMessage(progress);
      const padding = lastWidth > message.length ? " ".repeat(lastWidth - message.length) : "";

      stderr.write(`\r${message}${padding}`);
      lastWidth = message.length;
      isVisible = true;
    },
    clear() {
      if (!isVisible) {
        return;
      }

      stderr.write(`\r${" ".repeat(lastWidth)}\r`);
      lastWidth = 0;
      isVisible = false;
    },
  };
}

function formatProgressMessage(progress: SearchProgress): string {
  if (progress.phase === "loading") {
    return "Loading PDF...";
  }

  if (progress.totalPages === 0) {
    return "Scanning pages...";
  }

  const percentage = Math.floor((progress.processedPages / progress.totalPages) * 100);

  return `Scanning pages: ${progress.processedPages}/${progress.totalPages} (${percentage}%)`;
}
