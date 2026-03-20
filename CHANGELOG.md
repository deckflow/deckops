# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
