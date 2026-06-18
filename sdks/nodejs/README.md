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

## Create Tasks With Files

Pass user-selected files directly to task methods. The SDK uploads them internally and sends the resulting file ids to the task API:

```ts
const task = await deck.convertPptToPdf({
  files: ['./slides.pptx'],
  upload: {
    onProgress: (p) => console.log(`${Math.round(p * 100)}%`),
  },
});
```

`files` supports:

- Node.js file path: `'./a.pptx'`
- Node.js/browser binary data: `Uint8Array` or `ArrayBuffer`
- Browser `Blob`/`File`

For browser file pickers, pass the selected `File` object:

```ts
await deck.convertPptToPdf({
  files: [file],
});
```

For binary data without a file name, include per-file upload options:

```ts
await deck.imageOcr({
  files: [{ input: bytes, name: 'image.png' }],
  params: { language: 'en' },
});
```

For compatibility with existing integrations, `fileIds` is still accepted and can be combined with `files`.

## Generic Task API

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

Task detail responses are for status/progress metadata. Task results should be read through `deck.tasks.down(...)` or the backend-name alias `deck.ttask.down(...)`.

```ts
const result = await deck.ttask.down<'convertor.ppt2pdf'>(task.id);
const generationDownload = await deck.ttask.down<'generation'>(task.id, { type: 'pptx' });
console.log(generationDownload.downloadUrl);
```

## Result Types

The SDK exports concrete result types for every task type through `DeckTaskTypeResult`.

Most file-producing tasks return tuple-shaped file results because that is the backend contract:

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

`path` is the storage key or relative path in raw backend data. When the task detail API expands downloadable results, it may already be a signed/access URL.

Examples:

- `deck.convertPptToPdf(...)` returns `ConvertFileResult[]`.
- `deck.convertHtmlToPptx(...)` returns `{ target: FileResult; usedFonts: string[] }`.
- `deck.pptxSplit(...)` returns `{ ppt, sections, slides }` with typed slide file metadata.
- `deck.pptxGetFontInfo(...)` returns `{ fonts, embeddedFont, subsetFont }`.
- `deck.pptxGetTextShapes(...)` returns typed page/shape/text/image metadata.

## Typed Task Helpers

Every helper accepts `{ spaceId?, files?, fileIds?, name?, params?, upload? }`, sets the backend task `type`, uploads files when needed, and returns a typed `DeckTask`.

### File and Image

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

### Converters

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
  files: [referenceFile],
  params: {
    inputText: '写一份产品发布会方案',
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

## Browser and Node.js Notes

- Task helpers accept files directly and upload them before task creation.
- Node.js uploads can read a path and calculate MD5.
- Browser uploads can use `Blob`/`File`; the SDK reads the file name and calculates MD5.
- Server-Sent Event subscription is primarily intended for Node.js streams. Browser polling via `deck.tasks.wait(taskId, { useEventStream: false })` is the most portable option.
