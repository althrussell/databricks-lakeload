import { test, expect } from '@playwright/test';

test('LakeLoad renders the workload console', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'LakeLoad', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Shape the pressure', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Launch run', exact: true })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Recent load tests', exact: true })).toBeVisible();
});
