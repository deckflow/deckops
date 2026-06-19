**語言：** [English](README.md) | [简体中文](README.zh-CN.md) | **繁體中文** | [Français](README.fr.md) | [Español](README.es.md) | [Русский](README.ru.md) | [日本語](README.ja.md)

# Deckops

Deckops 是一個用於 Deckflow 任務自動化的 pnpm monorepo。

## 套件

- `sdks/nodejs` - `@deckops/sdk`，用於檔案上傳與任務 API 的 Node.js/瀏覽器相容 SDK。
- `apps/node-cli` - `deckops`，Node.js 命令列工具。用法見 [apps/node-cli/README.zh-TW.md](apps/node-cli/README.zh-TW.md)。

## 安裝與建置

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

## CLI

完整 CLI 文件（安裝、設定及所有命令範例）見 [apps/node-cli/README.zh-TW.md](apps/node-cli/README.zh-TW.md)。

本地建置與執行：

```bash
pnpm --filter deckops build
node apps/node-cli/dist/cli.js --help
```

快速開始：

```bash
deckops login
deckops config show
deckops convert slides.pptx --to pdf
```

## SDK

`@deckops/sdk` API 見 [sdks/nodejs/README.zh-TW.md](sdks/nodejs/README.zh-TW.md)。

基本範例：

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

## 工作區說明

- `createDeck({ root })` 中的 `root` 為 API 根位址，預設為 `https://app.deckflow.com/v1`。
- `token` 透過 `X-Auth-Token` 標頭傳送。
- `apiKey` 透過 `Authorization: Bearer {apiKey}` 標頭傳送。
- 後續可在 `sdks/go`、`sdks/python`、`sdks/java` 或 `sdks/rust` 下新增更多 SDK。
