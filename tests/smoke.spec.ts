import { test, expect, type Locator } from '@playwright/test';

async function contrastRatio(control: Locator) {
  return control.evaluate((element) => {
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
}

test('LakeLoad renders the workload console', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'LakeLoad', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Shape the pressure', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Simulate load|Stop load/ })).toBeVisible();
  await expect(page.getByText('Live database telemetry', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Branch lab', exact: true }).click();
  await expect(page.getByRole('button', { name: /Capture snapshot/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Branch lineage', exact: true })).toBeVisible();
  const restoreBranch = page.getByRole('button', { name: 'Restore isolated branch', exact: true });
  await restoreBranch.evaluate((element) => {
    (element as HTMLButtonElement).disabled = true;
  });
  await expect(restoreBranch).toBeDisabled();
  expect(await contrastRatio(restoreBranch)).toBeGreaterThanOrEqual(4.5);
  await page.getByRole('button', { name: 'Compare engines', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Lakebase and DBSQL, side by side', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Indexed request serving/ })).toBeVisible();
  await expect(page.locator('.comparison-lane.lakebase')).toContainText('Lakebase');
  await expect(page.locator('.comparison-lane.dbsql')).toContainText('DBSQL');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Prepare benchmark datasets', exact: true })).toBeVisible();
  await expect(page.getByLabel('Preparation details').getByText('Lakebase PostgreSQL', { exact: true })).toBeVisible();
  await expect(page.getByText('Unity Catalog Delta', { exact: true })).toBeVisible();
  await expect(page.getByText('Observed preparation time', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Prepare benchmark data', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Benchmark destinations', exact: true })).toBeVisible();
  await expect(page.getByText('Fixed App resource', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Benchmark catalog')).toBeVisible();
  await expect(page.getByLabel('Benchmark schema')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Validate and save destination', exact: true })).toBeVisible();
  await expect(page.getByText('Tables created in main.lakeload', { exact: true })).toBeVisible();
  await expect(page.getByLabel('LakeLoad Delta tables')).toContainText('lakeload_account');
  await expect(page.getByText('It keeps the catalog, schema, and every other object.', { exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'SQL warehouse under test', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'SQL warehouse' })).toBeVisible();
  const selectedWarehouse = page.getByRole('button', { name: 'Selected for DBSQL tests', exact: true });
  await expect(selectedWarehouse).toBeDisabled();
  expect(await contrastRatio(selectedWarehouse)).toBeGreaterThanOrEqual(4.5);
  await expect(page.getByRole('button', { name: 'Hard reset', exact: true })).toBeVisible();
});

test('LakeLoad hard reset remains usable without mobile overflow', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Hard reset all test data', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hard reset', exact: true })).toBeVisible();
  const overflow = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    elements: [...document.querySelectorAll<HTMLElement>('*')]
      .map((element) => ({
        tag: element.tagName,
        className: element.className.toString(),
        right: element.getBoundingClientRect().right,
      }))
      .filter((element) => element.right > window.innerWidth + 1)
      .slice(0, 10),
  }));
  expect(overflow.documentWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.viewport);
});
