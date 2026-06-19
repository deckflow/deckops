**言語:** [English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [Français](README.fr.md) | [Español](README.es.md) | [Русский](README.ru.md) | **日本語**

# @deckops/sdk

Deckops/Deckflow タスク API 用の Node.js/ブラウザ対応 SDK。

## インストール

```bash
pnpm add @deckops/sdk
```

この monorepo 内:

```bash
pnpm --filter @deckops/sdk build
```

## クライアントの作成

```ts
import { createDeck } from '@deckops/sdk';

const deck = createDeck({
  root: 'https://app.deckflow.com/v1',
  token: 'user-token',
  apiKey: 'api-key',
  spaceId: 'space-id',
});
```

オプション:

- `root?: string` - API のルートアドレス。デフォルトは `https://app.deckflow.com/v1`。
- `token?: string` - `X-Auth-Token` ヘッダーで送信。
- `apiKey?: string` - `Authorization: Bearer {apiKey}` として送信。
- `spaceId?: string` - タスクとファイル呼び出しのデフォルト space id。
- `authUuid?: string` - 明示的なクライアント UUID（UUID v4）を `X-Auth-UUID` で送信。自動永続化をスキップ。
- `authUuidStorage?: { get(), set(value) }` - クライアント UUID のカスタムストレージ（SSR、テスト、組み込みアプリ）。
- `onUnauthorized?: () => Promise<{ token: string; spaceId?: string } | string>` - 401 後に一度呼び出され、リクエストが再試行される。
- `onPaymentRequired?: () => Promise<void>` - 402 後に一度呼び出され、リクエストが再試行される。

すべての Deckops API リクエストには、セッション間でクライアントを追跡するための安定した UUID v4 である `X-Auth-UUID` が自動的に含まれます。

- **ブラウザ**: `localStorage` の `df_uuid` キーに永続化。
- **Node.js**: `~/.deckops/auth-uuid` に永続化（`DECKOPS_CONFIG_DIR` でディレクトリを上書き可能）。
- **明示的な上書き**: CI、コンテナ、マルチテナントサーバーで固定 ID を使う場合は `authUuid` を渡すか `DECKOPS_AUTH_UUID`（Node のみ）を設定。

```ts
const uuid = await deck.getAuthUuid();
console.log('Client UUID:', uuid);
```

## ファイル付きでタスクを作成

ユーザーが選択したファイルをタスクメソッドに直接渡します。SDK は内部でアップロードし、得られた file id をタスク API に送信します:

```ts
const task = await deck.convertPptToPdf({
  files: ['./slides.pptx'],
  upload: {
    onProgress: (p) => console.log(`${Math.round(p * 100)}%`),
  },
});
```

`files` は以下をサポート:

- Node.js ファイルパス: `'./a.pptx'`
- Node.js/ブラウザのバイナリデータ: `Uint8Array` または `ArrayBuffer`
- ブラウザの `Blob`/`File`

ブラウザのファイルピッカーでは、選択した `File` オブジェクトを渡します:

```ts
await deck.convertPptToPdf({
  files: [file],
});
```

ファイル名のないバイナリデータには、ファイルごとのアップロードオプションを含めます:

```ts
await deck.imageOcr({
  files: [{ input: bytes, name: 'image.png' }],
  params: { language: 'en' },
});
```

既存の統合との互換性のため、`fileIds` も引き続き受け付け、`files` と組み合わせ可能です。

## 汎用タスク API

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

タスク詳細レスポンスはステータス/進捗メタデータ用です。タスク結果は `deck.tasks.down(...)` またはバックエンド別名 `deck.ttask.down(...)` から読み取ってください。

```ts
const result = await deck.ttask.down<'convertor.ppt2pdf'>(task.id);
const generationDownload = await deck.ttask.down<'generation'>(task.id, { type: 'pptx' });
console.log(generationDownload.downloadUrl);
```

## 結果型

SDK は `DeckTaskTypeResult` を通じて、各タスクタイプの具体的な結果型をエクスポートします。

ファイルを生成するタスクの多くは、バックエンド契約に従いタプル形式のファイル結果を返します:

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

`path` は生のバックエンドデータにおけるストレージキーまたは相対パスです。タスク詳細 API がダウンロード可能な結果を展開する場合、すでに署名付き/アクセス URL になっていることがあります。

例:

- `deck.convertPptToPdf(...)` は `ConvertFileResult[]` を返す。
- `deck.convertHtmlToPptx(...)` は `{ target: FileResult; usedFonts: string[] }` を返す。
- `deck.pptxSplit(...)` は型付きスライドファイルメタデータを含む `{ ppt, sections, slides }` を返す。
- `deck.pptxGetFontInfo(...)` は `{ fonts, embeddedFont, subsetFont }` を返す。
- `deck.pptxGetTextShapes(...)` は型付きのページ/シェイプ/テキスト/画像メタデータを返す。

## 型付きタスクヘルパー

各ヘルパーは `{ spaceId?, files?, fileIds?, name?, params?, upload? }` を受け取り、バックエンドタスクの `type` を設定し、必要に応じてファイルをアップロードし、型付きの `DeckTask` を返します。

### ファイルと画像

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

### コンバーター

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

ファイル配列全体をバックエンドパラメータにマッピングするタスクタイプ（`pptx.join`、`convertor.html2pptx`、`html.buildPlayer`、`generation` を含む）では、複数ソースファイルの順序が意味を持ちます。他のほとんどのタスクタイプは1つのソースファイルのみを読み取るため、それらにはタスクごとに1ファイルを渡してください。

### HTML プレーヤー、生成、翻訳、リバンプ

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
    inputText: '製品ローンチプランを書いてください',
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

## ブラウザと Node.js に関する注意

- タスクヘルパーはファイルを直接受け取り、タスク作成前にアップロードします。
- Node.js でのアップロードはパスを読み取り MD5 を計算できます。
- ブラウザでのアップロードは `Blob`/`File` を使用可能。SDK はファイル名を読み取り MD5 を計算します。
- Server-Sent Event サブスクリプションは主に Node.js ストリーム向けです。ブラウザでは `deck.tasks.wait(taskId, { useEventStream: false })` によるポーリングが最も移植性の高い方法です。
