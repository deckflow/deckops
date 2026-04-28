# Deckops CLI

Deckops CLI is a TypeScript command-line tool for Deckflow file processing workflows (compress, convert, extract, OCR, and task management).

[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)

## Features

- File upload + task creation for Deckflow backend
- Built-in task polling with timeout and non-blocking mode
- Browser-based login flow with local callback server
- Auto re-login on 401 and checkout flow on 402
- JSON output mode (`--json`) for automation scripts
- Interactive REPL mode for repeated operations

## Installation

Install globally:

```bash
npm install -g deckops
```

Or run from source in this repository:

```bash
npm install
npm run build
node dist/cli.js --help
```

> CLI executable name from this package is `deckops`.

## Quick Start

### 1) Login (recommended)

```bash
deckops login
```

This command opens a browser, receives the callback at `http://localhost:3737`, and saves credentials into local config.

### 2) Basic usage

```bash
# Compress
deckops compress presentation.pptx

# OCR
deckops ocr image.jpg --language en

# Convert PPTX to PDF
deckops convert slides.pptx --to pdf

# Join multiple PPTX files in order
deckops join part1.pptx part2.pptx part3.pptx

# List recent tasks
deckops task list --limit 10
```

## Commands

### Global options

```bash
deckops --json <command>
```

- `--json`: machine-readable JSON output

### Login

```bash
deckops login [--port <port>]
```

- Default callback port: `3737`

### Config

```bash
deckops config set-token <token>
deckops config set-space <space-id>
deckops config set-api-base <url>
deckops config show
```

### Task management

```bash
deckops task list [--type <type>] [--limit <n>] [--offset <n>]
deckops task get <task-id>
deckops task delete <task-id>
```

### Compress

```bash
deckops compress <input-file> [--no-wait] [--timeout <seconds>]
```

Supported input extensions:

- Document/archive: `.zip`, `.pptx`, `.key`, `.docx`, `.xlsx`
- Video: `.mp4`, `.avi`, `.mov`, `.mkv`

### OCR

```bash
deckops ocr <input-file> [--language <lang>] [--no-wait] [--timeout <seconds>]
```

- Default language: `zh-hans`
- Supported languages: `zh-hans`, `zh-hant`, `en`, `ja`, `ko`, `ar`, `de`, `es`, `fr`, `it`, `pt`, `ru`
- Supported input extensions: `.jpg`, `.jpeg`, `.png`

### Extract

```bash
deckops extract <input-file> [--type <type>] [--no-wait] [--timeout <seconds>]
```

- Extract types:
  - `fonts` -> `pptx.getFontInfo`
  - `text-shapes` -> `pptx.getTextShapes`
- Auto-detection currently supports `.pptx` (defaults to `pptx.getFontInfo`)

### Convert

```bash
deckops convert <input-file> --to <format> [--width <number>] [--height <number>] [--no-wait] [--timeout <seconds>]
```

Supported output formats:

- `image`: `.ppt`, `.pptx`, `.pdf`, `.key`
- `pdf`: `.ppt`, `.pptx`, `.doc`, `.docx`, `.key`
- `video`: `.ppt`, `.pptx`
- `html`: `.key`
- `png`: `.html`, `.md`
- `pptx`: `.ppt`, `.html`
- `webp`: `.jpg`, `.jpeg`, `.png`

Notes:

- `--width` / `--height` only apply to **HTML -> PPTX** conversion (`.html --to pptx`) and will be sent to the backend as task params.

### Join (pptx)

```bash
deckops join <input-files...> [--name <name>] [--no-wait] [--timeout <seconds>]
```

Merges multiple `.pptx` files into a single deck using the `pptx.join` task. Files are merged in the order given on the command line, so the first file becomes the start of the merged deck.

- Requires at least **2** `.pptx` files
- All inputs must have the `.pptx` extension
- `--name` overrides the task name (defaults to the first input file's base name)

Example:

```bash
deckops join cover.pptx chapter-1.pptx chapter-2.pptx appendix.pptx
deckops join a.pptx b.pptx --name combined-deck --timeout 600
```

### Run explicit task type

```bash
deckops run <task-type> <input-files...> [--param <key=value>] [--no-wait] [--timeout <seconds>]
```

`--param` can be repeated and values are parsed as JSON when possible.

Example:

```bash
deckops run convertor.ppt2pdf demo.ppt --param quality="high"
deckops run some.task input.pdf --param retries=3 --param debug=true
```

### REPL

```bash
deckops repl
```

Inside REPL:

```bash
deckflow> config show
deckflow> task list
deckflow> exit
```

## Authentication behavior

- If `token` or `spaceId` is missing, most API commands will trigger login flow automatically.
- On backend `401`, client will auto prompt login and retry.
- On backend `402`, client will open browser checkout flow, then continue.

## Configuration

Config file path:

- `~/.deckops/config.json`

Common fields:

- `token`: auth token
- `spaceId`: workspace/space identifier
- `apiBase`: API base URL (default: `https://app.deckflow.com/v1`)
- `signURI`: optional sign-in URI field

Example:

```json
{
  "token": "your-auth-token",
  "spaceId": "your-space-id",
  "apiBase": "https://app.deckflow.com/v1"
}
```

## Development

Requirements:

- Node.js >= 18

Setup:

```bash
npm install
npm run build
npm run typecheck
npm run lint
npm test
```

Useful scripts:

- `npm run build`
- `npm run dev`
- `npm run test`
- `npm run test:unit`
- `npm run test:e2e`
- `npm run test:coverage`
- `npm run lint`
- `npm run format`
- `npm run typecheck`

## License

MIT

## Links

- [Changelog](./CHANGELOG.md)
- [Contributing](./CONTRIBUTING.md)
