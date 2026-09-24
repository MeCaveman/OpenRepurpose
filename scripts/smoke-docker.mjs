import { execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import process from 'node:process';

const suffix = `${process.pid}-${Date.now()}`;
const image = `openrepurpose:rc-smoke-${suffix}`;
const container = `openrepurpose-rc-smoke-${suffix}`;
const port = process.env.OPENREPURPOSE_DOCKER_SMOKE_PORT ?? '39102';
const accessToken = 'release-candidate-local-token-000000000000';
const volumes = ['config', 'data', 'models', 'temp'].map(
  (kind) => `openrepurpose-rc-${kind}-${suffix}`,
);

function docker(arguments_, options = {}) {
  return execFileSync('docker', arguments_, {
    encoding: 'utf8',
    stdio: options.capture === true ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })?.trim();
}

function removeContainer() {
  try {
    docker(['rm', '--force', container], { capture: true });
  } catch {
    // The container may not have been created yet.
  }
}

function startContainer() {
  docker([
    'run',
    '--detach',
    '--name',
    container,
    '--publish',
    `127.0.0.1:${port}:3000`,
    '--env',
    `APP_URL=http://127.0.0.1:${port}`,
    '--env',
    'LAN_ENABLED=true',
    '--env',
    `LAN_ACCESS_TOKEN=${accessToken}`,
    '--volume',
    `${volumes[0]}:/etc/openrepurpose`,
    '--volume',
    `${volumes[1]}:/var/lib/openrepurpose/data`,
    '--volume',
    `${volumes[2]}:/var/lib/openrepurpose/models`,
    '--volume',
    `${volumes[3]}:/var/lib/openrepurpose/tmp`,
    image,
  ]);
}

async function waitForServer() {
  const authorization = `Basic ${Buffer.from(`openrepurpose:${accessToken}`).toString('base64')}`;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const health = await globalThis.fetch(`http://127.0.0.1:${port}/api/health`);
      const ui = await globalThis.fetch(`http://127.0.0.1:${port}/`, {
        headers: { authorization },
      });
      if (
        health.ok &&
        (await health.json()).status === 'ok' &&
        ui.ok &&
        (await ui.text()).includes('<div id="root">')
      )
        return;
    } catch {
      // Startup races are expected until the deadline.
    }
    await new Promise((resolveWait) => globalThis.setTimeout(resolveWait, 250));
  }
  throw new Error('Docker release candidate did not become healthy.');
}

try {
  docker(['build', '--tag', image, '.']);
  for (const volume of volumes) docker(['volume', 'create', volume], { capture: true });

  startContainer();
  await waitForServer();
  const user = docker(['inspect', '--format', '{{.Config.User}}', container], { capture: true });
  if (user !== 'node') throw new Error(`Docker runtime user was ${user || 'empty'}, not node.`);
  docker([
    'exec',
    container,
    'node',
    '-e',
    "require('node:fs').writeFileSync('/var/lib/openrepurpose/data/rc-marker', 'persisted')",
  ]);

  removeContainer();
  startContainer();
  await waitForServer();
  const marker = docker(
    [
      'exec',
      container,
      'node',
      '-e',
      "process.stdout.write(require('node:fs').readFileSync('/var/lib/openrepurpose/data/rc-marker', 'utf8'))",
    ],
    { capture: true },
  );
  if (marker !== 'persisted') throw new Error('Docker data volume did not survive recreation.');
  process.stdout.write('Docker build, health, UI, non-root, and persistence smoke passed.\n');
} finally {
  removeContainer();
  for (const volume of volumes) {
    try {
      docker(['volume', 'rm', '--force', volume], { capture: true });
    } catch {
      // Cleanup remains best-effort after a failed build or start.
    }
  }
  try {
    docker(['image', 'rm', '--force', image], { capture: true });
  } catch {
    // The image may not have been built.
  }
}
