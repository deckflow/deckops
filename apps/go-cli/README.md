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

### macOS first run (Gatekeeper)

Pre-built binaries are not signed with an Apple Developer ID. On first launch, macOS may block the binary with a message such as **"cannot be opened because the developer cannot be verified"**, or ask you to allow it under **System Settings → Privacy & Security**.

This is expected for unsigned CLI tools. Use one of the following before running `deckops`:

**Option A — remove the quarantine flag (recommended)**

If you downloaded the archive from a browser or see the security prompt after extracting it:

```bash
xattr -d com.apple.quarantine /path/to/deckops
```

If `deckops` is already in your `PATH` (for example `/usr/local/bin/deckops`):

```bash
xattr -d com.apple.quarantine "$(which deckops)"
```

**Option B — open once from Finder**

Right-click the `deckops` binary → **Open** → confirm **Open** in the dialog. After that, you can run it from the terminal as usual.

**Option C — build from source (no Gatekeeper prompt)**

See [Build from source](#build-from-source) below. A binary compiled on your Mac is not quarantined.

> **Tip:** Installing via `curl … | tar -xz` (see example above) often avoids the quarantine flag. Browser downloads of the `.tar.gz` are more likely to trigger Gatekeeper.

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
