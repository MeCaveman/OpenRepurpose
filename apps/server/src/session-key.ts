import { randomBytes } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const SESSION_KEY_BYTES = 32;

function readSessionKey(path: string): Buffer {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Session key at ${path} must be a regular file, not a link or special file.`);
  }
  const key = readFileSync(path);
  if (key.length !== SESSION_KEY_BYTES) {
    throw new Error(`Session key at ${path} must contain exactly ${SESSION_KEY_BYTES} bytes.`);
  }
  return key;
}

/** Loads a stable local session key, atomically generating it on the first run. */
export function loadOrCreateSessionKey(path: string): Buffer {
  try {
    return readSessionKey(path);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const generatedKey = randomBytes(SESSION_KEY_BYTES);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'wx', 0o600);
    writeFileSync(descriptor, generatedKey);
    return generatedKey;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      return readSessionKey(path);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
