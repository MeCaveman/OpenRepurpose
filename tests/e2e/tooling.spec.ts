import { existsSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const webRoot = resolve('apps/web/dist');

async function serveProductionAssets(page: Page): Promise<void> {
  await page.route('http://openrepurpose.test/**', async (route) => {
    const url = new URL(route.request().url());
    const relativePath =
      url.pathname === '/' || extname(url.pathname) === '' ? 'index.html' : url.pathname.slice(1);
    const assetPath = resolve(webRoot, relativePath);
    if (!assetPath.startsWith(`${webRoot}${sep}`) || !existsSync(assetPath)) {
      await route.fulfill({ body: 'Not found', status: 404 });
      return;
    }
    await route.fulfill({ path: assetPath, status: 200 });
  });
}

test('React shell navigates between local tool sections', async ({ page }) => {
  await serveProductionAssets(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Your media pipeline');
  await expect(page.getByText('Local only')).toBeVisible();

  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
  await expect(page.getByRole('link', { name: 'Settings' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('overview routes operators through existing source, workflow, and destination views', async ({
  page,
}) => {
  await serveProductionAssets(page);
  await page.goto('/');

  const sequence = page.getByRole('list', { name: 'Route setup sequence' });
  await expect(sequence.getByRole('link')).toHaveCount(3);
  await expect(sequence.getByRole('link').nth(0)).toContainText('Sources');
  await expect(sequence.getByRole('link').nth(1)).toContainText('Workflows');
  await expect(sequence.getByRole('link').nth(2)).toContainText('Destinations');

  await page.setViewportSize({ height: 800, width: 320 });
  await expect(sequence).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  await sequence.getByRole('link', { name: /Sources/ }).click();
  await expect(page).toHaveURL(/\/sources$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sources');
});

test('application shell prioritizes the workspace at desktop and compact widths', async ({
  page,
}) => {
  await serveProductionAssets(page);
  await page.setViewportSize({ height: 900, width: 1440 });
  await page.goto('/');

  const main = page.getByRole('main');
  await expect(main).toBeVisible();
  await expect(main).toHaveAttribute('aria-labelledby', 'workspace-title');
  await expect(page.locator('[data-shell-region="resource-rail"]')).toBeVisible();
  await expect(page.locator('[data-navigation-mode="compact"]')).toBeHidden();
  await expect(page.locator('[data-shell-region="navigator"]')).toHaveCount(0);
  await expect(page.locator('[data-shell-region="inspector"]')).toHaveCount(0);
  await expect(page.locator('[data-shell-region="activity"]')).toHaveCount(0);

  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();

  await page.setViewportSize({ height: 800, width: 800 });
  await expect(page.locator('[data-shell-region="resource-rail"]')).toBeHidden();
  await expect(page.locator('[data-navigation-mode="compact"]')).toBeVisible();

  await page.setViewportSize({ height: 800, width: 320 });
  await expect(main).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('[data-navigation-mode="compact"]')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('job history renders persisted status and attempt detail', async ({ page }) => {
  await serveProductionAssets(page);
  await page.route('http://openrepurpose.test/api/jobs**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/jobs') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          jobs: [
            {
              id: 'job-1',
              type: 'fake.publish',
              status: 'retrying',
              attemptCount: 1,
              maxAttempts: 3,
              lastErrorCode: 'FAKE_TRANSIENT',
              lastErrorMessage: 'Temporary fake failure.',
            },
          ],
        }),
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        job: { id: 'job-1', type: 'fake.publish', status: 'retrying' },
        attempts: [
          {
            attemptNumber: 1,
            status: 'failed',
            errorCode: 'FAKE_TRANSIENT',
            errorMessage: 'Temporary fake failure.',
          },
        ],
      }),
    });
  });

  await page.goto('/jobs');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Jobs');
  await expect(page.getByText('retrying')).toBeVisible();
  await page.getByRole('button', { name: /fake\.publish/ }).click();
  await expect(page.getByRole('heading', { name: 'Attempt history' })).toBeVisible();
  await expect(page.getByText(/#1 · failed/)).toBeVisible();
});
