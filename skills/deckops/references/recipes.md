# Recipes

Commands below assume `deckops` is installed and logged in, and that the user agreed to upload
the document. With the npx fallback, replace the first word with
`npx -y @deckflow/deckops@3.0.0`.

Choose output paths inside a task-specific work directory. File names are examples.

## Markdown for an agent

```bash
deckops "report.pdf" --json
```

Read `content` and `report.warnings`. Images point into the DeckOps cache.

## One portable Markdown file

```bash
deckops "report.pdf" -o "work/report.md" --json
```

Images land in a sibling `report.assets-<id>/` directory. Verify links and assets before
moving the Markdown file alone.

## Durable PDF artifact with provenance

```bash
deckops parse "report.pdf" -o "work/report-pdf" --json
deckops convert "work/report-pdf" --anchors --json
```

Read `work/report-pdf/views/markdown/index.md`; keep the artifact for later views and source
lookup within the 7-day IR retention.

## PPTX or Keynote split by slide

```bash
deckops parse "slides.pptx" -o "work/slides-pptx" --json
deckops convert "work/slides-pptx" --split-pages --json
```

The view contains `index.md`, `001.md`, and following page files.

## Several views of one parse

```bash
deckops convert "work/report-pdf" -o "delivery/report-anchored.md" --anchors --json
deckops convert "work/report-pdf" -o "delivery/report.md" --json
```

Each converts the stored IR reference; nothing is uploaded again.

## Encrypted PDF

```bash
deckops parse "locked.pdf" --password "$PDF_PASSWORD" -o "work/locked-pdf" --json
```

Pass the password through the environment or a prompt the user controls; never echo it back.

## Web page

```bash
deckops convert "https://example.com/article" -o "work/article.md" --json
deckops convert "https://example.com/app" --mode source -o "work/app-source.md" --json
```

The cloud fetches the URL. `runtime` (default) renders the page; `source` uses the page source.

## Standard input

```bash
deckops parse - --from pdf -o "work/stdin-pdf" --json < "report.pdf"
```

`--from` picks the parse task; it cannot make unrelated bytes parse successfully.

## Retry after a timeout

```bash
deckops parse "large.pdf" -o "work/large-pdf" --timeout 600 --json
```

If it stops with `backend_error` after the task was created, run the same command again: it
resumes that task without a new upload or charge.

## Batch processing

There is no batch mode. Iterate an explicit file list, give every source its own output
directory, and collect each process's exit code, stdout, and stderr separately. Avoid
concurrent runs against the same artifact directory.
