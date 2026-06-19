**言語:** [English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [Français](README.fr.md) | [Español](README.es.md) | [Русский](README.ru.md) | **日本語**

# Deckops

Deckops は Deckflow タスク自動化のための pnpm monorepo です。

## パッケージ

- `sdks/nodejs` - `@deckops/sdk`、ファイルアップロードとタスク API 用の Node.js/ブラウザ対応 SDK。
- `apps/node-cli` - `deckops`、Node.js CLI。使い方は [apps/node-cli/README.ja.md](apps/node-cli/README.ja.md) を参照。

## インストールとビルド

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

## CLI

CLI の完全なドキュメント（インストール、設定、すべてのコマンドと例）は [apps/node-cli/README.ja.md](apps/node-cli/README.ja.md) を参照。

ローカルでビルドして実行:

```bash
pnpm --filter deckops build
node apps/node-cli/dist/cli.js --help
```

クイックスタート:

```bash
deckops login
deckops config show
deckops convert slides.pptx --to pdf
```

## SDK

`@deckops/sdk` API は [sdks/nodejs/README.ja.md](sdks/nodejs/README.ja.md) を参照。

基本的な例:

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

## ワークスペースに関する注意

- `createDeck({ root })` の `root` は API のルートアドレスで、デフォルトは `https://app.deckflow.com/v1`。
- `token` は `X-Auth-Token` ヘッダーで送信されます。
- `apiKey` は `Authorization: Bearer {apiKey}` で送信されます。
- 今後 `sdks/go`、`sdks/python`、`sdks/java`、`sdks/rust` に SDK を追加できます。
