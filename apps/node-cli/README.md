**Languages:** English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [Français](README.fr.md) | [Español](README.es.md) | [Русский](README.ru.md) | [日本語](README.ja.md)

# deckops CLI

Deckops is the command-line tool for [Deckflow](https://app.deckflow.com). Use it to upload files, create async tasks, and check task status.

## Requirements

- Node.js >= 18
- A valid Deckflow account and workspace (space)

## Installation

```bash
npm install -g deckops
deckops --help
```

## Quick start

Deckops will guide you through authentication and workspace setup when a command needs it.

```bash
deckops convert slides.pptx --to pdf
```

## Global options

| Option | Description |
|--------|-------------|
| `--json` | Output results as JSON (ideal for scripting) |
| `--version` | Show version number |
| `--help` | Show help information |

Examples:

```bash
# List tasks in JSON mode
deckops --json task list --limit 5

# View version
deckops --version

# View help for a subcommand
deckops convert --help
```

## File compression

### `compress <input-file>`

Compress Office documents, videos, or zip files. Task type is selected automatically based on file extension.

Supported formats: `.zip`, `.pptx`, `.key`, `.docx`, `.xlsx`, `.mp4`, `.avi`, `.mov`, `.mkv`

| Option | Description |
|--------|-------------|
| `-o, --out <path>` | Write task result to a file or directory |
| `--no-wait` | Do not wait for completion after creating the task |
| `--timeout <seconds>` | Wait timeout (default 300 seconds) |

```bash
# Compress a PPT presentation
deckops compress presentation.pptx

# Compress video and save result
deckops compress demo.mp4 -o ./output/compressed.mp4

# Create task only, do not wait
deckops compress large.pptx --no-wait
```

## Information extraction

### `extract <input-file>`

Extract fonts, text shapes, and other information from a file.

| Option | Description |
|--------|-------------|
| `--type <type>` | Extraction type: `fonts`, `text-shapes` |
| `-o, --out <path>` | Save result |
| `--no-wait` | Do not wait for completion |
| `--timeout <seconds>` | Timeout in seconds |

```bash
# Auto-extract font info from pptx
deckops extract slides.pptx

# Explicitly extract text shapes
deckops extract slides.pptx --type text-shapes

# Extract and save to directory
deckops extract slides.pptx --type fonts -o ./extracted/
```

## OCR text recognition

### `ocr <input-file>`

Perform OCR on images. Supports `.jpg`, `.jpeg`, `.png`.

| Option | Description |
|--------|-------------|
| `--language <lang>` | Language (default `zh-hans`) |
| `-o, --out <path>` | Save result |
| `--no-wait` | Do not wait for completion |
| `--timeout <seconds>` | Timeout in seconds |

Supported languages: `zh-hans`, `zh-hant`, `en`, `ja`, `ko`, `ar`, `de`, `es`, `fr`, `it`, `pt`, `ru`

```bash
# Recognize Chinese image (default language)
deckops ocr scan.jpg

# Recognize English image
deckops ocr document.png --language en

# Recognize Japanese and save
deckops ocr receipt.jpg --language ja -o ./ocr-result.json
```

## Format conversion

### `convert <input-files...> --to <format>`

Convert files to the specified format.

| Option | Description |
|--------|-------------|
| `--to <format>` | Output format (required): `image`, `pdf`, `video`, `html`, `png`, `pptx`, `webp` |
| `--width <number>` | Width for HTML → PPT/PNG |
| `--height <number>` | Height for HTML → PPT/PNG |
| `--need-embed-fonts [boolean]` | Whether to embed fonts for HTML → PPTX (default false) |
| `-o, --out <path>` | Save result |
| `--no-wait` | Do not wait for completion |
| `--timeout <seconds>` | Timeout in seconds |

**Multi-file note**: Only `html → pptx` supports multiple input files, merged in order into a single conversion task.

```bash
# PPT to PDF
deckops convert slides.pptx --to pdf

# Merge multiple HTML files into PPTX
deckops convert page1.html page2.html page3.html --to pptx

# HTML to PNG with dimensions and save
deckops convert slide.html --to png --width 1920 --height 1080 -o ./slide.png
```

## PPT merge

### `join <input-files...>`

Merge multiple `.pptx` files in the given order into one (task type `pptx.join`). At least 2 files required.

| Option | Description |
|--------|-------------|
| `--name <name>` | Task name |
| `-o, --out <path>` | Save result |
| `--no-wait` | Do not wait for completion |
| `--timeout <seconds>` | Timeout in seconds |

```bash
# Merge three presentations
deckops join intro.pptx body.pptx appendix.pptx

# Specify output task name and save
deckops join part1.pptx part2.pptx --name merged-deck -o ./merged.pptx

# Create task only
deckops join a.pptx b.pptx --no-wait
```

## AI content generation

### `create [input-files...]`

Generate document content from text or reference files (API task type `generation`).

| Option | Description |
|--------|-------------|
| `--input-text <text>` | Input text |
| `--enable-search [boolean]` | Enable search |
| `--advanced-model [boolean]` | Use advanced model |
| `--fast-mode [boolean]` | Fast mode |
| `--intent <intent>` | Generation intent |
| `--audience <audience>` | Target audience |
| `--page-count <number>` | Expected page count |
| `--author <name>` | Document author |
| `-o, --out <path>` | Save result |
| `--no-wait` | Do not wait for completion |
| `--timeout <seconds>` | Timeout in seconds |

Up to 2 reference files supported: `.html`, `.pdf`, `.docx`, `.pptx`, `.txt`, `.md`, `.mm`, `.xmind`, `.ipynb`

```bash
# Pure text generation
deckops create --input-text "Write a product launch plan"

# With reference file and page limit
deckops create outline.md --input-text "Expand into a full speech" --page-count 20

# Advanced model + search, and save result
deckops create brief.pdf --input-text "Generate a detailed report" --advanced-model --enable-search -o ./report/
```

## Document translation

### `translate <input-file>`

Translate document files. Supports `.docx`, `.pptx`, `.pdf`, `.xlsx`, `.key`.

| Option | Description |
|--------|-------------|
| `--from <language>` | Source language (required) |
| `--to <language>` | Target language (required) |
| `--model <model>` | Model (required): `Standard` or `Pro` |
| `--use-glossary [boolean]` | Use glossary |
| `--image-translate [boolean]` | Translate text in images |
| `-o, --out <path>` | Save result |
| `--no-wait` | Do not wait for completion |
| `--timeout <seconds>` | Timeout in seconds |

```bash
# Chinese to English (Standard model)
deckops translate handbook.docx --from zh --to en --model Standard

# English to Chinese, Pro model
deckops translate slides.pptx --from en --to zh --model Pro

# Auto-detect source language, enable glossary and save
deckops translate manual.pdf --from auto --to ja --model Pro --use-glossary -o ./translated.pdf
```

## Generic task execution

### `run <task-type> <input-files...>`

Execute with an explicit task type. Suitable for advanced usage or tasks not wrapped by the CLI.

| Option | Description |
|--------|-------------|
| `--param <key=value>` | Task parameters (repeatable; values support JSON) |
| `-o, --out <path>` | Save result |
| `--no-wait` | Do not wait for completion |
| `--timeout <seconds>` | Timeout in seconds |

**Multi-file note**: The following task types support multiple input files as an ordered source set: `pptx.join`, `convertor.html2pptx`, `html.buildPlayer`, `generation`.

```bash
# PPT to PDF (explicit task type)
deckops run convertor.ppt2pdf demo.ppt

# Merge PPT
deckops run pptx.join part1.pptx part2.pptx

# HTML to PPTX with parameters
deckops run convertor.html2pptx page1.html page2.html --param width=1920 --param needEmbedFonts=true
```

## Task management

### `task list`

List tasks in the workspace.

| Option | Description |
|--------|-------------|
| `--type <type>` | Filter by task type |
| `--limit <n>` | Maximum count (default 50) |
| `--offset <n>` | Pagination offset (default 0) |

```bash
# List 10 most recent tasks
deckops task list --limit 10

# Conversion tasks only
deckops task list --type convertor.ppt2pdf --limit 20

# Paginated JSON query
deckops --json task list --offset 50 --limit 50
```

### `task get <task-id>`

Get details for a single task.

| Option | Description |
|--------|-------------|
| `-o, --out <path>` | Download and save result of completed task |

```bash
# View task details
deckops task get abc123-task-id

# Download task result to file
deckops task get abc123-task-id -o ./result.pdf

# JSON mode
deckops --json task get abc123-task-id
```

### `task delete <task-id>`

Delete a specified task.

```bash
# Delete task
deckops task delete abc123-task-id

# JSON mode
deckops --json task delete abc123-task-id

# Confirm list after deletion
deckops task delete abc123-task-id && deckops task list --limit 5
```

## Interactive completion

In a TTY environment, if required arguments or options are missing, the CLI will attempt interactive prompts (not triggered when using `--json`). For example, when `--to` is missing, `convert` will guide you to choose an output format.

## Output and `-o` behavior

- Default: human-readable text + progress spinner
- `--json`: structured JSON for script parsing
- `-o, --out`: automatically download result after task completion
  - Single file → write to specified path
  - Multiple files → write to directory; if path ends with `.zip`, pack as zip
  - No file result → write JSON

When `-o` is specified, the CLI waits for task completion so it can download the result, even if `--no-wait` is also provided.

## FAQ

**Q: When is multi-file input valid?**

Only some tasks support ordered multi-source: `convert` for `html → pptx`, `join`, `create` (up to 2 reference files), and `run` for `pptx.join` / `convertor.html2pptx`, etc.

## Related links

- [Deckflow](https://app.deckflow.com)
- Issue tracker: [GitHub Issues](https://github.com/deckflow/deckops/issues)
