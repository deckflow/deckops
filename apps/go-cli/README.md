# deckops Go CLI

Go implementation of the Deckops CLI, using the local Go SDK in `sdks/go`.

## Build

```bash
go build -o deckops .
```

## Usage

```bash
deckops [--json] <command> [options]
```

The command surface mirrors `apps/node-cli`: `config`, `login`, `task`, `compress`, `extract`, `ocr`, `convert`, `join`, `create`, `translate`, and `run`.
