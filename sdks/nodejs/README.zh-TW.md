**語言：** [English](README.md) | [简体中文](README.zh-CN.md) | **繁體中文** | [Français](README.fr.md) | [Español](README.es.md) | [Русский](README.ru.md) | [日本語](README.ja.md)

# @deckops/sdk

用於 Deckops/Deckflow 任務 API 的 Node.js/瀏覽器相容 SDK。

## 安裝

```bash
pnpm add @deckops/sdk
```

在本 monorepo 中：

```bash
pnpm --filter @deckops/sdk build
```

## 建立客戶端

```ts
import { createDeck } from '@deckops/sdk';

const deck = createDeck({
  root: 'https://app.deckflow.com/v1',
  token: 'user-token',
  apiKey: 'api-key',
  spaceId: 'space-id',
});
```

選項：

- `root?: string` - API 根位址，預設為 `https://app.deckflow.com/v1`。
- `token?: string` - 透過 `X-Auth-Token` 標頭傳送。
- `apiKey?: string` - 透過 `Authorization: Bearer {apiKey}` 標頭傳送。
- `spaceId?: string` - 任務與檔案呼叫的預設 space id。
- `authUuid?: string` - 顯式客戶端 UUID（UUID v4），透過 `X-Auth-UUID` 傳送，跳過自動持久化。
- `authUuidStorage?: { get(), set(value) }` - 客戶端 UUID 的自訂儲存（SSR、測試、嵌入式應用）。
- `onUnauthorized?: () => Promise<{ token: string; spaceId?: string } | string>` - 401 後呼叫一次，然後重試請求。
- `onPaymentRequired?: () => Promise<void>` - 402 後呼叫一次，然後重試請求。

每個 Deckops API 請求會自動包含 `X-Auth-UUID`，即用於跨工作階段追蹤客戶端的穩定 UUID v4。

- **瀏覽器**：持久化在 `localStorage` 的 `df_uuid` 鍵下。
- **Node.js**：持久化在 `~/.deckops/auth-uuid`（可透過 `DECKOPS_CONFIG_DIR` 覆寫目錄）。
- **顯式覆寫**：傳入 `authUuid` 或設定 `DECKOPS_AUTH_UUID`（僅 Node）用於 CI、容器或多租戶伺服器的固定 ID。

```ts
const uuid = await deck.getAuthUuid();
console.log('Client UUID:', uuid);
```

## 透過檔案建立任務

將使用者選擇的檔案直接傳給任務方法。SDK 會在內部上傳並將得到的 file id 傳送給任務 API：

```ts
const task = await deck.convertPptToPdf({
  files: ['./slides.pptx'],
  upload: {
    onProgress: (p) => console.log(`${Math.round(p * 100)}%`),
  },
});
```

`files` 支援：

- Node.js 檔案路徑：`'./a.pptx'`
- Node.js/瀏覽器二進位資料：`Uint8Array` 或 `ArrayBuffer`
- 瀏覽器 `Blob`/`File`

瀏覽器檔案選擇器可直接傳入選中的 `File` 物件：

```ts
await deck.convertPptToPdf({
  files: [file],
});
```

無檔名的二進位資料需包含逐檔上傳選項：

```ts
await deck.imageOcr({
  files: [{ input: bytes, name: 'image.png' }],
  params: { language: 'en' },
});
```

為相容現有整合，仍接受 `fileIds`，可與 `files` 組合使用。

## 通用任務 API

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

任務詳情回應用於狀態/進度中繼資料。任務結果應透過 `deck.tasks.down(...)` 或後端別名 `deck.ttask.down(...)` 讀取。

```ts
const result = await deck.ttask.down<'convertor.ppt2pdf'>(task.id);
const generationDownload = await deck.ttask.down<'generation'>(task.id, { type: 'pptx' });
console.log(generationDownload.downloadUrl);
```

## 結果類型

SDK 透過 `DeckTaskTypeResult` 為每種任務類型匯出具體結果類型。

大多數產出檔案的任務回傳元組形檔案結果，這是後端約定：

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

`path` 是原始後端資料中的儲存鍵或相對路徑。當任務詳情 API 展開可下載結果時，可能已是簽名/存取 URL。

範例：

- `deck.convertPptToPdf(...)` 回傳 `ConvertFileResult[]`。
- `deck.convertHtmlToPptx(...)` 回傳 `{ target: FileResult; usedFonts: string[] }`。
- `deck.pptxSplit(...)` 回傳帶型別化幻燈片檔案中繼資料的 `{ ppt, sections, slides }`。
- `deck.pptxGetFontInfo(...)` 回傳 `{ fonts, embeddedFont, subsetFont }`。
- `deck.pptxGetTextShapes(...)` 回傳型別化的頁面/形狀/文字/圖片中繼資料。

## 型別化任務輔助方法

每個輔助方法接受 `{ spaceId?, files?, fileIds?, name?, params?, upload? }`，設定後端任務 `type`，按需上傳檔案，並回傳型別化的 `DeckTask`。

### 檔案與圖片

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

### 轉換器

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

有序多來源檔案對將整個檔案陣列對應到後端參數的任務類型有意義，包括 `pptx.join`、`convertor.html2pptx`、`html.buildPlayer` 和 `generation`。大多數其他任務類型只讀取一個來源檔案；此類任務每次傳一個檔案。

### HTML 播放器、生成、翻譯、改版

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
    inputText: '請撰寫一份產品發表會方案',
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

## 瀏覽器與 Node.js 說明

- 任務輔助方法直接接受檔案，在建立任務前上傳。
- Node.js 上傳可讀取路徑並計算 MD5。
- 瀏覽器上傳可使用 `Blob`/`File`；SDK 讀取檔名並計算 MD5。
- Server-Sent Event 訂閱主要面向 Node.js 串流。瀏覽器最可攜的方式是透過 `deck.tasks.wait(taskId, { useEventStream: false })` 輪詢。
