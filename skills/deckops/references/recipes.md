# Recipes

Commands below assume `deckops` is installed and, for the cloud verbs, logged in and that the
user agreed to upload the document. With the npx fallback, replace the first word with
`npx -y @deckflow/deckops@4.0.0`.

Choose output paths inside a task-specific work directory. File names are examples.

## What is this file?

```bash
deckops probe "unknown.pdf" --targets @summary --json
```

Local and free. Use it to decide the next step, not as a habit before every upload.

## Markdown for an agent

```bash
deckops "report.pdf" --json
```

Read `content` and `warnings`. Image links are signed URLs; they work without credentials.

## One Markdown file with its images

```bash
deckops convert "report.pdf" -o "work/report.md" --json
```

Images land in `work/report.assets/`. Move the Markdown file and that directory together.
Several documents can be converted into the same directory.

## Structured content for analysis

```bash
deckops extract "report.pdf" --to json -o "work/report.json" --json
deckops convert "report.pdf" -o "work/report.md" --json
```

The second command reuses the cloud parse of the first (`reusedParse: true`): no second parse
charge. Keep `schemaVersion` with any conclusion drawn from the JSON.

## Only the images

```bash
deckops extract "deck.pptx" --to assets -o "work/deck-images" --json
```

## Slides as images, or a deck as video

```bash
deckops render "deck.pptx" --to image --pages 1-5 -o "work/frames" --json
deckops render "deck.pptx" --to image --image-format webp --quality low -o "work/thumbs" --json
deckops render "deck.pptx" --to video -o "work/deck.mp4" --json
```

## PPTX or Keynote split by slide

```bash
deckops convert "slides.key" --split-pages -o "work/slides.md" --json
```

Writes `slides.md` plus `slides-001.md`, `slides-002.md`, … sharing `slides.assets/`.

## Encrypted PDF

```bash
deckops convert "locked.pdf" --password "$PDF_PASSWORD" -o "work/locked.md" --json
```

Pass the password through the environment or a prompt the user controls; never echo it back.

## Web page

```bash
deckops convert "https://example.com/article" -o "work/article.md" --json
deckops extract "https://example.com/article" --to json -o - --json
```

The cloud fetches the URL; a URL is never reused across runs.

## Standard input

```bash
deckops convert - --from pdf -o "work/stdin.md" --json < "report.pdf"
deckops probe - --from pptx --json < "deck.pptx"
```

`--from` names the format; it cannot make unrelated bytes valid.

## Retry after a timeout

```bash
deckops extract "large.pdf" --to json -o "work/large.json" --timeout 900 --json
```

If it stops with `backend_error` after the task was created, run the same command again: it
continues that task without a new upload or charge.

## Batch processing

There is no batch mode. Iterate an explicit file list and collect each process's exit code,
stdout and stderr separately. Documents may share an output directory; each owns its
`<stem>.assets/`. Do not run two processes on the same output path at once.
