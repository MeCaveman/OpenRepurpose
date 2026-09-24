import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];

describe('portable pnpm package materialization', () => {
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { force: true, recursive: true });
  });

  it('promotes the virtual-store dependency view for link-free module resolution', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openrepurpose-materialize-'));
    directories.push(directory);
    const source = join(directory, 'source');
    const destination = join(directory, 'destination');
    const virtualDependency = join(
      source,
      'node_modules',
      '.pnpm',
      'node_modules',
      'fixture-dependency',
    );
    mkdirSync(virtualDependency, { recursive: true });
    writeFileSync(join(virtualDependency, 'package.json'), '{"name":"fixture-dependency"}\n');

    execFileSync(
      process.execPath,
      [join(process.cwd(), 'scripts', 'materialize-package.mjs'), source, destination],
      { stdio: 'pipe' },
    );

    expect(
      existsSync(join(destination, 'node_modules', 'fixture-dependency', 'package.json')),
    ).toBe(true);
  });
});
