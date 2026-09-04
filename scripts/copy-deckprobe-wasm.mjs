import fs from 'node:fs/promises';
import path from 'node:path';

const source = path.resolve('node_modules/@deckflow/deckprobe/wasm/deckprobe_wasm_bg.wasm');
const destination = path.resolve('dist/browser/deckprobe_wasm_bg.wasm');

await fs.mkdir(path.dirname(destination), { recursive: true });
await fs.copyFile(source, destination);
