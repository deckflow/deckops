**语言：** [English](README.md) | **简体中文** | [繁體中文](README.zh-TW.md) | [Français](README.fr.md) | [Español](README.es.md) | [Русский](README.ru.md) | [日本語](README.ja.md)

# Deckops

Deckops 是一个用于 Deckflow 任务自动化的 pnpm monorepo。

## 包

- `sdks/typescript` - `@deckops/sdk`，用于文件上传与任务 API 的 TypeScript SDK，兼容 Node.js 和浏览器。
- `apps/node-cli` - `deckops`，Node.js 命令行工具。用法见 [apps/node-cli/README.zh-CN.md](apps/node-cli/README.zh-CN.md)。

## 安装与构建

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

## CLI

完整 CLI 文档（安装、配置及所有命令示例）见 [apps/node-cli/README.zh-CN.md](apps/node-cli/README.zh-CN.md)。

本地构建与运行：

```bash
pnpm --filter deckops build
node apps/node-cli/dist/cli.js --help
```

快速开始：

```bash
deckops login
deckops config show
deckops convert slides.pptx --to pdf
```

## SDK

`@deckops/sdk` API 见 [sdks/typescript/README.zh-CN.md](sdks/typescript/README.zh-CN.md)。

基本示例：

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

## 工作区说明

- `createDeck({ root })` 中的 `root` 为 API 根地址，默认为 `https://app.deckflow.com/v1`。
- `token` 通过 `X-Auth-Token` 头发送。
- `apiKey` 通过 `Authorization: Bearer {apiKey}` 头发送。
- 后续可在 `sdks/go`、`sdks/python`、`sdks/java` 或 `sdks/rust` 下添加更多 SDK。
