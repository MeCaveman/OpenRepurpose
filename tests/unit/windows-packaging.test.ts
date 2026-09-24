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
    expect(packaging).toContain('Dependency installation failed with exit code');
    expect(packaging).toContain('Production build failed with exit code');
    expect(packaging).toContain('Production deployment failed with exit code');
    expect(packaging).not.toContain('deploy --prod --legacy');
    expect(packaging).toContain('materialize-package.mjs');
    expect(packaging.match(/'apps\\cli\\dist'\) \(Join-Path \$app 'dist'\)/gu)).toHaveLength(2);
    expect(
      readFileSync(resolve(repositoryRoot, 'scripts/materialize-package.mjs'), 'utf8'),
    ).toContain("'.pnpm', 'node_modules'");
    expect(packaging).toContain('stage-web-distribution.mjs');
    expect(packaging).toContain('Could not stage the web distribution');
    expect(packaging).toContain('openrepurpose.cmd');
    expect(packaging).toContain('SHA256SUMS.txt');
    expect(packaging).toContain('THIRD_PARTY_NOTICES.md');
    expect(packaging).toContain("'LICENSE') -Destination $staging");
    expect(packaging).toContain("'docs') (Join-Path $staging 'docs')");
    expect(packaging).toContain("@('README.md', 'SECURITY.md', 'CONTRIBUTING.md')");
    expect(packaging).toContain('ZipFile]::CreateFromDirectory');
    expect(smoke).toContain("$env:APPDATA = Join-Path $cleanProfile 'Roaming'");
    expect(smoke).toContain('Remove-Item -LiteralPath $cleanProfile -Recurse -Force');
    expect(smoke).toContain('$extractDeadline = [DateTime]::UtcNow.AddMinutes(3)');
    expect(smoke).toContain('Start-Sleep -Seconds 1');
    expect(smoke).toContain("'http://127.0.0.1:39100/api/health'");
    expect(smoke).toContain('backup create --output');
    expect(smoke).toContain("'smoke-release-media.mjs'");
    expect(smoke).toContain('Start-Process -FilePath $bundledNode');
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
