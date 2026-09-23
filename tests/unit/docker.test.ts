import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../..');

describe('Docker deployment artifacts', () => {
  it('keeps the image lean, non-root, and FFmpeg-capable', async () => {
    const dockerfile = await readFile(resolve(repositoryRoot, 'Dockerfile'), 'utf8');

    expect(dockerfile).toContain('FROM node:24-bookworm-slim AS build');
    expect(dockerfile).toContain('pnpm deploy --filter @openrepurpose/server --prod');
    expect(dockerfile).toContain(
      'apt-get install --yes --no-install-recommends ca-certificates ffmpeg',
    );
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
});
