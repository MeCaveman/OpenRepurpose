import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SettingsPage } from '../../apps/web/src/features/settings/index';

describe('web settings page', () => {
  it('maps configuration to setup, account, model, and workflow surfaces', () => {
    const markup = renderToStaticMarkup(
      createElement(SettingsPage, { onNavigate: () => undefined }),
    );

    expect(markup).toContain('Configuration ownership');
    expect(markup).toContain('aria-label="Configuration areas"');
    expect(markup).toContain('href="/setup"');
    expect(markup).toContain('href="/accounts"');
    expect(markup).toContain('href="/models"');
    expect(markup).toContain('href="/workflows"');
  });

  it('states the fixed local installation policy without claiming live system status', () => {
    const markup = renderToStaticMarkup(
      createElement(SettingsPage, { onNavigate: () => undefined }),
    );

    expect(markup).toContain('Local, self-hosted installation');
    expect(markup).toContain('Loopback only in v0.5');
    expect(markup).toContain('Stored on this installation');
    expect(markup).toContain('Off by default');
    expect(markup).toContain('not inferred live system status');
  });

  it('does not invent general settings controls or feature colors', () => {
    const markup = renderToStaticMarkup(
      createElement(SettingsPage, { onNavigate: () => undefined }),
    );

    expect(markup).toContain('No in-app global preference controls');
    expect(markup).not.toMatch(/<(?:button|input|select|textarea)\b/);
    expect(markup).not.toMatch(/(?:bg|border|text)-(?:slate|cyan|fuchsia|rose|emerald)-/);
  });
});
