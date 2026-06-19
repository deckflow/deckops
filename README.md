# Deckops

Deckops is a pnpm monorepo for Deckflow task automation.

## Packages

- `sdks/nodejs` - `@deckops/sdk`, a Node.js/browser-compatible SDK for file upload and task APIs.
- `apps/nodejs` - `deckops`, the existing Node.js CLI. The command surface is unchanged and now calls `@deckops/sdk` internally.

## Install and Build

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

## CLI

The CLI package keeps the `deckops` package name and bin name.

```bash
pnpm --filter deckops build
node apps/nodejs/dist/cli.js --help
```

Common commands:

```bash
deckops login
deckops config show
deckops compress presentation.pptx
deckops ocr image.jpg --language en
deckops convert slides.pptx --to pdf
deckops convert page1.html page2.html --to pptx
deckops create --input-text "请写一份产品发布会方案"
deckops translate handbook.docx --from zh --to en --model Standard
deckops join part1.pptx part2.pptx
deckops task list --limit 10
deckops run convertor.ppt2pdf demo.ppt
deckops run pptx.join part1.pptx part2.pptx
```

Multiple input files are treated as one ordered source set only for task types that
consume ordered sources, such as `convertor.html2pptx`, `pptx.join`,
`html.buildPlayer`, and `generation`. Other task types use a single source file.

The CLI config file still defaults to `~/.deckops/config.json`. For tests or isolated runs, set `DECKOPS_CONFIG_DIR`.

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
