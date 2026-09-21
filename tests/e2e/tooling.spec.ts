import { existsSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { WHISPER_CPP_MODEL_CATALOG } from '../../packages/media/src/index';

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
  await expect(page).toHaveTitle('Dashboard · OpenRepurpose');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Your media pipeline');
  await expect(page.getByText('Local only')).toBeVisible();

  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
  await expect(page).toHaveTitle('Settings · OpenRepurpose');
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

test('settings maps existing configuration without inventing controls', async ({ page }) => {
  await serveProductionAssets(page);
  await page.goto('/settings');

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
  await expect(page.getByRole('heading', { name: 'Configuration ownership' })).toBeVisible();

  const areas = page.getByRole('list', { name: 'Configuration areas' });
  await expect(areas.getByRole('link')).toHaveCount(4);
  await expect(areas.getByRole('link', { name: /Review setup/ })).toHaveAttribute('href', '/setup');
  await expect(areas.getByRole('link', { name: /Manage accounts/ })).toHaveAttribute(
    'href',
    '/accounts',
  );
  await expect(areas.getByRole('link', { name: /Manage models/ })).toHaveAttribute(
    'href',
    '/models',
  );
  await expect(areas.getByRole('link', { name: /Manage workflows/ })).toHaveAttribute(
    'href',
    '/workflows',
  );
  await expect(page.getByRole('heading', { name: 'Installation policy' })).toBeVisible();
  await expect(page.getByText('No in-app global preference controls')).toBeVisible();
  await expect(
    page.locator('main input, main select, main textarea, main [role="switch"]'),
  ).toHaveCount(0);

  await page.setViewportSize({ height: 800, width: 320 });
  await expect(areas).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('model manager requires explicit downloads and stays usable across audited viewports', async ({
  page,
}) => {
  await serveProductionAssets(page);
  await page.route('http://openrepurpose.test/api/session', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ csrfToken: 'csrf' }) }),
  );
  let status: 'not-installed' | 'downloading' | 'installed' = 'not-installed';
  let readsAfterStart = 0;
  await page.route('http://openrepurpose.test/api/transcription/models**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'POST' && pathname.endsWith('/download')) {
      status = 'downloading';
      readsAfterStart = 0;
      await route.fulfill({
        contentType: 'application/json',
        status: 202,
        body: JSON.stringify({ model: { id: 'base', status } }),
      });
      return;
    }
    if (request.method() === 'POST' && pathname.endsWith('/verify')) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ model: { id: 'base', status: 'installed', integrity: 'verified' } }),
      });
      return;
    }
    if (request.method() === 'DELETE') {
      status = 'not-installed';
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ model: { id: 'base', status } }),
      });
      return;
    }
    if (status === 'downloading') {
      readsAfterStart += 1;
      if (readsAfterStart > 1) status = 'installed';
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        availableBytes: 8 * 1024 ** 3,
        reserveBytes: 256 * 1024 ** 2,
        storagePath: 'C:\\OpenRepurpose\\models\\whisper-cpp',
        models: WHISPER_CPP_MODEL_CATALOG.map((entry) => ({
          ...entry,
          diskRequiredBytes: entry.sizeBytes + 256 * 1024 ** 2,
          diskWarning: false,
          status: entry.id === 'base' ? status : 'not-installed',
          integrity: entry.id === 'base' && status === 'installed' ? 'verified' : 'not-installed',
          ...(entry.id === 'base' && status === 'downloading'
            ? {
                progress: {
                  downloadedBytes: 71 * 1024 ** 2,
                  totalBytes: 142 * 1024 ** 2,
                  percent: 50,
                },
              }
            : {}),
        })),
      }),
    });
  });

  await page.goto('/models');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Transcription models');
  await expect(page.getByText('downloads nothing until you choose a model')).toBeVisible();
  const baseRow = page.getByRole('listitem').filter({ hasText: 'Base · Multilingual' });
  await expect(baseRow.getByRole('button', { name: 'Download model' })).toBeVisible();
  await baseRow.getByRole('button', { name: 'Download model' }).click();
  await expect(page.getByText('Download started.')).toBeVisible();
  await expect(page.getByText('Installed · verified')).toBeVisible();
  await baseRow.getByRole('button', { name: 'Verify checksum' }).click();
  await expect(page.getByText('matches its published checksum')).toBeVisible();

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 412, height: 915 },
    { width: 768, height: 1024 },
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(page.getByRole('heading', { name: 'Whisper model catalog' })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    if (viewport.width <= 412) {
      const activeModelNavigation = page
        .locator('[data-navigation-mode="compact"]')
        .getByRole('link', { name: 'Models' });
      await expect(activeModelNavigation).toHaveAttribute('aria-current', 'page');
      await expect
        .poll(() =>
          activeModelNavigation.evaluate((element) => {
            const item = element.getBoundingClientRect();
            const navigation = element.parentElement?.getBoundingClientRect();
            return (
              navigation !== undefined &&
              item.left >= navigation.left &&
              item.right <= navigation.right
            );
          }),
        )
        .toBe(true);
    }
    if (process.env.CAPTURE_MODEL_MANAGER === '1' && viewport.width === 390)
      await page.screenshot({
        path: 'test-results/model-manager-mobile.png',
        fullPage: true,
      });
    if (process.env.CAPTURE_MODEL_MANAGER === '1' && viewport.width === 1440)
      await page.screenshot({
        path: 'test-results/model-manager-desktop.png',
        fullPage: true,
      });
  }

  page.once('dialog', (dialog) => dialog.accept());
  await baseRow.getByRole('button', { name: 'Delete model' }).click();
  await expect(baseRow.getByRole('button', { name: 'Download model' })).toBeVisible();
});

