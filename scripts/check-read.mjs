import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'deckops-read-cli-'));
const config = path.join(temp, 'config'); fs.mkdirSync(config);
const env = { ...process.env, DECKOPS_CACHE_DIR: path.join(temp, 'cache with spaces'), DECKOPS_CONFIG_DIR: config, DECKOPS_ENGINE: '', DECKOPS_ALLOW_UPLOAD: '', DECKOPS_FAIL_ON_DEGRADED: '' };
delete env.DECKOPS_ENGINE;
const run = (args, success = true) => { const result = spawnSync(process.execPath, [path.join(root, 'dist/cli.js'), ...args], { cwd: root, env, encoding: 'utf8', timeout: 15000 }); if (success) assert.equal(result.status, 0, result.stderr || result.stdout); else assert.notEqual(result.status, 0); return result; };
try {
 const file = path.join(root, 'tests/generated/test.docx');
 const expected = 'DeckOps deterministic migration document fixture\n';
 assert.equal(run([file]).stdout, expected);
 assert.equal(run(['--engine', 'local', file, '--quiet']).stdout, expected);
 const json = JSON.parse(run([file, '--json']).stdout); assert.equal(json.schemaVersion, 'deckops.read.v1'); assert.equal(json.content, expected);
 const ir = JSON.parse(run([file, '--format', 'ir']).stdout); assert.equal(ir.schemaVersion, 'deckir.v1');
 fs.writeFileSync(path.join(config, 'config.json'), JSON.stringify({ engine: 'auto', allowUpload: true, failOnDegraded: true }));
 assert.equal(JSON.parse(run([file, '--json']).stdout).report.decision.policy.upload, 'allow');
 assert.equal(JSON.parse(run([file, '--engine', 'local', '--json']).stdout).report.decision.policy.upload, 'deny');
 const denied = JSON.parse(run([file, '--no-allow-upload', '--no-fail-on-degraded', '--json']).stdout);
 assert.equal(denied.report.decision.policy.upload, 'deny'); assert.equal(denied.report.decision.policy.acceptance, 'best-effort');
 assert.equal(JSON.parse(run([file, '--output', file, '--json'], false).stdout).schemaVersion, 'deckops.read.v1');
 fs.writeFileSync(path.join(config, 'config.json'), '{}');
 assert.equal(run(['convert', file, '-o', '-']).stdout, expected);
 const converted = JSON.parse(run(['convert', file, '-o', '-', '--json']).stdout); assert.equal(converted.content, expected);
 const out = path.join(temp, 'out.md'), report = path.join(temp, 'run.json');
 assert.equal(run([file, '-o', out, '--report', report]).stdout, ''); assert.equal(fs.readFileSync(out, 'utf8'), expected);
 assert.equal(JSON.parse(fs.readFileSync(report, 'utf8')).schemaVersion, 'deckops.run.v1');
 // Minimal document with an embedded image tests actual Worker output and cache link lifetime.
 const imageDoc = path.join(temp, 'image.docx');
 const parts = {
  '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>Picture example</w:t><w:drawing><a:blip r:embed="r1"/></w:drawing></w:r></w:p></w:body></w:document>',
  'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/a.png"/></Relationships>',
 };
 fs.writeFileSync(imageDoc, zipSync({ ...Object.fromEntries(Object.entries(parts).map(([k,v]) => [k,strToU8(v)])), 'word/media/a.png': Buffer.from('89504e470d0a1a0a','hex') }));
 const picture = JSON.parse(run([imageDoc, '--preflight', 'off', '--json']).stdout);
 assert.ok(picture.assets.length); assert.ok(picture.content.includes('%20')); for(const asset of picture.assets) assert.ok(fs.existsSync(asset.path));
 const imageOut = path.join(temp, 'portable.md'); const written = JSON.parse(run([imageDoc, '-o', imageOut, '--preflight', 'off', '--json']).stdout);
 for(const asset of written.assets) { assert.equal(asset.lifecycle, 'output'); assert.ok(fs.existsSync(asset.path)); }
 assert.ok(fs.readFileSync(imageOut, 'utf8').includes('portable.assets-'));
 const pdf = JSON.parse(run([path.join(root, 'tests/generated/test.pdf'), '--json']).stdout); assert.equal(pdf.report.selected.parseEngine, 'local');
 assert.equal(JSON.parse(run(['capabilities', '--json']).stdout).schemaVersion, 'deckops.capabilities.v1');
 console.log('Built CLI content contract passed: stdout/JSON, config precedence, IR, images, PDF Worker, portable output and legacy convert.');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
