# Verbs, inputs and options

`deckops formats --json` prints the table the CLI routes by. Anything outside it fails with
`unsupported` and names the nearest combinations that exist.

| Verb and target | Inputs | Cloud task |
| --- | --- | --- |
| `probe` | `.pdf` `.pptx` `.docx` `.xlsx` `.key` `.ppt` `.doc` `.pages` `.numbers` | none — local |
| `render --to image` | `.pptx` `.ppt` `.pdf` `.key` `.docx` `.html` `.md` | `convertor.*` (DOCX through PDF) |
| `render --to video` | `.pptx` `.ppt` | `convertor.ppt2video` |
| `extract --to json` | `.pdf` `.pptx` `.docx` `.key`, http(s) URL | `document.extract` |
| `extract --to assets` | `.pdf` `.pptx` `.docx` `.key`, http(s) URL | `document.extract` |
| `convert --to markdown` | `.pdf` `.pptx` `.docx` `.key`, http(s) URL | `document.convert` |

Rendering a URL needs a server that lists it; until then save the page as `.html` and render the
file. Spreadsheets and Pages/Numbers documents are probe-only in this version.

## Render options

- `--pages 1-3,7` keeps those pages. The cloud renders and bills every page.
- `--quality low|medium|high` picks size and encoding; `--width <px>` sets the long edge;
  `--scale <n>` multiplies the default size. PPTX renders at 1080, 1920 or 2560 and warns when it
  snaps a requested size.
- `--image-format png|jpg|webp`: `jpg` for PPTX/PPT, PDF and DOCX only; `webp` everywhere.
- Video takes none of these.

## Parse options (extract and convert)

| Option | Applies to |
| --- | --- |
| `--profile fast\|balanced\|quality` | PDF; `quality` costs more |
| `--password <pwd>` | encrypted PDF |
| `--no-images` | PDF |
| `--stay-image-area-rate <0-1>` | Keynote |

Changing parse options is a different parse: the cloud reuses a parse only for the same file
and the same options. A password-protected source is never reused.

## Convert options

- `--anchors` — PDF: per-element provenance comments in the Markdown.
- `--split-pages` — PPTX/Keynote: also one Markdown file per slide.
- `--strict` — fail instead of warning when the Markdown cannot be rendered.
- `--keep-remote-images` — link images by their signed URLs instead of downloading them.

An option that cannot apply to the input is a `usage_error` before anything is uploaded.

## Common options

`-o/--output`, `--from <ext>` (stdin), `--space <id>`, `--timeout <seconds>` (default 300, the
whole run), `--force`, `--api-key`, `--token`, `--api-base`, `--json`, `--quiet`.
