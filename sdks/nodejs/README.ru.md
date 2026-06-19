**Языки:** [English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [Français](README.fr.md) | [Español](README.es.md) | **Русский** | [日本語](README.ja.md)

# @deckops/sdk

SDK для Node.js и браузера для API задач Deckops/Deckflow.

## Установка

```bash
pnpm add @deckops/sdk
```

В этом monorepo:

```bash
pnpm --filter @deckops/sdk build
```

## Создание клиента

```ts
import { createDeck } from '@deckops/sdk';

const deck = createDeck({
  root: 'https://app.deckflow.com/v1',
  token: 'user-token',
  apiKey: 'api-key',
  spaceId: 'space-id',
});
```

Параметры:

- `root?: string` - корневой адрес API. По умолчанию `https://app.deckflow.com/v1`.
- `token?: string` - отправляется в заголовке `X-Auth-Token`.
- `apiKey?: string` - отправляется как `Authorization: Bearer {apiKey}`.
- `spaceId?: string` - идентификатор пространства по умолчанию для вызовов задач и файлов.
- `authUuid?: string` - явный UUID клиента (UUID v4), отправляемый в `X-Auth-UUID`. Пропускает автоматическое сохранение.
- `authUuidStorage?: { get(), set(value) }` - пользовательское хранилище для UUID клиента (SSR, тесты, встроенные приложения).
- `onUnauthorized?: () => Promise<{ token: string; spaceId?: string } | string>` - вызывается один раз после 401, затем запрос повторяется.
- `onPaymentRequired?: () => Promise<void>` - вызывается один раз после 402, затем запрос повторяется.

Каждый запрос к API Deckops автоматически включает `X-Auth-UUID` — стабильный UUID v4 для отслеживания клиента между сессиями.

- **Браузер**: сохраняется в `localStorage` под ключом `df_uuid`.
- **Node.js**: сохраняется в `~/.deckops/auth-uuid` (переопределите каталог через `DECKOPS_CONFIG_DIR`).
- **Явное переопределение**: передайте `authUuid` или задайте `DECKOPS_AUTH_UUID` (только Node) для фиксированных ID в CI, контейнерах или мультитенантных серверах.

```ts
const uuid = await deck.getAuthUuid();
console.log('Client UUID:', uuid);
```

## Создание задач с файлами

Передавайте выбранные пользователем файлы напрямую в методы задач. SDK загружает их внутренне и отправляет полученные идентификаторы файлов в API задач:

```ts
const task = await deck.convertPptToPdf({
  files: ['./slides.pptx'],
  upload: {
    onProgress: (p) => console.log(`${Math.round(p * 100)}%`),
  },
});
```

`files` поддерживает:

- Путь к файлу в Node.js: `'./a.pptx'`
- Бинарные данные Node.js/браузера: `Uint8Array` или `ArrayBuffer`
- `Blob`/`File` браузера

Для диалогов выбора файлов в браузере передайте выбранный объект `File`:

```ts
await deck.convertPptToPdf({
  files: [file],
});
```

Для бинарных данных без имени файла укажите параметры загрузки для каждого файла:

```ts
await deck.imageOcr({
  files: [{ input: bytes, name: 'image.png' }],
  params: { language: 'en' },
});
```

Для совместимости с существующими интеграциями `fileIds` по-прежнему принимается и может комбинироваться с `files`.

## Универсальный API задач

```ts
const task = await deck.tasks.create({
  type: 'convertor.ppt2pdf',
  files: ['./slides.pptx'],
  name: 'slides',
  params: {},
});

await deck.tasks.list({ type: 'convertor.ppt2pdf', startIndex: 0, maxResults: 50 });
await deck.tasks.get(task.id);
await deck.tasks.wait(task.id, { timeout: 300, useEventStream: true });
await deck.tasks.down<'convertor.ppt2pdf'>(task.id);
await deck.tasks.delete(task.id);

const cancel = await deck.tasks.subscribe(task.id, {
  onUpdate: (next) => console.log(next.status),
  onError: console.error,
});
cancel();
```

Ответы с деталями задачи предназначены для метаданных статуса/прогресса. Результаты задач следует читать через `deck.tasks.down(...)` или псевдоним бэкенда `deck.ttask.down(...)`.

```ts
const result = await deck.ttask.down<'convertor.ppt2pdf'>(task.id);
const generationDownload = await deck.ttask.down<'generation'>(task.id, { type: 'pptx' });
console.log(generationDownload.downloadUrl);
```

## Типы результатов

SDK экспортирует конкретные типы результатов для каждого типа задачи через `DeckTaskTypeResult`.

Большинство задач, создающих файлы, возвращают результаты в виде кортежей — это контракт бэкенда:

```ts
type FileResult = [
  path: string,
  bytes: number,
  hash: string,
];

type ConvertFileResult = [
  path: string,
  bytes: number,
  hash: string,
  bounds?: { w?: number; h?: number; total?: number } | null,
];
```

`path` — ключ хранения или относительный путь в сырых данных бэкенда. Когда API деталей задачи разворачивает загружаемые результаты, это может быть уже подписанный/доступный URL.

Примеры:

- `deck.convertPptToPdf(...)` возвращает `ConvertFileResult[]`.
- `deck.convertHtmlToPptx(...)` возвращает `{ target: FileResult; usedFonts: string[] }`.
- `deck.pptxSplit(...)` возвращает `{ ppt, sections, slides }` с типизированными метаданными файлов слайдов.
- `deck.pptxGetFontInfo(...)` возвращает `{ fonts, embeddedFont, subsetFont }`.
- `deck.pptxGetTextShapes(...)` возвращает типизированные метаданные страниц/фигур/текста/изображений.

## Типизированные вспомогательные методы задач

Каждый вспомогательный метод принимает `{ spaceId?, files?, fileIds?, name?, params?, upload? }`, задаёт `type` задачи бэкенда, при необходимости загружает файлы и возвращает типизированный `DeckTask`.

### Файлы и изображения

```ts
await deck.fileCompress({ files: ['./document.pdf'] });
await deck.imageOcr({ files: [file], params: { language: 'en' } });
await deck.imageConvertWebp({ files: [file] });
await deck.imageResize({ files: [file], params: { maxWidth: 1024 } });
```

### PPTX

```ts
await deck.pptxSplit({ files: ['./slides.pptx'], params: { indexes: [0, 1] } });
await deck.pptxJoin({ files: ['./part1.pptx', './part2.pptx'], name: 'merged' });
await deck.pptxGetFontInfo({ files: ['./slides.pptx'] });
await deck.pptxGetTextShapes({
  files: ['./slides.pptx'],
  params: { includeNotes: true, ignoreEmptyText: true },
});
await deck.pptxEmbedFonts({
  files: ['./slides.pptx'],
  params: { usedFonts: ['Arial'] },
});
```

### Конвертеры

```ts
await deck.convertPptToImage({
  files: ['./slides.pptx'],
  params: { resolution: 1920, format: 'jpg' },
});
await deck.convertPptToPptx({ files: ['./slides.ppt'] });
await deck.convertPptToPdf({ files: ['./slides.pptx'] });
await deck.convertDocToPdf({ files: ['./handbook.docx'] });
await deck.convertPptToVideo({ files: ['./slides.pptx'] });
await deck.convertPdfToImage({ files: ['./document.pdf'] });
await deck.convertKeynoteToImage({ files: ['./deck.key'] });
await deck.convertKeynoteToHtml({ files: ['./deck.key'] });
await deck.convertKeynoteToPdf({ files: ['./deck.key'] });
await deck.convertHtmlToPng({
  files: [{ input: htmlBytes, name: 'page.html' }],
  params: { width: 1280, height: 720, fullPage: true },
});
await deck.convertMarkdownToPng({
  files: [{ input: markdownBytes, name: 'page.md' }],
  params: { theme: 'dark', pageWidth: 960 },
});
await deck.convertHtmlToPptx({
  files: [{ input: htmlBytes, name: 'deck.html' }],
  params: { width: 1280, height: 720, needEmbedFonts: false },
});
await deck.convertHtmlToPptx({
  files: ['./page1.html', './page2.html'],
  params: { width: 1280, height: 720 },
});
```

Порядок нескольких исходных файлов важен для типов задач, которые сопоставляют весь массив файлов с параметрами бэкенда, включая `pptx.join`, `convertor.html2pptx`, `html.buildPlayer` и `generation`. Большинство других типов задач читают один исходный файл; для них передавайте по одному файлу на задачу.

### HTML-плеер, генерация, перевод, обновление

```ts
await deck.htmlBuildPlayer({
  params: {
    contents: [{ key: 'pages/1.html' }],
    pageWidth: 1280,
    pageHeight: 720,
    title: 'Deck',
    description: 'Deck player',
    brandMarkPosition: 'none',
  },
});

await deck.generation({
  files: [referenceFile],
  params: {
    inputText: 'Напишите план запуска продукта',
    enableSearch: true,
    pageCount: 8,
  },
});

await deck.translation({
  files: [file],
  params: {
    from: 'zh',
    to: 'en',
    model: 'Standard',
    useGlossary: false,
    imageTranslate: false,
  },
});

await deck.revamp({
  files: [file],
  params: { lang: 'zh' },
});
```

## Заметки для браузера и Node.js

- Вспомогательные методы задач принимают файлы напрямую и загружают их перед созданием задачи.
- Загрузки в Node.js могут читать путь и вычислять MD5.
- Загрузки в браузере могут использовать `Blob`/`File`; SDK читает имя файла и вычисляет MD5.
- Подписка Server-Sent Event в основном предназначена для потоков Node.js. Наиболее переносимый вариант для браузера — опрос через `deck.tasks.wait(taskId, { useEventStream: false })`.
