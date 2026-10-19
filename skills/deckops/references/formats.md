# Formats and operations

`deckops formats --json` prints the installed CLI's matrix; the relevant `--help` lists live
flags. Every input below is parsed by DeckOps Cloud after it is uploaded.

| Input | Cloud parse task | Markdown | Notes |
| --- | --- | --- | --- |
| `.pdf` | `pdf.pdfParse` | Yes | `--profile`, `--password`, `--no-images`; `--anchors` on convert. |
| `.pptx` | `pptx.parse` | Yes; artifact views can split by slide | `--split-pages` on convert. |
| `.docx` | `docx.parseTextAndImage` | Yes | No DOCX-specific parse options. |
| `.key` | `keynote.parseTextAndImage` | Yes; artifact views can split by slide | `--stay-image-area-rate`; `--split-pages` on convert. |
| HTTP(S) URL | `html.getByURL` | Yes | `--mode source` or `runtime` (default). The cloud fetches the URL. |
| `.doc`, `.ppt`, `.xls`, `.xlsx`, `.pages`, `.numbers` | Unsupported | Unsupported | Exit 3 with a hint, e.g. save as `.docx`/`.pptx`. |
| Artifact directory | Already parsed | Yes, by its IR reference | Never uploads the source; fails with `ir_expired` after 7 days. |

Artifacts written by DeckOps 2.x are refused with `input_error`; parse the source again with
`--force`.

## Parse options

| Option | Format | Values and notes |
| --- | --- | --- |
| `--profile` | PDF | `fast`, `balanced` (default), or `quality`. |
| `--password` | PDF | The PDF password. Never repeat or expose it in summaries or logs. |
| `--no-images` | PDF | Skips image extraction; use only when images cannot affect the task. |
| `--stay-image-area-rate` | Keynote | Number from 0 through 1. |
| `--mode` | URL | `source` (fetched page source) or `runtime` (rendered page, default). |

A parse option on the wrong format is a `usage_error` before anything is uploaded. Parse
options cannot be applied to an existing artifact; parse the source into a separate artifact
when a different parse is needed, so the previous result remains available.

## View options

| Option | Applies to | Notes |
| --- | --- | --- |
| `--to markdown` | Every input | Markdown is the only target in this version. |
| `--anchors` | PDF | Emits provenance comments carrying element identifiers. |
| `--split-pages` | PPTX and Keynote | Writes `001.md`, `002.md`, … beside `index.md` in an artifact view. |
| `--strict` | Every input | Fails the cloud render instead of degrading. |
| `--keep-remote-images` | Every input | Accepts expiring remote image links when a download fails; the result is not durable offline. |

## Claims about content

Use the IR fields and Markdown that exist. Do not promise that columns, floating objects,
cross-page tables, formulas, or charts were reconstructed when the output shows otherwise.
Convert serializes the IR to Markdown; export (returning a modified document in its source
format) is not implemented, so do not describe Markdown output as an exported document.
