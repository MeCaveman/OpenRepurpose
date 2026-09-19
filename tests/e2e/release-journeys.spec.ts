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

test('setup journey reports mocked destination readiness and TikTok audit restriction', async ({
  page,
}) => {
  await serveProductionAssets(page);
  await page.route('**/api/setup', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        tiktok: {
          configured: true,
          clientSecretConfigured: true,
          flow: 'desktop',
          redirectUri: 'http://127.0.0.1:3000/api/accounts/tiktok/oauth/callback',
        },
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
  await expect(page.getByRole('heading', { name: 'Destination readiness' })).toBeVisible();
  await expect(page.getByText('Configured')).toHaveCount(2);
  await expect(page.getByText('TikTok unaudited clients can publish only')).toBeVisible();
  await expect(page.getByText(/youtube\/oauth\/callback/)).toBeVisible();

  await page.setViewportSize({ height: 800, width: 320 });
  await expect(page.getByRole('heading', { name: 'YouTube credentials' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'TikTok credentials' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('Meta accounts journey keeps Facebook Pages and Instagram targets distinct', async ({
  page,
}) => {
  await serveProductionAssets(page);
  await page.route('**/api/session', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ csrfToken: 'csrf' }) }),
  );
  let targetUpdate: { enabled: boolean } | undefined;
  await page.route('**/api/accounts/meta/targets/page-target-1', async (route) => {
    targetUpdate = route.request().postDataJSON() as { enabled: boolean };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({}) });
  });
  await page.route('**/api/accounts', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        accounts: [],
        meta: {
          configured: true,
          redirectUri: 'http://127.0.0.1:3000/api/accounts/meta/oauth/callback',
        },
        metaCredentials: [
          {
            id: 'meta-credential-1',
            externalId: 'meta-user-1',
            displayName: 'Meta Creator',
            status: 'connected',
            scopes: ['pages_show_list', 'pages_manage_posts', 'instagram_content_publish'],
            tokenExpiresAt: '2026-10-01T00:00:00.000Z',
          },
        ],
        metaTargets: [
          {
            id: 'page-target-1',
            credentialId: 'meta-credential-1',
            kind: 'facebook_page',
            displayName: 'Northwind Page',
            pageId: 'page-1',
            enabled: true,
            availability: 'available',
          },
          {
            id: 'instagram-target-1',
            credentialId: 'meta-credential-1',
            kind: 'instagram_professional',
            displayName: 'Northwind Reels',
            username: 'northwind_reels',
            pageId: 'page-1',
            enabled: false,
            availability: 'available',
          },
        ],
      }),
    }),
  );
  await page.goto('/accounts');
  await expect(page.getByRole('heading', { name: 'Platform connections' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Google OAuth credentials' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'TikTok Login Kit credentials' })).toBeVisible();
  await expect(page.getByText('Meta Creator')).toBeVisible();
  await expect(page.getByText('Northwind Page')).toBeVisible();
  await expect(page.getByText('Facebook Page target')).toBeVisible();
  await expect(page.getByText('Northwind Reels')).toBeVisible();
  await expect(page.getByText('Instagram professional target')).toBeVisible();
  await expect(page.getByText('@northwind_reels')).toBeVisible();
  await expect(page.getByRole('checkbox')).toHaveCount(2);
  await page.getByRole('checkbox', { name: /Northwind Page/ }).click();
  await expect.poll(() => targetUpdate).toEqual({ enabled: false });

  await page.setViewportSize({ height: 800, width: 320 });
  await expect(
    page.getByRole('heading', { name: 'Meta app and publishing targets' }),
  ).toBeVisible();
  await expect(page.getByText('Northwind Page')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('remote source journey preserves polling controls and media lifecycle detail', async ({
  page,
}) => {
  await serveProductionAssets(page);
  await page.route('**/api/accounts', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        accounts: [
          {
            id: 'account-1',
            displayName: 'Workshop Channel',
            externalId: 'channel-owner-1',
            provider: 'youtube',
            status: 'connected',
            capabilities: ['youtube.identity.read'],
          },
        ],
        tiktok: {
          configured: false,
          clientSecretConfigured: false,
          flow: 'desktop',
          redirectUri: 'http://127.0.0.1:3000/api/accounts/tiktok/oauth/callback',
        },
        youtube: {
          configured: true,
          clientSecretConfigured: true,
          redirectUri: 'http://127.0.0.1:3000/api/accounts/youtube/oauth/callback',
        },
      }),
    }),
  );
  await page.route('**/api/session', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ csrfToken: 'csrf' }) }),
  );
  let pollRequested = false;
  await page.route('**/api/sources/source-1/poll', async (route) => {
    pollRequested = route.request().method() === 'POST';
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ source: { id: 'source-1', status: 'active' } }),
    });
  });
  await page.route('**/api/sources/source-1', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        source: { id: 'source-1', status: 'active' },
        items: [
          {
            id: 'item-1',
            externalId: 'video-1',
            metadata: { title: 'Workshop introduction' },
            lifecycleStatus: 'observed',
            resolutionStatus: 'unavailable',
            cleanupStatus: 'not_eligible',
          },
        ],
      }),
    }),
  );
  await page.route('**/api/sources', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        sources: [
          {
            adapterId: 'youtube',
            displayName: 'Workshop uploads',
            id: 'source-1',
            lastPollAt: '2026-09-19T10:15:00.000Z',
            lastSuccessfulPollAt: '2026-09-19T10:15:00.000Z',
            status: 'active',
          },
        ],
      }),
    }),
  );

  await page.goto('/sources');
  await expect(page.getByRole('heading', { name: 'Add a YouTube upload source' })).toBeVisible();
  await expect(page.getByRole('option', { name: 'Workshop Channel' })).toBeAttached();
  await expect(page.getByRole('heading', { name: 'Workshop uploads' })).toBeVisible();
  await expect(page.getByText('Active', { exact: true })).toBeVisible();
  await expect(page.getByText('Workshop introduction')).toBeVisible();
  await expect(page.getByText('Resolution · Unavailable')).toBeVisible();
  await expect(page.getByText('Local original required')).toBeVisible();

  await page.getByRole('button', { name: 'Poll now' }).click();
  await expect.poll(() => pollRequested).toBe(true);

  await page.setViewportSize({ height: 800, width: 320 });
  await expect(page.getByRole('button', { name: 'Poll now' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
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
