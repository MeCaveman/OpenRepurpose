import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AccountsPage } from '../../apps/web/src/features/accounts/index';
import type { AccountsPageProps } from '../../apps/web/src/features/accounts/index';

function accountsProps(overrides: Partial<AccountsPageProps> = {}): AccountsPageProps {
  return {
    accounts: [],
    activeAction: undefined,
    error: undefined,
    feedback: { meta: null, tiktok: null, youtube: null },
    isLoading: false,
    meta: {
      clientId: '',
      clientSecret: '',
      credentials: [],
      status: {
        configured: true,
        redirectUri: 'http://127.0.0.1:3000/api/accounts/meta/oauth/callback',
      },
      targets: [],
    },
    onConnectMeta: () => undefined,
    onConnectTikTok: () => undefined,
    onConnectYouTube: () => undefined,
    onMetaClientIdChange: () => undefined,
    onMetaClientSecretChange: () => undefined,
    onMetaTargetChange: () => undefined,
    onRediscoverMetaTargets: () => undefined,
    onRemoveAccount: () => undefined,
    onRetry: () => undefined,
    onSaveMeta: () => undefined,
    onSaveTikTok: () => undefined,
    onSaveYouTube: () => undefined,
    onTikTokClientKeyChange: () => undefined,
    onTikTokClientSecretChange: () => undefined,
    onYouTubeClientIdChange: () => undefined,
    onYouTubeClientSecretChange: () => undefined,
    tiktok: {
      capabilities: {},
      clientKey: '',
      clientSecret: '',
      status: {
        configured: true,
        flow: 'desktop',
        redirectUri: 'http://127.0.0.1:3000/api/accounts/tiktok/oauth/callback',
      },
    },
    youtube: {
      clientId: '',
      clientSecret: '',
      status: {
        configured: true,
        redirectUri: 'http://127.0.0.1:3000/api/accounts/youtube/oauth/callback',
      },
    },
    ...overrides,
  };
}

describe('web accounts page', () => {
  it('uses labeled token-backed credential forms for every current provider', () => {
    const markup = renderToStaticMarkup(createElement(AccountsPage, accountsProps()));

    expect(markup).toContain('Platform connections');
    expect(markup).toContain('Google OAuth credentials');
    expect(markup).toContain('Meta app and publishing targets');
    expect(markup).toContain('TikTok Login Kit credentials');
    expect(markup).toContain('name="youtube-client-id"');
    expect(markup).toContain('name="meta-client-secret"');
    expect(markup).toContain('name="tiktok-client-key"');
    expect(markup.match(/translate="no"/g)).toHaveLength(3);
    expect(markup).toContain('var(--or-bg-surface)');
    expect(markup).not.toMatch(/(?:slate|cyan|emerald|rose|amber)-/);
  });

  it('keeps Meta identities and publishing targets distinct and status-labeled', () => {
    const props = accountsProps({
      activeAction: 'meta-target:page-target-1',
      meta: {
        clientId: '',
        clientSecret: '',
        credentials: [
          {
            displayName: 'Meta Creator',
            externalId: 'meta-user-1',
            id: 'meta-credential-1',
            scopes: ['pages_show_list', 'instagram_content_publish'],
            status: 'connected',
            tokenExpiresAt: '2026-10-01T00:00:00.000Z',
          },
        ],
        status: {
          configured: true,
          redirectUri: 'http://127.0.0.1:3000/api/accounts/meta/oauth/callback',
        },
        targets: [
          {
            availability: 'available',
            credentialId: 'meta-credential-1',
            displayName: 'Northwind Page',
            enabled: true,
            id: 'page-target-1',
            kind: 'facebook_page',
            pageId: 'page-1',
          },
          {
            availability: 'unavailable',
            blocker: 'App review required',
            credentialId: 'meta-credential-1',
            displayName: 'Northwind Reels',
            enabled: false,
            id: 'instagram-target-1',
            kind: 'instagram_professional',
            pageId: 'page-1',
            username: 'northwind_reels',
          },
        ],
      },
    });
    const markup = renderToStaticMarkup(createElement(AccountsPage, props));

    expect(markup).toContain('Meta Creator');
    expect(markup).toContain('Northwind Page');
    expect(markup).toContain('Facebook Page target');
    expect(markup).toContain('Northwind Reels');
    expect(markup).toContain('Instagram professional target · @northwind_reels');
    expect(markup).toContain('Permission/review blocker: App review required');
    expect(markup).toContain('Updating…');
    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain('disabled=""');
  });

  it('renders connected account capabilities and request feedback without color-only state', () => {
    const props = accountsProps({
      accounts: [
        {
          capabilities: ['youtube.video.upload', 'youtube.identity.read'],
          displayName: 'Workshop Channel',
          externalId: 'channel-1',
          id: 'account-1',
          provider: 'youtube',
          status: 'connected',
        },
      ],
      feedback: { meta: 'error', tiktok: 'error', youtube: 'connected' },
    });
    const markup = renderToStaticMarkup(createElement(AccountsPage, props));

    expect(markup).toContain('YouTube connected');
    expect(markup).toContain('TikTok connection failed');
    expect(markup).toContain('Meta connection failed');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Workshop Channel');
    expect(markup).toContain('>Connected<');
    expect(markup).toContain('Upload: allowed');
    expect(markup).toContain('Identity: available');
  });

  it('shows stable action progress and an operational empty state', () => {
    const markup = renderToStaticMarkup(
      createElement(
        AccountsPage,
        accountsProps({ activeAction: 'youtube-save', youtube: accountsProps().youtube }),
      ),
    );

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('Saving credentials…');
    expect(markup).toContain('No publishing accounts');
    expect(markup).toContain('Save platform credentials and connect a publishing account');
  });

  it('does not announce an empty account state before the initial request settles', () => {
    const markup = renderToStaticMarkup(
      createElement(AccountsPage, accountsProps({ isLoading: true })),
    );

    expect(markup).toContain('Loading account status…');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).not.toContain('No publishing accounts');
  });

  it('offers in-place recovery after account requests fail', () => {
    const markup = renderToStaticMarkup(
      createElement(AccountsPage, accountsProps({ error: 'Account status is unavailable.' })),
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Reload account status');
  });
});
