# DeckParse 前端接入文档

本文面向需要在浏览器中把 PDF、PPTX、DOCX、Keynote 或网页解析为 Markdown 的前端开发者。

## 1. 接入目标

前端的标准调用链是：

```text
用户选择文件 → 默认 DeckProbe 本地预检 → parse() 生成 IR → convert() 生成 Markdown → 前端展示或保存结果
```

SDK 使用云端解析服务，不是离线解析。文件输入默认以 `validate` 模式在本地 module Worker/WASM 中完成格式与结构探测；正文 IR 和 Markdown 仍由云端生成。浏览器入口不会访问本地文件系统，也不需要 Node.js polyfill。

## 2. 安装

```bash
npm install @deckflow/deckparse@0.2.0
```

必须从浏览器子路径导入：

```ts
import { createClient } from '@deckflow/deckparse/browser';
```

不要从 `@deckflow/deckparse` 根路径导入前端 SDK；根路径是 Node.js/CLI API。

## 3. 鉴权和 API 地址

### 推荐：通过业务后端代理

```ts
const client = createClient({
  apiBase: '/api/deckparse',
});
```

业务后端负责登录态、权限检查和上游密钥，浏览器只访问同源接口。代理需要保留 DeckParse 的上游 API 路径和请求方法。

### 直接访问 DeckFlow API

只有前端已经取得短期、用户级 Access Token 时才使用：

```ts
const client = createClient({
  apiBase: 'https://app.deckflow.com/v1',
  token: userAccessToken,
  onUnauthorized: async () => {
    return await refreshUserAccessToken();
  },
});
```

禁止把服务端 API Key、永久密钥或其他共享密钥放进前端代码、构建变量或浏览器存储。浏览器 SDK 不提供 `apiKey` 参数。

## 4. 最小可运行示例

HTML：

```html
<input id="document-input" type="file" accept=".pdf,.pptx,.docx,.key" />
<button id="cancel-button" type="button">取消</button>
<pre id="markdown-output"></pre>
```

TypeScript：

```ts
import {
  createClient,
  DeckParseError,
  type BrowserProgress,
} from '@deckflow/deckparse/browser';

const client = createClient({
  apiBase: '/api/deckparse',
});

const input = document.querySelector<HTMLInputElement>('#document-input')!;
const cancelButton = document.querySelector<HTMLButtonElement>('#cancel-button')!;
const output = document.querySelector<HTMLElement>('#markdown-output')!;

let controller: AbortController | undefined;

function showProgress(event: BrowserProgress): void {
  if (event.phase === 'preflight') {
    console.log(`本地预检：${event.status}`);
    return;
  }
  if (event.phase === 'upload') {
    console.log(`上传进度：${Math.round(event.progress * 100)}%`);
    return;
  }

  // taskId 应保存下来，用于断线或超时后的任务恢复。
  console.log(`${event.phase}：${event.status}，taskId=${event.taskId}`);
}

input.addEventListener('change', async () => {
  const file = input.files?.[0];
  if (!file) return;

  controller?.abort();
  controller = new AbortController();
  output.textContent = '解析中…';

  try {
    // 第一步：上传文件并解析为 IR。
    const doc = await client.parse(file, {
      signal: controller.signal,
      timeout: 300, // 单位：秒
      onProgress: showProgress,
    });

    // 第二步：基于刚才的 IR 转为 Markdown，不会再次上传或解析源文件。
    const result = await doc.convert({
      signal: controller.signal,
      timeout: 300,
      onProgress: showProgress,
    });

    console.log({
      parseTaskId: doc.taskId,
      inspection: doc.inspection,
      preflightWarnings: doc.warnings,
      convertTaskId: result.taskId,
      irKey: doc.irKey,
      format: result.format,
      images: result.images,
    });

    output.textContent = result.markdown;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      output.textContent = '已取消';
      return;
    }

    if (error instanceof DeckParseError) {
      console.error({
        code: error.code,
        message: error.message,
        hint: error.hint,
        taskId: error.taskId,
      });
      output.textContent = error.hint ?? error.message;
      return;
    }

    output.textContent = '解析失败，请稍后重试';
    console.error(error);
  }
});

cancelButton.addEventListener('click', () => controller?.abort());
```

## 5. 建议封装成业务函数

