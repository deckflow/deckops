# Changelog

## 0.2.0 — 2026-09-01

- Add DeckProbe preflight (`off | validate | strict`) before Node/browser uploads, defaulting CLI and both SDKs to fail-open `validate`, with target-level format, encryption, active-content, page/slide and presentation-size facts.
- Persist successful local reports as `probe.json`, register summaries in artifact manifests/envelopes, and expose `inspection` plus `inspectionReport()` on document handles.
- Ship a lazy browser module Worker and DeckProbe WASM asset; add real-browser PDF preflight coverage. Node.js now requires version 20 or newer.
- Add `@deckflow/deckparse/browser`: File, named Blob/binary and URL inputs; in-memory IR and Markdown results; reusable IR references.
- Add task progress/status lookup, abortable requests/upload/wait, fail-closed authentication refresh and no automatic replay of task-creation POSTs.
- Preserve envelope fields, credential resolution and cloud-cache semantics; `off` remains an explicit performance/CSP escape hatch and URL inputs always skip local preflight.
- Extract shared runtime-independent routing, parameter mapping, format validation and error translation.
- Add DOM-only type checks, self-contained browser distribution checks and localhost HTTP/real-browser conformance fixtures.
