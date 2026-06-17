# @deckops/sdk

Node.js and browser-compatible SDK for Deckops/Deckflow task APIs.

## Install

```bash
pnpm add @deckops/sdk
```

In this monorepo:

```bash
pnpm --filter @deckops/sdk build
```

## Create a Client

```ts
import { createDeck } from '@deckops/sdk';

const deck = createDeck({
  root: 'https://app.deckflow.com/v1',
  token: 'user-token',
  apiKey: 'api-key',
  spaceId: 'space-id',
});
```

Options:

- `root?: string` - API root address. Defaults to `https://app.deckflow.com/v1`.
- `token?: string` - sent as `X-Auth-Token`.
- `apiKey?: string` - sent as `Authorization: Bearer {apiKey}`.
- `spaceId?: string` - default space id for task and file calls.
- `onUnauthorized?: () => Promise<{ token: string; spaceId?: string } | string>` - called once after a 401, then the request is retried.
- `onPaymentRequired?: () => Promise<void>` - called once after a 402, then the request is retried.

## Upload Files

Task methods use `fileIds` as their main input model. Upload files separately first:

```ts
const file = await deck.files.upload('./slides.pptx', {
  spaceId: 'space-id',
  onProgress: (p) => console.log(`${Math.round(p * 100)}%`),
});

await deck.convertPptToPdf({ fileIds: [file.id] });
```

Upload input supports:

- Node.js file path: `deck.files.upload('./a.pptx')`
- Node.js/browser binary data: `Uint8Array` or `ArrayBuffer`
- Browser `Blob`/`File`

For Node.js paths and binary data, the SDK calculates MD5. For browser `Blob`/`File`, pass `hash` because browsers do not provide MD5:

```ts
await deck.files.upload(file, {
  name: file.name,
  hash: 'md5-hash',
});
```

Low-level upload auth is also available:

```ts
await deck.files.requestUpload({
  name: 'slides.pptx',
  bytes: 123,
  hash: 'md5-hash',
});
```

## Generic Task API

```ts
const task = await deck.tasks.create({
  type: 'convertor.ppt2pdf',
  fileIds: ['file-id'],
  name: 'slides',
  params: {},
});

await deck.tasks.list({ type: 'convertor.ppt2pdf', startIndex: 0, maxResults: 50 });
await deck.tasks.get(task.id);
await deck.tasks.wait(task.id, { timeout: 300, useEventStream: true });
await deck.tasks.delete(task.id);

const cancel = await deck.tasks.subscribe(task.id, {
  onUpdate: (next) => console.log(next.status),
  onError: console.error,
});
cancel();
```

## Typed Task Helpers

Every helper accepts `{ spaceId?, fileIds?, name?, params? }`, sets the backend task `type`, and returns a typed `DeckTask`.

### File and Image

```ts
await deck.fileCompress({ fileIds: ['file-id'] });
await deck.imageOcr({ fileIds: ['file-id'], params: { language: 'en' } });
await deck.imageConvertWebp({ fileIds: ['file-id'] });
await deck.imageResize({ fileIds: ['file-id'], params: { maxWidth: 1024 } });
```

### PPTX

```ts
await deck.pptxSplit({ fileIds: ['file-id'], params: { indexes: [0, 1] } });
await deck.pptxJoin({ fileIds: ['a', 'b'], name: 'merged' });
await deck.pptxGetFontInfo({ fileIds: ['file-id'] });
await deck.pptxGetTextShapes({
  fileIds: ['file-id'],
  params: { includeNotes: true, ignoreEmptyText: true },
});
await deck.pptxEmbedFonts({
  fileIds: ['file-id'],
  params: { usedFonts: ['Arial'] },
});
```

### Converters

```ts
await deck.convertPptToImage({
  fileIds: ['file-id'],
  params: { resolution: 1920, format: 'jpg' },
});
await deck.convertPptToPptx({ fileIds: ['file-id'] });
await deck.convertPptToPdf({ fileIds: ['file-id'] });
await deck.convertDocToPdf({ fileIds: ['file-id'] });
await deck.convertPptToVideo({ fileIds: ['file-id'] });
await deck.convertPdfToImage({ fileIds: ['file-id'] });
await deck.convertKeynoteToImage({ fileIds: ['file-id'] });
await deck.convertKeynoteToHtml({ fileIds: ['file-id'] });
await deck.convertKeynoteToPdf({ fileIds: ['file-id'] });
await deck.convertHtmlToPng({
  fileIds: ['file-id'],
  params: { width: 1280, height: 720, fullPage: true },
});
await deck.convertMarkdownToPng({
  fileIds: ['file-id'],
  params: { theme: 'dark', pageWidth: 960 },
});
await deck.convertHtmlToPptx({
  fileIds: ['file-id'],
  params: { width: 1280, height: 720, needEmbedFonts: false },
});
```

### HTML Player, Generation, Translation, Revamp

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
  fileIds: ['reference-file-id'],
  params: {
    inputText: '写一份产品发布会方案',
    enableSearch: true,
    pageCount: 8,
  },
});

await deck.translation({
  fileIds: ['file-id'],
  params: {
    from: 'zh',
    to: 'en',
    model: 'Standard',
    useGlossary: false,
    imageTranslate: false,
  },
});

await deck.revamp({
  fileIds: ['file-id'],
  params: { lang: 'zh' },
});
```

## Browser and Node.js Notes

- Task creation is environment-neutral because it uses `fileIds`.
- Node.js uploads can read a path and calculate MD5.
- Browser uploads must provide a file name and MD5 hash when the input is `Blob`/`File`.
- Server-Sent Event subscription is primarily intended for Node.js streams. Browser polling via `deck.tasks.wait(taskId, { useEventStream: false })` is the most portable option.
