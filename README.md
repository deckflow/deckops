# DeckOps

> The open-source CLI and SDK for DeckOps Cloud: turn PDF, PPTX, DOCX, Keynote and web pages into Markdown and durable IR artifacts an agent can hold on to.

DeckOps is a thin client. Parsing, the IR, Markdown rendering and quality judgments all happen in DeckOps Cloud; the client uploads the source, waits for the task, stores what the server returns and downloads the images it references. **Every parse uploads the document to DeckFlow's cloud.**

```bash
deckops doc.pdf                    # Markdown on stdout
deckops doc.pdf --json             # content + run report
deckops doc.pdf -o doc.md          # portable Markdown + adjacent image assets
deckops parse doc.pdf              # durable artifact doc/ (server IR, manifest)
deckops convert doc/               # artifact → Markdown view, never re-uploads
deckops convert doc.pdf -o doc.md  # one-shot: parse + convert, no artifact kept
```

It is the **Parse** pillar of the [DeckFlow](https://github.com/deckflow) family: [DeckRender](https://github.com/deckflow/deckrender) turns documents into pixels, DeckOps turns them into state an agent can work with.

## Install

```bash
npx -y @deckflow/deckops@latest doc.pdf
npm install -g @deckflow/deckops
```

The CLI and Node.js entry require Node.js 22.18 or newer. Frontend applications use the [browser entry](#browser-sdk) of the same package.

## Log in

All parsing runs in DeckOps Cloud, so DeckOps needs an identity. Log in once:

```bash
deckops auth login
deckops auth status
deckops config list     # every credential, and exactly where it came from
```

Credentials live in `~/.deckflow/credentials` and are shared with every DeckFlow CLI. Each field resolves independently through flags → environment → file: `--api-key` / `DECKOPS_API_KEY` / `DECKFLOW_API_KEY`, and likewise `--token`, `--space` (`DECKOPS_SPACE_ID`) and `--api-base` (`DECKOPS_API_BASE`). `DECKFLOW_CONFIG_DIR` moves the shared directory; `DECKOPS_CONFIG_DIR` moves the product defaults (`~/.deckflow/deckops/config.json`), whose only setting is `deckops config set timeout <seconds>`. Without any credential the cloud treats a call as a guest with a small daily quota (`quota_error`); a rejected credential is an `auth_error`, never a silent guest.

## Three verbs

```
SOURCE    document → Markdown       default entry (read)
parse     document → IR artifact    durable, reusable
convert   artifact → Markdown view  never uploads or re-parses; a document is a one-shot
```

```bash
deckops report.pdf > report.md
deckops report.pdf --report run.json > report.md   # deckops.run.v2 report beside the content
deckops report.pdf --format ir --json               # the server IR instead of Markdown
deckops parse slides.pptx -o slides/
deckops convert slides/ --split-pages               # views/markdown/001.md …
deckops convert slides/ -o - --anchors              # Markdown to stdout
```

- **Read** parses into a cache artifact under `DECKOPS_CACHE_DIR` (default `~/.cache/deckops`), converts it, and prints only the content on stdout; warnings go to stderr. `-o FILE` writes `FILE` plus an immutable `FILE.assets-<id>/` directory; without `-o`, image links point at the cache. URL and password-protected sources are never reused by identity.
- **Parse twice, pay once.** Same source bytes and parse options → the artifact is reused with no request (`reusedParse: true`). `--force` parses again.
- **Convert never re-uploads.** It sends the artifact's `irKey` to the cloud renderer, downloads every image into `assets/` and rewrites the links, so the Markdown outlives the signed URLs. A failed image download fails the convert unless `--keep-remote-images`.
- **Interrupted runs resume.** If a parse task was created but its result never arrived (timeout, lost connection), `submission.json` records it and the next identical run waits for that task instead of submitting and paying again.
- **Cloud IR lives 7 days.** A parse after `expiresAt` parses again (with a warning); a convert after it fails with `ir_expired` before any request.

Options: `-o/--output`, `--from <ext>` (stdin), `--space <id>`, `--timeout <seconds>` (default 120, the whole operation), `--force`, `--api-key`, `--token`, `--api-base`, `--json`, `--quiet`. Parse: `--profile fast|balanced|quality`, `--password`, `--no-images` (PDF); `--stay-image-area-rate` (Keynote); `--mode source|runtime` (URL, default runtime). Convert: `--to markdown`, `--anchors` (PDF), `--split-pages` (PPTX/Keynote), `--strict`, `--keep-remote-images`. A flag that cannot apply to the input is a `usage_error` before anything is uploaded.

| Input | Parse task | Markdown | Notes |
| --- | --- | --- | --- |
| `.pdf` | `pdf.pdfParse` | ✅ | `--profile` `--password` `--no-images`; `--anchors` |
| `.pptx` | `pptx.parse` | ✅ | `--split-pages` |
| `.docx` | `docx.parseTextAndImage` | ✅ | |
| `.key` | `keynote.parseTextAndImage` | ✅ | `--stay-image-area-rate`; `--split-pages` |
| http(s) URL | `html.getByURL` | ✅ | `--mode source\|runtime` |
| `.doc` `.ppt` `.xls(x)` `.pages` `.numbers` | ❌ | ❌ | `unsupported` with a way out |

`deckops formats [--json]` prints the same matrix. `extract`, `modify` and `export` are reserved and exit with `not_implemented`.

## Artifact layout

```
doc/
├── ir.json            the server parse response, verbatim (irKey and irSchemaVersion at the top)
├── manifest.json      written last: registered ⇒ present
├── submission.json    only while a cloud task has no result yet
├── assets/            images downloaded by convert, named by persistent key
└── views/markdown/    index.md (+ 001.md … with --split-pages)
```

`manifest.json` is version 3: `source` (sha256, name, bytes; a URL records sha256 of the URL), `parse` (taskId, type, irKey, irSchemaVersion, params, createdAt, expiresAt = createdAt + 7 days), `views.markdown` (taskId, schemaVersion, params, files), `assets` (key, hash, bytes, mediaType) and `producer.deckops`. Artifacts written by DeckOps 2.x (manifest v1/v2) are refused with `input_error`; run `deckops parse <source> --force`.

## Coding agents

DeckOps ships an Agent Skill that teaches coding agents when to parse, when to reuse an artifact, and that a parse uploads the document.

```bash
deckops install --skills                    # into agent directories found in the project
deckops install --skills --agent claude -g  # user-level
deckops install --skills --dry-run --json
```

Upgrades protect managed files that were edited after installation; `--force` replaces them.

## `--json` and errors

```jsonc
// deckops parse doc.pdf --json
{ "ok": true, "op": "parse", "input": "doc.pdf", "type": "pdf.pdfParse", "format": "pdf",
  "taskId": "t_1", "irKey": "ir_1", "irSchemaVersion": "result.v3", "expiresAt": "2026-10-26T…",
  "reusedParse": false, "artifact": "doc", "outputs": [{ "file": "doc/ir.json", "bytes": 1 }],
  "warnings": [], "durationMs": 1 }
// deckops convert doc/ --json   (taskId is null for a cached view; content only with -o -)
{ "ok": true, "op": "convert", "input": "doc/", "to": "markdown", "format": "pdf",
  "taskId": "t_2", "parseTaskId": "t_1", "reusedParse": true,
  "outputs": [{ "file": "doc/views/markdown/index.md", "bytes": 1 }], "warnings": [], "durationMs": 1 }
// deckops doc.pdf --json
{ "schemaVersion": "deckops.read.v2", "ok": true, "format": "markdown", "content": "…",
  "outputs": [], "assets": [{ "path": "…", "lifecycle": "cache", "bytes": 1 }],
  "report": { "schemaVersion": "deckops.run.v2", "parseTaskId": "t_1", "convertTaskId": "t_2",
              "cacheHit": false, "artifactBase": "…", "warnings": [] } }
// any failure
{ "ok": false, "op": "parse", "error": { "code": "auth_error", "message": "…", "hint": "…", "taskId": "…" } }
```

| exit | `error.code` | meaning |
| --- | --- | --- |
| 2 | `usage_error` | bad or removed flag, or a flag that cannot apply to this input |
| 3 | `unsupported` | unsupported extension or `--to` target |
| 4 | `auth_error` | credential missing, rejected or expired |
| 5 | `input_error`, `ir_not_found`, `ir_expired`, `ir_schema_unsupported`, `ir_invalid`, `asset_error` | fixable by the caller — each carries a hint |
| 6 | `backend_error` | task failed or the API was unreachable; carries the taskId when one exists |
| 7 | `not_implemented` | reserved verbs (`extract`, `modify`, `export`) |
| 8 | `quota_error` | quota exhausted — `deckops auth login` |

The `--json` envelopes, error and exit codes, artifact layout and shared credential file are public contracts; changing any of them is a breaking change recorded in `CHANGELOG.md`. The backend-code table in `src/shared/errors.ts` and `src/errors/codes.ts` are the cross-language contract other SDKs follow.

## Node SDK

```ts
import { createClient, parse, read, openArtifact, DeckOpsError } from '@deckflow/deckops';

const { content } = await read('report.pdf');          // Markdown, nothing on stdout
const doc = await parse('report.pdf');                 // artifact report/
doc.taskId; doc.irKey; doc.irSchemaVersion; doc.expiresAt;
const ir = await doc.ir();                             // ir.json as the server returned it
await doc.convert({ anchors: true });                  // report/views/markdown/index.md

const same = await openArtifact('report/');            // later, in another process
await same.convert();                                  // cached view, or a new one while the IR lives

const client = createClient({ spaceId: 'space_1' });  // explicit values win over the credential chain
await client.convert('slides.pptx', { out: 'slides.md', splitPages: true });
await client.parseEnvelope('doc.pdf', { out: 'doc', force: true });   // the CLI's --json envelope
```

`createClient({ apiKey, token, spaceId, apiBase })` resolves the rest through the shared credential chain. Every call takes `signal`, `spaceId`, `timeout` (seconds) and `force`; `parse`/`read`/`convert` take the parse options (`profile`, `password`, `includeImages`, `stayImageAreaRate`, `mode`), `out` and `from`; `convert` adds `to`, `anchors`, `splitPages`, `strict`, `keepRemoteImages`; `read` adds `format`, `reportFile`, `cacheDir`, `anchors`. Unknown options — including the removed 2.x ones such as `engine` or `preflight` — are a `usage_error`, never silently ignored.

## Browser SDK

```ts
import { createClient } from '@deckflow/deckops/browser';

const client = createClient({
  apiBase: '/api/deckops',             // an authenticated same-origin proxy (recommended)
  // or: apiBase: 'https://app.deckflow.com/v1', token: userAccessToken,
  //     onUnauthorized: async () => refreshUserAccessToken(),
});

const controller = new AbortController();
const doc = await client.parse(file, {  // File from <input type="file">
  signal: controller.signal,
  timeout: 300,                         // seconds; bounds task waiting, not the upload
  onProgress(event) {
    if (event.phase === 'upload') console.log(event.progress);       // 0..1
    else console.log(event.phase, event.taskId, event.status);       // parse | convert
  },
});
const ir = await doc.ir();              // in-memory server response
const view = await doc.convert({ splitPages: true });
console.log(view.markdown, view.markdownPages, view.images);
await client.convert({ irKey: doc.irKey }, { strict: true });        // no upload, no re-parse
```

Inputs are `File`, `{ file: Blob | Uint8Array | ArrayBuffer, name }` or `{ url }`; paths, stdin, unnamed Blobs and Node options (`out`, `force`, …) are rejected before any request. `parse()` returns a `BrowserParsedDocument` (`taskId`, `spaceId`, `type`, `irKey`, `irSchemaVersion`, `ir()`, `convert()`). `convert()` returns `markdown`, optional `markdownPages`, `images` (signed, expiring URLs), `format`, `schemaVersion`, `taskId` and `reusedParse: true`; a `markdownError` rejects instead of returning placeholder content. Nothing is written to storage.

**Authentication.** Never put a server API key in browser code; the browser client has no `apiKey` option. Prefer a backend proxy: it keeps secrets server-side, preserves the upstream API paths (requests, the task event stream, uploads and downloads), checks the user, tenant and `spaceId` on every operation, and protects cookie-authenticated mutations against CSRF. Connect directly only with a short-lived, user-scoped token. A 401 calls `onUnauthorized` once; return a nonempty token for the same user. A failed refresh rejects with `auth_error` and never falls back to a guest identity.

**CORS for direct access.** Allow your origin on the API, the SSE stream, signed upload URLs, result downloads and image URLs; allow the `X-Auth-Token`, `X-Auth-UUID`, `Content-Type` and `response-event-stream` headers; expose `ETag` for multipart uploads. Local tests cannot certify a production deployment.

**Recovery.** Aborting stops requests and waiting but does not cancel a submitted cloud task. Keep the task id from `onProgress`; `client.getTask(id, { spaceId })` reports it and `client.convert({ taskId })` renders a completed parse without another upload. Task creation is never retried automatically; files of 4 MiB or more are uploaded first and referenced by id. Treat Markdown as untrusted input and sanitize it when rendering; persist images yourself if the Markdown must outlive the signed URLs. The entry is framework-independent ESM, safe to import during SSR, and needs Fetch, Web Crypto, Blob/File and AbortController.

## Development

```bash
pnpm install --frozen-lockfile
pnpm check           # skill, typecheck (Node + browser), tests, build, browser export, boundaries, CLI contract
pnpm check:package   # tarball ≤ 1 MiB, production install ≤ 12 MiB, `formats --json` cold start P95 ≤ 300 ms
pnpm browser:smoke   # open the printed localhost URL for real-browser checks

DECKOPS_API_BASE=… DECKOPS_TOKEN=… CONFORMANCE_PDF=sample.pdf pnpm conformance   # real backend, by hand
```

Tests run the SDK and the built CLI over real HTTP against a local wire-protocol fixture (`tests/browser/fake-cloud.mjs`); they verify the client contract, not cloud parsing quality. `check:boundaries` keeps document parsing out for good: no parser dependencies, no `local/`, `engine/`, `quality/`, `ir/` or `views/` source trees, no `node:` imports in `client/`, `cloud/`, `shared/` or `errors/`, no worker threads and no WebAssembly. `check-browser` holds the browser bundle to its gzip budget. The layering rules are in [`src/README.md`](src/README.md); the transport's provenance is in [`src/cloud/README.md`](src/cloud/README.md).

## License

Copyright (c) 2026 DeckFlow. DeckOps-owned code is licensed under the
[Apache License 2.0](LICENSE) (`Apache-2.0`) from 3.0.0 onward.

Previously published versions keep the license they were published under: 2.x under
`AGPL-3.0-only`, 1.x under MIT.
Third-party components retain their own licenses and notices; see
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
