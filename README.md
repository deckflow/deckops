# DeckOps

> The open-source CLI and SDK for DeckOps Cloud: probe, render, extract and convert PDF, PPTX, DOCX, Keynote and web pages.

DeckOps has four atomic capabilities. **Probe** runs locally and free with the open-source [DeckProbe](https://github.com/deckflow/deckprobe) engine and never uploads. **Render**, **Extract** and **Convert** run in DeckOps Cloud: the client uploads the source once, waits for the task and fetches the result. **Those three upload the document to DeckFlow's cloud.**

```bash
deckops probe deck.pptx                     # local metadata and detection report; no login, no network
deckops render deck.pptx --to image         # slide images  deck/001.png …
deckops extract report.pdf --to json        # the structured document  report.json + report.assets/
deckops convert report.pdf -o report.md     # Markdown + report.assets/
deckops report.pdf                          # Markdown on stdout (= convert -o -)
```

The cloud parses a document once and reuses that parse for 7 days: converting and then extracting the same file in the same space is one parse and one charge, from any machine.

## Install

```bash
npx -y @deckflow/deckops@latest report.pdf
npm install -g @deckflow/deckops
```

The CLI and Node.js entry require Node.js 22.18 or newer. `@deckflow/deckprobe` is an optional dependency: installing with `--omit=optional` keeps every verb except `probe`, which then reports `unsupported` with the install command. Frontend applications use the [browser entry](#browser-sdk) of the same package; it has no probe.

## Log in

Render, extract and convert need an identity; probe never does. Log in once:

```bash
deckops auth login
deckops auth status
deckops config list     # every credential, and exactly where it came from
```

Credentials live in `~/.deckflow/credentials` and are shared with every DeckFlow CLI. Each field resolves independently through flags → environment → file: `--api-key` / `DECKOPS_API_KEY` / `DECKFLOW_API_KEY`, and likewise `--token`, `--space` (`DECKOPS_SPACE_ID`) and `--api-base` (`DECKOPS_API_BASE`). `DECKFLOW_CONFIG_DIR` moves the shared directory; `DECKOPS_CONFIG_DIR` moves the product defaults (`~/.deckflow/deckops/config.json`), whose only setting is `deckops config set timeout <seconds>`. Without any credential the cloud treats a call as a guest with a small daily quota (`quota_error`); a rejected credential is an `auth_error`, never a silent guest.

## Four verbs

| Verb | Produces | Inputs | Runs |
| --- | --- | --- | --- |
| `probe` | DeckProbe report (schema 2) | `.pdf` `.pptx` `.docx` `.xlsx` `.key` `.ppt` `.doc` `.pages` `.numbers` | local, free |
| `render --to image` | one image per page or slide | `.pptx` `.ppt` `.pdf` `.key` `.docx` `.html` `.md` (URL once the server offers it) | cloud |
| `render --to video` | a video | `.pptx` `.ppt` | cloud |
| `extract --to json` | the structured document | `.pdf` `.pptx` `.docx` `.key`, URL | cloud |
| `extract --to assets` | the document's images | `.pdf` `.pptx` `.docx` `.key`, URL | cloud |
| `convert --to markdown` | Markdown | `.pdf` `.pptx` `.docx` `.key`, URL | cloud |

`deckops formats [--json]` prints this matrix from the route table itself. A combination that is not in it fails with `unsupported` and names the nearest ones that are.

```bash
deckops probe report.pdf --targets page_count,title --level metadata
deckops render deck.pptx --to image --pages 1-3,7 --quality high --image-format webp -o frames/
deckops render deck.pptx --to video -o deck.mp4
deckops extract report.pdf --to json -o -          # JSON on stdout
deckops extract slides.key --to assets -o images/
deckops convert slides.pptx --split-pages -o slides.md
deckops convert https://example.com/article -o article.md
```

- **Probe** is DeckProbe in-process (native binary when its platform package is installed, WebAssembly otherwise). It needs no login and sends no request, and its report is printed unchanged — `deckops probe --json` and `deckprobe --pretty` print the same JSON. Probe is not a preflight: the other verbs never call it.
- **Render** maps `--quality low|medium|high`, `--width` and `--scale` to what each task accepts (PPTX renders at 1080/1920/2560 and says when it snapped). The cloud renders every page; `--pages` selects which ones are kept, before any per-frame WebP conversion. DOCX is laid out as PDF first.
- **Extract** `--to json` returns the server's structured document with its `schemaVersion`; asset references are relative paths. `--to assets` lists the images without another parse.
- **Convert** returns Markdown. `--anchors` (PDF) adds per-element provenance comments, `--split-pages` (PPTX/Keynote) one Markdown file per slide, `--strict` fails instead of warning when rendering degrades.
- **Parse options** for extract and convert: `--profile fast|balanced|quality`, `--password`, `--no-images` (PDF); `--stay-image-area-rate` (Keynote). An option that cannot apply to the input is a `usage_error` before anything is uploaded. A password-protected source is never reused by the server and never remembered on disk.
- **One upload.** Uploads are verified by the server before a task uses them. `~/.cache/deckops/index.json` (`DECKOPS_CACHE_DIR`) remembers `sha256 → fileId` for three days, so repeated runs on the same bytes upload nothing.
- **Interrupted runs continue.** If a task was created but its result never arrived (timeout, lost connection, a failed download), the next identical run waits for that task instead of submitting and paying again. If the request left but no task id came back, DeckOps refuses to guess; `--force` submits anew.

Common options: `-o/--output` (`-` for stdout where the verb allows it), `--from <ext>` (stdin), `--space <id>`, `--timeout <seconds>` (default 300: the whole run, uploads and downloads included), `--force`, `--api-key`, `--token`, `--api-base`, `--json`, `--quiet`. Sources larger than 256 MiB are refused before they are read. `modify` and `export` are reserved and exit with `not_implemented`.

## Files on disk

```
report.md            convert -o report.md        links  report.assets/…
report.assets/       that document's images, replaced as a whole on every run
report-001.md …      convert --split-pages (same report.assets/)
report.json          extract --to json -o report.json   (+ report.assets/)
report/assets/…      extract --to assets (default directory <stem>/)
deck/001.png …       render; a single output is <stem>.<ext>, -o x.png with many frames gives x-001.png …
```

Without `-o`, `convert SOURCE` writes `<stem>.md` and `extract SOURCE --to json` writes `<stem>.json` beside the source; the bare `deckops SOURCE` prints Markdown with signed image links. Every download is checked against the md5 the server reported. Each document owns its `<stem>.assets/`, so many documents can be written into one directory.

## Coding agents

DeckOps ships an Agent Skill that teaches coding agents to combine the verbs — probe first, then extract, convert or render — and that only probe stays on the machine.

```bash
deckops install --skills                    # into agent directories found in the project
deckops install --skills --agent claude -g  # user-level
deckops install --skills --dry-run --json
```

Upgrades protect managed files that were edited after installation; `--force` replaces them.

## `--json` and errors

```jsonc
// deckops render deck.pptx --to image --json
{ "ok": true, "op": "render", "input": "deck.pptx", "to": "image",
  "tasks": [{ "type": "convertor.ppt2image", "id": "t_1" }],
  "outputs": [{ "file": "deck/001.png", "bytes": 1, "page": 1, "width": 1920, "height": 1080 }],
  "pages": 12, "warnings": [], "durationMs": 1 }
// deckops convert report.pdf -o - --json   (content only with -o -)
{ "ok": true, "op": "convert", "input": "report.pdf", "to": "markdown",
  "tasks": [{ "type": "document.convert", "id": "t_2" }], "outputs": [],
  "format": "pdf", "pages": 12, "reusedParse": false, "content": "# …", "warnings": [], "durationMs": 1 }
// deckops extract report.pdf --to json -o report.json --json
{ "ok": true, "op": "extract", "input": "report.pdf", "to": "json",
  "tasks": [{ "type": "document.extract", "id": "t_3" }],
  "outputs": [{ "file": "report.json", "bytes": 1 }, { "file": "report.assets/p1_i0000.png", "bytes": 1 }],
  "format": "pdf", "pages": 12, "reusedParse": true, "schemaVersion": "result.v3", "warnings": [], "durationMs": 1 }
// any failure
{ "ok": false, "op": "convert", "error": { "code": "quota_error", "message": "…", "hint": "…", "taskId": "…" } }
```

`deckops probe --json` prints the DeckProbe report itself, and the error envelope only on failure.

| exit | `error.code` | meaning |
| --- | --- | --- |
| 2 | `usage_error` | bad or removed flag, or an option that cannot apply to this input |
| 3 | `unsupported` | an input, target or combination the route table does not have, or a server without it |
| 4 | `auth_error` | credential missing, rejected or expired |
| 5 | `input_error`, `asset_error`, `ir_*` | fixable by the caller — each carries a hint |
| 6 | `backend_error` | task failed or timed out, or the API was unreachable; carries the taskId when one exists |
| 7 | `not_implemented` | reserved verbs (`modify`, `export`) |
| 8 | `quota_error` | quota or package balance exhausted |

The `--json` envelopes, error and exit codes, files on disk and the shared credential file are public contracts; changing any of them is a breaking change recorded in `CHANGELOG.md`. The backend-code table in `src/shared/errors.ts` and `src/errors/codes.ts` are the cross-language contract other SDKs follow.

## Node SDK

```ts
import { createClient, probe, isDeckOpsError } from '@deckflow/deckops';

const report = await probe('report.pdf', { targets: ['page_count'] });  // local; no client, no network

const ops = createClient();                         // credentials resolve on the first cloud call
const markdown = await ops.convert('report.pdf');   // { content, images, format, pages, reusedParse, tasks, … }
const json = await ops.extract('report.pdf', { to: 'json' });          // one upload, reused parse
const frames = await ops.render('deck.pptx', { to: 'image', pages: [1, 2], imageFormat: 'webp' });
await frames.outputs[0].blob();                     // signed URL, no credentials needed
```

`createClient({ apiKey, token, spaceId, apiBase })` resolves the rest through the shared credential chain. The SDK returns results with signed URLs and writes nothing; the CLI writes files. Inputs are paths, `{ file, name }` or `{ url }`. Every call takes `signal`, `spaceId`, `timeout` (seconds for the whole call, default 300), `onProgress`, `useEventStream` and `pollInterval`; `convert` adds `anchors`, `splitPages`, `strict`, `imageRefs: 'url' | 'path'`, and extract and convert take the parse options. `ops.tasks.get / wait / download` and `ops.files.upload` are the low level; a task reports `status`, `credits`, `consumedMS`, `createdAt` and `completedAt` as the server billed it. Unknown options — including removed ones such as `preflight` or `out` — are a `usage_error`, never silently ignored.

## Browser SDK

```ts
import { createClient, isDeckOpsError } from '@deckflow/deckops/browser';

const ops = createClient({
  apiBase: '/api/deckops',             // an authenticated same-origin proxy (recommended)
  // or: apiBase: 'https://app.deckflow.com/v1', token: userAccessToken, spaceId,
  //     onUnauthorized: async () => refreshUserAccessToken(), authUuid,
});

const controller = new AbortController();
const markdown = await ops.convert(file, {   // File from <input type="file">
  signal: controller.signal,
  timeout: 300,                              // seconds for the whole call
  onProgress(event) {
    if (event.phase === 'task') console.log(event.type, event.id, event.status);
    else console.log(event.phase, event.progress);                  // upload | download, 0..1
  },
});
markdown.content;                            // image links are signed URLs (imageRefs: 'url')
const json = await ops.extract(file, { to: 'json' });               // the same File is not uploaded again
json.content; json.schemaVersion; json.assets;
```

Inputs are `File`, `{ file: Blob | Uint8Array | ArrayBuffer, name }` or `{ url }`; paths, unnamed Blobs and Node options are rejected before any request, and so is any option the client does not know (`usage_error` naming it). Results carry `content`, `format`, `pages`, `reusedParse`, `warnings`, `tasks` (`{ type, id }`) and `outputs`; `images` / `assets` are the matching outputs, and `RemoteFile.blob()` fetches one. Progress events belong to the call that made them: `upload` (0–1, at once 1 when the file is reused), `task` (on creation and each status change, `completed` before `download`) and `download`.

**Authentication.** Never put a server API key in browser code; the browser client has no `apiKey` option. Prefer a backend proxy that checks the user, tenant and `spaceId` on every operation. Connect directly only with a short-lived, user-scoped token. A 401 calls `onUnauthorized` once (concurrent 401s share the refresh, and a request sent before it simply retries with the new token); return a nonempty token for the same user and the request is retried once, in its own space. A failed refresh rejects with `auth_error` and never falls back to a guest; requests that create tasks are never retried. The device id is `authUuid` when given, otherwise localStorage `df_uuid` (created when missing), sent as `X-Auth-UUID`; any 1–100 visible ASCII characters will do, so an app's own UUID or nanoid is reused.

**Errors and cancellation.** Failures are `DeckOpsError` (`code`, `message`, `hint`, `taskId`, `details`); `isDeckOpsError(error, 'quota_error')` narrows them, and a quota error carries the server's message and keeps its body in `details` for a top-up dialog. A timeout carries the task id and `details.reason === 'timeout'`. Aborting rejects with the signal's own `reason` (an `AbortError` `DOMException` without one) and does not cancel a submitted cloud task; `ops.tasks.get(id, { spaceId })` reports it later.

**CORS for direct access.** Allow your origin on the API (including `GET /tools/capabilities` and `PUT /files/:id/status/uploaded`), the SSE stream, signed upload URLs and result downloads; allow the `X-Auth-Token`, `X-Auth-UUID`, `Content-Type` and `response-event-stream` headers; expose `ETag` for multipart uploads. Treat Markdown as untrusted input. The entry is framework-independent ESM without Workers or WebAssembly, sends no request and touches no storage when imported, is safe to import during SSR, and needs Fetch, Web Crypto, Blob/File and AbortController.

## Development

```bash
pnpm install --frozen-lockfile
pnpm check           # skill, typecheck (Node + browser), tests, build, browser export, boundaries, CLI contract
pnpm check:package   # tarball ≤ 1 MiB; --omit=optional install ≤ 12 MiB; probe in the default install; cold start P95 ≤ 300 ms
pnpm browser:smoke   # open the printed localhost URL for real-browser checks

DECKOPS_API_BASE=… DECKOPS_TOKEN=… CONFORMANCE_PDF=sample.pdf pnpm conformance   # real backend, by hand
```

Tests run the SDK and the built CLI over real HTTP against a local wire-protocol fixture (`tests/browser/fake-cloud.mjs`); they verify the client contract, not cloud quality. `check:boundaries` keeps document interpretation out of the client: DeckProbe only as an optional dependency imported by `src/ops/probe.ts` alone (which may not reach the cloud, auth or config layers), a declarative route table, no `node:` imports in the isomorphic layers, no worker threads and no WebAssembly in `dist/`. The layering rules are in [`src/README.md`](src/README.md); the transport's provenance is in [`src/cloud/README.md`](src/cloud/README.md).

## License

Copyright (c) 2026 DeckFlow. DeckOps-owned code is licensed under the
[Apache License 2.0](LICENSE) (`Apache-2.0`) from 3.0.0 onward.

Previously published versions keep the license they were published under: 2.x under
`AGPL-3.0-only`, 1.x under MIT.
Third-party components retain their own licenses and notices; see
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES). The optional `@deckflow/deckprobe` engine is a separate
package under its own license.
