import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkForUpdate, createCli } from '../../apps/cli/src/index.js';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const read = (path: string) => readFileSync(resolve(repositoryRoot, path), 'utf8');

describe('v1.0 release mechanics', () => {
  it('keeps workspace manifests and runtime surfaces on the same product version', async () => {
    for (const manifest of [
      'package.json',
      'apps/cli/package.json',
      'apps/server/package.json',
      'apps/web/package.json',
      'packages/core/package.json',
      'packages/db/package.json',
      'packages/local-secrets/package.json',
      'packages/media/package.json',
      'packages/shared/package.json',
      'packages/platform-sdk/package.json',
      'packages/testkit/package.json',
      'integrations/youtube/package.json',
      'integrations/tiktok/package.json',
      'integrations/meta/package.json',
      'integrations/twitch/package.json',
      'integrations/kick/package.json',
    ])
      expect(JSON.parse(read(manifest)) as { version: string }).toMatchObject({ version: '1.0.0' });

    expect(read('apps/server/src/app.ts')).toContain('OPENREPURPOSE_VERSION');
    expect(read('apps/server/src/api-v1.ts')).toContain('OPENREPURPOSE_VERSION');
    expect(read('apps/server/src/mcp.ts')).toContain('OPENREPURPOSE_VERSION');
    let output = '';
    await createCli({ write: (chunk) => (output += chunk) }).parseAsync([
      'node',
      'openrepurpose',
      'version',
    ]);
    expect(output).toBe('1.0.0\n');
  });

  it('checks an explicit GitHub latest-release endpoint without downloading an update', async () => {
    const update = await checkForUpdate(
      'https://api.github.com/repos/openrepurpose/openrepurpose/releases/latest',
      async () =>
        new Response(
          JSON.stringify({
            html_url: 'https://github.com/openrepurpose/openrepurpose/releases/tag/v1.0.1',
            tag_name: 'v1.0.1',
          }),
          { status: 200 },
        ),
    );
    expect(update).toEqual({
      currentVersion: '1.0.0',
      latestVersion: '1.0.1',
      notesUrl: 'https://github.com/openrepurpose/openrepurpose/releases/tag/v1.0.1',
      updateAvailable: true,
    });
  });

  it('keeps portable checksums, optional signatures, release notes, and published-artifact verification in the release workflow', () => {
    const workflow = read('.github/workflows/release.yml');
    expect(workflow).toContain('OpenRepurpose-windows-x64.zip.sha256');
    expect(workflow).toContain('OpenRepurpose-linux-x64.tar.xz.sha256');
    expect(workflow).toContain('OPENREPURPOSE_RELEASE_SIGNING_KEY');
    expect(workflow).toContain('gh release create');
    expect(workflow).toContain('gh release download');
    expect(workflow).toContain('smoke-windows-artifact.ps1');
    expect(workflow).toContain('smoke-linux-artifact.sh');
    expect(read('scripts/release-artifacts.mjs')).toContain('SHA256SUMS.txt');
    expect(read('docs/release-notes/v1.0.0.md')).toContain('Verify before installing');
  });
});
