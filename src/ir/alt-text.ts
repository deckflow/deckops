/**
 * 图片的替代文字：留下作者写的描述，去掉工具顺手塞进去的东西。
 *
 * 实测两份讲义的 106 条替代文字：一份的 55 条大半是剪贴画缓存名（`imgyjavg[1]`）；另一份的
 * 51 条里有图片网址、QQ 临时文件路径、「Image result for …」「See the source image」这类搜索
 * 引擎的样板话，还有 UTF-8 被当成 Latin-1 读出来的乱码（`ä¸­ä¿¡éå¢` 其实是「中信集团」）。
 * 原样放进 `![…]`，读者看到的是噪声。
 *
 * 能救的救回来：乱码按 Latin-1 → UTF-8 还原，搜索样板话剥掉只留检索词。救不回来的返回
 * undefined，调用方只保留原文于 IR，不再当作描述。
 */
export function imageAltText(raw: string | undefined): string | undefined {
  let text = repairMojibake(raw?.trim() ?? '').replace(/\s+/g, ' ').trim();
  text = text.replace(AUTO_DESCRIPTION_SUFFIX, '').trim();
  for (const pattern of SEARCH_BOILERPLATE) text = text.replace(pattern, '').trim();
  if (!text || JUNK.some((pattern) => pattern.test(text))) return undefined;
  return text;
}

/** 必应、百度、Office 的图片搜索与截图工具写进来的样板话；剥掉它们，剩下的检索词才是描述。 */
const SEARCH_BOILERPLATE: readonly RegExp[] = [
  /^(?:image result for|related image|see the source image)\b:?\s*/i,
  /\s*(?:的图像结果|的图片搜索结果|相关图片)$/,
];

/** Office 自动生成的描述带的尾巴（「A picture containing …  Description automatically generated」）。 */
const AUTO_DESCRIPTION_SUFFIX = /\s*(?:description automatically generated|自动生成的说明)\.?$/i;

const IMAGE_FILE = /\.(?:png|jpe?g|gif|bmp|tiff?|webp|emf|wmf|svg|heic)(?![a-z])/i;

/** 不是描述的替代文字。 */
const JUNK: readonly RegExp[] = [
  /^[a-z][a-z0-9+.-]*:\/\//i, // 网址
  /^www\./i,
  /^[a-z]:\\/i, // Windows 路径
  /^(?:\/|~\/)\S/, // Unix 路径
  IMAGE_FILE, // 文件名：「timg.jpeg」「屏幕快照 2017-02-15 下午12.58.49.png」
  /^[\w-]{3,16}\[\d+\]$/, // Office 剪贴画缓存名「imgyjavg[1]」
  /^(?:屏幕剪辑|屏幕截图|screen ?clipping|screenshot)$/i,
  /^(?:picture|image|img|图片|图像|照片)\s*\d*$/i, // 与形状默认名同样的占位字样
];

/**
 * UTF-8 字节被当成 Latin-1 解码后的乱码：每个字符都落在 U+0000–U+00FF，且字节序列本身是合法
 * UTF-8。真正的 Latin-1 文字（「café」）按 UTF-8 严格解码会失败，保持原样。
 */
function repairMojibake(text: string): string {
  if (!/[\u0080-ÿ]/.test(text) || /[^\u0000-ÿ]/.test(text)) return text;
  try {
    const repaired = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(text, (character) => character.charCodeAt(0)));
    return /[^\u0000-\u007f]/.test(repaired) ? repaired : text;
  } catch {
    return text;
  }
}
