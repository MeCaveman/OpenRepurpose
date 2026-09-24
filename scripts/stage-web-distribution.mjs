import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import process from 'node:process';

const [appDirectory, webDistribution] = process.argv.slice(2).map((path) => resolve(path));
if (appDirectory === undefined || webDistribution === undefined)
  throw new Error(
    'Usage: node scripts/stage-web-distribution.mjs <app-directory> <web-distribution>',
  );
if (!existsSync(resolve(webDistribution, 'index.html')))
  throw new Error('The web production distribution is missing after build.');

const serverDirectories = [];
function discoverServerDirectories(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const entryPath = resolve(directory, entry.name);
    if (entry.name === 'server' && basename(directory) === '@openrepurpose') {
      const packagePath = resolve(entryPath, 'package.json');
      if (
        existsSync(packagePath) &&
        JSON.parse(readFileSync(packagePath, 'utf8')).name === '@openrepurpose/server'
      )
        serverDirectories.push(entryPath);
    }
    discoverServerDirectories(entryPath);
  }
}

discoverServerDirectories(resolve(appDirectory, 'node_modules'));
if (serverDirectories.length === 0)
  throw new Error('The deployed application does not contain @openrepurpose/server.');

for (const serverDirectory of serverDirectories) {
  const destination = resolve(serverDirectory, '..', 'web', 'dist');
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(webDistribution))
    cpSync(resolve(webDistribution, entry), resolve(destination, entry), {
      recursive: true,
    });
}
