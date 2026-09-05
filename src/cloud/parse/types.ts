/** 支持解析的格式，与 IR 信封的 `format` 一一对应。 */
export type IrFormat = 'pdf' | 'pptx' | 'docx' | 'keynote' | 'html';

/**
 * 每个 parse 任务结果都带的两个字段，指向这次解析存下来的 IR。
 *
 * 拿着 `irKey` 就能在保留期内反复调 `deck.convert()` 派生不同 View，源文件不必再传一次。
 */
export interface IrResult {
  /** 已存储 IR 的 key */
  irKey: string;
  /** 该 IR 的版本标签，convert 的门禁按它判断认不认 */
  irSchemaVersion: string;
}

/** IR 保留期：7 天。过期后引用会得到 `irExpired`，重新 parse 即可。 */
export const IR_RETENTION_DAYS = 7;

/** IR 中被引用的二进制资源。**只存持久 key，不存带效期的地址。** */
export interface IrResource {
  /** body 里引用这份资源用的标识：pdf 用工件内相对路径，pptx 用 zip 内路径，其余即 key */
  ref: string;
  key: string;
  bytes: number;
  hash: string;
  /** 建议的落盘相对路径，形如 `assets/p1_i0000.png` */
  suggestedPath: string;
}

/**
 * IR 信封：自描述信头 + 解析器原样输出。
 *
 * 这是 IR 的**存储形态**。parse 任务的响应仍是扁平的（`slides` / `content` / `document`
 * 直接在顶层），信封只在存储里出现，`deck.convert()` 按 `irKey` 读它。
 */
export interface IrEnvelope<B = unknown> {
  format: IrFormat;
  schemaVersion: string;
  producer: { name: string; version: string };
  source: { sha256?: string; name?: string; bytes?: number };
  /** ISO 8601 */
  createdAt: string;
  body: B;
  resources?: IrResource[];
}

// ------------------------------------------------------------------- convert

/** convert 支持的 View 目标。v1 只有 markdown，枚举位是给后续 html / text 预留的。 */
export type ConvertTarget = 'markdown';

/** 分页 markdown 的页分隔符，`markdown.split(PAGE_SEPARATOR)` 可还原分页。 */
export const PAGE_SEPARATOR = '\n\n---\n\n';

/**
 * convert 交付的图片清单，四种格式同一形状。
 *
 * 下游据此把 markdown 里的图片下载到本地并改写为相对路径 —— 因为正文里的地址带有效期，
 * 直接存盘几小时后就是死链。
 */
export interface ConvertImage {
  /** 该图片在 markdown 正文里出现的引用，即现签的访问地址 */
  ref: string;
  /** OSS 持久 key */
  key: string;
  /** 建议落盘相对路径 */
  suggestedPath: string;
  bytes?: number;
  hash?: string;
}

export interface ConvertTaskParams {
  /** 已存储 IR 的 key，与 `taskId` 二选一 */
  irKey?: string;
  /** 产出该 IR 的 parse 任务 id，与 `irKey` 二选一 */
  taskId?: string;
  /** 目标 View，默认 markdown */
  to?: ConvertTarget;
  /** pdf：markdown 是否写入逐元素溯源注释，默认 false（注释体积通常是正文的数倍） */
  markdownMeta?: boolean;
  /** 分页格式（pptx / keynote）：是否额外返回逐页数组 */
  markdownPages?: boolean;
  /** 渲染失败时抛错；默认 false，容错返回 `markdownError` */
  markdownStrict?: boolean;
}

export interface ConvertTaskResult {
  /** IR 的格式，由信封给出而不是调用方声明 */
  format: IrFormat;
  schemaVersion: string;
  to: ConvertTarget;
  /** 完整 markdown；分页格式按页用 `PAGE_SEPARATOR` 连接 */
  markdown: string;
  /** 逐页 markdown，仅 `markdownPages: true` 且格式分页时返回 */
  markdownPages?: string[];
  /** 容错模式下渲染失败的原因；有它就说明 markdown 不可信 */
  markdownError?: string;
  images: ConvertImage[];
}
