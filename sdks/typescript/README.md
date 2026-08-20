**Languages:** English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [Français](README.fr.md) | [Español](README.es.md) | [Русский](README.ru.md) | [日本語](README.ja.md)

# @deckops/sdk

TypeScript SDK for Deckops/Deckflow task APIs in Node.js and browsers.

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
- `authUuid?: string` - explicit client UUID (UUID v4) sent as `X-Auth-UUID`. Skips automatic persistence.
- `authUuidStorage?: { get(), set(value) }` - custom storage for client UUID (SSR, tests, embedded apps).
- `onUnauthorized?: () => Promise<{ token: string; spaceId?: string } | string>` - called once after a 401, then the request is retried.
- `onPaymentRequired?: () => Promise<void>` - called once after a 402, then the request is retried.

`token`, `apiKey`, and `spaceId` are all optional. When `spaceId` is omitted the SDK resolves it from `GET /user`, an endpoint that only requires `X-Auth-UUID`. This means `token` and `apiKey` can both be empty: the SDK runs in **guest mode**, the server identifies the guest by `X-Auth-UUID` and enforces usage limits and rate quotas. This is useful for try-before-login experiences.

```ts
const deck = createDeck({ authUuid: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' });
await deck.generation({ params: { inputText: 'Write a launch plan', pageCount: 8 } });
```

Every Deckops API request automatically includes `X-Auth-UUID`, a stable UUID v4 used to track the client across sessions.

- **Browser**: persisted in `localStorage` under `df_uuid`.
- **Node.js**: persisted in `~/.deckops/auth-uuid` (override the directory with `DECKOPS_CONFIG_DIR`).
- **Explicit override**: pass `authUuid` or set `DECKOPS_AUTH_UUID` (Node only) for fixed IDs in CI, containers, or multi-tenant servers.

```ts
const uuid = await deck.getAuthUuid();
console.log('Client UUID:', uuid);
```

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
await deck.convertHtmlToPptx({
  files: ['./page1.html', './page2.html'],
  params: { width: 1280, height: 720 },
});
```

Ordered multi-source files are meaningful for task types that map the whole file
array into backend parameters, including `pptx.join`, `convertor.html2pptx`,
`html.buildPlayer`, and `generation`. Most other task types read one source file;
pass one file per task for those.

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
    inputText: 'Write a product launch plan',
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

## Parse Documents

`deck.parse()` picks a parser from the file extension or URL, creates the task,
waits for it, and returns what `output` asked for. Markdown is rendered by the
backend — the SDK does no conversion of its own.

```ts
// Markdown only (the default): the structured result is dropped server-side.
const { markdown } = await deck.parse('./slides.pptx');
```

`output` picks what comes back:

| `output`     | markdown fields | `result` | Sent to the backend                  |
| ------------ | --------------- | -------- | ------------------------------------ |
| `'markdown'` | ✅              | —        | `markdown: true, markdownOnly: true` |
| `'ir'`       | —               | ✅       | *(no markdown params)*               |
| `'all'`      | ✅              | ✅       | `markdown: true`                     |

`result` is the response body passed through verbatim, so type it with the task
type's result:

```ts
import type { PdfParseStructuredResult, PptxParseStructuredResult } from '@deckops/sdk';

const ir = await deck.parse<PdfParseStructuredResult>('./report.pdf', { output: 'ir' });
ir.result?.document.elements;

const both = await deck.parse<PptxParseStructuredResult>('./slides.pptx', {
  output: 'all',
  markdownPages: true,
});
both.markdown; both.markdownPages; both.result;
```

Per-parser params ride on the same options object and are only sent to the task
types that accept them — `markdownPages` for `.pptx` / `.key`, `password`,
`parseProfile`, `includeImages`, `markdownMeta` for `.pdf`, `stayImageAreaRate`
for `.key`:

```ts
await deck.parse('./report.pdf', { output: 'all', parseProfile: 'quality', password: 'pw' });
```

Already-uploaded files take `{ fileId, name }`; links take `{ url, mode }`:

```ts
await deck.parse({ fileId: 'uploaded-file-id', name: 'slides.pptx' });
await deck.parse({ url: 'https://example.com/article', mode: 'runtime' });
```

Supported extensions are `.pdf`, `.pptx`, `.docx`, and `.key`. The low-level
helpers (`deck.pdfParse` → `pdf.pdfParse`, `deck.pptxParse`, `deck.docxParse`,
`deck.keynoteParse`, `deck.htmlGetByURL`) take the backend params directly,
including `markdown`, `markdownOnly`, `markdownPages`, and `markdownStrict`.

The backend degrades rather than fails by default: when Markdown rendering
breaks, `markdownError` explains why and `markdown` is empty. Pass
`markdownStrict: true` to make the task fail instead.

Markdown needs a backend running `@deckflow/platform-slave` 0.21.0 or newer.
Older servers ignore the markdown params silently instead of rejecting them, so
`parse()` throws rather than handing back an empty string that would read as an
empty document. `{ output: 'ir' }` does not need the markdown params and works
against older backends.

## Browser and Node.js Notes

- Task helpers accept files directly and upload them before task creation.
- Node.js uploads can read a path and calculate MD5.
- Browser uploads can use `Blob`/`File`; the SDK reads the file name and calculates MD5.
- Server-Sent Event subscription works in Node.js and modern browsers; polling remains available with `deck.tasks.wait(taskId, { useEventStream: false })`.
