import { expect, test } from '@playwright/test';

const remoteOnly = !process.env.PLAYWRIGHT_BASE_URL;

test('settings exposes and validates the DBSQL warehouse target', async ({ page }, testInfo) => {
  test.skip(remoteOnly, 'deployed warehouse settings acceptance test');
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();

  const response = await page.request.get('/api/lakeload/warehouses');
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as {
    selectedWarehouseId: string;
    warehouses: Array<{ id: string; name: string }>;
  };
  expect(body.warehouses.length).toBeGreaterThan(0);

  const selector = page.getByRole('combobox', { name: 'SQL warehouse' });
  await expect(selector).toHaveValue(body.selectedWarehouseId);
  await expect(selector.locator('option')).toHaveCount(body.warehouses.length);
  await expect(
    page.getByText('Every DBSQL setup query, workload, and side-by-side comparison uses this warehouse.')
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('warehouse-settings.png'), fullPage: true });

  const alternative = body.warehouses.find((warehouse) => warehouse.id !== body.selectedWarehouseId);
  if (alternative) {
    try {
      await selector.selectOption(alternative.id);
      await page.getByRole('button', { name: 'Use for DBSQL tests', exact: true }).click();
      await expect(page.getByText(`${alternative.name} is now the DBSQL test warehouse.`, { exact: true })).toBeVisible(
        {
          timeout: 60_000,
        }
      );
      await expect
        .poll(async () => {
          const overview = await page.request.get('/api/lakeload/overview');
          return ((await overview.json()) as { sqlWarehouse: { id: string } }).sqlWarehouse.id;
        })
        .toBe(alternative.id);
    } finally {
      const restored = await page.request.post('/api/lakeload/warehouse', {
        data: { warehouseId: body.selectedWarehouseId },
      });
      expect(restored.ok()).toBeTruthy();
    }
  }
});

test('warehouse settings has no mobile overflow', async ({ page }, testInfo) => {
  test.skip(remoteOnly, 'deployed warehouse settings acceptance test');
  await page.setViewportSize({ width: 375, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'SQL warehouse' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: testInfo.outputPath('warehouse-settings-mobile.png'), fullPage: true });
});
