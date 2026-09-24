import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');

describe('Linux x64 portable release contract', () => {
  it('pins an official Node runtime consistent with the repository toolchain', () => {
    const runtime = JSON.parse(
      readFileSync(resolve(repositoryRoot, 'scripts/release/linux-runtime.json'), 'utf8'),
    ) as { archiveName: string; nodeVersion: string; platform: string; sha256: string };

    expect(runtime.nodeVersion).toBe(
      readFileSync(resolve(repositoryRoot, '.node-version'), 'utf8').trim(),
    );
    expect(runtime.platform).toBe('linux-x64');
    expect(runtime.archiveName).toBe(`node-v${runtime.nodeVersion}-linux-x64.tar.xz`);
    expect(runtime.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('creates a self-contained launcher and isolated XDG smoke workflow', () => {
    const packaging = readFileSync(resolve(repositoryRoot, 'scripts/package-linux.mjs'), 'utf8');
    const smoke = readFileSync(resolve(repositoryRoot, 'scripts/smoke-linux-artifact.sh'), 'utf8');

    expect(packaging).toContain("process.platform !== 'linux' || process.arch !== 'x64'");
    expect(packaging).toContain("'@openrepurpose/cli', 'deploy', '--prod'");
    expect(packaging).toContain('materialize-package.mjs');
    expect(packaging).toContain('node_modules/@openrepurpose/web/dist');
    expect(packaging).toContain("'openrepurpose'");
    expect(packaging).toContain('SHA256SUMS.txt');
    expect(packaging).toContain("'--sort=name'");
    expect(packaging).toContain("'--mtime=@0'");
    expect(smoke).toContain('XDG_CONFIG_HOME="$clean_profile/config"');
    expect(smoke).toContain('XDG_DATA_HOME="$clean_profile/data"');
    expect(smoke).toContain('`${base}/api/health`');
    expect(smoke).toContain('http://127.0.0.1:39100');
  });

  it('documents portable runtime limitations and durable XDG locations', () => {
    const documentation = readFileSync(resolve(repositoryRoot, 'docs/linux-install.md'), 'utf8');

    expect(documentation).toContain('FFmpeg and ffprobe are intentionally external');
    expect(documentation).toContain('~/.config/OpenRepurpose');
    expect(documentation).toContain('~/.local/share/OpenRepurpose');
    expect(documentation).toContain('Linux arm64 is not released in this packet');
  });
});
