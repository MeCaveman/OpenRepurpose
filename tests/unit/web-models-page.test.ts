import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('transcription model manager UI', () => {
  const page = readFileSync(resolve('apps/web/src/features/models/models-page.tsx'), 'utf8');
  const route = readFileSync(resolve('apps/web/src/features/models/models-route.tsx'), 'utf8');

  it('keeps downloads explicit and exposes storage, disk, integrity, and tradeoff details', () => {
    expect(page).toContain('downloads nothing until you choose a model');
    expect(page).toContain('WHISPER_MODEL_DIR');
    expect(page).toContain('diskRequiredBytes');
    expect(page).toContain('languageSupport');
    expect(page).toContain('performance');
    expect(page).toContain('Verify checksum');
    expect(page).toContain('Delete model');
    expect(page).toContain('Download model');
    expect(page).toContain('<Progress');
  });

  it('uses the shared token and primitive layers without a feature-local visual system', () => {
    expect(page).toContain("from '../../components/ui'");
    expect(page).toContain('var(--or-');
    expect(page).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(page).not.toMatch(/rgba?\(/i);
    expect(page).not.toContain('font-sans');
    expect(page).not.toContain('transition-all');
  });

  it('uses CSRF-protected user mutations and polls only while a server download is active', () => {
    expect(route).toContain('getCsrfToken');
    expect(route).toContain("action === 'delete' ? 'DELETE' : 'POST'");
    expect(route).toContain('if (!isDownloading) return');
    expect(route).toContain('window.setInterval');
    expect(route).toContain('window.confirm');
  });
});
