# DeckOps

> Parse any document into an agent-operable representation.

DeckOps reads documents as **Markdown by default**, with quality evidence and policy-controlled upgrades. Explicit `parse` creates durable IR artifacts for repeated use.

```bash
deckops doc.pdf                  # Markdown only on stdout
deckops doc.pdf --json           # content + assessment + routing decision
deckops doc.pdf -o doc.md        # portable Markdown and adjacent image assets
deckops parse doc.pdf            # explicit durable IR artifact (doc/)
deckops convert doc/             # artifact → local markdown view, no re-parse/network
deckops convert doc.pdf -o doc.md  # one-shot: portable markdown, images localized
```

It is the **Parse** pillar of the [DeckFlow](https://github.com/deckflow) family: [DeckRender](https://github.com/deckflow/deckrender) turns documents into pixels, DeckOps turns them into state an agent can hold on to.

## Install

```bash
npx -y @deckflow/deckops@latest doc.pdf
```

```bash
npm install -g @deckflow/deckops
```

The CLI and Node.js entry require Node.js 22.18 or newer. Frontend applications use the separate cloud-only [browser entry](#use-it-in-the-browser).

Local PDF parsing uses `pdf-lite-parse@0.2.1` and exports embedded images without expensive composite-figure rasterization. Extractable overlay text is retained separately; visual fidelity losses are reported in `quality`. `--no-images` (SDK: `includeImages: false`) skips image export entirely.

Ordinary `npm install @deckflow/deckops` is now lightweight for PDF parsing: the parser embeds a pinned subset of PDF.js and its portable resources, with no separately installed `pdfjs-dist` or automatic canvas dependency. DeckProbe is pinned to the published 2.6.0 package; it uses its matching optional native CLI when available and falls back to WASM otherwise. To omit those as well and use the strict no-native installation:

```bash
npm install --omit=optional @deckflow/deckops
```

Embedded-image PDF parsing works in both installation modes without canvas. Use the cloud engine explicitly when full figure fidelity is needed. Applications calling `pdf-lite-parse` directly can explicitly install canvas for its opt-in composite mode; DeckOps does not enable it automatically.

## Content and upgrade policy

```bash
deckops report.pdf > report.md
deckops report.pdf --report report.run.json > report.md
deckops report.pdf --format ir --json
deckops report.pdf --engine auto --allow-upload
deckops capabilities --json
```

Plain stdout contains only the selected content; stderr carries actionable diagnostics.
`--json` returns one `deckops.read.v1` object. File output returns `content: null` and file receipts.
Use `-o report.md` for portable image links; redirected stdout refers to persistent local cache
assets under `DECKOPS_CACHE_DIR` (default `~/.cache/deckops`). Cache files remain until explicitly
removed. Independent exports use an adjacent `report.assets-<id>/` directory so failed rewrites
cannot damage a previous export's links. `--format ir -o FILE` is rejected; use `parse -o DIR`
for a portable IR bundle. `--quiet` on the default entry keeps content and actionable problems.

The Node SDK also exposes `read()`:

```ts
import { read } from '@deckflow/deckops';
const result = await read('report.pdf', { engine: 'local' });
console.log(result.content);
console.log(result.report.assessment, result.report.decision);
const structured = await read('report.pdf', { format: 'ir' });
```

SDK options do not inherit CLI product configuration. `cloudLimits` can bound source bytes/pages;
unverifiable page limits or monetary `maxCost` prevent submission. A timeout/unknown preflight
is never upload authorization. OCR/SmartArt/table repair capabilities are currently marked
unverified and do not automatically trigger paid attempts. Known alternate document parsing and
cloud-only formats use the declared API contract, followed by conservative candidate comparison.
Cloud failures retain a usable local candidate; an unresolved submission journal prevents automatic
resubmission. Existing artifact reads never upload the source. Source facts, heuristic quality
issues and unassessed dimensions remain distinct; no accuracy score is invented.

## Use from a coding agent

DeckOps ships an Agent Skill that teaches coding agents when to parse a source, when to reuse an artifact, how to preserve provenance, and how to report quality limits. Install it at project scope with:

```bash
deckops install --skills
```

Auto mode installs into agent directories already present in the project and falls back to `.agents/skills/deckops/`. Select a host or inspect the plan explicitly when needed:

```bash
deckops install --skills --agent codex
deckops install --skills --agent claude -g
deckops install --skills --dir /path/to/agent/skills
deckops install --skills --dry-run --json
```

The package and installer use the same files from [`skills/deckops/`](skills/deckops/). Upgrades protect managed files that were edited after installation and preserve other local files in the skill directory; `--force` explicitly replaces conflicting managed content. Installing the skill does not change DeckOps credentials, engine defaults, or document data.

## Two verbs, deliberately

```
SOURCE   document → Markdown        default content entry
parse    document → IR artifact     persistent IR workflow
capabilities  local/cloud registry  machine-readable upgrade capabilities
convert  IR artifact → view        --to markdown (v1); never re-parses the source
```

`deckops doc.pdf` is `parse`. The artifact it leaves behind is the point:

```
doc/
├── ir.json          public deckir.v1 document model
├── probe.json       optional local DeckProbe report (`--preflight validate|strict`)
├── assets/          images by persistent identity
├── manifest.json    source hash, parser identity, quality, optional cloud reference
└── views/markdown/  written by convert, never by parse
```

- **Local and private by default.** `--engine local` is the default, requires no login, and never constructs a cloud client. URL source mode only fetches the URL the user supplied and bounded redirects.
- **Parse twice, pay once.** Same bytes + engine + compatible parser version + options = instant artifact reuse. Compatibility uses the parser major, plus the minor for pre-1.0 PDF releases. `--json` reports `"engine": "artifact-cache"`.
- **Convert never re-parses.** Manifest v2 stores public `deckir.v1`; local artifacts remain convertible indefinitely. The 7-day lifetime only applies to an optional cloud `irKey`.
- **No silent fallback.** `--engine auto` upgrades only with upload authorization and a matching supported remedy. Authorization may come from flags, environment or user config; `--no-allow-upload` overrides it. `--fail-on-degraded` rejects the final result after candidate selection and output checks.

Local parsers enforce source, ZIP expansion/ratio, asset, XML depth/event, URL response, timeout and worker-heap limits. The main budgets can be raised explicitly with `--max-source-bytes`, `--max-expanded-bytes`, `--max-part-bytes`, `--max-asset-bytes`, `--max-total-asset-bytes`, `--max-zip-entries`, `--max-url-bytes` and `--worker-heap-mb`; overrides are recorded in the artifact cache identity.

## Supported formats

```bash
deckops formats
```

| Input | parse → IR | convert → markdown | flags |
| --- | --- | --- | --- |
| `.pdf` | ✅ local `deckir.v1` | ✅ local | no OCR; `--password`, `--page-furniture`, `--overlaid-text`, `--anchors` |
| `.pptx` | ✅ local | ✅ local | Chart/SmartArt preserved as opaque when partial; `--split-pages` |
| `.docx` | ✅ local | ✅ local | `--tracked-changes final\|original\|all` |
| `.key` | ☁ cloud | ☁ cloud | local IWA parsing is intentionally unsupported |
| http(s) URL | ✅ local source / ☁ runtime | ✅ local | `--mode source\|runtime` |
| `.doc` `.ppt` `.xls(x)` `.pages` `.numbers` | ❌ | ❌ | clear error + a way out |

Unsupported pairs fail with a hint, never an approximation.

## Local preflight with DeckProbe

For local files and stdin, DeckOps validates the real document container before parsing it:

```bash
deckops parse report.pdf                       # validate is the default
deckops convert slides.pptx --preflight strict -o slides.md
deckops parse report.pdf --preflight off       # skip for latency/CSP compatibility
```

`validate` is the CLI, Node SDK and Browser SDK default. It rejects a malformed/container-mismatched document and an encrypted document without an applicable password; probe budget/runtime failures become warnings and parsing continues. `off` is the explicit performance/CSP escape hatch. `strict` is never implicit. URLs skip local preflight.

The bounded metadata probe records format/profile, extension agreement, encryption, macros, external relationships, embedded files, page/slide count, and presentation size when available. Macros, external relationships and embedded objects are warnings, not default blockers. A `partial` DeckProbe report is evaluated target by target—it is not treated as a damaged file.

Successful reports are stored verbatim as `probe.json`; their compact summary is registered in `manifest.json` and returned as `inspection`. DeckProbe does not render, execute content, perform OCR, or replace a malware scanner.

## Machine-readable output

```bash
$ deckops convert doc/ --json
{
  "ok": true,
  "op": "convert",
  "engine": "local",
  "format": "pdf",
  "taskId": null,
  "reusedParse": true,
  "outputs": [{ "file": "doc/views/markdown/index.md", "bytes": 48213 }],
  "warnings": [],
  "durationMs": 728
}
```

Errors carry a stable `error.code` and a distinct exit code:

| exit | `error.code` | meaning |
| --- | --- | --- |
| 2 | `usage_error` | bad flags, or a flag that cannot apply to this input |
| 3 | `unsupported` | unsupported extension or `--to` target |
| 4 | `auth_error` | credential rejected or expired |
| 5 | `input_error`, `ir_not_found`, `ir_expired`, `ir_schema_unsupported`, `ir_invalid`, `asset_error` | fixable by the caller — each carries a hint saying how |
| 6 | `backend_error` | task failed; includes the taskId for follow-up |
| 7 | `not_implemented` | reserved verbs (`extract`, `modify`, `export`) |
| 8 | `quota_error` | guest quota exhausted — `deckops auth login` |

## Engine and authentication

```bash
deckops parse report.pdf                         # local, never uploads
deckops parse report.pdf --engine cloud          # explicit upload authorization
deckops parse report.pdf --engine auto            # local only; suggests cloud if degraded
deckops parse report.pdf --engine auto --allow-upload
```

Authentication is only resolved when a cloud request is actually selected. Credentials live in `~/.deckflow/credentials` and are shared with every DeckFlow CLI — log in once through DeckOps, DeckRender or DeckHTML and the others pick it up:

```bash
deckops auth login
deckops config list     # every value, and exactly where it came from
```

Environment variables win over stored files: `DECKOPS_API_KEY` → `DECKFLOW_API_KEY` (and `DECKOPS_TOKEN` / `DECKOPS_API_BASE` / `DECKOPS_SPACE_ID` likewise). Each field resolves independently — when something authenticates oddly, `deckops config list` shows which file or variable is responsible.

Shared credentials and `auth-uuid` remain under `~/.deckflow` (`DECKFLOW_CONFIG_DIR`). Product defaults live separately at `~/.deckflow/deckops/config.json`; `DECKOPS_CONFIG_DIR` changes only that product directory. For example, `deckops config set engine local` and `deckops config set preflight strict` set CLI defaults. Explicit options override product environment variables, which override stored defaults.

After upgrading from DeckParse, run `deckops config migrate --dry-run`, inspect the reported paths and field names, then run `deckops config migrate`. This one-time operation merges only missing valid fields from `~/.deckparse/config.json` and the former tool's `~/.deckops/config.json`, preserves source files and existing target values, and never changes the shared UUID. Use `--from-parse <directory>` / `--from-tools <directory>` for custom legacy locations. Normal commands do not read these old directories or `DECKPARSE_*` variables. The old tools now use `decktools` / `DECKTOOLS_*`; they are not a dependency of this package.

**Where parsing happens:** CLI and Node SDK parsing is local by default for PDF, PPTX, DOCX and static URL source. Cloud parsing only happens after `--engine cloud` or `--engine auto --allow-upload`. The browser entry keeps its existing cloud parse/convert contract and does not bundle local parsers.

## Use it as a Node.js library

```ts
import { parse, openArtifact } from '@deckflow/deckops';

const doc = await parse('doc.pdf'); // local by default; preflight defaults to validate
doc.irKey;                          // undefined for a local artifact
doc.inspection;                     // local format/security/structure summary
await doc.inspectionReport();       // full DeckProbe schema-v2 report
await doc.convert();                // offline view materialized into the artifact
await doc.convert({ anchors: true }); // pdf: provenance comments carrying node ids

// Days or years later, in another process — no cloud call:
const same = await openArtifact('doc/');
await same.convert({ splitPages: true });
```

`extract`, `modify` and `export` are reserved verbs on the same handle — the roadmap runs Parse → Extract → Modify → Export → render-verified round trips.

## Use it in the browser

```bash
npm install @deckflow/deckops
```

```ts
import { createClient } from '@deckflow/deckops/browser';

const client = createClient({
  apiBase: 'https://app.deckflow.com/v1',
  token: userAccessToken, // user-scoped credential approved for browser use
  // onUnauthorized: async () => refreshUserAccessToken(),
});

// file is the File selected by an <input type="file">.
const controller = new AbortController();
const doc = await client.parse(file, {
  // preflight defaults to validate; use 'off' to avoid Worker/WASM startup
  signal: controller.signal,
  timeout: 300, // seconds; only bounds task waiting, not upload time
  onProgress(event) {
    if (event.phase === 'upload') console.log(event.progress); // 0..1
    else if (event.phase === 'preflight') console.log(event.status);
    else console.log(event.taskId, event.status); // available after submission
  },
});

const ir = await doc.ir(); // in-memory server response; no filesystem access
const view = await doc.convert();
console.log(view.markdown, view.images);

// The source is not uploaded or parsed again.
await client.convert({ irKey: doc.irKey }, { strict: true });
```

Inputs are `File`, `{ file: Blob | Uint8Array | ArrayBuffer, name: string }`, or `{ url: 'https://…' }`. Bare paths, stdin, unnamed Blobs and Node-only options such as `out`/`force` are rejected before any request. PDF parse options (`profile`, `password`, `includeImages`), Keynote's `stayImageAreaRate`, URL `mode`, and Markdown options (`anchors`, `splitPages`, `strict`) keep their Node names. Format-specific flags are checked when the input/document format is known.

`parse()` returns a `BrowserParsedDocument` with `taskId`, `type`, `irKey`, `irSchemaVersion`, `ir()`, `convert()`, optional `inspection`/`inspectionReport()`, and preflight `warnings`. For local files, browser preflight defaults to `validate`, runs in a packaged module Worker and loads DeckProbe's WASM on first use; `off` avoids that startup. URL input skips it. Conversion returns `BrowserConvertResult`: `markdown`, optional `markdownPages`, `images`, `format`, `schemaVersion`, `taskId` and `reusedParse: true`. It does **not** return local paths, create artifact directories, cache documents between calls, or download all images. A `markdownError` is an error, never successful placeholder content.

### Authentication and deployment

- Do not put a server API key in browser code or a frontend environment variable. The browser client deliberately has no `apiKey` option. Direct cloud access requires credentials and permissions intended for browser users; issuing short-lived/scoped credentials is a backend responsibility, not a feature this SDK creates.
- If your application uses a secret API key or an existing login cookie, use an authenticated backend proxy and pass `apiBase: '/api/deckops'`. The proxy must preserve the upstream API paths, authorize each operation/space, protect cookie-authenticated mutations against CSRF, and keep secrets server-side. Omitting `token` is appropriate only for such a proxy or intentionally permitted guest access. The SDK does not add a backend service.
- A 401 may refresh through `onUnauthorized` once. Return a nonempty token string for the same user; account/default-space changes require an explicit new client. Failed refreshes reject with `auth_error`; they never switch to a guest identity/space. Task-creation POSTs are not automatically replayed on ambiguous network failures or gateway errors. Files of at least 4 MiB are uploaded first and referenced by `fileId`; that reduces large request failures but is not a server-side idempotency guarantee.
- For direct access, configure CORS for the API, event stream, signed upload endpoints, result downloads and image assets. Allow the methods/headers actually used, including `X-Auth-Token`, `X-Auth-UUID`, `Content-Type` and `response-event-stream`; multipart uploads need `Access-Control-Expose-Headers: ETag`. API credentials must not be forwarded to signed storage URLs. Production permissions/CORS must be verified for your deployment; localhost tests cannot certify them.

### Cancellation, recovery and result lifetime

Every browser parse/convert accepts `signal`, `onProgress`, `timeout` (seconds), `useEventStream` and `pollInterval` (milliseconds). Upload progress reports completed upload work, not a guaranteed continuous byte-level progress stream; small inline uploads report completion after the request succeeds. Aborting stops the client's HTTP requests, uploads and waiting; it does **not** cancel or refund a cloud task that was already submitted. An aborted call preserves the signal's abort reason (normally `AbortError`). Do not automatically call `parse()` again after an uncertain submission failure.

Keep the task id from `onProgress`. Other operation errors use `DeckOpsError` with stable `code`, `hint` and, once known, `taskId`:

```ts
const task = await client.getTask(savedParseTaskId);
if (task.status === 'completed') {
  // Retrieve a view of the completed parse without another upload/parse.
  const view = await client.convert({ taskId: task.id });
}
```

Operations may specify `spaceId` without changing the client's default; document handles keep their parse space for later conversions. When recovering an operation in a different space, pass that same `spaceId` to `getTask()` and to a subsequent by-reference `convert()`.

Cloud IR references currently have a 7-day retention period; `doc.ir()` retaining a local snapshot does not extend it. Image `ref` values are signed, expiring URLs for temporary preview, not permanent links. Persisting/offline-exporting assets is an explicit application concern. Treat document content as untrusted and sanitize rendered Markdown/HTML in your display layer.

The browser entry is framework-independent ESM and safe to import during SSR. It targets modern browsers with Fetch, Web Crypto, Blob/File and AbortController; use HTTPS (localhost is suitable for development). It still uploads documents for cloud parsing — browser support does not mean offline/on-device parsing.

## Development

```bash
pnpm install
pnpm check          # typecheck + unit + integration + build
pnpm check:browser  # DOM-only types + HTTP integration + browser export checks
pnpm browser:smoke  # open the printed localhost URL for real-browser checks

# conformance drives the built CLI against a real backend:
DECKOPS_API_BASE=… DECKOPS_TOKEN=… \
CONFORMANCE_PDF=sample.pdf CONFORMANCE_PPTX=sample.pptx pnpm conformance
```

The browser distribution includes its DeckProbe module Worker and WASM asset; consumers need no Node polyfills, bundler aliases or dependency patches. The cloud transport and its regression tests are owned by this repository. Source builds have no dependency on the legacy tool SDK or a sibling checkout; use `pnpm install --frozen-lockfile` for reproducible builds. See [cloud implementation provenance](src/cloud/README.md).

Browser tests use a local fake API and mostly synthetic bytes; they verify transport contracts, not cloud document parsing quality or production CORS. `pnpm browser:smoke` also probes a real local PDF through the packaged Worker/WASM, and serves its page and API on separate localhost origins to exercise preflight, signed uploads and response-header visibility in a real browser.

The `--json` envelope, error codes, exit codes, artifact layout and the shared credential file format are public contracts. Changing any of them is a breaking change; note it in `CHANGELOG.md`.

## License

Copyright (c) 2026 DeckFlow. DeckOps-owned code is licensed under the
[GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`).

This change applies to the source tree from the license-change commit onward
and releases starting with 2.0.0. Previously published versions, including 1.1.1, retain
their original MIT license; this change does not revoke permissions already granted.

Third-party components retain their own licenses and copyright notices. See
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES) and the licenses accompanying those
components, including the PDF.js resources embedded in `pdf-lite-parse`.
The DeckOps license does not replace or remove those notices.

Source and build instructions are available in this repository; use the tag or
commit corresponding to the version you distribute. When distributing or
operating a modified network-accessible version, follow the applicable
corresponding-source requirements in AGPL-3.0, including section 13.

## Lightweight quality and paid cloud parsing

Local parsing extracts available content quickly. It does not run OCR or reconstruct
complex visual semantics. Default Markdown remains best-effort: quality limitations are
reported on stderr without turning them into execution failures. Agent integrations should
use `deckops SOURCE --json` (content plus report) or retain `--report RUN.json` and stderr.

`report.assessment.summary` includes known source/parsed pages, missing and failed pages,
searchable body text, suspected OCR pages, visual-risk pages and control-character counts.
Unknown source counts remain absent. Missing-page lists are capped at 1,000; the full count
and truncation flag remain available. `no_issue_detected` does not certify completeness.

`assessment.recommendation` may suggest paid cloud high-quality parsing even in local mode;
`decision` independently records whether policy permits execution. Local never uploads.
Automatic cloud submission still requires upload authorization, compatible parameters,
verified capabilities and configured limits. OCR, layout and other specialized remedies
without a verified service contract remain in the capability catalog as unverified;
a user may explicitly select cloud parsing without a promise that it repairs every defect.
Cloud output retains its own quality assessment. `--fail-on-degraded` remains opt-in.

Markdown preserves ordinary `&&` and literal code contents, and replaces unsupported C0/DEL
controls with U+FFFD plus diagnostics; original IR is retained. Output byte counts describe
actual files, including cache hits. Identical assets within an artifact's candidates and
selected result share immutable files through hard links where supported, with normal-file
fallback. Updates replace files atomically; do not edit artifact assets in place. Portable
exports remain independent copies. Global deduplication and old export cleanup are deferred.
