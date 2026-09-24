import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../..');

describe('Docker deployment artifacts', () => {
  it('declares and includes the selected project license', async () => {
    const rootPackage = JSON.parse(
      readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'),
    ) as { license: string };
    const license = await readFile(resolve(repositoryRoot, 'LICENSE'), 'utf8');

    expect(rootPackage.license).toBe('AGPL-3.0-only');
    expect(license).toContain('GNU AFFERO GENERAL PUBLIC LICENSE');
    expect(license).toContain('Version 3, 19 November 2007');
  });

  it('keeps the image lean, non-root, and avoids bundling unaudited media binaries', async () => {
    const dockerfile = await readFile(resolve(repositoryRoot, 'Dockerfile'), 'utf8');

    expect(dockerfile).toContain(
      'FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build',
    );
    expect(dockerfile).toContain(
      'FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS runtime',
    );
    expect(dockerfile).toContain('pnpm deploy --filter @openrepurpose/server --prod');
    expect(dockerfile).toContain('COPY LICENSE THIRD_PARTY_NOTICES.md ./');
    expect(dockerfile).toContain('COPY docs/licenses ./docs/licenses');
    expect(dockerfile).not.toMatch(/(?:apt-get|apk|dnf).*ffmpeg/i);
    expect(dockerfile).not.toMatch(/\bffmpeg\b/i);
    expect(dockerfile).toContain('/workspace/LICENSE ./LICENSE');
    expect(dockerfile).toContain('/workspace/THIRD_PARTY_NOTICES.md ./THIRD_PARTY_NOTICES.md');
    expect(dockerfile).toContain('USER node');
    expect(dockerfile).not.toMatch(/(TOKEN|SECRET|CLIENT_SECRET|OAUTH).*=\S+/i);
  });

  it('requires runtime credentials and declares intentional persistent/media mounts', async () => {
    const compose = await readFile(resolve(repositoryRoot, 'docker-compose.yml'), 'utf8');

    expect(compose).toContain('LAN_ACCESS_TOKEN: ${LAN_ACCESS_TOKEN:?');
    expect(compose).toContain('127.0.0.1:3000:3000');
    expect(compose).toContain('openrepurpose-config:/etc/openrepurpose');
    expect(compose).toContain('openrepurpose-data:/var/lib/openrepurpose/data');
    expect(compose).toContain('openrepurpose-models:/var/lib/openrepurpose/models');
    expect(compose).toContain('./media:/media:ro');
    expect(compose).not.toContain('LAN_ACCESS_TOKEN: "');
  });

  it('has an engine-backed smoke that proves health, non-root execution, and persistence', async () => {
    const smoke = await readFile(resolve(repositoryRoot, 'scripts/smoke-docker.mjs'), 'utf8');

    expect(smoke).toContain("docker(['build', '--tag', image, '.'])");
    expect(smoke).toContain("'{{.Config.User}}'");
    expect(smoke).toContain('/api/health');
    expect(smoke).toContain('rc-marker');
    expect(smoke).not.toContain('shell: true');
  });
});
