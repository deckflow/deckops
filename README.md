# Deckops

Deckops is a pnpm monorepo for Deckflow task automation.

## Packages

- `sdks/nodejs` - `@deckops/sdk`, a Node.js/browser-compatible SDK for file upload and task APIs.
- `apps/node-cli` - `deckops`, the Node.js CLI. See [apps/node-cli/README.md](apps/node-cli/README.md) for usage.

## Install and Build

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

## CLI

See [apps/node-cli/README.md](apps/node-cli/README.md) for full CLI documentation (install, config, and all commands with examples).

Build and run locally:

```bash
pnpm --filter deckops build
node apps/node-cli/dist/cli.js --help
```

Quick start:

```bash
deckops login
deckops config show
deckops convert slides.pptx --to pdf
```

## SDK

See [sdks/nodejs/README.md](sdks/nodejs/README.md) for the `@deckops/sdk` API.

Basic example:

```ts
import { createDeck } from '@deckops/sdk';

const deck = createDeck({
  token: process.env.DECKOPS_TOKEN,
  spaceId: process.env.DECKOPS_SPACE_ID,
});

const task = await deck.convertPptToPdf({
  files: ['./slides.pptx'],
  name: 'slides',
});

const done = await deck.tasks.wait(task.id);
console.log(done.result);
```

## Workspace Notes

- `root` in `createDeck({ root })` is the API root address and defaults to `https://app.deckflow.com/v1`.
- `token` is sent as `X-Auth-Token`.
- `apiKey` is sent as `Authorization: Bearer {apiKey}`.
- Future SDKs can be added under `sdks/go`, `sdks/python`, `sdks/java`, or `sdks/rust`.
