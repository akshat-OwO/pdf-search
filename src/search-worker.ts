import { parentPort, workerData } from "node:worker_threads";

import { extractPageText, loadPdfDocument } from "./pdf.js";
import { findPageMatches } from "./search-core.js";
import type { PageSearchResult } from "./search.js";
import type { SearchQuery } from "./search-core.js";

interface WorkerInput {
  pdfPath: string;
  pages: number[];
  query: SearchQuery;
  contextChars: number;
}

interface WorkerProgressMessage {
  type: "progress";
  processedPages: number;
}

interface WorkerResultMessage {
  type: "result";
  pages: PageSearchResult[];
}

interface WorkerErrorMessage {
  type: "error";
  message: string;
}

type WorkerMessage = WorkerProgressMessage | WorkerResultMessage | WorkerErrorMessage;

async function run(payload: WorkerInput): Promise<PageSearchResult[]> {
  const document = await loadPdfDocument(payload.pdfPath, { disableWorker: true });
  const pageResults: PageSearchResult[] = [];

  try {
    for (const page of payload.pages) {
      const text = await extractPageText(document, page);
      const matches = findPageMatches(text, payload.query, payload.contextChars);
      pageResults.push({ page, matches });
      postMessage({
        type: "progress",
        processedPages: 1,
      });
    }

    return pageResults;
  } finally {
    await document.destroy();
  }
}

function postMessage(message: WorkerMessage): void {
  parentPort?.postMessage(message);
}

if (!parentPort) {
  throw new Error("search-worker must be run as a worker thread.");
}

void run(workerData as WorkerInput)
  .then((pages) => {
    postMessage({
      type: "result",
      pages,
    });
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Worker failed";
    postMessage({
      type: "error",
      message,
    });
  });
