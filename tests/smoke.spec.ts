import { test, expect } from '@playwright/test';

test('LakeLoad renders the workload console', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'LakeLoad', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Prepare the benchmark', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Prepare all data', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Scenarios', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Test the right engine for the job', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Indexed point lookup/ })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Recent benchmark runs', exact: true })).toBeVisible();
});