```ts
import {
  createClient,
  type BrowserImage,
  type BrowserProgress,
} from '@deckflow/deckparse/browser';

const client = createClient({ apiBase: '/api/deckparse' });

export interface MarkdownDocument {
  markdown: string;
  markdownPages: string[];
  images: BrowserImage[];
  format: 'pdf' | 'pptx' | 'docx' | 'keynote' | 'html';
  parseTaskId: string;
  convertTaskId: string;
  irKey: string;
}

export async function parseFileToMarkdown(
  file: File,
  options: {
    signal?: AbortSignal;
    onProgress?: (event: BrowserProgress) => void;
  } = {},
): Promise<MarkdownDocument> {
  const operationOptions = {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    timeout: 300,
  };

  const doc = await client.parse(file, operationOptions);
  const result = await doc.convert(operationOptions);

  return {
    markdown: result.markdown,
    markdownPages: result.markdownPages ?? [],
    images: result.images,
    format: result.format,
    parseTaskId: doc.taskId,
    convertTaskId: result.taskId,
    irKey: doc.irKey,
  };
}
```

React、Vue、Svelte 等框架只需要在组件中调用这个函数，并把 `markdown`、进度和错误同步到各自的状态管理中。

## 6. 支持的输入

| 输入 | 写法 |
| --- | --- |
| 文件选择器中的文件 | `client.parse(file)` |
| 带文件名的 Blob | `client.parse({ file: blob, name: 'report.pdf' })` |
| 二进制数据 | `client.parse({ file: uint8Array, name: 'slides.pptx' })` |
| 网页 URL | `client.parse({ url: 'https://example.com/article' })` |

支持的文件扩展名：

- `.pdf`
- `.pptx`
- `.docx`
- `.key`

浏览器 SDK 不接受本地路径字符串，例如 `/Users/me/report.pdf`。

### 本地 DeckProbe 预检

```ts
const doc = await client.parse(file); // 默认 preflight: 'validate'

console.log(doc.inspection);              // 格式、加密、页数/幻灯片数等摘要
console.log(await doc.inspectionReport()); // 完整 schema-v2 证据报告
console.log(doc.warnings);                // 宏、外链、嵌入对象等提示
```

- `validate`：CLI、Node SDK、Browser SDK 默认值。格式/容器不匹配和无可用密码的加密文件会在上传前失败；探测预算或运行故障给出 warning 后继续。
- `off`：显式性能/CSP 兼容逃生口，不启动 Worker 或加载 DeckProbe WASM。
- `strict`：只允许显式开启；任何必需事实未解析或探测故障都会在上传前失败。
- URL 输入始终跳过本地探测并返回 warning。

预检按 target 判断，不能只看 DeckProbe 顶层 `partial`；缺少标题等可选元数据不代表文件损坏。DeckProbe 也不是杀毒软件，不会渲染、执行宏或跟随外链。

## 7. 格式参数

### PDF

```ts
const doc = await client.parse(file, {
  profile: 'balanced', // fast | balanced | quality
  includeImages: true,
  password: '可选的 PDF 密码',
});

const result = await doc.convert({
  anchors: true,
});
```

### PPTX / Keynote 按页输出

```ts
const doc = await client.parse(file);
const result = await doc.convert({ splitPages: true });

console.log(result.markdown);       // 完整 Markdown
console.log(result.markdownPages);  // 每页一个字符串
```

`splitPages` 只适用于 PPTX 和 Keynote；`anchors` 只适用于 PDF。参数与格式不匹配时，SDK 会在发请求前报错。

## 8. 返回值

`doc.convert()` 返回的主要字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `markdown` | `string` | 完整 Markdown |
| `markdownPages` | `string[] \| undefined` | 启用 `splitPages` 后的分页结果 |
| `images` | `BrowserImage[]` | Markdown 中引用的图片信息 |
| `format` | `string` | 实际文档格式 |
| `taskId` | `string` | 转换任务 ID |
| `reusedParse` | `true` | 表示转换复用了已生成的 IR |

`doc` 本身包含：

- `doc.taskId`：解析任务 ID
- `doc.irKey`：IR 引用，可在保留期内再次转换
- `doc.type`：解析任务类型
- `doc.inspection`：启用预检时的本地事实摘要
- `doc.inspectionReport()`：完整 DeckProbe schema-v2 报告
- `doc.warnings`：预检未阻断的宏、外链、嵌入对象或运行提示
- `doc.ir()`：获取当前内存中的 IR 数据；只需要 Markdown 时不必调用

## 9. 进度、取消和恢复

进度事件有三类：

