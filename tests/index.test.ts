import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PDFDocument, StandardFonts } from "pdf-lib";
import { expect, test } from "vite-plus/test";

import { runCli } from "../src/index.ts";
import { formatSearchResults } from "../src/index.ts";
import { fetchPdfFromUrl } from "../src/index.ts";
import { getPdfPageText } from "../src/index.ts";
import { searchPdf } from "../src/index.ts";

const bundledSearchEntry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.mjs");

test("searchPdf returns page-numbered results in page order", async () => {
  const fixture = await createPdfFixture([
    "Needle appears once on page one.",
    "This page does not contain the query.",
    "A final needle appears twice: needle.",
  ]);

  try {
    const result = await searchPdf(fixture.pdfPath, "needle", {
      concurrency: 2,
    });

    expect(result.pageCount).toBe(3);
    expect(result.matchCount).toBe(3);
    expect(result.results.map((page) => page.page)).toEqual([1, 3]);
    expect(result.results[0].matches).toHaveLength(1);
    expect(result.results[1].matches).toHaveLength(2);
  } finally {
    await fixture.cleanup();
  }
});

test("searchPdf returns stable results across worker counts", async () => {
  const fixture = await createPdfFixture([
    "Alpha needle appears with beta.",
    "Gamma only page.",
    "Needle appears again with alpha and gamma needle.",
    "No match here.",
  ]);

  try {
    const serial = await searchPdf(
      fixture.pdfPath,
      {
        and: ["needle"],
        or: ["alpha", "gamma"],
      },
      {
        concurrency: 1,
        contextChars: 12,
      },
    );
    const parallel = await searchPdf(
      fixture.pdfPath,
      {
        and: ["needle"],
        or: ["alpha", "gamma"],
      },
      {
        concurrency: 4,
        contextChars: 12,
      },
    );

    expect(parallel.pageCount).toBe(serial.pageCount);
    expect(parallel.matchCount).toBe(serial.matchCount);
    expect(parallel.results).toEqual(serial.results);
    expect(parallel.results.map((page) => page.page)).toEqual([1, 3]);
  } finally {
    await fixture.cleanup();
  }
});

test.skipIf(!existsSync(bundledSearchEntry))(
  "bundled searchPdf matches serial under Node worker concurrency",
  async () => {
    const { searchPdf: searchPdfBundled } = await import(pathToFileURL(bundledSearchEntry).href);
    const fixture = await createPdfFixture([
      "Alpha needle appears with beta.",
      "Gamma only page.",
      "Needle appears again with alpha and gamma needle.",
      "No match here.",
    ]);

    try {
      const serial = await searchPdfBundled(
        fixture.pdfPath,
        {
          and: ["needle"],
          or: ["alpha", "gamma"],
        },
        {
          concurrency: 1,
          contextChars: 12,
        },
      );
      const parallel = await searchPdfBundled(
        fixture.pdfPath,
        {
          and: ["needle"],
          or: ["alpha", "gamma"],
        },
        {
          concurrency: 4,
          contextChars: 12,
        },
      );

      expect(parallel.pageCount).toBe(serial.pageCount);
      expect(parallel.matchCount).toBe(serial.matchCount);
      expect(parallel.results).toEqual(serial.results);
    } finally {
      await fixture.cleanup();
    }
  },
);

test("formatSearchResults includes surrounding text in context mode", async () => {
  const fixture = await createPdfFixture(["Alpha beta needle gamma delta."]);

  try {
    const result = await searchPdf(fixture.pdfPath, "needle", {
      contextChars: 8,
    });
    const output = formatSearchResults(result, { showContext: true });

    expect(output).toContain("Page 1");
    expect(output).toContain("needle");
    expect(output).toContain("gamma");
  } finally {
    await fixture.cleanup();
  }
});

test("searchPdf supports AND-only page filters", async () => {
  const fixture = await createPdfFixture([
    "Alpha and beta appear together here.",
    "Only alpha appears on this page.",
    "Only beta appears on this page.",
  ]);

  try {
    const result = await searchPdf(fixture.pdfPath, {
      and: ["alpha", "beta"],
      or: [],
    });

    expect(result.results.map((page) => page.page)).toEqual([1]);
    expect(result.matchCount).toBe(2);
  } finally {
    await fixture.cleanup();
  }
});

test("searchPdf supports OR-only page filters", async () => {
  const fixture = await createPdfFixture([
    "Alpha appears here.",
    "Gamma appears here.",
    "Nothing relevant is on this page.",
  ]);

  try {
    const result = await searchPdf(fixture.pdfPath, {
      and: [],
      or: ["alpha", "gamma"],
    });

    expect(result.results.map((page) => page.page)).toEqual([1, 2]);
    expect(result.matchCount).toBe(2);
  } finally {
    await fixture.cleanup();
  }
});

