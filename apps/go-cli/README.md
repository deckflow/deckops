# deckops Go CLI

Go implementation of the Deckops CLI, using the local Go SDK in `sdks/go`.

## Install

Pre-built binaries are published on [GitHub Releases](https://github.com/deckflow/deckops/releases). Look for assets named `deckops_<version>_<os>_<arch>.tar.gz` (or `.zip` on Windows).

Example (macOS Apple Silicon):

```bash
VERSION=0.7.0
curl -fsSL "https://github.com/deckflow/deckops/releases/download/go-cli/v${VERSION}/deckops_${VERSION}_darwin_arm64.tar.gz" \
  | tar -xz
sudo mv deckops /usr/local/bin/
deckops --version
```

Replace `darwin_arm64` with your platform:

| Platform | Asset suffix |
|----------|--------------|
| macOS (Apple Silicon) | `darwin_arm64` |
| macOS (Intel) | `darwin_amd64` |
| Linux (x64) | `linux_amd64` |
| Linux (ARM64) | `linux_arm64` |
| Windows (x64) | `windows_amd64.zip` |
| Windows (ARM64) | `windows_arm64.zip` |

Verify downloads with the `checksums.txt` file attached to the same release.

## Build from source

```bash
go build -o deckops .
```

## Usage

```bash
deckops [--json] <command> [options]
```

The command surface mirrors `apps/node-cli`: `config`, `login`, `task`, `compress`, `extract`, `ocr`, `convert`, `join`, `create`, `translate`, and `run`.

## Release (maintainers)

Push a tag to trigger the GitHub Actions release workflow:

```bash
git tag go-cli/v0.7.0
git push origin go-cli/v0.7.0
```

This builds macOS, Linux, and Windows binaries and uploads them to GitHub Releases.
