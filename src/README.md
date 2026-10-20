# Source layout

DeckOps is a client that moves bytes and never interprets documents. Five layers, each
depending only on the ones above it:

```
cloud/    transport: HTTP client, files upload, task create/wait/download/start, capabilities
ops/      the route table (verb × input family × target → task chain), parameter mapping,
          chain execution and result normalization
client/   isomorphic SDK: createClientWith(options, runtime) — render, convert, extract, tasks, files
node/     Node only: source reading, the cache index (sha256 → fileId, submission journal),
          result writing and image localization, the operations, the runtime and the Node SDK
cli/      commander assembly, option parsing, output rendering and exit codes
```

`ops/probe.ts` is the one local verb: it loads the optional `@deckflow/deckprobe` engine and
nothing from the cloud, credential or configuration layers.

`browser/index.ts` is the client bound to the browser runtime. `config/` and `auth/` hold the
shared credential chain and login flow the Node layer uses. `shared/` holds error translation
and limits, `errors/` the error and exit code contract; both are safe in every runtime.
`types.ts` holds the command-line flag and `--json` envelope contracts.

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
5. The route table is data, not code. `ops/routes.ts` declares `{ verb, from, to, steps,
   options, requires?, caveat? }` rows whose steps name a mapping function in `ops/params.ts`;
   adding a conversion is adding a row.

`pnpm check:boundaries` (`scripts/check-boundaries.mjs`) enforces the mechanical part: no
parser dependencies (DeckProbe only as an optional dependency, imported only by
`ops/probe.ts`, which may not import `cloud/`, `auth/` or `config/`), a declarative
`ops/routes.ts`, no `local/`, `engine/`, `quality/`, `ir/` or `views/` trees, no `node:` imports
in `client/`, `cloud/`, `ops/`, `shared/` or `errors/`, no worker threads, no WebAssembly in
`dist/` and no probe engine in the browser entry.
