# Changelog

## @deckflow/deckops 1.0.0 — migration candidate, 2026-09-05

- Rename the product and its sole CLI to DeckOps / `deckops`; export `DeckOpsError` without a legacy alias. Historical entries below describe the former DeckParse package.
- Own the required cloud transport, DTOs and regression tests directly; remove the former SDK dependency and browser patch, with no replacement shared client package.
- Separate product defaults from shared credentials and UUID, and add an explicit, repeatable `config migrate` operation that preserves existing target values and source files.
- Keep DeckIR, manifest v1/v2, schema identity, parser identities and `producer.deckparse` unchanged.
- See `src/cloud/README.md` for source provenance and explicit transport deltas from the previous Node distribution.

## 1.0.0 — 2026-09-04

- Make the Node CLI/SDK local-first and offline by default for PDF, PPTX, DOCX and static HTML source; cloud use now requires `--engine cloud` or `auto --allow-upload`.
- Publish `deckir.v1` and manifest v2, with stable source-derived ids, content-addressed assets, deterministic quality checks and optional remote references.
- Add local Markdown rendering so v2 artifacts remain convertible without credentials, network access or cloud-retention limits; keep manifest v1 cloud conversion compatibility.
- Integrate `pdf-lite-parse@0.1.1` lazily and map result.v3 pages, nodes, assets and warnings without reimplementing PDF parsing.
- Add bounded OPC/XML DOCX/PPTX parsers, static HTML parsing, worker isolation, ZIP/XML/URL resource limits, tracked-change policy and opaque-object visibility.
- Remove `zod` from the runtime baseline; add package/install-size checks, a strict `--omit=optional` no-native path, third-party notices and Node.js 22.18 minimum.
- Keep `@deckflow/deckparse/browser` cloud-only and API-compatible.

## 0.2.0 — 2026-09-01

- Add DeckProbe preflight (`off | validate | strict`) before Node/browser uploads, defaulting CLI and both SDKs to fail-open `validate`, with target-level format, encryption, active-content, page/slide and presentation-size facts.
- Persist successful local reports as `probe.json`, register summaries in artifact manifests/envelopes, and expose `inspection` plus `inspectionReport()` on document handles.
- Ship a lazy browser module Worker and DeckProbe WASM asset; add real-browser PDF preflight coverage. Node.js now requires version 20 or newer.
- Add `@deckflow/deckparse/browser`: File, named Blob/binary and URL inputs; in-memory IR and Markdown results; reusable IR references.
- Add task progress/status lookup, abortable requests/upload/wait, fail-closed authentication refresh and no automatic replay of task-creation POSTs.
- Preserve envelope fields, credential resolution and cloud-cache semantics; `off` remains an explicit performance/CSP escape hatch and URL inputs always skip local preflight.
- Extract shared runtime-independent routing, parameter mapping, format validation and error translation.
- Add DOM-only type checks, self-contained browser distribution checks and localhost HTTP/real-browser conformance fixtures.
