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
pdf-search <pdfPath> <query> [options]
pdf-search <pdfPath> --and <term> [--and <term> ...] [--or <term> ...] [options]
pdf-search --page <number> <pdfPath>
```

### Options

- `-p, --page <number>`: print extracted text for one page (1-based); do not combine with search arguments or `--context` / `--context-chars` / `--concurrency`
- `--page-format <mode>`: only with `--page`. **`compact`** (default): single-line style text like search extraction. **`layout`**: keep line breaks from the PDF text runs. **`json`**: one JSON object per line with `page` and `text` (the `text` field uses **layout** formatting)
- `--and <term>`: require a page to contain this term; repeat for all required terms
- `--or <term>`: require a page to contain at least one optional term; repeat as needed
- `-c, --context`: show a short snippet around each match
- `--context-chars <number>`: control how much surrounding text is shown
- `--concurrency <number>`: control how many worker threads process pages in parallel
- `-h, --help`: print usage help

Search terms are matched as case-insensitive substrings. Normal runs suppress
recoverable PDF parser warnings, and progress is shown on stderr while the file
is being scanned.

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
is capped by the total page count to avoid oversubscription.

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

## Releasing (maintainers)

1. **npm access** — Use an account that owns the `@akshatowo` scope. Prefer [Trusted Publishing](https://docs.npmjs.com/trusted-publishers): connect GitHub repository `akshat-OwO/pdf-search` and the **Release** workflow for `@akshatowo/pdf-search`. Otherwise add an `NPM_TOKEN` repository secret and pass `NODE_AUTH_TOKEN` on the publish step (see comment in [`.github/workflows/release.yml`](.github/workflows/release.yml)).

2. **Version** — `pnpm exec bumpp` updates `package.json` only ([`bump.config.ts`](bump.config.ts) disables commit, tag, and push). Commit the change, then tag and push, for example:

   ```bash
   git tag v0.1.0
   git push origin main --tags
   ```

   Or run **Release** manually from the Actions tab (`workflow_dispatch`).

3. **CI** — [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs `pnpm exec vp check`, `pnpm exec vp test`, and `pnpm exec vp pack` on pushes and pull requests to `main`.

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