test("searchPdf supports mixed AND and OR page filters", async () => {
  const fixture = await createPdfFixture([
    "Alpha, beta, and gamma all appear together.",
    "Alpha and beta appear, but gamma is missing.",
    "Alpha and gamma appear, but beta is missing.",
  ]);

  try {
    const result = await searchPdf(fixture.pdfPath, {
      and: ["alpha"],
      or: ["beta", "gamma"],
    });

    expect(result.results.map((page) => page.page)).toEqual([1, 2, 3]);
    expect(result.results[0].matches.map((match) => match.term)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test("formatSearchResults reports no matches clearly", async () => {
  const fixture = await createPdfFixture(["There is nothing relevant on this page."]);

  try {
    const result = await searchPdf(fixture.pdfPath, "needle");
    const output = formatSearchResults(result);

    expect(result.matchCount).toBe(0);
    expect(output).toContain("No matches found.");
  } finally {
    await fixture.cleanup();
  }
});

test("searchPdf throws for unreadable paths", async () => {
  await expect(searchPdf("/definitely/missing/file.pdf", "needle")).rejects.toThrow(
    "PDF file is not readable",
  );
});

test("searchPdf loads remote http URL once and searches with concurrency", async () => {
  const bytes = await buildPdfBytes([
    "Needle appears once on page one.",
    "This page does not contain the query.",
    "A final needle appears twice: needle.",
  ]);
  const { baseUrl, close } = await servePdfBuffer(bytes);

  try {
    const result = await searchPdf(`${baseUrl}/doc.pdf`, "needle", {
      concurrency: 2,
    });

    expect(result.pageCount).toBe(3);
    expect(result.matchCount).toBe(3);
    expect(result.filePath).toBe(`${baseUrl}/doc.pdf`);
    expect(result.results.map((page) => page.page)).toEqual([1, 3]);
  } finally {
    await close();
  }
});

test("getPdfPageText accepts remote http URL", async () => {
  const bytes = await buildPdfBytes([
    "Content unique to page one.",
    "Second page has different words.",
  ]);
  const { baseUrl, close } = await servePdfBuffer(bytes);

  try {
    const page2 = await getPdfPageText(`${baseUrl}/doc.pdf`, 2);
    expect(page2).toContain("Second page");
    expect(page2).not.toContain("page one");
  } finally {
    await close();
  }
});

test("searchPdf throws when remote URL returns non-OK status", async () => {
  const { baseUrl, close } = await servePdfBuffer(Buffer.alloc(0), { statusCode: 404 });

  try {
    await expect(searchPdf(`${baseUrl}/missing.pdf`, "x")).rejects.toThrow(
      "Failed to fetch PDF from URL: HTTP 404",
    );
  } finally {
    await close();
  }
});

test("searchPdf accepts file:// URL", async () => {
  const fixture = await createPdfFixture(["file protocol needle here"]);

  try {
    const url = pathToFileURL(fixture.pdfPath).href;
    const result = await searchPdf(url, "needle");
    expect(result.matchCount).toBe(1);
    expect(result.results.map((page) => page.page)).toEqual([1]);
  } finally {
    await fixture.cleanup();
  }
});

test("getPdfPageText accepts file:// URL", async () => {
  const fixture = await createPdfFixture(["Page one only"]);

  try {
    const url = pathToFileURL(fixture.pdfPath).href;
    const text = await getPdfPageText(url, 1);
    expect(text).toContain("Page one");
  } finally {
    await fixture.cleanup();
  }
});

test("searchPdf throws when remote URL returns HTTP 200 with non-PDF body", async () => {
  const bytes = new TextEncoder().encode("this is not a pdf file");
  const { baseUrl, close } = await servePdfBuffer(bytes);

  try {
    await expect(searchPdf(`${baseUrl}/fake.pdf`, "needle")).rejects.toThrow(
      "Failed to read PDF file",
    );
  } finally {
    await close();
  }
});

test("fetchPdfFromUrl respects maxFetchBytes", async () => {
  const bytes = await buildPdfBytes(["short"]);
  const { baseUrl, close } = await servePdfBuffer(bytes);

  try {
    await expect(fetchPdfFromUrl(`${baseUrl}/doc.pdf`, { maxFetchBytes: 16 })).rejects.toThrow(
      "exceeds maxFetchBytes (16)",
    );
  } finally {
    await close();
  }
});

test("fetchPdfFromUrl times out when the server never responds", async () => {
  const { baseUrl, close } = await serveStallForever();

  try {
    await expect(fetchPdfFromUrl(`${baseUrl}/slow.pdf`, { fetchTimeoutMs: 80 })).rejects.toThrow(
      "request timed out",
    );
  } finally {
    await close();
  }
});

test("searchPdf remote URL works with PDF_SEARCH_FORCE_WORKERS", async () => {
  const previousWorkers = process.env.PDF_SEARCH_FORCE_WORKERS;
  process.env.PDF_SEARCH_FORCE_WORKERS = "1";

  const bytes = await buildPdfBytes([
    "Needle on remote with workers env.",
    "Second page no match.",
  ]);
  const { baseUrl, close } = await servePdfBuffer(bytes);

  try {
    const result = await searchPdf(`${baseUrl}/doc.pdf`, "needle", {
      concurrency: 2,
    });
    expect(result.matchCount).toBe(1);
    expect(result.results.map((page) => page.page)).toEqual([1]);
  } finally {
    await close();
    if (previousWorkers === undefined) {
      delete process.env.PDF_SEARCH_FORCE_WORKERS;
    } else {
      process.env.PDF_SEARCH_FORCE_WORKERS = previousWorkers;
    }
  }
});

test("getPdfPageText returns text for the requested page only", async () => {
  const fixture = await createPdfFixture([
    "Content unique to page one.",
    "Second page has different words.",
    "Third page is also distinct.",
  ]);

  try {
    const page2 = await getPdfPageText(fixture.pdfPath, 2);
    expect(page2).toContain("Second page");
    expect(page2).not.toContain("page one");
    expect(page2).not.toContain("Third page");
  } finally {
    await fixture.cleanup();
  }
});

test("getPdfPageText rejects out-of-range page numbers", async () => {
  const fixture = await createPdfFixture(["Only one page here."]);

  try {
    await expect(getPdfPageText(fixture.pdfPath, 2)).rejects.toThrow(
      "Page number must be an integer from 1 to 1",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("getPdfPageText layout preserves line breaks from newline in page text", async () => {
  const fixture = await createPdfFixture(["Line one alpha.\nLine two beta."]);

  try {
    const compact = await getPdfPageText(fixture.pdfPath, 1, {
      format: "compact",
    });
    const layout = await getPdfPageText(fixture.pdfPath, 1, {
      format: "layout",
    });

    expect(compact).not.toContain("\n");
    expect(layout).toContain("\n");
    expect(compact).toContain("alpha");
    expect(compact).toContain("beta");
    expect(layout).toContain("alpha");
    expect(layout).toContain("beta");
  } finally {
    await fixture.cleanup();
  }
});

test("searchPdf throws for invalid PDF content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pdf-search-invalid-"));
  const filePath = join(directory, "invalid.pdf");

  try {
    await writeFile(filePath, "not actually a pdf", "utf8");

    await expect(searchPdf(filePath, "needle")).rejects.toThrow("Failed to read PDF file");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runCli prints contextual results when the flag is enabled", async () => {
  const fixture = await createPdfFixture(["Context around needle is useful for users."]);

  try {
    const captured = createCapturedIo();
    const exitCode = await runCli(
      [fixture.pdfPath, "needle", "--context", "--context-chars", "10"],
      captured.io,
    );

    expect(exitCode).toBe(0);
    expect(captured.stdout).toContain("Page 1");
    expect(captured.stdout).toContain("needle");
    expect(captured.stderr).toContain("Loading PDF...");
    expect(captured.stderr).toContain("Scanning pages:");
    expect(captured.stderr).not.toContain("Warning:");
  } finally {
    await fixture.cleanup();
  }
});

test("runCli supports repeatable --and and --or flags", async () => {
  const fixture = await createPdfFixture([
    "Alpha and beta appear together.",
    "Alpha appears on its own.",
    "Gamma appears on its own.",
  ]);

  try {
    const captured = createCapturedIo();
    const exitCode = await runCli(
      [fixture.pdfPath, "--and", "alpha", "--or", "beta", "--or", "gamma"],
      captured.io,
    );

    expect(exitCode).toBe(0);
    expect(captured.stdout).toContain('Query: all of "alpha"; any of "beta", "gamma"');
    expect(captured.stdout).toContain("Page 1");
    expect(captured.stdout).not.toContain("Page 2");
    expect(captured.stdout).not.toContain("Page 3");
  } finally {
    await fixture.cleanup();
  }
});

test("runCli prints single-page text with --page", async () => {
  const fixture = await createPdfFixture([
    "First page text.",
    "Middle page for extraction.",
    "Last page text.",
  ]);

  try {
    const captured = createCapturedIo();
    const exitCode = await runCli(["--page", "2", fixture.pdfPath], captured.io);

    expect(exitCode).toBe(0);
    expect(captured.stdout).toContain("Middle page");
    expect(captured.stdout).not.toContain("First page");
    expect(captured.stderr).toBe("");
  } finally {
    await fixture.cleanup();
  }
});

test("runCli --page-format json prints layout text in JSON", async () => {
  const fixture = await createPdfFixture(["Only page content here."]);

  try {
    const captured = createCapturedIo();
    const exitCode = await runCli(
      ["--page", "1", "--page-format", "json", fixture.pdfPath],
      captured.io,
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(captured.stdout.trim()) as {
      page: number;
      text: string;
    };
    expect(parsed.page).toBe(1);
    expect(parsed.text.length).toBeGreaterThan(0);
    expect(parsed.text).toContain("Only page");
    expect(captured.stderr).toBe("");
  } finally {
    await fixture.cleanup();
  }
});

test("runCli rejects --page-format without --page", async () => {
  const captured = createCapturedIo();
  const exitCode = await runCli(["/tmp/x.pdf", "--page-format", "layout"], captured.io);

  expect(exitCode).toBe(1);
  expect(captured.stderr).toContain("--page-format is only valid with --page.");
});

test("runCli rejects --page-format with search mode", async () => {
  const captured = createCapturedIo();
  const exitCode = await runCli(["/tmp/x.pdf", "needle", "--page-format", "json"], captured.io);

  expect(exitCode).toBe(1);
  expect(captured.stderr).toContain("--page-format is only valid with --page.");
});

test("runCli rejects --page combined with search query", async () => {
  const captured = createCapturedIo();
  const exitCode = await runCli(["/tmp/x.pdf", "query", "--page", "1"], captured.io);

  expect(exitCode).toBe(1);
  expect(captured.stderr).toContain("With --page, provide only <pdfPathOrUrl>.");
});

test("runCli rejects missing search terms", async () => {
  const captured = createCapturedIo();
  const exitCode = await runCli(["/tmp/example.pdf"], captured.io);

  expect(exitCode).toBe(1);
  expect(captured.stderr).toContain(
    "Provide either <pdfPath> <query> or at least one --and/--or term.",
  );
});

test("runCli rejects flags without values", async () => {
  const captured = createCapturedIo();
  const exitCode = await runCli(["/tmp/example.pdf", "--and", "--context"], captured.io);

  expect(exitCode).toBe(1);
  expect(captured.stderr).toContain("Missing value for --and.");
});

async function createPdfFixture(pageTexts: string[]): Promise<{
  pdfPath: string;
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "pdf-search-"));
  const pdfPath = join(directory, "fixture.pdf");
  const bytes = await buildPdfBytes(pageTexts);
  await writeFile(pdfPath, bytes);

  return {
    pdfPath,
    cleanup: async () => {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function buildPdfBytes(pageTexts: string[]): Promise<Uint8Array> {
  const pdfDocument = await PDFDocument.create();
  const font = await pdfDocument.embedFont(StandardFonts.Helvetica);

  for (const text of pageTexts) {
    const page = pdfDocument.addPage([612, 792]);
    page.drawText(text, {
      x: 48,
      y: 700,
      size: 16,
      font,
      maxWidth: 500,
    });
  }

  return new Uint8Array(await pdfDocument.save());
}

function serveStallForever(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer((_request, _response) => {
      /* never write a response — client should hit fetch timeout */
    });

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Expected numeric listen address."));
        return;
      }

      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.closeAllConnections?.();
            server.close((error) => {
              if (error) {
                closeReject(error);
              } else {
                closeResolve();
              }
            });
          }),
      });
    });
  });
}

function servePdfBuffer(
  bytes: Uint8Array,
  options: { statusCode?: number } = {},
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const statusCode = options.statusCode ?? 200;
      response.writeHead(statusCode, { "Content-Type": "application/pdf" });
      response.end(Buffer.from(bytes));
    });

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Expected numeric listen address."));
        return;
      }

      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => {
              if (error) {
                closeReject(error);
              } else {
                closeResolve();
              }
            });
          }),
      });
    });
  });
}

function createCapturedIo(): {
  io: {
    stdout: { write: (chunk: string | Uint8Array) => boolean };
    stderr: { write: (chunk: string | Uint8Array) => boolean };
  };
  stdout: string;
  stderr: string;
} {
  const state = {
    stdout: "",
    stderr: "",
  };

  return {
    io: {
      stdout: {
        write: (chunk) => {
          state.stdout += String(chunk);
          return true;
        },
      },
      stderr: {
        write: (chunk) => {
          state.stderr += String(chunk);
          return true;
        },
      },
    },
    get stdout() {
      return state.stdout;
    },
    get stderr() {
      return state.stderr;
    },
  };
}
