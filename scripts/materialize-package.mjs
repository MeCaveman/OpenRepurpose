import { cpSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const [source, destination] = process.argv.slice(2);
if (source === undefined || destination === undefined)
  throw new Error('Usage: node scripts/materialize-package.mjs <source> <destination>');

const sourcePath = resolve(source);
const destinationPath = resolve(destination);
if (!existsSync(sourcePath)) throw new Error(`Package source does not exist: ${sourcePath}`);
if (destinationPath.startsWith(`${sourcePath}\\`) || sourcePath.startsWith(`${destinationPath}\\`))
  throw new Error('Source and destination must not contain one another.');
rmSync(destinationPath, { force: true, recursive: true });
cpSync(sourcePath, destinationPath, { dereference: true, recursive: true });
