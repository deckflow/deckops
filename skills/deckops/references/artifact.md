# Artifact and provenance

## Version 2 layout

```text
artifact/
├── ir.json
├── manifest.json
├── probe.json              optional successful preflight report
├── assets/
└── views/markdown/
    ├── index.md
    └── 001.md ...          when split-page output applies
```

Keep the directory together. `ir.json` alone does not carry every asset, view, cache, and
inspection contract.

`manifest.json` records the source identity, parser and parameters, parse engine, quality,
assets, views, and an optional cloud remote reference. The manifest is written last, so a
registered output should exist; still verify files before delivery.

Version 1 artifacts contain cloud-native IR references and generally need their cloud path.
When the source exists, parse it again to create a v2 artifact rather than treating v1 as a
durable offline format.

## Parse and view reuse

A v2 parse can be reused when the artifact matches source bytes, engine, normalized parse
parameters, and a compatible parser version. This is artifact-local reuse, not a global cache.
Pre-1.0 PDF parsers also use minor-version compatibility. URL parses do not use the same
source-byte hash shortcut.

Views are cached by renderer and view parameters. DeckOps currently registers one Markdown
view configuration. Regenerating another configuration replaces `views/markdown/`; copy a
finished delivery elsewhere when several variants must be retained.

On a cache hit, `outputs[].bytes` can be zero even when the existing file is non-empty. Check
the file itself. In 2.1.1, a cached artifact view can also bypass materialization of a new
portable `-o` destination; use artifact conversion with `--force` and verify the target.

The public v2 `deckir.v1` can be rendered locally after the remote reference expires. A cloud
conversion requires a remote reference that exists and has not expired. Converting with
`--engine cloud` does not upload a purely local artifact or add a remote reference.

## Public IR fields

At the top level, use:

- `schemaVersion`, `format`, and `source` for identity.
- `producer` for actual parser engine/name/version.
- `document.metadata`, `pages`, `nodes`, and `assets` for content.
- `quality` for checks and coverage.

Nodes provide stable identity within this parsed source, hierarchy, order, text or runs,
optional page/bounds/z-order, `sourceRef`, extensions, issues, and optional opaque data.
Asset records preserve path, hash, size, media type, and sometimes source references.

Node IDs are derived from the source and parser locators, but do not promise stability after
the source changes or parser behavior changes.

## Preparing traceable material for retrieval

DeckOps does not create embeddings, a vector index, a retrieval service, or `chunks.jsonl` in
2.1.1. If the task needs downstream chunks, derive them from the artifact and retain this
minimum evidence:

| Evidence | Source |
| --- | --- |
| Source identity | `source.sha256`, `source.name`, artifact path |
| Schema and format | `schemaVersion`, `format`, manifest version |
| Node identity | `id`, `parentId`, `children`, `order` |
| Original location | `sourceRef`, plus `page` and `bbox` when present |
| Semantic relationships | Runs, hierarchy, table children, extensions, asset IDs/paths |
| Reliability | Document quality plus relevant node issues or opaque reason |

Group along node order and hierarchy, keep tables intact where practical, and carry heading
context into child chunks. Load only the nodes needed for the task rather than putting a
large complete IR into model context.

Never invent missing pages, coordinates, chart values, formula semantics, or asset content.
Remote/expiring image links and missing assets must remain visible as limitations of an
offline deliverable.
