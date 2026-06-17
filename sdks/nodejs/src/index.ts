import { FilesApi } from './files.js';
import { HttpClient } from './http-client.js';
import { TasksApi } from './tasks.js';
import type {
  CreateDeckOptions,
  DeckTask,
  DeckTaskType,
  TaskShortcutParams,
} from './types.js';

export * from './errors.js';
export * from './types.js';

export interface DeckClient {
  /** API root address used by this client. */
  readonly root: string;
  /** Task APIs. */
  readonly tasks: TasksApi;
  /** File upload APIs. */
  readonly files: FilesApi;
  /** Update X-Auth-Token for future requests. */
  setToken(token: string | undefined): void;
  /** Update Authorization Bearer api key for future requests. */
  setApiKey(apiKey: string | undefined): void;
  /** Update default space id for future requests. */
  setSpaceId(spaceId: string | undefined): void;
  fileCompress(params: TaskShortcutParams<'file.compress'>): Promise<DeckTask<'file.compress'>>;
  imageOcr(params: TaskShortcutParams<'image.ocr'>): Promise<DeckTask<'image.ocr'>>;
  imageConvertWebp(params: TaskShortcutParams<'image.convertWebp'>): Promise<DeckTask<'image.convertWebp'>>;
  imageResize(params: TaskShortcutParams<'image.resize'>): Promise<DeckTask<'image.resize'>>;
  pptxSplit(params: TaskShortcutParams<'pptx.split'>): Promise<DeckTask<'pptx.split'>>;
  pptxJoin(params: TaskShortcutParams<'pptx.join'>): Promise<DeckTask<'pptx.join'>>;
  pptxGetFontInfo(params: TaskShortcutParams<'pptx.getFontInfo'>): Promise<DeckTask<'pptx.getFontInfo'>>;
  pptxGetTextShapes(params: TaskShortcutParams<'pptx.getTextShapes'>): Promise<DeckTask<'pptx.getTextShapes'>>;
  pptxEmbedFonts(params: TaskShortcutParams<'pptx.embedFonts'>): Promise<DeckTask<'pptx.embedFonts'>>;
  convertPptToImage(params: TaskShortcutParams<'convertor.ppt2image'>): Promise<DeckTask<'convertor.ppt2image'>>;
  convertPptToPptx(params: TaskShortcutParams<'convertor.ppt2pptx'>): Promise<DeckTask<'convertor.ppt2pptx'>>;
  convertPptToPdf(params: TaskShortcutParams<'convertor.ppt2pdf'>): Promise<DeckTask<'convertor.ppt2pdf'>>;
  convertDocToPdf(params: TaskShortcutParams<'convertor.doc2pdf'>): Promise<DeckTask<'convertor.doc2pdf'>>;
  convertPptToVideo(params: TaskShortcutParams<'convertor.ppt2video'>): Promise<DeckTask<'convertor.ppt2video'>>;
  convertPdfToImage(params: TaskShortcutParams<'convertor.pdf2image'>): Promise<DeckTask<'convertor.pdf2image'>>;
  convertKeynoteToImage(
    params: TaskShortcutParams<'convertor.keynote2image'>
  ): Promise<DeckTask<'convertor.keynote2image'>>;
  convertKeynoteToHtml(
    params: TaskShortcutParams<'convertor.keynote2html'>
  ): Promise<DeckTask<'convertor.keynote2html'>>;
  convertKeynoteToPdf(
    params: TaskShortcutParams<'convertor.keynote2pdf'>
  ): Promise<DeckTask<'convertor.keynote2pdf'>>;
  convertHtmlToPng(params: TaskShortcutParams<'convertor.html2png'>): Promise<DeckTask<'convertor.html2png'>>;
  convertMarkdownToPng(
    params: TaskShortcutParams<'convertor.markdown2png'>
  ): Promise<DeckTask<'convertor.markdown2png'>>;
  convertHtmlToPptx(params: TaskShortcutParams<'convertor.html2pptx'>): Promise<DeckTask<'convertor.html2pptx'>>;
  htmlBuildPlayer(params: TaskShortcutParams<'html.buildPlayer'>): Promise<DeckTask<'html.buildPlayer'>>;
  generation(params: TaskShortcutParams<'generation'>): Promise<DeckTask<'generation'>>;
  translation(params: TaskShortcutParams<'translation'>): Promise<DeckTask<'translation'>>;
  revamp(params: TaskShortcutParams<'revamp'>): Promise<DeckTask<'revamp'>>;
}

export function createDeck(options: CreateDeckOptions = {}): DeckClient {
  const http = new HttpClient(options);
  const tasks = new TasksApi(http);
  const files = new FilesApi(http);

  const shortcut = <T extends DeckTaskType>(type: T) => {
    return (params: TaskShortcutParams<T>) =>
      tasks.create<T>({
        ...params,
        params: (params.params ?? {}) as never,
        type,
      });
  };

  return {
    root: http.root,
    tasks,
    files,
    setToken: (token) => http.setToken(token),
    setApiKey: (apiKey) => http.setApiKey(apiKey),
    setSpaceId: (spaceId) => http.setSpaceId(spaceId),
    fileCompress: shortcut('file.compress'),
    imageOcr: shortcut('image.ocr'),
    imageConvertWebp: shortcut('image.convertWebp'),
    imageResize: shortcut('image.resize'),
    pptxSplit: shortcut('pptx.split'),
    pptxJoin: shortcut('pptx.join'),
    pptxGetFontInfo: shortcut('pptx.getFontInfo'),
    pptxGetTextShapes: shortcut('pptx.getTextShapes'),
    pptxEmbedFonts: shortcut('pptx.embedFonts'),
    convertPptToImage: shortcut('convertor.ppt2image'),
    convertPptToPptx: shortcut('convertor.ppt2pptx'),
    convertPptToPdf: shortcut('convertor.ppt2pdf'),
    convertDocToPdf: shortcut('convertor.doc2pdf'),
    convertPptToVideo: shortcut('convertor.ppt2video'),
    convertPdfToImage: shortcut('convertor.pdf2image'),
    convertKeynoteToImage: shortcut('convertor.keynote2image'),
    convertKeynoteToHtml: shortcut('convertor.keynote2html'),
    convertKeynoteToPdf: shortcut('convertor.keynote2pdf'),
    convertHtmlToPng: shortcut('convertor.html2png'),
    convertMarkdownToPng: shortcut('convertor.markdown2png'),
    convertHtmlToPptx: shortcut('convertor.html2pptx'),
    htmlBuildPlayer: shortcut('html.buildPlayer'),
    generation: shortcut('generation'),
    translation: shortcut('translation'),
    revamp: shortcut('revamp'),
  };
}
