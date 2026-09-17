import { expect, test } from '@playwright/test';

test('Playwright shell loads without application services', () => {
  expect(process.platform).toBeTruthy();
});
