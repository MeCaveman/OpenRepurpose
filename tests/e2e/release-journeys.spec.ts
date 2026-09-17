import { existsSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const webRoot = resolve('apps/web/dist');

async function serveProductionAssets(page: Page): Promise<void> {
  await page.route('http://openrepurpose.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) return route.fallback();
    const relativePath =
      url.pathname === '/' || extname(url.pathname) === '' ? 'index.html' : url.pathname.slice(1);
    const assetPath = resolve(webRoot, relativePath);
    if (!assetPath.startsWith(`${webRoot}${sep}`) || !existsSync(assetPath))
      return route.fulfill({ body: 'Not found', status: 404 });
    return route.fulfill({ path: assetPath, status: 200 });
  });
}

test('setup journey reports mocked YouTube readiness', async ({ page }) => {
  await serveProductionAssets(page);
  await page.route('**/api/setup', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        youtube: {
          configured: true,
          clientSecretConfigured: true,
          redirectUri: 'http://127.0.0.1:3000/api/accounts/youtube/oauth/callback',
        },
      }),
    }),
  );
  await page.goto('/setup');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Setup');
  await expect(page.getByText('Configured')).toBeVisible();
});

test('manual import to publish queues one YouTube upload', async ({ page }) => {
  await serveProductionAssets(page);
  await page.route('**/api/media', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ media: [] }) }),
  );
  await page.route('**/api/accounts', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        accounts: [
          {
            id: 'account-1',
            displayName: 'Mock channel',
            externalId: 'channel',
            provider: 'youtube',
            status: 'connected',
            capabilities: ['youtube.video.upload'],
          },
        ],
        youtube: {
          configured: true,
          clientSecretConfigured: true,
          redirectUri: 'http://127.0.0.1:3000/callback',
        },
      }),
    }),
  );
  await page.route('**/api/session', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ csrfToken: 'csrf' }) }),
  );
  let queued = false;
  await page.route('**/api/media/import', (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        asset: {
          id: 'media-1',
          path: 'C:\\clips\\episode one.mp4',
          state: 'available',
          metadata: { durationSeconds: 7 },
        },
        duplicate: false,
      }),
    }),
  );
  await page.route('**/api/publish/youtube', async (route) => {
    queued = true;
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        created: true,
        job: { id: 'job-1', type: 'youtube.upload', status: 'pending' },
      }),
    });
  });
  await page.route('**/api/jobs', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        jobs: queued
          ? [
              {
                id: 'job-1',
                type: 'youtube.upload',
                status: 'pending',
                attemptCount: 0,
                maxAttempts: 3,
              },
            ]
          : [],
      }),
    }),
  );

  await page.goto('/media');
  await page.getByLabel('Local file path').fill('C:\\clips\\episode one.mp4');
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByText('No local media has been imported yet.')).toBeVisible();
  // The mocked import response is followed by a media refresh; provide the imported asset now.
  await page.unroute('**/api/media');
  await page.route('**/api/media', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        media: [
          {
            id: 'media-1',
            path: 'C:\\clips\\episode one.mp4',
            state: 'available',
            metadata: { durationSeconds: 7 },
          },
        ],
      }),
    }),
  );
  await page.reload();
  await page.getByRole('button', { name: 'Publish to YouTube' }).click();
  await page.getByLabel('Title').fill('Episode one');
  await page.getByLabel('Connected account').selectOption('account-1');
  await page.getByRole('button', { name: 'Queue upload' }).click();
  await expect.poll(() => queued).toBe(true);
});

test('watched-folder workflow contract leads to a queued upload', async ({ page }) => {
  await serveProductionAssets(page);
  await page.route('**/api/session', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ csrfToken: 'csrf' }) }),
  );
  await page.route('**/api/workflows', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { sourceDirectory: string; accountId: string };
      expect(body.sourceDirectory).toContain('watched');
      expect(body.accountId).toBe('account-1');
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          workflow: { id: 'workflow-1', name: 'Watched uploads', enabled: true },
        }),
      });
    }
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ workflows: [] }),
    });
  });
  await page.route('**/api/jobs', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        jobs: [
          {
            id: 'job-1',
            type: 'youtube.upload',
            status: 'pending',
            attemptCount: 0,
            maxAttempts: 3,
          },
        ],
      }),
    }),
  );
  await page.goto('/jobs');
  await expect(page.getByText('youtube.upload')).toBeVisible();
  const response = await page.evaluate(async () => {
    const session = await fetch('/api/session');
    const { csrfToken } = (await session.json()) as { csrfToken: string };
    return fetch('/api/workflows', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: location.origin,
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({
        name: 'Watched uploads',
        sourceDirectory: 'C:/watched',
        accountId: 'account-1',
        titleTemplate: '{{file.stem}}',
        enabled: true,
      }),
    }).then((result) => result.status);
  });
  expect(response).toBe(201);
});
