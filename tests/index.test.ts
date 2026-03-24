import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PDFDocument, StandardFonts } from "pdf-lib";
import { expect, test } from "vite-plus/test";

import { runCli } from "../src/index.ts";
import { formatSearchResults } from "../src/index.ts";
import { searchPdf } from "../src/index.ts";

const bundledSearchEntry = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "index.mjs",
);

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
    const { searchPdf: searchPdfBundled } = await import(
      pathToFileURL(bundledSearchEntry).href
    );
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
  const fixture = await createPdfFixture([
    "There is nothing relevant on this page.",
  ]);

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
  await expect(
    searchPdf("/definitely/missing/file.pdf", "needle"),
  ).rejects.toThrow("PDF file is not readable");
});

test("searchPdf throws for invalid PDF content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pdf-search-invalid-"));
  const filePath = join(directory, "invalid.pdf");

  try {
    await writeFile(filePath, "not actually a pdf", "utf8");

    await expect(searchPdf(filePath, "needle")).rejects.toThrow(
      "Failed to read PDF file",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runCli prints contextual results when the flag is enabled", async () => {
  const fixture = await createPdfFixture([
    "Context around needle is useful for users.",
  ]);

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
    expect(captured.stdout).toContain(
      'Query: all of "alpha"; any of "beta", "gamma"',
    );
    expect(captured.stdout).toContain("Page 1");
    expect(captured.stdout).not.toContain("Page 2");
    expect(captured.stdout).not.toContain("Page 3");
  } finally {
    await fixture.cleanup();
  }
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
  const exitCode = await runCli(
    ["/tmp/example.pdf", "--and", "--context"],
    captured.io,
  );

  expect(exitCode).toBe(1);
  expect(captured.stderr).toContain("Missing value for --and.");
});

async function createPdfFixture(pageTexts: string[]): Promise<{
  pdfPath: string;
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "pdf-search-"));
  const pdfPath = join(directory, "fixture.pdf");
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

  await writeFile(pdfPath, await pdfDocument.save());

  return {
    pdfPath,
    cleanup: async () => {
      await rm(directory, { recursive: true, force: true });
    },
  };
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
