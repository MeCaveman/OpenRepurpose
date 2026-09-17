import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { loadApplicationConfig } from '@openrepurpose/shared';
import { assertLocalOnly, buildServer } from './app.js';
import { loadOrCreateSessionKey } from './session-key.js';

export async function startServer(): Promise<void> {
  const config = loadApplicationConfig();
  assertLocalOnly(config);
  const sessionKey = loadOrCreateSessionKey(config.paths.sessionKeyPath);
  const server = buildServer({ config, logger: true, sessionKey });

  const close = async () => {
    await server.close();
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);

  await server.listen({ host: config.bindHost, port: config.port });
}

function isExecutedDirectly(): boolean {
  return (
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  );
}

if (isExecutedDirectly()) {
  startServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Server startup failed.';
    process.stderr.write(`OpenRepurpose server failed to start: ${message}\n`);
    process.exitCode = 1;
  });
}

export { assertLocalOnly, buildServer } from './app.js';
export { loadOrCreateSessionKey } from './session-key.js';
