# Changelog

## 2.4.1 — 2026-09-23 — Scoped PDF parser

- Depend on `@deckflow/pdf-lite-parse@0.2.1`, the new scoped name of the local PDF parser; the unscoped
  `pdf-lite-parse` package is deprecated. The parser code is unchanged, and so is the `pdf-lite-parse`
  producer name recorded in IR, so existing local PDF artifacts stay reusable.

## 2.4.0 — 2026-09-23 — PPTX lists and clean emphasis

- Read PPTX list structure in both engines: each paragraph's outline level and bullet are resolved
  through the OOXML inheritance chain (paragraph → shape list style → layout placeholder → master
  placeholder → master title/body/other style → presentation default) and recorded on text nodes as
  `extensions.paragraphs` (`start`/`end` offsets into `text`, `level`, `list: 'bullet' | 'number'`).
  Markdown renders them as nested `-` / `1.` lists; lead lines that switch bullets off stay plain.
  **Behavior change**: CommonMark list items go from 25 to 483 on the example lecture deck and from 8
  to 194 on a Chinese business deck. The cloud path reads the same chain from the presentation JSON;
  it needs a backend on `@deckflow/presentation` ≥ 0.3.7 to see `<a:buNone/>` (older backends render
  lead lines as list items).
- Emphasis Markdown that parses: adjacent runs with the same formatting are merged before marking
  (`**50****% ****的**** **` becomes `**50% 的** `), whitespace and edge punctuation that would stop
  a marker from closing move outside it, whitespace-only runs get no markers, and italic nests inside
  bold. The example decks go from 90 and 188 stray `**` in CommonMark output to 0.
- Headings: an empty title placeholder is no longer a heading (no more bare `##`), and a multi-paragraph
  title renders on one heading line instead of spilling its second line into body text.
- Cloud submission journal: `submission_unknown` is recorded only when the task-creation request is
  about to be sent. A failure while resolving the space or uploading no longer blocks every later
  parse. `--force` now resubmits over an unresolved submission, with a warning that the earlier task,
  if it was created, may be billed separately.
- Errors for requests that got no response name the host and request
  (`Cannot reach the DeckFlow API (GET https://…/v1/user): timeout of 30000ms exceeded`) and hint at
  the network or proxy, instead of `API Error (unknown): …`.
- Bump the local PPTX parser to `deckparse-pptx` 3, the cloud adapter to `deckflow-cloud` 3 for PPTX
  only (cloud PDF/DOCX artifacts stay reusable, so they are not re-billed) and the Markdown renderer to
  1.3.0.

## 2.3.0 — 2026-09-22 — PPTX slide layout

- Resolve group transforms in both PPTX engines: group children now carry slide coordinates
  (the child canvas `chOff`/`chExt` is mapped onto the group frame). Only rotated or flipped groups
  still report `group_transform_partial`; a 99-slide lecture deck drops from 339 such warnings to 38.
- Read slides in layout order instead of z-order: title first, then body/content placeholders, then
  other shapes top-to-bottom and left-to-right (rows judged against the taller shape), with furniture
  and position-less nodes last. Groups are ordered as units and their children in layout order.
  z-order stays available in `zIndex`. **Behavior change**: PPTX node `order` and Markdown order change.
- Type footer, date and slide-number placeholders as `footer` / `page_number`. Their text stays in the
  IR; Markdown no longer renders them, and no longer renders `page_number` nodes from any format.
  **Behavior change**: the example deck loses 92 repeated footer lines and 92 slide numbers.
- Cloud PPTX: carry bold, italic, underline and strike from the cloud text runs (runs are attached only
  when they reproduce the node text exactly), and report bounding boxes and slide sizes in points like
  the local parser instead of EMU. **Behavior change** for cloud bbox units.
- Bump the local PPTX parser to `deckparse-pptx` 2, the cloud adapter to `deckflow-cloud` 2 and the
  Markdown renderer to 1.2.0, so cached artifacts produced by the previous versions are not reused.

## 2.2.0 — 2026-09-20 — Cloud IR fidelity and honest quality

- Expand cloud tables into `table_row`/`table_cell` so Markdown renders them. The generic cloud
  walker emitted flat shape children that the renderer dropped, so a cloud-parsed table produced
  no Markdown at all.
- Type cloud PPTX title placeholders as headings and text-bearing shapes as text, matching the
  local parser. Cloud Markdown previously carried no heading structure whatsoever.
