import {
  createClient, isDeckOpsError, type ConvertResult, type ExtractJsonResult, type ProgressEvent, type RenderResult,
} from '@deckflow/deckops/browser';

const client = createClient({ apiBase: '/api/deckops', token: 'user-token', spaceId: 'space', onUnauthorized: async () => 'fresh-token' });
const signal = new AbortController().signal;
const onProgress = (event: ProgressEvent): void => {
  if (event.phase === 'task') { event.id satisfies string; event.type satisfies string; event.status satisfies string; }
  else event.progress satisfies number;
};

async function browserConsumer(): Promise<[ConvertResult, ExtractJsonResult, RenderResult]> {
  const file = new File(['bytes'], 'report.pdf');
  const markdown = await client.convert(file, { signal, onProgress, timeout: 120, useEventStream: true, anchors: true });
  markdown.content satisfies string;
  markdown.images[0]?.url satisfies string | undefined;
  markdown.tasks[0]?.id satisfies string | undefined;
  const json = await client.extract(file, { to: 'json', profile: 'quality' });
  json.content satisfies unknown;
  json.schemaVersion satisfies string;
  const assets = await client.extract({ file: new Blob(['bytes']), name: 'slides.pptx' }, { to: 'assets' });
  assets.assets satisfies { url: string; path: string }[];
  await client.convert({ url: 'https://example.com/' });
  await client.convert({ file: new Uint8Array([1]), name: 'document.docx' }, { imageRefs: 'path' });
  const frames = await client.render({ file: new ArrayBuffer(1), name: 'slides.key' }, { to: 'image', pages: [1, 2], imageFormat: 'webp' });
  await frames.outputs[0]?.blob();
  await client.tasks.get(markdown.tasks[0]!.id, { spaceId: 'other-space', signal });
  return [markdown, json, frames];
}
void browserConsumer;

// platform-slide-editor: Markdown and the structured document from one upload.
async function slideEditor(file: File): Promise<[string, unknown]> {
  const markdown = await client.convert(file, { to: 'markdown', onProgress });
  const document = await client.extract(file, { to: 'json' }).catch((error: unknown) => {
    if (isDeckOpsError(error, 'quota_error')) return undefined;
    throw error;
  });
  return [markdown.content, document?.content];
}
void slideEditor;

// @ts-expect-error Server API keys are not part of the browser API.
createClient({ apiKey: 'not-a-browser-credential' });
// @ts-expect-error Local preflight no longer exists.
client.convert(new File(['bytes'], 'report.pdf'), { preflight: 'off' });
// @ts-expect-error Refresh cannot implicitly switch an in-flight operation's space.
createClient({ onUnauthorized: async () => ({ token: 'token', spaceId: 'other' }) });
// @ts-expect-error Bare filesystem paths are Node-only.
client.convert('/tmp/report.pdf');
// @ts-expect-error Render needs a target.
client.render(new File(['bytes'], 'deck.pptx'), {});
// @ts-expect-error There is no parse verb in DeckOps 4.
client.parse(new File(['bytes'], 'report.pdf'));
// @ts-expect-error No filesystem output options in the browser.
client.convert(new File(['bytes'], 'report.pdf'), { out: './report.md' });
// @ts-expect-error Probe runs in Node only.
client.probe(new File(['bytes'], 'report.pdf'));
