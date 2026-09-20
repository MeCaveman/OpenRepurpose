import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  Alert,
  Button,
  Checkbox,
  ErrorState,
  FormField,
  Input,
} from '../../apps/web/src/components/ui/index';

describe('web UI primitives', () => {
  it('keeps a loading button named, busy, and disabled', () => {
    const markup = renderToStaticMarkup(
      createElement(Button, {
        children: 'Save workflow',
        isLoading: true,
        loadingLabel: 'Saving workflow',
        type: 'submit',
        variant: 'primary',
      }),
    );

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('Saving workflow');
    expect(markup).not.toContain('Save workflow');
  });

  it('associates a form label and error with its native control', () => {
    const markup = renderToStaticMarkup(
      createElement(
        FormField,
        { error: 'A value is required.', label: 'Workflow name', required: true },
        createElement(Input, { name: 'workflowName' }),
      ),
    );
    const controlId = markup.match(/<input[^>]*\sid="([^"]+)"/)?.[1];

    expect(controlId).toBeDefined();
    expect(markup).toContain(`for="${controlId}"`);
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain(`aria-describedby="${controlId}-error"`);
    expect(markup).toContain('required=""');
  });

  it('gives a checkbox a full native hit target and associated description', () => {
    const markup = renderToStaticMarkup(
      createElement(Checkbox, {
        checked: true,
        description: 'Only authorized media may be reused.',
        label: 'Rights confirmed',
        onChange: () => undefined,
      }),
    );

    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain('checked=""');
    expect(markup).toContain('Rights confirmed');
    expect(markup).toContain('Only authorized media may be reused.');
    expect(markup).toContain('size-[var(--or-target-min)]');
  });

  it('uses assertive errors and polite success status semantics', () => {
    const errorMarkup = renderToStaticMarkup(
      createElement(Alert, { children: 'Could not save.', variant: 'error' }),
    );
    const neutralMarkup = renderToStaticMarkup(
      createElement(Alert, { children: 'Local-only operation.' }),
    );
    const successMarkup = renderToStaticMarkup(
      createElement(Alert, { children: 'Upload queued.', variant: 'success' }),
    );

    expect(errorMarkup).toContain('role="alert"');
    expect(successMarkup).toContain('role="status"');
    expect(neutralMarkup).not.toContain('role=');
  });

  it('associates an error-state heading with the alert region', () => {
    const markup = renderToStaticMarkup(
      createElement(ErrorState, {
        description: 'Reload the interface to continue.',
        headingLevel: 1,
        title: 'The interface could not render.',
      }),
    );
    const headingId = markup.match(/<h1[^>]*id="([^"]+)"/)?.[1];

    expect(headingId).toBeDefined();
    expect(markup).toContain(`aria-labelledby="${headingId}"`);
    expect(markup).toContain('role="alert"');
  });
});
