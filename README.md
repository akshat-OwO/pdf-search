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
```

### Options

- `-c, --context`: show a short snippet around each match
- `--context-chars <number>`: control how much surrounding text is shown
- `--concurrency <number>`: control how many pages are processed at once
- `-h, --help`: print usage help

## Examples

Search a PDF and print page-level match counts:

```bash
pdf-search "./docs/guide.pdf" "worker threads"
```

Search a PDF and show surrounding text for each hit:

```bash
pdf-search "./docs/guide.pdf" "worker threads" --context
```

Increase snippet length and page-processing concurrency:

```bash
pdf-search "./docs/guide.pdf" "worker threads" --context --context-chars 80 --concurrency 6
```

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
