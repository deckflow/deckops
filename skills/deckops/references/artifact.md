# Artifact and provenance

## Layout

```text
artifact/
├── ir.json            the server parse response, verbatim
├── manifest.json      written last
├── submission.json    only while a cloud task has no result yet
├── assets/            images downloaded by convert
└── views/markdown/
    ├── index.md
    └── 001.md ...     with --split-pages
```

Keep the directory together. `ir.json` alone does not carry the views, images, and the cloud
reference needed for later conversion.

`manifest.json` (version 3) records:

- `source`: `sha256`, `name`, `bytes` of the uploaded source (a URL records the hash of the
  URL and 0 bytes).
- `parse`: `taskId`, `type`, `irKey`, `irSchemaVersion`, the normalized `params`, `createdAt`,
  and `expiresAt` (7 days later).
- `views.markdown`: the convert `taskId`, `schemaVersion`, view `params`, and `files`.
- `assets`: each downloaded image's persistent `key`, `hash`, `bytes`, and `mediaType`.

The manifest is written last, so a registered file should exist; still verify files before
delivery.

## Reuse

A parse reuses the artifact when the source bytes and normalized parse options match and the
IR has not expired: `reusedParse: true`, no upload, no charge. URLs are never reused by
identity, since the page may have changed. `--force` parses again.

A convert reuses `views/markdown/` when the view options match and every registered file
exists: `taskId: null`. A different option set, `--force`, or an explicit `-o` renders again
from the stored IR reference and replaces `views/markdown/`; copy a finished delivery
elsewhere when several variants must be kept.

## The IR

`ir.json` is the server's response. Its top level carries `irKey` and `irSchemaVersion`; the
rest of the structure belongs to the cloud and the stated schema version, not to the CLI.
Read the fields that are present for the task; do not assume a field from another schema
version. DeckOps does not validate, normalize, or grade the IR on the client.

## Preparing traceable material for retrieval

DeckOps does not create embeddings, a vector index, or chunk files. If the task needs
downstream chunks, derive them from the artifact and keep at least:

| Evidence | Source |
| --- | --- |
| Source identity | `manifest.source.sha256`, `manifest.source.name`, artifact path |
| Parse identity | `manifest.parse.taskId`, `irKey`, `irSchemaVersion` |
| Location | page or slide numbers and element identifiers present in the IR or `--anchors` output |
| Assets | image paths under `assets/` and their manifest keys |
| Limits | warnings and any content you observed to be missing or reduced |

Follow the document's order and hierarchy, keep tables intact where practical, and carry
heading context into child chunks. Load only the parts of a large IR the task needs. Never
invent missing pages, coordinates, chart values, formula semantics, or image content.