test('transcript editor saves cues and preserves the audited workbench boundaries', async ({
  page,
}) => {
  await serveProductionAssets(page);
  let revision = 1;
  let cueText = 'Opening caption';
  await page.route('http://openrepurpose.test/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/session') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ csrfToken: 'csrf' }),
      });
      return;
    }
    if (url.pathname === '/api/media') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          media: [
            {
              id: 'media-1',
              metadata: { durationSeconds: 7, height: 1080, width: 1920 },
              path: 'C:\\clips\\episode one.mp4',
              state: 'available',
            },
          ],
        }),
      });
      return;
    }
    if (url.pathname === '/api/accounts') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ accounts: [] }),
      });
      return;
    }
    if (url.pathname === '/api/media/media-1/transcripts') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          transcripts: [
            {
              cues: [{ startMs: 0, endMs: 1_250, text: cueText }],
              hasUserEdits: revision > 1,
              id: 'transcript-1',
              language: 'en',
              model: { id: 'base', version: 'v1' },
              providerId: 'whisper-cpp',
              revision,
              updatedAt: new Date(0).toISOString(),
            },
          ],
        }),
      });
      return;
    }
    if (url.pathname === '/api/transcripts/transcript-1' && request.method() === 'PUT') {
      const body = request.postDataJSON() as {
        readonly cues: readonly { readonly text: string }[];
        readonly expectedRevision: number;
      };
      expect(body.expectedRevision).toBe(revision);
      cueText = body.cues[0]!.text;
      revision += 1;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          transcript: {
            cues: [{ startMs: 0, endMs: 1_250, text: cueText }],
            hasUserEdits: true,
            id: 'transcript-1',
            language: 'en',
            model: { id: 'base', version: 'v1' },
            providerId: 'whisper-cpp',
            revision,
            updatedAt: new Date(1).toISOString(),
          },
        }),
      });
      return;
    }
    if (url.pathname === '/api/transcripts/transcript-1/export') {
      await route.fulfill({
        contentType: 'text/vtt; charset=utf-8',
        headers: { 'Content-Disposition': 'attachment; filename="transcript.vtt"' },
        body: `WEBVTT\n\n00:00:00.000 --> 00:00:01.250\n${cueText}\n`,
      });
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: '{}', status: 404 });
  });

  await page.goto('/media');
  await page.getByRole('button', { name: 'Transcript' }).click();
  await expect(page.getByRole('heading', { name: 'Edit episode one.mp4' })).toBeVisible();
  await expect(page.getByLabel('Start')).toHaveValue('00:00:00.000');
  await expect(page.getByLabel('End')).toHaveValue('00:00:01.250');

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 412, height: 915 },
    { width: 768, height: 1024 },
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(page.getByRole('heading', { name: 'Edit episode one.mp4' })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    if (viewport.width === 1366)
      await expect(page.getByRole('heading', { name: 'Media ledger' })).not.toBeVisible();
    if (viewport.width >= 1440)
      await expect(page.getByRole('heading', { name: 'Media ledger' })).toBeVisible();
    if (viewport.width <= 412) {
      const saveHeight = await page
        .getByRole('button', { name: 'Save transcript' })
        .evaluate((element) => element.getBoundingClientRect().height);
      expect(saveHeight).toBeGreaterThanOrEqual(44);
    }
    if (process.env.CAPTURE_TRANSCRIPT_EDITOR === '1' && viewport.width === 390)
      await page.screenshot({
        path: 'test-results/transcript-editor-mobile.png',
        fullPage: true,
      });
    if (process.env.CAPTURE_TRANSCRIPT_EDITOR === '1' && viewport.width === 1440)
      await page.screenshot({
        path: 'test-results/transcript-editor-desktop.png',
        fullPage: true,
      });
  }

  await page.getByLabel('End').fill('00:00:00.000');
  await page.getByRole('button', { name: 'Save transcript' }).click();
  await expect(page.getByText('End time must be later than start time.')).toBeVisible();
  await page.getByLabel('End').fill('00:00:01.250');
  await page.getByLabel('Caption text').fill('Edited caption أهلاً');
  await page.getByRole('button', { name: 'Save transcript' }).click();
  await expect(page.getByText('Your cue text and timestamps are persisted locally.')).toBeVisible();
  expect(cueText).toBe('Edited caption أهلاً');

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export VTT' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('transcript-1.vtt');
});

