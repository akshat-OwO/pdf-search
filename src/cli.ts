import process from "node:process";

import { formatSearchResults } from "./format.js";
import { searchPdf } from "./search.js";
import type { SearchProgress, SearchQuery } from "./search.js";

const DEFAULT_CONTEXT_CHARS = 40;
const DEFAULT_CONCURRENCY = 4;

export interface CliIo {
  stdout: Pick<typeof process.stdout, "write">;
  stderr: Pick<typeof process.stderr, "write">;
}

interface ParsedCliArgs {
  pdfPath: string;
  query: string | SearchQuery;
  showContext: boolean;
  contextChars: number;
  concurrency: number;
}

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
    const result = await searchPdf(args.pdfPath, args.query, {
      concurrency: args.concurrency,
      contextChars: args.contextChars,
      onProgress: progress.update,
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
    const message =
      error instanceof Error ? error.message : "Unexpected CLI error";
    const output =
      error instanceof CliUsageError
        ? `${message}\n\n${getUsageText()}\n`
        : `${message}\n`;

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
  let concurrency = DEFAULT_CONCURRENCY;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    switch (argument) {
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
    throw new CliUsageError("Expected a PDF path.");
  }

  const [pdfPath, legacyQuery] = positionals;
  const hasFlagQuery = and.length > 0 || or.length > 0;

  if (hasFlagQuery && positionals.length !== 1) {
    throw new CliUsageError(
      "Use either <pdfPath> <query> or <pdfPath> with --and/--or flags.",
    );
  }

  if (!hasFlagQuery && positionals.length !== 2) {
    throw new CliUsageError(
      "Provide either <pdfPath> <query> or at least one --and/--or term.",
    );
  }

  return {
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
  };
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
    const constraint = allowZero
      ? "a non-negative integer"
      : "a positive integer";
    throw new CliUsageError(`${flagName} must be ${constraint}.`);
  }

  return parsed;
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
    "  pdf-search <pdfPath> <query> [options]",
    "  pdf-search <pdfPath> --and <term> [--and <term> ...] [--or <term> ...] [options]",
    "",
    "Options:",
    "  --and <term>                 Require a page to contain this term",
    "  --or <term>                  Require a page to contain at least one OR term",
    "  -c, --context                Show surrounding text for each match",
    "  --context-chars <number>     Characters of surrounding text to include",
    "  --concurrency <number>       Number of pages to process at once",
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
      const padding =
        lastWidth > message.length
          ? " ".repeat(lastWidth - message.length)
          : "";

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

  const percentage = Math.floor(
    (progress.processedPages / progress.totalPages) * 100,
  );

  return `Scanning pages: ${progress.processedPages}/${progress.totalPages} (${percentage}%)`;
}
