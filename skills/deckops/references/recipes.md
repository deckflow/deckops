# Recipes

Commands below assume `deckops` is installed. When using the npx fallback, replace the first
word with `npx -y @deckflow/deckops@2.1.1`.

Choose output paths inside a task-specific work directory. File names are examples.

## One portable Markdown file

```bash
deckops convert "report.pdf" --engine local --preflight validate \
  -o "work/report.md" --json
```

The portable form places images in a sibling `report.assets/` directory. Verify links and
assets before moving only the Markdown file.

## Durable PDF artifact with provenance

```bash
deckops parse "report.pdf" --engine local --preflight validate \
  -o "work/report-pdf" --json
deckops convert "work/report-pdf" --engine local --anchors --json
```

Read `work/report-pdf/views/markdown/index.md`; keep the artifact for future views or source
lookup.

## DOCX tracked-change views

```bash
deckops convert "contract.docx" --engine local --preflight validate \
  --tracked-changes final -o "work/contract-final.md" --json
```

Use `original` or `all` only when that reading view is requested. To retain several views,
parse each variant into a distinct artifact. This does not accept or reject revisions in the
source file.

## PPTX split by slide

```bash
deckops parse "slides.pptx" --engine local --preflight validate \
  -o "work/slides-pptx" --json
deckops convert "work/slides-pptx" --engine local --split-pages --json
```

The artifact view contains `index.md`, `001.md`, and subsequent page files. Do not rely on
one-shot portable conversion to create those separate files in 2.1.1.

## Keynote with existing upload authorization

```bash
deckops parse "talk.key" --engine cloud --preflight validate \
  -o "work/talk-key" --json
deckops convert "work/talk-key" --engine cloud --split-pages --json
```

The second command consumes the existing remote reference and does not upload the source
again. Preserve task IDs. If submission outcome is uncertain, inspect/recover that task
rather than submitting another parse.

## Allow cloud only when local is insufficient

Use this only when the user has allowed automatic upload:

```bash
deckops parse "report.pdf" --engine auto --allow-upload \
  --preflight validate -o "work/report-auto" --json
```

Automatic routing does not mean every local error is retried in cloud. Inspect the returned
engine and quality.

## URL source and runtime

Static HTML source mode:

```bash
deckops convert "https://example.com/article" --engine local --mode source \
  -o "work/article.md" --json
```

Runtime mode, with cloud processing already authorized:

```bash
deckops convert "https://example.com/app" --engine cloud --mode runtime \
  -o "work/app.md" --json
```

## Standard input

```bash
deckops parse - --from pdf --engine local --preflight validate \
  -o "work/stdin-pdf" --json < "report.pdf"
```

`--from` selects a parser; it cannot force unrelated bytes through a parser successfully.

## Batch processing

DeckOps 2.1.1 has no JSONL batch mode. Iterate an explicit file list in the host environment,
give every source a unique output path, and collect each process's exit code, stdout, and
stderr separately. Avoid concurrent writes to the same artifact or view directory.

## Re-materialize a portable file from an artifact

If an artifact view cache already exists, conversion may return the cached view without
creating a newly requested `-o` file. Use `--force` on the artifact conversion and then check
the requested file exists:

```bash
deckops convert "work/report-pdf" --engine local --force \
  -o "delivery/report.md" --json
```

This forces the view operation, not a new source parse.
