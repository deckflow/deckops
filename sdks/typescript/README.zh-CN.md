**语言：** [English](README.md) | **简体中文** | [繁體中文](README.zh-TW.md) | [Français](README.fr.md) | [Español](README.es.md) | [Русский](README.ru.md) | [日本語](README.ja.md)

# @deckops/sdk

用于 Deckops/Deckflow 任务 API 的 TypeScript SDK，兼容 Node.js 和浏览器。

## 安装

```bash
pnpm add @deckops/sdk
```

在本 monorepo 中：

```bash
pnpm --filter @deckops/sdk build
```

## 创建客户端

```ts
import { createDeck } from '@deckops/sdk';

const deck = createDeck({
  root: 'https://app.deckflow.com/v1',
  token: 'user-token',
  apiKey: 'api-key',
  spaceId: 'space-id',
});
```

选项：

- `root?: string` - API 根地址，默认为 `https://app.deckflow.com/v1`。
- `token?: string` - 通过 `X-Auth-Token` 头发送。
- `apiKey?: string` - 通过 `Authorization: Bearer {apiKey}` 头发送。
- `spaceId?: string` - 任务与文件调用的默认 space id。
- `authUuid?: string` - 显式客户端 UUID（UUID v4），通过 `X-Auth-UUID` 发送，跳过自动持久化。
- `authUuidStorage?: { get(), set(value) }` - 客户端 UUID 的自定义存储（SSR、测试、嵌入式应用）。
- `onUnauthorized?: () => Promise<{ token: string; spaceId?: string } | string>` - 401 后调用一次，然后重试请求。
- `onPaymentRequired?: () => Promise<void>` - 402 后调用一次，然后重试请求。

每个 Deckops API 请求会自动包含 `X-Auth-UUID`，即用于跨会话追踪客户端的稳定 UUID v4。

- **浏览器**：持久化在 `localStorage` 的 `df_uuid` 键下。
- **Node.js**：持久化在 `~/.deckops/auth-uuid`（可通过 `DECKOPS_CONFIG_DIR` 覆盖目录）。
- **显式覆盖**：传入 `authUuid` 或设置 `DECKOPS_AUTH_UUID`（仅 Node）用于 CI、容器或多租户服务器的固定 ID。

```ts
const uuid = await deck.getAuthUuid();
console.log('Client UUID:', uuid);
```

## 通过文件创建任务

将用户选择的文件直接传给任务方法。SDK 会在内部上传并将得到的 file id 发送给任务 API：

```ts
const task = await deck.convertPptToPdf({
  files: ['./slides.pptx'],
  upload: {
    onProgress: (p) => console.log(`${Math.round(p * 100)}%`),
  },
});
```

`files` 支持：

- Node.js 文件路径：`'./a.pptx'`
- Node.js/浏览器二进制数据：`Uint8Array` 或 `ArrayBuffer`
- 浏览器 `Blob`/`File`

浏览器文件选择器可直接传入选中的 `File` 对象：

```ts
await deck.convertPptToPdf({
  files: [file],
});
```

无文件名的二进制数据需包含逐文件上传选项：

```ts
await deck.imageOcr({
  files: [{ input: bytes, name: 'image.png' }],
  params: { language: 'en' },
});
```

为兼容现有集成，仍接受 `fileIds`，可与 `files` 组合使用。

## 通用任务 API

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

任务详情响应用于状态/进度元数据。任务结果应通过 `deck.tasks.down(...)` 或后端别名 `deck.ttask.down(...)` 读取。

```ts
const result = await deck.ttask.down<'convertor.ppt2pdf'>(task.id);
const generationDownload = await deck.ttask.down<'generation'>(task.id, { type: 'pptx' });
console.log(generationDownload.downloadUrl);
```

## 结果类型

SDK 通过 `DeckTaskTypeResult` 为每种任务类型导出具体结果类型。

大多数产出文件的任务返回元组形文件结果，这是后端约定：

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

`path` 是原始后端数据中的存储键或相对路径。当任务详情 API 展开可下载结果时，可能已是签名/访问 URL。

示例：

- `deck.convertPptToPdf(...)` 返回 `ConvertFileResult[]`。
- `deck.convertHtmlToPptx(...)` 返回 `{ target: FileResult; usedFonts: string[] }`。
- `deck.pptxSplit(...)` 返回带类型化幻灯片文件元数据的 `{ ppt, sections, slides }`。
- `deck.pptxGetFontInfo(...)` 返回 `{ fonts, embeddedFont, subsetFont }`。
- `deck.pptxGetTextShapes(...)` 返回类型化的页面/形状/文本/图片元数据。

## 类型化任务辅助方法

每个辅助方法接受 `{ spaceId?, files?, fileIds?, name?, params?, upload? }`，设置后端任务 `type`，按需上传文件，并返回类型化的 `DeckTask`。

### 文件与图片

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

### 转换器

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

有序多源文件对将整个文件数组映射到后端参数的任务类型有意义，包括 `pptx.join`、`convertor.html2pptx`、`html.buildPlayer` 和 `generation`。大多数其他任务类型只读取一个源文件；此类任务每次传一个文件。

### HTML 播放器、生成、翻译、改版

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
    inputText: '请写一份产品发布会方案',
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

## 浏览器与 Node.js 说明

- 任务辅助方法直接接受文件，在创建任务前上传。
- Node.js 上传可读取路径并计算 MD5。
- 浏览器上传可使用 `Blob`/`File`；SDK 读取文件名并计算 MD5。
- Server-Sent Event 订阅支持 Node.js 和现代浏览器；也可以通过 `deck.tasks.wait(taskId, { useEventStream: false })` 使用轮询。
