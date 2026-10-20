# Browser SDK verification

The HTTP fixture models the SDK's real task, download, signed-upload, and SSE
endpoints. It does not mock the SDK or call a cloud service.

Run the automated protocol checks:

```sh
pnpm exec vitest run tests/browser/client.test.ts
```

Verify the shipped browser bundle in an actual browser:

```sh
pnpm build
node scripts/browser-smoke.mjs
```

Open the printed localhost URL and click **Run browser checks**. The page imports
`dist/browser/index.js` directly as an ES module, without a bundler, Node globals,
or browser automation dependency. A successful run displays `PASS — 17/17 browser
checks`. `DECKOPS_SMOKE_PORT` optionally fixes the server port.

The script serves the page and API on separate localhost ports so the checks
exercise real browser CORS enforcement, preflight requests, and exposed multipart
ETag headers. One additional check uses a relative same-origin proxy API root
without a browser token.

The checks cover File/named Blob/typed bytes/URL input, Markdown with signed image links,
one upload for convert then extract, upload verification, concurrent per-call spaces, SSE
progress and the polling fallback, signed and multipart uploads with exposed ETags, rendered
frames fetched as Blobs, fail-closed authentication, one token refresh, non-retried task
creation, cancellation with the caller's reason, and timeouts that name their task. The
automated tests additionally cover input validation, concurrent refreshes, the device id,
SSR import and task recovery.

This is local protocol and browser-runtime verification. It does **not** establish
that a production API permits browser credentials or has the required API,
event-stream, upload, and image-download CORS configuration.
