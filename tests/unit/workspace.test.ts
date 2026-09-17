import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

const expectedPackages = new Map([
  ['apps/cli', '@openrepurpose/cli'],
  ['apps/server', '@openrepurpose/server'],
  ['apps/web', '@openrepurpose/web'],
  ['packages/core', '@openrepurpose/core'],
  ['packages/db', '@openrepurpose/db'],
  ['packages/media', '@openrepurpose/media'],
  ['packages/platform-sdk', '@openrepurpose/platform-sdk'],
  ['packages/shared', '@openrepurpose/shared'],
  ['packages/testkit', '@openrepurpose/testkit'],
]);

describe('workspace skeleton', () => {
  it.each([...expectedPackages])('declares %s as %s', async (directory, expectedName) => {
    const manifestUrl = new URL(`${directory}/package.json`, `file:///${repositoryRoot}/`);
    const manifest = JSON.parse(await readFile(manifestUrl, 'utf8')) as {
      name?: string;
      private?: boolean;
    };

    expect(manifest).toMatchObject({
      name: expectedName,
      private: true,
    });
  });
});
