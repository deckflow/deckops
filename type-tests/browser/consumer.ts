import { createClient, type BrowserConvertResult, type BrowserProgress } from '@deckflow/deckops/browser';

const client = createClient({ apiBase: '/api/deckops' });
const signal = new AbortController().signal;
const onProgress = (event: BrowserProgress): void => {
  if (event.phase === 'upload') event.progress satisfies number;
  else { event.taskId satisfies string; event.spaceId satisfies string; }
};

async function browserConsumer(): Promise<BrowserConvertResult> {
  const doc = await client.parse<{ document: unknown }>(new File(['bytes'], 'report.pdf'), { signal, onProgress });
  (await doc.ir()).document satisfies unknown;
  await client.parse({ file: new Blob(['bytes']), name: 'slides.pptx' });
  await client.parse({ file: new Uint8Array([1]), name: 'document.docx' });
  await client.parse({ file: new ArrayBuffer(1), name: 'slides.key' });
  await client.parse({ url: 'https://example.com/' }, { mode: 'source' });
  await client.getTask(doc.taskId, { spaceId: 'other-space', signal });
  return doc.convert({ anchors: true, signal });
}
void browserConsumer;

// platform-slide-editor: parse with progress, read the IR, derive Markdown.
async function slideEditor(file: File): Promise<string> {
  const doc = await client.parse(file, { onProgress });
  const ir = await doc.ir();
  void ir;
  const view = await doc.convert();
  return view.markdown;
}
void slideEditor;

// @ts-expect-error Server API keys are not part of the browser API.
createClient({ apiKey: 'not-a-browser-credential' });
// @ts-expect-error Local preflight no longer exists.
client.parse(new File(['bytes'], 'report.pdf'), { preflight: 'off' });
// @ts-expect-error Refresh cannot implicitly switch an in-flight operation's space.
createClient({ onUnauthorized: async () => ({ token: 'token', spaceId: 'other' }) });
// @ts-expect-error Bare filesystem paths are Node-only.
client.parse('/tmp/report.pdf');
// @ts-expect-error A Blob without a filename is not a complete input.
client.parse(new Blob(['bytes']));
// @ts-expect-error Browser results have no artifact directory option.
client.parse(new File(['bytes'], 'report.pdf'), { out: './artifact' });
// @ts-expect-error Convert takes an IR reference, never a source file.
client.convert(new File(['bytes'], 'report.pdf'));
// @ts-expect-error References are exclusive.
client.convert({ irKey: 'key', taskId: 'task' });
// @ts-expect-error No implicit persistent cache or filesystem-only flags.
client.convert({ irKey: 'key' }, { force: true });
