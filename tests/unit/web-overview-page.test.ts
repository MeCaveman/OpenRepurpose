import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { OverviewPage } from '../../apps/web/src/features/overview/index';

describe('web overview page', () => {
  it('orients the operator around the existing source-to-destination route', () => {
    const markup = renderToStaticMarkup(
      createElement(OverviewPage, { onNavigate: () => undefined }),
    );

    expect(markup).toContain('Move media through the local workbench');
    expect(markup).toContain('aria-label="Route setup sequence"');
    expect(markup).toContain('href="/sources"');
    expect(markup).toContain('href="/workflows"');
    expect(markup).toContain('href="/accounts"');
    expect(markup.indexOf('>Sources<')).toBeLessThan(markup.indexOf('>Workflows<'));
    expect(markup.indexOf('>Workflows<')).toBeLessThan(markup.indexOf('>Destinations<'));
  });

  it('uses token-backed route markers without inventing dashboard status', () => {
    const markup = renderToStaticMarkup(
      createElement(OverviewPage, { onNavigate: () => undefined }),
    );

    expect(markup).toContain('>01<');
    expect(markup).toContain('>02<');
    expect(markup).toContain('>03<');
    expect(markup).toContain('var(--or-border-selected)');
    expect(markup).toContain('var(--or-bg-selected)');
    expect(markup).not.toContain('analytics');
    expect(markup).not.toContain('metric');
  });

  it('links the local-first note to the existing setup route', () => {
    const markup = renderToStaticMarkup(
      createElement(OverviewPage, { onNavigate: () => undefined }),
    );

    expect(markup).toContain('Local-first operation');
    expect(markup).toContain('href="/setup"');
    expect(markup).toContain('setup readiness');
  });
});
