import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');

describe('Windows x64 portable release contract', () => {
  it('pins a Node runtime consistent with the repository toolchain', () => {
    const runtime = JSON.parse(
      readFileSync(resolve(repositoryRoot, 'scripts/release/windows-runtime.json'), 'utf8'),
    ) as { archiveName: string; nodeVersion: string; platform: string; sha256: string };

    expect(runtime.nodeVersion).toBe(
      readFileSync(resolve(repositoryRoot, '.node-version'), 'utf8').trim(),
    );
    expect(runtime.platform).toBe('win32-x64');
    expect(runtime.archiveName).toBe(`node-v${runtime.nodeVersion}-win-x64.zip`);
    expect(runtime.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('builds a self-contained launcher and clean-profile smoke workflow', () => {
    const packaging = readFileSync(resolve(repositoryRoot, 'scripts/package-windows.ps1'), 'utf8');
    const smoke = readFileSync(
      resolve(repositoryRoot, 'scripts/smoke-windows-artifact.ps1'),
      'utf8',
    );

    expect(packaging).toContain('pnpm --filter @openrepurpose/cli deploy --prod');
    expect(packaging).not.toContain('deploy --prod --legacy');
    expect(packaging).toContain('materialize-package.mjs');
    expect(packaging).toContain('node_modules\\@openrepurpose\\web\\dist');
    expect(packaging).toContain('openrepurpose.cmd');
    expect(packaging).toContain('SHA256SUMS.txt');
    expect(packaging).toContain('THIRD_PARTY_NOTICES.md');
    expect(packaging).toContain("'LICENSE') -Destination $staging");
    expect(packaging).toContain("'docs\\licenses') (Join-Path $staging 'docs\\licenses')");
    expect(packaging).toContain('ZipFile]::CreateFromDirectory');
    expect(smoke).toContain("$env:APPDATA = Join-Path $cleanProfile 'Roaming'");
    expect(smoke).toContain("'http://127.0.0.1:39100/api/health'");
  });

  it('makes every runtime workspace package direct for pnpm portable deployment', () => {
    const cliPackage = JSON.parse(
      readFileSync(resolve(repositoryRoot, 'apps/cli/package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };
    expect(Object.keys(cliPackage.dependencies)).toEqual(
      expect.arrayContaining([
        '@openrepurpose/meta',
        '@openrepurpose/platform-sdk',
        '@openrepurpose/twitch',
      ]),
    );
  });

  it('documents redistributed dependency provenance and keeps unaudited media tools external', () => {
    const notices = readFileSync(resolve(repositoryRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    expect(notices).toContain('FFmpeg/ffprobe');
    expect(notices).toContain('whisper.cpp executable');
    expect(notices).toContain('SIL Open Font License 1.1');
    expect(notices).toContain('scripts/release/windows-runtime.json');
    expect(notices).toContain('AGPL-3.0-only');
  });
});
