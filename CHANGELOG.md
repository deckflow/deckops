# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Task polling / detail 404**: `getTask`, SSE subscribe, and `deleteTask` now send `spaceId` as a query parameter when the client is configured with a space (same as `task list`), fixing backends that require space scope for `/tools/tasks/:id`.

### Changed

- **API errors**: When the response includes `X-RequestId` (or common variants), it is appended to the error text and exposed as `requestId` in `--json` error output for easier support/debugging. Also reads correlation ids from JSON error bodies (e.g. `requestId`) and from `AxiosHeaders.toJSON()` when plain header iteration misses values. `ctx.error` now accepts the caught error object so `APIError` metadata is preserved in `--json` mode.
- **API errors**: Response body is always printed for `APIError`—terminal mode shows a **Response body:** block (pretty JSON / text, truncated at 32k chars); `--json` adds `body` (parsed) and `bodyText` (formatted string).

### Added

- **New `create` command** for document generation (CLI verb; API task type remains `generation`)
  - Supports text-only or file-assisted generation
  - Requires at least one of `inputText` or input files
  - Supports up to 2 reference files
  - Supports extensions: `.html`, `.pdf`, `.docx`, `.pptx`, `.txt`, `.md`, `.mm`, `.xmind`, `.ipynb`
- **New `translate` command** for document translation
  - Supports extensions: `.docx`, `.pptx`, `.pdf`, `.xlsx`, `.key`
  - `engine`/`model` are optional with defaults
  - Default engine: `gemini`
  - If engine is omitted, default model is `gemini-flash`
  - If engine is provided and model omitted, default model is the first model under that engine
  - Validates engine-model compatibility and PDF-specific model matrix

## [0.4.0] - 2026-03-21

### Added

- **New `login` command** for interactive authentication
  - Opens browser automatically for login
  - Uses local callback server to receive token
  - Automatically saves token to configuration
  - Similar to npm/GitHub CLI login experience
  - Example: `deckflow login`

## [0.3.0] - 2026-03-20

### Added

- **New `ocr` command** for Optical Character Recognition
  - Dedicated command for extracting text from images
  - Supports 12 languages via `--language` parameter
  - Example: `deckflow ocr image.jpg --language en`

### Removed

- **`file` command removed**
  - File upload is now an internal operation
  - Users interact with higher-level commands (compress, ocr, convert, etc.)
  - File upload happens automatically when needed

### Changed

- **BREAKING CHANGE**: Configuration directory moved from `~/.tools-ui/` to `~/.deckops/`
  - Config file now located at `~/.deckops/config.json`
  - This provides a more intuitive and branded directory name
  - Users need to reconfigure or manually move their existing config file
- **BREAKING CHANGE**: `render` command renamed to `convert`
  - `--format` parameter renamed to `--to`
  - Example: `deckflow convert slides.pptx --to pdf` (previously `deckflow render slides.pptx --format pdf`)
- **BREAKING CHANGE**: OCR moved from `extract` to dedicated `ocr` command
  - Old: `deckflow extract image.jpg --type ocr --language en`
  - New: `deckflow ocr image.jpg --language en`
  - `extract` command now only supports `fonts` and `text-shapes` types
- **spaceId is now optional**
  - Only authentication token is required for configuration

### Migration Guide

If you have an existing configuration at `~/.tools-ui/config.json`, you can migrate it:

```bash
# Option 1: Move the entire directory
mv ~/.tools-ui ~/.deckops

# Option 2: Reconfigure with the CLI
deckflow config set-token YOUR_TOKEN
deckflow config set-space YOUR_SPACE_ID
```

## [0.2.0] - 2024-03-20

### Added

- **Complete TypeScript Implementation** - Full rewrite of Python deckflow-cli in TypeScript
- **Core Modules**
  - Configuration management with Zod validation
  - API client with axios and automatic retry
  - File uploader with multi-part concurrent uploads (p-limit)
- **CLI Commands** (16+ commands)
  - Config commands: `set-token`, `set-space`, `set-api-base`, `show`
  - File commands: `upload`
  - Task commands: `list`, `get`, `delete`
  - Business commands: `compress`, `extract`, `render`, `run`
  - Interactive: `repl`
- **Features**
  - Server-Sent Events (SSE) for real-time task updates
  - Multi-part concurrent file uploads (max 5 concurrent, 10MB chunks)
  - File deduplication based on MD5 hash
  - Auto-retry for network failures (429/5xx errors)
  - Progress indicators with ora
  - JSON output mode for all commands
  - REPL interactive mode
  - OSS and Local platform support
- **Testing**
  - 8 unit tests for Config module (100% coverage)
  - 12 unit tests for API Client module (100% coverage)
  - 5 unit tests for File Uploader module (100% coverage)
  - 19 E2E tests for CLI commands
  - Total: 44 tests, all passing
- **Documentation**
  - Comprehensive README with examples
  - API documentation
  - Contributing guidelines
  - Changelog

### Technical Details

- Built with TypeScript 5.3
- Uses Commander.js for CLI framework
- axios + axios-retry for HTTP client
- eventsource-parser for SSE support
- p-limit for concurrency control
- Vitest for testing
- tsup for building
- ESLint + Prettier for code quality

### Compatibility

- 100% feature parity with Python version 0.2.0
- Compatible configuration file format
- Compatible API requests and responses
- Node.js >= 18.0.0 required

## [0.1.0] - Initial Planning

- Project structure design
- Technology stack selection
- Implementation roadmap

---

[0.2.0]: https://github.com/user/deckflow-cli/releases/tag/v0.2.0
[0.1.0]: https://github.com/user/deckflow-cli/releases/tag/v0.1.0
