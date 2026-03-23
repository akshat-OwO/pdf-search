import process from "node:process";

import { formatSearchResults } from "./format.js";
import { searchPdf } from "./search.js";

const DEFAULT_CONTEXT_CHARS = 40;
const DEFAULT_CONCURRENCY = 4;

export interface CliIo {
  stdout: Pick<typeof process.stdout, "write">;
  stderr: Pick<typeof process.stderr, "write">;
}

interface ParsedCliArgs {
  pdfPath: string;
  query: string;
  showContext: boolean;
  contextChars: number;
  concurrency: number;
}

class CliUsageError extends Error {}

export async function runCli(
  argv: string[],
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  try {
    if (argv.includes("--help") || argv.includes("-h")) {
      io.stdout.write(`${getUsageText()}\n`);
      return 0;
    }

    const args = parseCliArgs(argv);
    const result = await searchPdf(args.pdfPath, args.query, {
      concurrency: args.concurrency,
      contextChars: args.contextChars,
    });

    io.stdout.write(
      formatSearchResults(result, {
        showContext: args.showContext,
      }),
    );

    return 0;
  } catch (error) {
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
      default:
        if (argument.startsWith("-")) {
          throw new CliUsageError(`Unknown flag: ${argument}`);
        }

        positionals.push(argument);
    }
  }

  if (positionals.length !== 2) {
    throw new CliUsageError("Expected exactly 2 arguments: <pdfPath> <query>.");
  }

  return {
    pdfPath: positionals[0],
    query: positionals[1],
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

function getUsageText(): string {
  return [
    "Usage: pdf-search <pdfPath> <query> [options]",
    "",
    "Options:",
    "  -c, --context                Show surrounding text for each match",
    "  --context-chars <number>     Characters of surrounding text to include",
    "  --concurrency <number>       Number of pages to process at once",
    "  -h, --help                   Show this help message",
  ].join("\n");
}
