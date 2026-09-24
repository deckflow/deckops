import { describe, expect, it } from 'vitest';
import { imageAltText } from '../../src/ir/alt-text.js';

/** UTF-8 字节逐个当成 Latin-1 字符：实测替代文字里的乱码就是这样来的（含看不见的 C1 控制字符）。 */
const garbled = (text: string): string => String.fromCharCode(...new TextEncoder().encode(text));

describe('image alt text', () => {
  it('keeps descriptions written by the author', () => {
    expect(imageAltText('Alice')).toBe('Alice');
    expect(imageAltText('kw_skype_logo')).toBe('kw_skype_logo');
    expect(imageAltText('  DNS   message  ')).toBe('DNS message');
    expect(imageAltText('A picture containing screenshot\n\nDescription automatically generated')).toBe('A picture containing screenshot');
  });

  it('drops links, file paths, file names and clip-art cache names', () => {
    for (const junk of [
      'https://d30y9cdsu7xlg0.cloudfront.net/png/219186-200.png',
      'C:\\Users\\Administrator\\Desktop\\埃森哲\\day 1\\QQ截图20161011111029.pngQQ截图20161011111029',
      'timg.jpeg',
      '屏幕快照 2017-02-15 下午12.58.49.png',
      'imgyjavg[1]',
      '屏幕剪辑',
      'See the source image',
      'Picture 3',
      '',
      undefined,
    ]) expect(imageAltText(junk)).toBeUndefined();
  });

  it('strips search boilerplate and repairs UTF-8 read as Latin-1', () => {
    expect(imageAltText(`Image result for ${garbled('中信集团')} logo`)).toBe('中信集团 logo');
    expect(imageAltText('ARTIFICIAL INTELLIGENCE 的图像结果')).toBe('ARTIFICIAL INTELLIGENCE');
    // 真正的 Latin-1 文字不是合法 UTF-8，保持原样。
    expect(imageAltText('café')).toBe('café');
  });
});
