import path from 'node:path';
import './generate-fixtures.mjs';
import { fileURLToPath } from 'node:url';
import { createFakeCloud } from '../tests/browser/fake-cloud.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.DECKOPS_SMOKE_PORT ?? '0');
const cloud = await createFakeCloud();
const website = await createFakeCloud({ staticRoot: root, port });
console.log(`Browser SDK smoke test: ${website.origin}/?apiOrigin=${encodeURIComponent(cloud.origin)}`);
console.log('Open the page and click Run browser checks. Requests stay on localhost; no cloud credentials are used.');
console.log('The API uses a second localhost origin to exercise CORS and exposed multipart ETag headers.');
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => { await Promise.all([cloud.close(), website.close()]); process.exit(0); });
}
