import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../..');

function readRepositoryFile(path: string): string {
  return readFileSync(resolve(repositoryRoot, path), 'utf8');
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  const [red, green, blue] = channels.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

describe('permanent Direction E design system', () => {
  const reference = readRepositoryFile('apps/web/src/styles/tokens/reference.css');
  const semantic = readRepositoryFile('apps/web/src/styles/tokens/semantic.css');
  const globalStyles = readRepositoryFile('apps/web/src/styles.css');
  const webPackage = JSON.parse(readRepositoryFile('apps/web/package.json')) as {
    dependencies: Record<string, string>;
  };

  it('defines the approved Modern Teal reference scale without the retired accent', () => {
    expect(reference).toContain('--or-teal-50: #edfbf9');
    expect(reference).toContain('--or-teal-300: #83d5cb');
    expect(reference).toContain('--or-teal-400: #68c6bb');
    expect(reference).toContain('--or-teal-500: #49b2a5');
    expect(reference).toContain('--or-teal-600: #348e84');
    expect(reference).toContain('--or-teal-900: #153c38');
    expect(reference).not.toContain('--or-copper-');
  });

  it('maps the exact approved dark accent values and complete light equivalents', () => {
    expect(semantic).toContain('--or-bg-selected: rgb(73 178 165 / 0.15)');
    expect(semantic).toContain('--or-text-link: var(--or-teal-300)');
    expect(semantic).toContain('--or-text-accent: var(--or-teal-300)');
    expect(semantic).toContain('--or-border-selected: var(--or-teal-500)');
    expect(semantic).toContain('--or-action-primary-bg: var(--or-teal-500)');
    expect(semantic).toContain('--or-action-primary-bg-hover: var(--or-teal-400)');
    expect(semantic).toContain('--or-action-primary-bg-active: var(--or-teal-600)');
    expect(semantic).toContain('--or-route-default: rgb(73 178 165 / 0.42)');
    expect(semantic).toContain('--or-route-selected: var(--or-teal-500)');
    expect(semantic).toContain('--or-selection-bg: rgb(73 178 165 / 0.26)');

    expect(semantic).toContain('--or-bg-selected: var(--or-teal-100)');
    expect(semantic).toContain('--or-text-link: var(--or-teal-700)');
    expect(semantic).toContain('--or-text-accent: var(--or-teal-700)');
    expect(semantic).toContain('--or-route-default: rgb(40 114 107 / 0.42)');
    expect(semantic).toContain('--or-selection-bg: var(--or-teal-200)');
    expect(semantic).not.toContain('--or-copper-');
  });

  it('keeps semantic status and focus mappings separate from the identity accent', () => {
    expect(semantic).toContain('--or-focus-ring: var(--or-blue-300)');
    expect(semantic).toContain('--or-focus-ring: var(--or-blue-700)');
    expect(semantic).toContain('--or-status-success-fg: var(--or-green-300)');
    expect(semantic).toContain('--or-status-info-fg: var(--or-blue-300)');
    expect(semantic).toContain('--or-status-warning-fg: var(--or-yellow-300)');
    expect(semantic).toContain('--or-status-danger-fg: var(--or-red-300)');
  });

  it.each([
    ['dark primary action', '#0d1014', '#49b2a5'],
    ['light primary action', '#ffffff', '#28726b'],
    ['dark link', '#83d5cb', '#101419'],
    ['light link', '#28726b', '#fbfaf7'],
    ['dark body', '#d6d4cd', '#101419'],
    ['light body', '#292f35', '#fbfaf7'],
    ['dark focus', '#93c9ff', '#101419'],
    ['light focus', '#27659f', '#fbfaf7'],
    ['dark success', '#9ddaae', '#191e24'],
    ['dark information', '#93c9ff', '#191e24'],
    ['dark warning', '#eec65b', '#191e24'],
    ['dark danger', '#f4a0a3', '#191e24'],
    ['light success', '#287041', '#e1f5e7'],
    ['light information', '#27659f', '#e3f1ff'],
    ['light warning', '#77550c', '#fff1c2'],
    ['light danger', '#93363b', '#ffe6e7'],
  ])('%s text meets WCAG AA contrast', (_label, foreground, background) => {
    expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ['dark selected/route indicator', '#49b2a5', '#191e24'],
    ['light selected/route indicator', '#28726b', '#ffffff'],
    ['dark focus indicator', '#93c9ff', '#101419'],
    ['light focus indicator', '#27659f', '#fbfaf7'],
  ])('%s meets non-text contrast', (_label, indicator, adjacentSurface) => {
    expect(contrastRatio(indicator, adjacentSurface)).toBeGreaterThanOrEqual(3);
  });

  it('self-hosts only the approved font families and used weights', () => {
    expect(reference).toContain("'Geist', ui-sans-serif");
    expect(reference).toContain("'JetBrains Mono', ui-monospace");
    expect(reference).not.toMatch(/Fira Sans|Fira Mono/);

    expect(globalStyles.match(/@fontsource\/geist\/latin-/g)).toHaveLength(3);
    expect(globalStyles).toContain('@fontsource/geist/latin-400.css');
    expect(globalStyles).toContain('@fontsource/geist/latin-500.css');
    expect(globalStyles).toContain('@fontsource/geist/latin-600.css');
    expect(globalStyles.match(/@fontsource\/jetbrains-mono\/latin-/g)).toHaveLength(2);
    expect(globalStyles).toContain('@fontsource/jetbrains-mono/latin-400.css');
    expect(globalStyles).toContain('@fontsource/jetbrains-mono/latin-600.css');
    expect(globalStyles).not.toMatch(/https?:\/\//);

    expect(webPackage.dependencies['@fontsource/geist']).toBe('5.3.0');
    expect(webPackage.dependencies['@fontsource/jetbrains-mono']).toBe('5.3.0');
  });
});
