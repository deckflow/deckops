# Formats and operations

Use `deckops formats --json` for the installed CLI's high-level matrix and the relevant
command's `--help` for live flags. The table below records the DeckOps 2.1.1 behavior that
matters when choosing a workflow.

| Input | Parse | Convert | Important limits |
| --- | --- | --- | --- |
| `.pdf` | Local or explicitly cloud | Markdown | Local parsing has no OCR and uses the balanced profile. Embedded images do not imply complete composite-figure rendering. |
| `.pptx` | Local or explicitly cloud | Markdown; artifact views can split by slide | Charts and SmartArt may be retained as opaque nodes without their full semantic models. |
| `.docx` | Local or explicitly cloud | Markdown | Tracked-change view is selected at parse time. OMML formulas may retain text and opaque source rather than layout-equivalent math. |
| `.key` | Cloud | Cloud Markdown; a v2 public IR can also use the local renderer | There is no local IWA parser. A local view of cloud-adapted IR is not automatically equivalent to a cloud view. |
| HTTP(S) URL | Local `source` or cloud `runtime` | Markdown | Source mode fetches static HTML without executing a browser. It is not a general remote Office/PDF downloader. |
| `.doc`, `.ppt`, `.xls`, `.xlsx`, `.pages`, `.numbers` | Unsupported | Unsupported | Another tool's ability to identify or inspect the format does not mean DeckOps can read its content. |
| v2 artifact | Already parsed | Local; cloud only with a valid remote reference | Conversion does not reparse, upload, or create a missing remote reference. |
| v1 artifact | Already parsed | Cloud-native path | It is not guaranteed to remain offline-convertible. Reparse the source to create v2 when possible. |

## Format-specific parse options

| Option | Format | Values and notes |
| --- | --- | --- |
| `--profile` | PDF | `balanced` works locally. `fast` and `quality` require cloud parsing in 2.1.1. |
| `--password` | PDF | Supplies the PDF password. Never repeat or expose it in summaries or logs. |
| `--no-images` | PDF | Skips image extraction; use only when images cannot affect the task. |
| `--page-furniture` | PDF | `off`, `drop`, or `extract`. |
| `--overlaid-text` | PDF | `auto`, `keep`, or `drop`. |
| `--tracked-changes` | DOCX | `final`, `original`, or `all`; it chooses a reading view and does not modify the Word file. |
| `--stay-image-area-rate` | Keynote | Cloud-only numeric threshold from 0 through 1. |
| `--mode` | URL | `source` for static fetch or `runtime` for cloud runtime parsing. |

Parse options cannot be supplied when converting an existing artifact. If a different parse
view is required, parse the source into a separate artifact so the previous result remains
available.

## View options

| Option | Applies to | Notes |
| --- | --- | --- |
| `--to markdown` | Every convertible artifact/source | Markdown is the only target in 2.1.1. |
| `--anchors` | PDF | Emits provenance comments carrying DeckIR node IDs. |
| `--split-pages` | PPTX and Keynote | Use artifact conversion for reliable per-page file materialization in 2.1.1. |
| `--strict` | Cloud Markdown renderer | This is not the local parse-quality or preflight switch. |
| `--keep-remote-images` | Cloud view | Accepts expiring remote image links; a result that uses them is not durable offline. |

`--fail-on-degraded` gates parse quality. `--preflight strict` gates the preliminary
container/metadata check. `convert --strict` gates the cloud Markdown renderer. Keep the
three decisions separate.

## Reading-order and semantic claims

The public DeckIR contains node hierarchy, `order`, source references, optional page and
bounding-box data, assets, and quality findings. Use fields that exist. Do not promise that
all columns, floating objects, cross-page tables, formulas, or charts have been reconstructed
when the format parser reports partial or opaque content.

Convert means serializing IR to Markdown. Export means returning a modified document in its
source format, which is not implemented in this version. Do not describe Markdown output as
an exported Office or PDF document.
