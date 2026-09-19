import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { NotFoundPage } from '../../apps/web/src/features/not-found/index';

describe('web unknown-route page', () => {
  it('provides a semantic recovery path without inventing another destination', () => {
    const markup = renderToStaticMarkup(
      createElement(NotFoundPage, { onNavigate: () => undefined }),
    );

    expect(markup).toContain('Return to the local workbench');
    expect(markup).toContain('href="/"');
    expect(markup).toContain('Open Dashboard');
    expect(markup).toContain('local files, workflows, and jobs are unaffected');
  });

  it('uses token-backed presentation', () => {
    const markup = renderToStaticMarkup(
      createElement(NotFoundPage, { onNavigate: () => undefined }),
    );

    expect(markup).toContain('var(--or-bg-workspace)');
    expect(markup).toContain('var(--or-text-link)');
    expect(markup).not.toMatch(
      /(?:bg|border|text)-(?:slate|cyan|fuchsia|rose|emerald|white|black)-/,
    );
  });
});
