import { execFileSync } from 'node:child_process';
import process from 'node:process';

const image = `openrepurpose-linux-artifact-smoke:${process.pid}`;
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();

try {
  execFileSync(
    'docker',
    [
      'build',
      '--network',
      'host',
      '--file',
      'scripts/release/Dockerfile.linux-artifact-smoke',
      '--build-arg',
      `OPENREPURPOSE_SOURCE_COMMIT=${sourceCommit}`,
      '--tag',
      image,
      '.',
    ],
    { stdio: 'inherit' },
  );
  process.stdout.write('Linux x64 portable artifact Docker smoke passed.\n');
} finally {
  try {
    execFileSync('docker', ['image', 'rm', '--force', image], { stdio: 'ignore' });
  } catch {
    // The build may fail before creating a tagged image.
  }
}
