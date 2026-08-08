import { test, expect } from '@playwright/test';

test('LakeLoad renders the workload console', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'LakeLoad', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Shape the pressure', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Simulate load|Stop load/ })).toBeVisible();
  await expect(page.getByText('Live database telemetry', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Branch lab', exact: true }).click();
  await expect(page.getByRole('button', { name: /Capture snapshot/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Branch lineage', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Compare engines', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Lakebase and DBSQL, side by side', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Indexed request serving/ })).toBeVisible();
  await expect(page.locator('.comparison-lane.lakebase')).toContainText('Lakebase');
  await expect(page.locator('.comparison-lane.dbsql')).toContainText('DBSQL');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'SQL warehouse under test', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'SQL warehouse' })).toBeVisible();
  const selectedWarehouse = page.getByRole('button', { name: 'Selected for DBSQL tests', exact: true });
  await expect(selectedWarehouse).toBeDisabled();
  const disabledContrast = await selectedWarehouse.evaluate((element) => {
    const style = getComputedStyle(element);
    const luminance = (value: string) => {
      const channels = (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      return channels
        .map((channel) => channel / 255)
        .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
        .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
    };
    const foreground = luminance(style.color);
    const background = luminance(style.backgroundColor);
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  });
  expect(disabledContrast).toBeGreaterThanOrEqual(4.5);
  await expect(page.getByRole('button', { name: 'Hard reset', exact: true })).toBeVisible();
});

test('LakeLoad hard reset remains usable without mobile overflow', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Hard reset all test data', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hard reset', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});
