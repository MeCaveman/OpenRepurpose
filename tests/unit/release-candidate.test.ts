import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const read = (path: string) => readFileSync(resolve(repositoryRoot, path), 'utf8');

describe('v1.0 release-candidate matrix', () => {
  it('keeps explicit source, native artifact, Docker, and optional live gates in CI', () => {
    const workflow = read('.github/workflows/ci.yml');

    expect(workflow).toContain('release-candidate-source:');
    expect(workflow).toContain('windows-portable-artifact:');
    expect(workflow).toContain('linux-portable-artifact:');
    expect(workflow).toContain('docker-artifact:');
    expect(workflow).toContain('live-platform-smoke:');
    expect(workflow).toContain("github.event_name == 'workflow_dispatch'");
    expect(workflow).toContain('environment: live-platform-smoke');
    expect(workflow).toContain('Mocked first-party platform contracts');
    expect(workflow).toContain('FFmpeg and subtitle matrix');
    expect(workflow).toContain('title=Windows portable artifact smoke');
  });

  it('runs media verification against packaged code and keeps live checks read-only', () => {
    const mediaSmoke = read('scripts/smoke-release-media.mjs');
    const liveSmoke = read('scripts/smoke-live-platforms.mjs');

    expect(mediaSmoke).toContain("'node_modules',");
    expect(mediaSmoke).toContain('compileTransformCommand');
    expect(mediaSmoke).toContain('FfprobeMediaProbe');
    const stagedWebDistribution = read('scripts/stage-web-distribution.mjs');
    expect(stagedWebDistribution).toContain("'@openrepurpose/server'");
    expect(stagedWebDistribution).toContain("resolve(serverDirectory, 'web', 'dist')");
    expect(read('apps/server/src/app.ts')).toContain('const packagedStaticRoot');
    expect(read('package.json')).toContain('smoke:linux-artifact:docker');
    expect(liveSmoke).toContain('No live platform credential set was supplied');
    expect(liveSmoke).not.toContain('JSON.stringify(process.env)');
    expect(liveSmoke).not.toMatch(/video(?:s)?[./_-](?:insert|upload)/iu);
  });
});
