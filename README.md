# pdf-search

`pdf-search` is a Node CLI for searching text in a PDF and printing matches with
their page numbers. You can also print the extracted text for a single page by
number without scanning every page (PDF.js resolves the page directly).

## Install

From npm:

```bash
pnpm add -g @akshatowo/pdf-search
# or: npm install -g @akshatowo/pdf-search
```

From a clone (contributors):

```bash
pnpm install
```

## Usage

```bash
pdf-search <pdfPathOrUrl> <query> [options]
pdf-search <pdfPathOrUrl> --and <term> [--and <term> ...] [--or <term> ...] [options]
pdf-search --page <number> <pdfPathOrUrl>
```

`<pdfPathOrUrl>` may be a filesystem path, a `file://` URL, or an `http://` / `https://` URL to a PDF. Each CLI invocation that loads a remote URL downloads the file again (there is no cross-call cache). The programmatic API behaves the same: `loadPdfDocument` and `getPdfPageText` fetch on every call unless you pass local bytes or a path yourself.

### Options

- `-p, --page <number>`: print extracted text for one page (1-based); do not combine with search arguments or `--context` / `--context-chars` / `--concurrency`
- `--page-format <mode>`: only with `--page`. **`compact`** (default): single-line style text like search extraction. **`layout`**: keep line breaks from the PDF text runs. **`json`**: one JSON object per line with `page` and `text` (the `text` field uses **layout** formatting)
- `--and <term>`: require a page to contain this term; repeat for all required terms
- `--or <term>`: require a page to contain at least one optional term; repeat as needed
- `-c, --context`: show a short snippet around each match
- `--context-chars <number>`: control how much surrounding text is shown
- `--concurrency <number>`: for **local** PDFs (and the bundled CLI), how many **worker threads** share the scan—this is where you usually see a wall-clock speedup on multi-core machines. For **`http(s)` URLs**, the file is scanned **in the main process** (to avoid copying the whole download into every worker), so this flag has **little effect on runtime**; matches and ordering stay the same.
- `--fetch-timeout-ms <n>`: for `http(s)` PDFs only, abort if the response is not received in time; default is 120000 when omitted. Use `0` to disable the timeout
- `--max-fetch-bytes <n>`: for `http(s)` PDFs only, reject responses larger than _n_ bytes (checked while streaming)
- `-h, --help`: print usage help

Search terms are matched as case-insensitive substrings. Normal runs suppress
recoverable PDF parser warnings, and progress is shown on stderr while the file
is being scanned.

### Security note

If you pass URLs from untrusted users (for example inside a web application), fetching them can carry **SSRF** risk (internal addresses, redirect chains) and **resource** risk (very large downloads). Prefer allowlists, trusted hosts, or downloading out-of-band. Remote fetches use a default timeout; use `--max-fetch-bytes` (CLI) or `maxFetchBytes` (API) when you need an explicit body size limit.

## Examples

Search a PDF and print page-level match counts:

```bash
pdf-search "./docs/guide.pdf" "worker threads"
```

Require pages to contain both terms:

```bash
pdf-search "./docs/guide.pdf" --and "worker threads" --and "memory pressure"
```

Require pages to contain `worker threads` and at least one of two related terms:

```bash
pdf-search "./docs/guide.pdf" --and "worker threads" --or "benchmarking" --or "throughput"
```

Search a PDF and show surrounding text for each hit:

```bash
pdf-search "./docs/guide.pdf" "worker threads" --context
```

Increase snippet length and worker-thread concurrency:

```bash
pdf-search "./docs/guide.pdf" "worker threads" --context --context-chars 80 --concurrency 6
```

Dump normalized text for page 3 only (stdout is suitable for piping):

```bash
pdf-search --page 3 "./docs/guide.pdf"
```

Preserve line structure, or emit JSON for scripts:

```bash
pdf-search --page 3 --page-format layout "./docs/guide.pdf"
pdf-search --page 3 --page-format json "./docs/guide.pdf"
```

`--concurrency` defaults to a bounded worker-thread count based on CPU cores, and
is capped by the total page count to avoid oversubscription. That default matters
most for **local** PDFs when the bundled CLI can use worker threads. For
**remote** `http(s)` PDFs, scanning stays in-process, so changing `--concurrency`
usually does not improve wall-clock time much.

## Example Output

Default mode:

```text
PDF: guide.pdf
Query: "worker threads"
Pages scanned: 42
Matches found: 3

Page 4: 1 match
Page 18: 2 matches
```

Multi-term mode:

```text
PDF: guide.pdf
Query: all of "worker threads"; any of "benchmarking", "throughput"
Pages scanned: 42
Matches found: 4

Page 18: 2 matches
Page 27: 2 matches
```

Context mode:

```text
PDF: guide.pdf
Query: "worker threads"
Pages scanned: 42
Matches found: 3

Page 4
  1. ...processing pool uses worker threads to keep the search responsive...

Page 18
  1. ...a bounded worker threads strategy reduces memory pressure...
  2. ...benchmarking worker threads across pages improves throughput...
```

## Development

Run the test suite:

```bash
vp test
```

Build the CLI:

```bash
vp pack
```

Run checks:

```bash
vp check
```

Run a synthetic concurrency benchmark:

```bash
vp run bench
```
