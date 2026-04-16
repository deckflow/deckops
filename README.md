# Deckflow CLI

> Deckflow CLI helps you convert, extract, ocr from the command line.

[![Tests](https://img.shields.io/badge/tests-44%20passed-brightgreen)](tests/)
[![Coverage](https://img.shields.io/badge/coverage-100%25-brightgreen)](tests/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)

A powerful command-line tool for file processing, conversion, and task management.

## ✨ Features

- 🚀 **Fast File Processing** - Compress, extract, and convert files with ease
- 🔄 **Real-time Updates** - Server-Sent Events (SSE) for live task progress
- 📦 **Smart Uploads** - Multi-part concurrent uploads with automatic deduplication
- 🎯 **Type-Safe** - Full TypeScript implementation with comprehensive type definitions
- 🔁 **Auto-Retry** - Automatic retry logic for network failures (429/5xx errors)
- 📊 **JSON Output** - Machine-readable output for scripting and automation
- 💬 **Interactive REPL** - REPL mode for batch operations
- 🌈 **Beautiful UI** - Progress indicators and colored output

## 📦 Installation

```bash
npm install -g @deckflow/cli
```

Or use without installing:

```bash
npx @deckflow/cli <command>
```

## 🚀 Quick Start

### 1. Login

**Option A: Interactive Login (Recommended)**

```bash
# Open browser and login automatically
deckflow login
```

This will:
1. Open your browser to the login page
2. Wait for you to complete authentication
3. Automatically save the token to your configuration

**Option B: Manual Configuration**

```bash
# Set your authentication token manually
deckflow config set-token YOUR_TOKEN

# Optional: Set your workspace/space ID (defaults to 'UMYSELF')
deckflow config set-space YOUR_SPACE_ID

# Optional: Set custom API base URL
deckflow config set-api-base https://api.example.com

# View current configuration
deckflow config show
```

### 2. Basic Usage

```bash
# Compress a file
deckflow compress presentation.pptx

# Extract text from image (OCR)
deckflow ocr image.jpg --language en

# Convert PowerPoint to PDF
deckflow convert slides.pptx --to pdf

# List tasks
deckflow task list --limit 10

# Get task details
deckflow task get <task-id>
```

## 📖 Commands

### Login

```bash
deckflow login                         # Interactive login via browser
  --port <port>                        # Local server port (default: 3737)
```

This command:
- Opens your default browser to the login page
- Starts a local server to receive the authentication callback
- Automatically saves the token to your configuration

### Configuration Commands

```bash
deckflow config set-token <token>      # Set authentication token
deckflow config set-space <space-id>   # Set workspace ID
deckflow config set-api-base <url>     # Set API base URL
deckflow config show                    # Show current configuration
```

### Task Management

```bash
deckflow task list                      # List all tasks
  --type <type>                         # Filter by task type
  --limit <n>                           # Maximum results (default: 50)
  --offset <n>                          # Pagination offset (default: 0)

deckflow task get <task-id>             # Get task details
deckflow task delete <task-id>          # Delete a task
```

### Compress Files

```bash
deckflow compress <input-file>          # Compress a file
  --no-wait                             # Don't wait for completion
  --timeout <seconds>                   # Timeout in seconds (default: 300)
```

**Supported formats:**
- Documents: ZIP, PPTX, KEY, DOCX, XLSX
- Videos: MP4, AVI, MOV, MKV

### OCR (Optical Character Recognition)

```bash
deckflow ocr <input-file>               # Extract text from images
  --language <lang>                     # OCR language (default: zh-hans)
  --no-wait                             # Don't wait for completion
  --timeout <seconds>                   # Timeout in seconds (default: 300)
```

**Supported languages:**
`zh-hans`, `zh-hant`, `en`, `ja`, `ko`, `ar`, `de`, `es`, `fr`, `it`, `pt`, `ru`

**Supported formats:**
JPG, JPEG, PNG

### Extract Information

```bash
deckflow extract <input-file>           # Extract information from files
  --type <type>                         # Extract type: fonts, text-shapes
  --no-wait                             # Don't wait for completion
  --timeout <seconds>                   # Timeout in seconds (default: 300)
```

**Extract types:**
- `fonts` - Font information (PPTX)
- `text-shapes` - Text shapes (PPTX)

### Convert Files

```bash
deckflow convert <input-file>           # Convert file format
  --to <format>                         # Required: output format
  --no-wait                             # Don't wait for completion
  --timeout <seconds>                   # Timeout in seconds (default: 300)
```

**Output formats:**
- `image` - Convert to images (PPT, PPTX, PDF, KEY)
- `pdf` - Convert to PDF (PPT, PPTX, DOC, DOCX, KEY)
- `video` - Convert to video (PPT, PPTX)
- `html` - Convert to HTML (KEY)
- `png` - Convert to PNG (HTML, MD)
- `pptx` - Convert to PPTX (PPT, HTML)
- `webp` - Convert to WebP (JPG, JPEG, PNG)

### Run Custom Tasks

```bash
deckflow run <task-type> <input-files...>   # Run task with explicit type
  --param <key=value>                       # Task parameters (repeatable)
  --no-wait                                 # Don't wait for completion
  --timeout <seconds>                       # Timeout in seconds (default: 300)
```

**Example:**
```bash
deckflow run convertor.ppt2pdf presentation.ppt --param quality=high
```

### Interactive REPL

```bash
deckflow repl                           # Start interactive mode

# In REPL:
deckflow> config show
deckflow> compress presentation.pptx
deckflow> task list
deckflow> exit
```

## 🔧 Advanced Usage

### JSON Output for Scripting

All commands support `--json` flag for machine-readable output:

```bash
# Get configuration as JSON
deckflow --json config show

# List tasks as JSON
deckflow --json task list | jq '.tasks[0].id'

# Compress and get result as JSON
deckflow --json compress file.zip
```

### Batch Processing

```bash
# Process multiple files
for file in *.pptx; do
  deckflow compress "$file"
done

# Or use REPL mode
deckflow repl
```

### Non-blocking Operations

```bash
# Start task without waiting
deckflow compress video.mp4 --no-wait

# Check task status later
deckflow task get <task-id>
```

## 🏗️ Development

### Requirements

- Node.js >= 18.0.0
- npm or yarn

### Setup

```bash
# Clone repository
git clone <repository-url>
cd nodejs-deckflow-cli

# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Run with coverage
npm run test:coverage

# Development mode
npm run dev
```

### Project Structure

```
nodejs-deckflow-cli/
├── src/
│   ├── core/               # Core modules
│   │   ├── config.ts       # Configuration management
│   │   ├── api-client.ts   # API client with SSE
│   │   └── file-uploader.ts # File upload logic
│   ├── commands/           # CLI commands
│   ├── types/              # TypeScript types
│   ├── utils/              # Utilities
│   ├── context.ts          # CLI context
│   └── cli.ts              # Main entry
├── tests/
│   ├── unit/               # Unit tests
│   └── e2e/                # E2E tests
└── dist/                   # Build output
```

### Testing

```bash
# Run all tests
npm test

# Run unit tests only
npm run test:unit

# Run E2E tests only
npm run test:e2e

# Run with coverage
npm run test:coverage
```

**Test Coverage:**
- Config: 8 tests (100% coverage)
- API Client: 12 tests (100% coverage)
- File Uploader: 5 tests (100% coverage)
- E2E: 19 tests
- **Total: 44 tests, all passing**

## 🔑 Configuration

Configuration is stored in `~/.deckflow/config.json`:

```json
{
  "token": "your-auth-token",
  "spaceId": "your-space-id",
  "apiBase": "https://api.example.com/v1"
}
```

**Configuration options:**
- `token` - Authentication token (required)
- `spaceId` - Workspace/space ID (optional, default: `UMYSELF`)
- `apiBase` - API base URL (default: `https://app.deckflow.com/v1`)
- `signURI` - Sign-in URI (optional)

## 🐛 Troubleshooting

### "Not configured" error

Make sure you've set your authentication token:

```bash
deckflow config set-token <your-token>

# Optionally set space ID (defaults to 'UMYSELF')
deckflow config set-space <your-space-id>
```

### Task timeout

Increase timeout for large files:

```bash
deckflow compress large-file.mp4 --timeout 600
```

## 📄 License

MIT

## 🙏 Acknowledgments

This is a TypeScript port of the Python [deckflow-cli](../python-deckflow-cli), maintaining 100% feature compatibility while leveraging the Node.js ecosystem.

## 🔗 Links

- [Documentation](./docs/)
- [API Reference](./docs/api.md)
- [Changelog](./CHANGELOG.md)
- [Contributing](./CONTRIBUTING.md)
