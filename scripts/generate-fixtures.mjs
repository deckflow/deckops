/** Deterministic synthetic documents for CI. Never reads or replaces user samples. */
import fs from 'node:fs';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';

const directory = path.resolve(import.meta.dirname, '../tests/generated');
fs.mkdirSync(directory, { recursive: true });
const xml = (body) => `<?xml version="1.0" encoding="UTF-8"?>${body}`;
const relNS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const officeNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const typeNS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const archive = (name, entries) => fs.writeFileSync(path.join(directory, name), zipSync(Object.fromEntries(
  Object.entries(entries).map(([key, value]) => [key, [typeof value === 'string' ? strToU8(value) : value, { mtime: new Date('2020-01-01T00:00:00Z') }]])
)));

const stream = 'BT /F1 18 Tf 40 140 Td (DeckOps deterministic migration document fixture) Tj ET\n';
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
];
let pdf = '%PDF-1.4\n';
const offsets = [];
objects.forEach((body, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${body}\nendobj\n`; });
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
fs.writeFileSync(path.join(directory, 'test.pdf'), pdf);

archive('test.docx', {
  '[Content_Types].xml': xml(`<Types xmlns="${typeNS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`),
  '_rels/.rels': xml(`<Relationships xmlns="${relNS}"><Relationship Id="rId1" Type="${officeNS}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="${officeNS}/extended-properties" Target="docProps/app.xml"/></Relationships>`),
  'word/document.xml': xml('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DeckOps deterministic migration document fixture</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>'),
  'docProps/app.xml': xml('<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Pages>1</Pages></Properties>'),
});
archive('test.pptx', {
  '[Content_Types].xml': xml(`<Types xmlns="${typeNS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`),
  '_rels/.rels': xml(`<Relationships xmlns="${relNS}"><Relationship Id="rId1" Type="${officeNS}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`),
  'ppt/presentation.xml': xml(`<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${officeNS}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`),
  'ppt/_rels/presentation.xml.rels': xml(`<Relationships xmlns="${relNS}"><Relationship Id="rId1" Type="${officeNS}/slide" Target="slides/slide1.xml"/></Relationships>`),
  'ppt/slides/slide1.xml': xml('<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Fixture"/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>DeckOps deterministic migration presentation fixture</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'),
});
// Minimal IWA identity/structure fixture: uncompressed frame, one document
// ArchiveInfo object and one slide component. It is not a local Keynote parser.
const iwa = new Uint8Array([1, 9, 0, 0, 8, 8, 1, 18, 4, 8, 1, 24, 0]);
archive('test.key', {
  'Index/Document.iwa': iwa,
  'Index/Slide.iwa': iwa,
  'Metadata/Properties.plist': xml('<plist version="1.0"><dict><key>fileFormatVersion</key><string>1.0</string><key>isMultiPage</key><true/></dict></plist>'),
});
