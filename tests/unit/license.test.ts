import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('distribution license metadata', () => {
  it('declares AGPL-3.0-only and retains the license and third-party notices in npm files', () => {
    const manifest = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(manifest.license).toBe('AGPL-3.0-only');
    expect(manifest.files).toEqual(expect.arrayContaining(['LICENSE', 'THIRD_PARTY_NOTICES']));
    const license = fs.readFileSync(new URL('../../LICENSE', import.meta.url), 'utf8');
    expect(license).toContain('GNU AFFERO GENERAL PUBLIC LICENSE');
    expect(license).toContain('Version 3, 19 November 2007');
    expect(license).toContain('13. Remote Network Interaction');
    expect(license).toContain('END OF TERMS AND CONDITIONS');
    const notices = fs.readFileSync(new URL('../../THIRD_PARTY_NOTICES', import.meta.url), 'utf8');
    expect(notices).toContain('PDF.js / pdfjs-dist');
    expect(notices).toContain('Apache License 2.0');
    expect(notices).toContain('Copyright 2020 Arjun Barrett');
    expect(notices).toContain('ISC License');
  });
});
