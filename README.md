# pdf-search

`pdf-search` is a Node CLI for searching text in a PDF and printing matches with
their page numbers.

## Install

```bash
vp install
```

## Usage

```bash
pdf-search <pdfPath> <query> [options]
pdf-search <pdfPath> --and <term> [--and <term> ...] [--or <term> ...] [options]
```

### Options

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