- Stop reading a shape's preset geometry path as an asset pointer and stop descending into
  `prstGeom`; the first raised spurious `cloud_asset_unavailable` checks for every freeform, the
  second created empty phantom nodes whose type merely contained "chart".
- Report `embedded_object_undetected` when preflight finds embedded objects that the result
  neither represents nor reports, comparing counted chart/SmartArt parts against represented
  nodes. **Behavior change**: such results now report `degraded` rather than `pass`, so
  `--fail-on-degraded` rejects them; they were previously delivered as clean.
- Fetch cloud parse assets concurrently with bounded retries, matching the convert path, instead
  of one serial pass that lost an image on any transient error. Link parse nodes through an index
  rather than a linear scan of every node built so far.

## 2.1.1 — 2026-09-09 — Lightweight quality and delivery fixes

- Summarize missing/failed pages, body text, OCR/visual risks and unsupported controls; expose
  paid cloud recommendations independently of local/auto/cloud execution policy.
- Preserve best-effort Markdown and optional strict gating; provide the same assessment in
  read, parse and convert, including cached artifacts. Local OCR remains unsupported.
- Fix command ampersands and code fencing, report control replacement without changing IR,
  respect disabled DOCX strike styles, and report actual output bytes on cache hits.
- Share immutable identical assets across candidates and selected artifacts, using atomic
  replacement and copy fallback. Invalidate affected DOCX parser and Markdown renderer caches.
- Update the bundled Agent skill to consume quality reports and keep upload choices explicit.
- Depend on the published DeckProbe 2.6.0 package; remove the temporary vendor archive and bundled dependency override.

- Ship a DeckOps Agent Skill with format, artifact, output, recipe, and limit references for traceable document-to-knowledge workflows.
- Add `deckops install --skills` with project/global/explicit targets, dry-run JSON receipts, managed-file hash protection, and preservation of local additions.
- Validate skill resources during checks and prepack, and verify installation from the production npm tarball.

## 2.1.0 — 2026-09-09

- Default bare CLI calls now return Markdown; add `read()` SDK, `--format ir`, JSON content envelopes and independent run reports.
- Introduce evidence-based assessments, a shared capability registry, policy provenance, negative overrides, candidate comparison and a final quality gate.
- Detect sparse raster PDF pages individually; unknown/unverified remedies and visual-only warnings do not automatically upload.
- Preserve local/cloud candidates, freeze local source bytes, propagate cancellation, journal uncertain submissions and disable mutation retries.
- Integrate DeckProbe 2.6.0 bounded preflight and exact SmartArt inventory; bundle the tested upstream release snapshot for independent installs.
- Keep stdout ownership in the CLI and preserve cache/export image lifetimes.

## @deckflow/deckops 2.0.0 — 2026-09-07

- License DeckOps-owned code under AGPL-3.0-only from this license-change commit onward. Preserve third-party licenses and notices; already published releases through 1.1.1 remain under their original MIT license.
- Use a new major version to make the license transition explicit. No parsing API or runtime dependency changes from 1.1.1.

## @deckflow/deckops 1.1.1 — 2026-09-07

- Upgrade to `pdf-lite-parse@0.2.1`, which embeds a fixed, allowlisted PDF.js runtime and resources instead of declaring a runtime `pdfjs-dist` dependency.
- Ordinary npm installations no longer pull in canvas for PDF parsing. Keep DeckProbe's independent optional platform CLI packages unchanged; `--omit=optional` remains available for a strict no-native installation.
- Add default-install PDF smoke tests and enforce smaller installed-size budgets plus absence of separate PDF.js/canvas packages.

## @deckflow/deckops 1.1.0 — 2026-09-07

- Upgrade the exact `pdf-lite-parse` dependency to 0.2.0. Local PDF parsing exports embedded images by default without expensive composite-figure rasterization; extractable overlay text and fidelity warnings remain visible.
- Pass `includeImages: false` through as `images: 'none'`, skipping image export instead of extracting then discarding assets.
- Record the actual upstream parser version in IR/manifests and invalidate pre-1.0 PDF parse caches across minor versions. Existing artifacts remain convertible.
- Retain offline operation, lazy PDF loading, resource isolation, and the strict no-native install path.

## @deckflow/deckops 1.0.0 — 2026-09-07

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
