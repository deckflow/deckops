**Языки:** [English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [Français](README.fr.md) | [Español](README.es.md) | **Русский** | [日本語](README.ja.md)

# Deckops

Deckops — это pnpm monorepo для автоматизации задач Deckflow.

## Пакеты

- `sdks/nodejs` — `@deckops/sdk`, SDK для Node.js/браузера для загрузки файлов и API задач.
- `apps/node-cli` — `deckops`, CLI для Node.js. См. [apps/node-cli/README.ru.md](apps/node-cli/README.ru.md).

## Установка и сборка

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

## CLI

Полная документация CLI (установка, конфигурация и все команды с примерами) — в [apps/node-cli/README.ru.md](apps/node-cli/README.ru.md).

Сборка и локальный запуск:

```bash
pnpm --filter deckops build
node apps/node-cli/dist/cli.js --help
```

Быстрый старт:

```bash
deckops login
deckops config show
deckops convert slides.pptx --to pdf
```

## SDK

API `@deckops/sdk` описан в [sdks/nodejs/README.ru.md](sdks/nodejs/README.ru.md).

Базовый пример:

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

## Примечания по workspace

- `root` в `createDeck({ root })` — корневой адрес API, по умолчанию `https://app.deckflow.com/v1`.
- `token` передаётся в заголовке `X-Auth-Token`.
- `apiKey` передаётся как `Authorization: Bearer {apiKey}`.
- В будущем SDK можно добавить в `sdks/go`, `sdks/python`, `sdks/java` или `sdks/rust`.
