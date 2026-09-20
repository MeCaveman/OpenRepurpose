import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SetupPage } from '../../apps/web/src/features/setup/index';

describe('web setup page', () => {
  it('presents configured credential readiness through shared semantic patterns', () => {
    const markup = renderToStaticMarkup(
      createElement(SetupPage, {
        error: undefined,
        isLoading: false,
        onRetry: () => undefined,
        tiktokStatus: {
          configured: true,
          flow: 'desktop',
          redirectUri: 'http://127.0.0.1:3000/api/accounts/tiktok/oauth/callback',
        },
        youtubeStatus: {
          configured: true,
          redirectUri: 'http://127.0.0.1:3000/api/accounts/youtube/oauth/callback',
        },
      }),
    );

    expect(markup).toContain('Destination readiness');
    expect(markup.match(/>Configured</g)).toHaveLength(2);
    expect(markup).toContain('YouTube credentials');
    expect(markup).toContain('TikTok credentials');
    expect(markup).toContain('BYO TikTok Login Kit app · desktop flow');
    expect(markup).toContain('TikTok unaudited clients can publish only');
    expect(markup).toContain('var(--or-status-success-bg)');
    expect(markup).toContain('translate="no"');
  });

  it('distinguishes required setup work from configured destinations', () => {
    const markup = renderToStaticMarkup(
      createElement(SetupPage, {
        error: undefined,
        isLoading: false,
        onRetry: () => undefined,
        tiktokStatus: {
          configured: false,
          flow: 'web',
          redirectUri: 'http://localhost/tiktok-callback',
        },
        youtubeStatus: {
          configured: true,
          redirectUri: 'http://localhost/youtube-callback',
        },
      }),
    );

    expect(markup).toContain('Configured');
    expect(markup).toContain('Action required');
    expect(markup).toContain('var(--or-status-warning-bg)');
    expect(markup).toContain('BYO TikTok Login Kit app · web flow');
  });

  it('uses a stable polite loading region before setup data arrives', () => {
    const markup = renderToStaticMarkup(
      createElement(SetupPage, {
        error: undefined,
        isLoading: true,
        onRetry: () => undefined,
        tiktokStatus: undefined,
        youtubeStatus: undefined,
      }),
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('Checking setup status…');
    expect(markup).not.toContain('Action required');
  });

  it('renders a semantic error without showing speculative readiness', () => {
    const markup = renderToStaticMarkup(
      createElement(SetupPage, {
        error: 'Setup status is unavailable.',
        isLoading: false,
        onRetry: () => undefined,
        tiktokStatus: undefined,
        youtubeStatus: undefined,
      }),
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Setup status unavailable');
    expect(markup).toContain('Setup status is unavailable.');
    expect(markup).toContain('Retry setup check');
    expect(markup).not.toContain('Action required');
  });
});