```ts
type BrowserProgress =
  | { phase: 'preflight'; status: 'running' | 'completed' }
  | { phase: 'upload'; progress: number }
  | { phase: 'parse' | 'convert'; taskId: string; status: 'pending' | 'running' | 'completed' | 'failed' };
```

注意：

- 上传进度为 `0～1`；小文件可能只报告完成，不保证连续增长。
- 取消预检会立即停止当前调用的等待并且不会开始上传；已经在 Worker 中运行的有界探测可能在后台完成。
- `timeout` 的单位是秒，只限制云端任务等待时间，不限制文件上传耗时；需要中止完整流程时使用 `AbortController`。
- `AbortController.abort()` 会停止浏览器中的上传、请求和等待。
- 如果云端任务已经创建，取消本地请求不会取消或退款云端任务。
- 一旦收到 `parse` 阶段的 `taskId`，应保存它。发生断线或超时时，不要盲目重新上传。

任务恢复示例：

```ts
const task = await client.getTask(savedParseTaskId);

if (task.status === 'completed') {
  const result = await client.convert({ taskId: task.id });
  console.log(result.markdown);
}
```

如果解析时指定了 `spaceId`，恢复任务和再次转换时必须传同一个 `spaceId`。

## 10. 错误处理

业务代码主要处理以下错误码：

| 错误码 | 建议处理 |
| --- | --- |
| `auth_error` | 刷新用户登录态；失败则要求重新登录 |
| `quota_error` | 提示额度不足 |
| `unsupported` | 提示文件格式不支持 |
| `input_error` / `usage_error` | 提示文件或调用参数不正确 |
| `ir_not_found` / `ir_expired` | IR 不存在或已过期，需要重新解析源文件 |
| `backend_error` | 展示失败信息，并结合 `taskId` 排查或恢复 |

不要对未知网络错误自动重复调用 `parse()`。如果任务创建成功但响应在途中断开，自动重试可能产生重复任务。

## 11. Markdown 和图片处理

- `result.markdown` 是文档内容，必须按不可信输入处理。
- 使用前端现有的 Markdown 渲染组件，并开启 HTML/链接协议过滤；不要直接把结果赋给 `innerHTML`。
- `result.images[].ref` 是用于临时预览的签名 URL，可能过期，不能作为永久资源地址。
- 如果业务需要长期保存 Markdown，应由后端下载图片、存入自己的对象存储，并重写 Markdown 中的图片链接。

## 12. 上线前检查

### 使用后端代理时

- [ ] 服务端密钥只存在后端。
- [ ] 代理校验当前用户、租户和 `spaceId` 权限。
- [ ] Cookie 鉴权的写请求已防护 CSRF。
- [ ] 代理支持普通请求、任务事件流、上传和下载相关路径。

### 浏览器直连时

- [ ] 前端使用的是短期、用户级 Token，不是服务端 API Key。
- [ ] API、SSE、签名上传地址、结果下载地址和图片地址都允许业务域名跨域访问。
- [ ] CORS 允许 `X-Auth-Token`、`X-Auth-UUID`、`Content-Type`、`response-event-stream`。
- [ ] 分片上传响应通过 `Access-Control-Expose-Headers` 暴露 `ETag`。

### 功能验收

- [ ] PDF、PPTX、DOCX、Keynote 各验证一个真实文件。
- [ ] 验证大于 4 MiB 的文件上传。
- [ ] 验证进度展示和取消按钮。
- [ ] 验证 Token 过期和刷新失败场景。
- [ ] 验证 Markdown 渲染时的内容安全。
- [ ] 验证图片过期后的业务处理策略。

## 13. 常见问题

### 为什么要先 `parse()`，再 `convert()`？

`parse()` 生成可复用 IR，`convert()` 根据 IR 生成 Markdown。同一个 IR 可以重复转换，不需要再次上传源文件。

### 能不能只调用一个方法直接得到 Markdown？

业务层可以使用本文的 `parseFileToMarkdown()` 封装，对页面来说就是一次调用；SDK 内部仍保留 Parse → Convert 两步，以支持任务恢复和 IR 复用。

### 可以在 SSR 中导入吗？

可以导入 `@deckflow/deckparse/browser`，但 `File` 的获取和实际解析调用应在浏览器端执行。

### SDK 会在浏览器本地保存文件吗？

不会。浏览器接口只接收内存数据并返回内存结果，不创建目录，也不自动持久化 Markdown 或图片。
