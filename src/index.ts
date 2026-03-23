#!/usr/bin/env node

import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runCli } from "./cli.js";

export { runCli } from "./cli.js";
export { formatSearchResults } from "./format.js";
export type {
  PageSearchResult,
  SearchMatch,
  SearchProgress,
  SearchQuery,
  SearchPdfOptions,
  SearchPdfResult,
} from "./search.js";
export { searchPdf } from "./search.js";

const executedPath = process.argv[1];
const currentFilePath = fileURLToPath(import.meta.url);
const isDirectExecution =
  executedPath !== undefined && resolve(executedPath) === currentFilePath;

if (isDirectExecution) {
  void runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
