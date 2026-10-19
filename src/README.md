# Source layout

DeckOps is a client that moves bytes and never interprets documents. Four layers, each
depending only on the ones above it:

```
cloud/    transport: HTTP client, files upload, task create/wait/download, parse facade
client/   isomorphic SDK: createClientWith(options, runtime) — parse, convert, resume, getTask
node/     Node only: artifacts (manifest v3, submission log, locks), image localization,
          the parse/convert/read operations, the Node runtime and the Node SDK surface
cli/      commander assembly, option parsing, output rendering and exit codes
```

`browser/index.ts` is the client bound to the browser runtime. `config/` and `auth/` hold the
shared credential chain and login flow the Node layer uses. `shared/` holds pure tables and
helpers (extension routes, parameter mapping, flag validation, error translation) and
`errors/` the error and exit code contract; both are safe in every runtime. `types.ts` holds
the public artifact, option and envelope contracts.

## Rules

1. `cloud/` only knows HTTP and the task protocol — no filesystem, credential files or
   Markdown.
2. `client/` never imports `node:*`; runtime differences arrive through `DeckRuntime`
   (`cloud/runtime.ts`), implemented by `node/runtime.ts` and `cloud/browser.ts`.
3. `node/` is the only layer that touches the filesystem; `cli/` is the only layer that
   touches the process (stdout, stderr, exit codes, argv).
4. No layer interprets document content: nothing parses PDF, OOXML, IWA or HTML, derives a
   view from the IR, or grades quality. The IR and Markdown pass through as the server sent
   them; the client only rewrites image links to the files it downloaded.

`pnpm check:boundaries` (`scripts/check-boundaries.mjs`) enforces the mechanical part: no
parser dependencies, no `local/`, `engine/`, `quality/`, `ir/` or `views/` trees, no `node:`
imports in `client/`, `cloud/`, `shared/` or `errors/`, no worker threads, no WebAssembly in
`dist/`.
