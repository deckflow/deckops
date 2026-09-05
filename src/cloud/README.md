# Product-owned cloud implementation

These are ordinary private source modules, not an embedded SDK package. Node
loads them lazily only for cloud work; the browser bundles the browser runtime.
There is no source synchronization, sibling checkout, shared client package or
dependency on either the legacy tool SDK or DeckTools.

## Provenance and migration baseline (2026-09-05)

- Product baseline: `6092eaf12964dbfb08127e1e1a8d0a4e457d65cd`.
- Source: DeckFlow's former DeckOps TypeScript SDK at
  `4a5f70677d6cb7cd5e95ee6a89a88adf942687b0`, `sdks/typescript/src` and
  `sdks/typescript/tests/unit`. Copyright remains with the original DeckFlow
  contributors; subsequent maintenance belongs to this product.
- Previously installed SDK: `@deckops/sdk@0.8.0-next.0`.
- Original lock SHA-256:
  `eae4a3a7ca40aa17d4df15ccd5557ae03f026951bd71597e52f81bd6a24207d7`.
- Original browser-only patch SHA-256:
  `ed4300570deb5e1d06f23da951c2d7bbe781dfc92fcfaafd019b9aadf47f107a`.
  The original patch is recoverable from the product baseline commit.
- Before migration: 107 passing tests; browser consumer 35,715 bytes gzip.

The old Node entry was **not** replaced by that browser patch. The selected
source includes the browser changes: runtime-specific UUID/file access, abort
propagation through upload/submission/wait/download and retry backoff, task-space
tracking through refresh and parse/convert, early task notification, and an
overall wait deadline that closes the stream. These are explicit Node deltas,
covered by the migrated transport tests, not a claim of byte-identical Node code.
Routing, IR references, thresholds, timeouts, retry delays and the Node guest /
mutation-retry defaults remain unchanged. Browser continues to fail closed on
authentication and disables mutation retries by default.

## Scope

`contracts.ts` owns the transport DTOs. `parse/types.ts` owns the cloud IR reference
and conversion result contracts; they are distinct from local DeckIR. Only parse
task names and `parse.convert` are represented. The transport assembles upload,
create/get/wait/download and the parse/convert primitives. General tool shortcuts,
task list/delete/start, generation and translation are deliberately absent.

Axios 1.19.0 and eventsource-parser 1.1.2 are direct dependencies matching the
previous lock. This migration does not replace HTTP libraries. Strict optional
property typing is adapted locally without relaxing the project's compiler.

`tests/cloud` owns request fixtures and regression tests. Changes to the backend
protocol require local source/test updates; neither product builds against the
other. Live cloud conformance is a separate credentialed check, not implied by
passing mock tests.