test('unknown routes provide a direct workbench recovery path', async ({ page }) => {
  await serveProductionAssets(page);
  await page.goto('/not-a-current-view');

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'This local view does not exist.',
  );
  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Return to the local workbench' })).toBeVisible();
  await page.getByRole('link', { name: 'Open Dashboard' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Your media pipeline');

  await page.goBack();
  await expect(page).toHaveURL(/\/not-a-current-view$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'This local view does not exist.',
  );
  await page.goForward();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Your media pipeline');
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
  await page.setViewportSize({ height: 768, width: 1366 });
  await page.route('http://openrepurpose.test/api/session', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ csrfToken: 'csrf' }) }),
  );
  let cancellationRequested = false;
  await page.route('http://openrepurpose.test/api/jobs**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/jobs/job-1/cancel' && route.request().method() === 'POST') {
      cancellationRequested = true;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ job: { id: 'job-1', status: 'retrying' } }),
      });
      return;
    }
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
              createdAt: '2026-09-18T12:00:00.000Z',
              ...(cancellationRequested
                ? { cancellationRequestedAt: '2026-09-18T12:03:00.000Z' }
                : {}),
              lastErrorCode: 'FAKE_TRANSIENT',
              lastErrorMessage: 'Temporary fake failure.',
              destination: {
                destinationId: 'youtube',
                remoteId: 'remote-1',
                remoteStatus: 'processing',
                uploadedBytes: 1572864,
              },
            },
          ],
        }),
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        job: {
          id: 'job-1',
          type: 'fake.publish',
          status: 'retrying',
          attemptCount: 1,
          maxAttempts: 3,
        },
        destination: {
          destinationId: 'youtube',
          remoteId: 'remote-1',
          remoteStatus: 'processing',
          uploadedBytes: 1572864,
        },
        attempts: [
          {
            attemptNumber: 1,
            status: 'failed',
            errorCode: 'FAKE_TRANSIENT',
            errorMessage: 'Temporary fake failure.',
            startedAt: '2026-09-18T12:01:00.000Z',
            finishedAt: '2026-09-18T12:02:00.000Z',
          },
        ],
      }),
    });
  });

  await page.goto('/jobs');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Jobs');
  await expect(page.getByRole('heading', { name: 'Execution ledger' })).toBeVisible();
  await expect(page.getByText('Retrying').first()).toBeVisible();
  await expect(page.getByText('youtube · processing').first()).toBeVisible();
  const jobTrigger = page.getByRole('button', { name: /fake\.publish/ });
  await jobTrigger.click();
  await expect(page.getByRole('heading', { name: 'Attempt history' })).toBeFocused();
  await expect(jobTrigger).toBeHidden();
  await expect(page.getByText('Attempt 1')).toBeVisible();
  await expect(page.getByText('Failed')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Destination checkpoint' })).toBeVisible();

  await page.setViewportSize({ height: 900, width: 1440 });
  await expect(jobTrigger).toBeVisible();

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect.poll(() => cancellationRequested).toBe(true);
  await expect(page.getByRole('button', { name: 'Cancellation requested' })).toBeDisabled();

  await page.getByRole('button', { name: 'Close details' }).click();
  await expect(page.getByRole('heading', { name: 'Attempt history' })).toBeHidden();
  await expect(jobTrigger).toBeFocused();

  await page.setViewportSize({ height: 800, width: 320 });
  await expect(page.getByRole('button', { name: /fake\.publish/ })).toBeVisible();
  await page.getByRole('button', { name: /fake\.publish/ }).click();
  await expect(page.getByRole('heading', { name: 'Attempt history' })).toBeVisible();
  await expect(page.getByRole('button', { name: /fake\.publish/ })).toBeHidden();
  await page.getByRole('button', { name: 'Close details' }).click();
  await expect(page.getByRole('button', { name: /fake\.publish/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('transform jobs expose live progress, inspection, and cancellation', async ({ page }) => {
  await serveProductionAssets(page);
  await page.setViewportSize({ height: 844, width: 390 });
  await page.route('http://openrepurpose.test/api/session', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ csrfToken: 'csrf' }) }),
  );
  let listRequests = 0;
  let cancellationRequested = false;
  const transform = (percent: number) => ({
    id: 'derivative-1',
    status: cancellationRequested ? 'cancelled' : 'running',
    progress: { outTimeMillis: 12_000, percent, speed: 1.2 },
    provenance: {
      encoder: 'libx264',
      ffmpegVersion: 'ffmpeg 8.0.1',
      outputProfileVersion: 'common-mp4-v1',
      recipeHash: 'sha256:recipe',
      sourceMediaId: 'media-1',
      normalizedPlan: {
        user: { steps: [{ type: 'fit', mode: 'crop', width: 1080, height: 1920 }] },
      },
    },
  });
  await page.route('http://openrepurpose.test/api/jobs**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/jobs/job-transform/cancel' && route.request().method() === 'POST') {
      cancellationRequested = true;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ job: { id: 'job-transform', status: 'running' } }),
      });
      return;
    }
    if (pathname === '/api/jobs') {
      listRequests += 1;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          jobs: [
            {
              id: 'job-transform',
              type: 'media.transform',
              status: 'running',
              attemptCount: 1,
              maxAttempts: 3,
              ...(cancellationRequested
                ? { cancellationRequestedAt: '2026-09-20T12:03:00.000Z' }
                : {}),
              transform: transform(listRequests === 1 ? 25 : 62.5),
            },
          ],
        }),
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        job: {
          id: 'job-transform',
          type: 'media.transform',
          status: 'running',
          attemptCount: 1,
          maxAttempts: 3,
          ...(cancellationRequested ? { cancellationRequestedAt: '2026-09-20T12:03:00.000Z' } : {}),
        },
        transform: transform(listRequests === 1 ? 25 : 62.5),
        attempts: [{ attemptNumber: 1, status: 'running' }],
      }),
    });
  });

  await page.goto('/jobs');
  await expect(page.getByText('62.5%').last()).toBeVisible();
  expect(listRequests).toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: /media\.transform/ }).click();
  await expect(page.getByRole('heading', { name: 'Derivative inspection' })).toBeVisible();
  await expect(page.getByText('derivative-1')).toBeVisible();
  await expect(page.getByText('1080 × 1920 · crop')).toBeVisible();

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect.poll(() => cancellationRequested).toBe(true);
  await expect(page.getByRole('button', { name: 'Cancellation requested' })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
