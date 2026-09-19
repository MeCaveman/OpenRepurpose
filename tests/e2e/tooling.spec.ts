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

test('application shell prioritizes the workspace at desktop and compact widths', async ({
  page,
}) => {
  await serveProductionAssets(page);
  await page.setViewportSize({ height: 900, width: 1440 });
  await page.goto('/');

  const main = page.getByRole('main');
  await expect(main).toBeVisible();
  await expect(main).toHaveAttribute('aria-labelledby', 'workspace-title');
  await expect(page.locator('[data-shell-region]')).toHaveCount(0);

  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();

  await page.setViewportSize({ height: 800, width: 320 });
  await expect(main).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
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
