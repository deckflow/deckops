# DeckOps Cloud vs Local Boundary

This document explains how `DeckOps`, `DeckUse`, and hosted DeckFlow services fit together.

## Short Version

```text
DeckOps CLI = local command entry
DeckFlow Cloud = hosted execution and conversion engine
DeckUse = local open-source PPTX editing workflow
```

## What Runs Locally

The `deckops` command runs locally on a developer machine, in CI, or inside another automation environment.

Local responsibilities include:

- reading command arguments and configuration
- authenticating the user or automation token
- uploading input files
- creating remote DeckFlow tasks
- polling or streaming task status
- returning script-friendly output such as JSON

## What Runs In DeckFlow Cloud

Cloud responsibilities include:

- hosted rendering and conversion work
- long-running task execution
- account, space, or tenant permission checks
- billing, quota, and plan enforcement
- secure output storage and retrieval
- operational monitoring for backend jobs

This includes hosted conversion flows such as HTML to PPTX when they require managed rendering capacity.

## What Belongs In DeckUse Instead

Use `DeckUse` for local-first workflows:

- unpacking PPTX files into a workspace
- inspecting slides, shapes, text, and metadata
- applying deterministic structural edits
- rebuilding PPTX files locally
- working without a cloud account by default

`DeckUse` should not be presented as the hosted conversion engine, and `DeckOps` should not be presented as a fully local PPTX editor.

## GitHub Role

This repository should act as a developer product surface:

- trust entry
- documentation entry
- CLI and integration example entry
- feedback entry
- contributor entry

The repo should make the cloud-first model clear without implying that all hosted execution internals live here.

## Documentation Checklist

When adding or changing docs, keep these points explicit:

- what runs locally
- what requires DeckFlow Cloud
- what credential or token is required
- what output is created by a hosted task
- when `DeckUse` is the better tool
