import { cpSync, existsSync, rmSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import process from 'node:process';

const [source, destination] = process.argv.slice(2);
if (source === undefined || destination === undefined)
  throw new Error('Usage: node scripts/materialize-package.mjs <source> <destination>');

const sourcePath = resolve(source);
const destinationPath = resolve(destination);
if (!existsSync(sourcePath)) throw new Error(`Package source does not exist: ${sourcePath}`);
function containsPath(parent, child) {
  const pathFromParent = relative(parent, child);
  return pathFromParent === '' || (!pathFromParent.startsWith('..') && !isAbsolute(pathFromParent));
}

const sourceContainsDestination = containsPath(sourcePath, destinationPath);
const destinationContainsSource = containsPath(destinationPath, sourcePath);
if (sourceContainsDestination || destinationContainsSource)
  throw new Error('Source and destination must not contain one another.');
rmSync(destinationPath, { force: true, recursive: true });
cpSync(sourcePath, destinationPath, { dereference: true, recursive: true });
