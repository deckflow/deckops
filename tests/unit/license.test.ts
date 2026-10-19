import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('distribution license metadata', () => {
  it('declares Apache-2.0 and retains the license and third-party notices in npm files', () => {
    const manifest = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(manifest.license).toBe('Apache-2.0');
    expect(manifest.files).toEqual(expect.arrayContaining(['LICENSE', 'THIRD_PARTY_NOTICES']));
    const license = fs.readFileSync(new URL('../../LICENSE', import.meta.url), 'utf8');
    expect(license).toContain('Apache License');
    expect(license).toContain('Version 2.0, January 2004');
    expect(license).toContain('END OF TERMS AND CONDITIONS');
    expect(fs.readFileSync(new URL('../../skills/deckops/LICENSE', import.meta.url), 'utf8')).toBe(license);
    const notices = fs.readFileSync(new URL('../../THIRD_PARTY_NOTICES', import.meta.url), 'utf8');
    for (const bundled of Object.keys(manifest.dependencies).filter((name) => ['axios', 'eventsource-parser', 'p-limit'].includes(name))) {
      expect(notices).toContain(`\n${bundled}\n`);
    }
    expect(notices).toContain('Permission is hereby granted, free of charge');
  });
});
