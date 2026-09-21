import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('web application boundary', () => {
  const appSource = readFileSync(resolve('apps/web/src/App.tsx'), 'utf8');

  it('registers the existing routes, the local model manager, and the not-found boundary', () => {
    const registeredPaths = [
      '/',
      '/setup',
      '/accounts',
      '/sources',
      '/media',
      '/workflows',
      '/jobs',
      '/models',
      '/settings',
    ];

    for (const path of registeredPaths) expect(appSource).toContain(`href: '${path}'`);
    expect(appSource.match(/\bhref: '/g)).toHaveLength(registeredPaths.length);
    expect(appSource).toContain('NotFoundPage');
  });

  it('contains route and shell composition without feature requests or mutations', () => {
    expect(appSource).not.toContain("fetch('/api/");
    expect(appSource).not.toContain('X-CSRF-Token');
    expect(appSource).not.toContain('FormEvent<HTMLFormElement>');
    expect(appSource).toContain('ApplicationShell');
    expect(appSource).toContain('route.render(navigate)');
  });
});
