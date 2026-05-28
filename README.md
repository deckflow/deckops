# DeckOps

Cloud-first CLI for DeckFlow processing tasks.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

DeckOps is the developer-facing command line for running DeckFlow tasks in the cloud: create, translate, compress, convert, extract, OCR, and task orchestration.

It is designed for teams that want:

- a scriptable CLI for backend document processing
- asynchronous task management for large or long-running jobs
- cloud credentials that can be rotated, scoped, and audited
- a clear separation between local editing (`DeckUse`) and cloud execution (`DeckOps`)

## Project Positioning

`DeckOps` and `DeckUse` are sister projects with different responsibilities:

- `DeckOps`: cloud runtime, remote task execution, account or key-based access, operational workflows
- `DeckUse`: local runtime, open-source structural editing of PPTX workspaces, no cloud dependency by default

Use `DeckOps` when you need hosted processing capacity or team-managed backend workflows.

## Cloud vs Local

The `deckops` CLI runs on a developer machine or in CI, but its main job is to create and manage jobs in DeckFlow Cloud. This repository is the developer trust, documentation, integration, and contribution entry for that workflow.

The hosted rendering and conversion engine is delivered through DeckFlow Cloud. Use `DeckUse` when the job is local PPTX inspection, structural editing, or rebuilding without a cloud dependency.

See [docs/CLOUD_VS_LOCAL.md](docs/CLOUD_VS_LOCAL.md) for the product boundary between `DeckOps`, `DeckUse`, and hosted DeckFlow services.

## Features

- Upload files and create DeckFlow backend tasks
- Poll long-running jobs with timeout or non-blocking mode
- Authenticate with browser login flow or service credentials
- Return machine-readable JSON for automation scripts
- Re-login automatically on `401` and guide checkout flow on `402`
- Work interactively through a REPL for repeated operations

## Installation

Install globally:

```bash
npm install -g deckops
```

Run from source:

```bash
npm install
npm run build
node dist/cli.js --help
```

## Authentication Model

DeckOps is intended for cloud usage. That means credentials are part of the product surface, not an optional afterthought.

Supported CLI entry points today:

```bash
deckops login
deckops config set-token <token>
deckops config set-space <space-id>
deckops config set-api-base <url>
deckops config show
```

Recommended credential strategy:

- use browser login for individual developers
- use API keys or service tokens for CI, automation, and shared systems
- keep keys scoped to the minimum required capability
- rotate keys instead of sharing personal login credentials

See [docs/CLOUD_AUTH_MODEL.md](docs/CLOUD_AUTH_MODEL.md) for the recommended permission model and validation direction for this project.

## Quick Start

### 1. Authenticate

Interactive login:

```bash
deckops login
```

This opens a browser, receives the callback at `http://localhost:3737`, and stores credentials locally.

Headless setup:

```bash
deckops config set-token <token>
deckops config set-space <space-id>
```

### 2. Run a task

```bash
# Compress a deck
deckops compress presentation.pptx

# OCR an image
deckops ocr image.jpg --language en

# Convert PPTX to PDF
deckops convert slides.pptx --to pdf

# Generate from a text prompt
deckops create --input-text "请写一份产品发布会方案"

# Translate a document
deckops translate handbook.docx --from zh --to en --model Standard

# Merge multiple PPTX files
deckops join part1.pptx part2.pptx part3.pptx

# List recent tasks
deckops task list --limit 10
```

### 3. Use JSON mode in automation

```bash
deckops --json task get <task-id>
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
- Auto-detection currently supports `.pptx` and defaults to `pptx.getFontInfo`

### Convert

```bash
deckops convert <input-files...> --to <format> [--width <number>] [--height <number>] [--need-embed-fonts [boolean]] [--no-wait] [--timeout <seconds>]
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

- `--width` and `--height` apply only to `HTML -> PPTX` and `HTML -> PNG`
- `--need-embed-fonts` applies only to `HTML -> PPTX`
- Multiple input files are currently supported only for `HTML -> PPTX`

### Create

```bash
deckops create [input-files...] [--input-text <text>] [--enable-search [boolean]] [--advanced-model [boolean]] [--fast-mode [boolean]] [--intent <intent>] [--audience <audience>] [--page-count <number>] [--author <name>] [--no-wait] [--timeout <seconds>]
```

Rules:

- At least one of `--input-text` or input files is required
- Up to `2` reference files are allowed
- Supported file extensions: `.html`, `.pdf`, `.docx`, `.pptx`, `.txt`, `.md`, `.mm`, `.xmind`, `.ipynb`

### Translate

```bash
deckops translate <input-file> --from <language> --to <language> --model <Standard|Pro> [--use-glossary [boolean]] [--image-translate [boolean]] [--no-wait] [--timeout <seconds>]
```

Rules:

- Exactly one input file is required
- Supported file extensions: `.docx`, `.pptx`, `.pdf`, `.xlsx`, `.key`
- `--model` is required and must be `Standard` or `Pro`

### Join

```bash
deckops join <input-files...> [--name <name>] [--no-wait] [--timeout <seconds>]
```

- Requires at least `2` `.pptx` files
- Merges files in the order provided
- `--name` overrides the task name

### Run explicit task type

```bash
deckops run <task-type> <input-files...> [--param <key=value>] [--no-wait] [--timeout <seconds>]
```

## Repository Layout

```text
src/          CLI source code
tests/        Unit and e2e coverage
docs/         Product and auth documentation
```

Useful project documents:

- [CONTRIBUTING.md](CONTRIBUTING.md)
- [CHANGELOG.md](CHANGELOG.md)
- [LICENSE](LICENSE)
- [SECURITY.md](SECURITY.md)
- [docs/README.md](docs/README.md)
- [docs/CLOUD_AUTH_MODEL.md](docs/CLOUD_AUTH_MODEL.md)
- [docs/CLOUD_VS_LOCAL.md](docs/CLOUD_VS_LOCAL.md)
- [docs/ROADMAP.md](docs/ROADMAP.md)

## Development

```bash
npm install
npm run build
npm test
npm run typecheck
```

## Roadmap

- clarify API key scope definitions for hosted task types
- implement explicit server-side key validation and auditability guidance
- improve CI and automation examples for non-interactive usage
- expand examples for common developer workflows

更新日期：2026-05
