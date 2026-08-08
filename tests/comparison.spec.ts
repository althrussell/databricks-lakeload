import { expect, test } from '@playwright/test';

const acceptanceEnabled = Boolean(process.env.PLAYWRIGHT_BASE_URL && process.env.RUN_COMPARISON_ACCEPTANCE);

test.describe('deployed engine comparison', () => {
  test.skip(!acceptanceEnabled, 'set PLAYWRIGHT_BASE_URL and RUN_COMPARISON_ACCEPTANCE=1');
  test.describe.configure({ mode: 'serial' });

  test('runs matched OLTP loads side by side with live inspectable charts', async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    await page.goto('/');

    const overview = await page.request.get('/api/lakeload/overview');
    const activeRunId = (await overview.json()).activeRunId as string | null;
    if (activeRunId) await page.request.delete(`/api/lakeload/runs/${activeRunId}`);

    await page.getByRole('button', { name: 'Compare engines', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Lakebase and DBSQL, side by side' })).toBeVisible();

    const duration = page
      .getByText('Per-engine duration', { exact: true })
      .locator('xpath=ancestor::label')
      .locator('input');
    await duration.focus();
    await duration.press('Home');
    await expect(page.getByText('10 sec', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Run matched comparison', exact: true }).click();
    const lakebaseLane = page.locator('.comparison-lane.lakebase');
    const dbsqlLane = page.locator('.comparison-lane.dbsql');

    await expect(lakebaseLane.getByText('running', { exact: true })).toBeVisible({ timeout: 15_000 });
    const liveLakebaseChart = lakebaseLane.locator('svg[aria-label*="updated every second"]').first();
    await expect(liveLakebaseChart).toBeVisible();
    await expect
      .poll(async () => liveLakebaseChart.locator('polyline').first().getAttribute('points'), { timeout: 20_000 })
      .toMatch(/\d/);
    await liveLakebaseChart.hover({ position: { x: 180, y: 80 } });
    await expect(lakebaseLane.locator('.chart-tooltip')).toBeVisible();

    await expect(dbsqlLane.getByText('running', { exact: true })).toBeVisible({ timeout: 35_000 });
    await expect(dbsqlLane.locator('svg[aria-label*="updated every second"]').first()).toBeVisible();
    await expect(lakebaseLane.locator('.status-completed')).toBeVisible();
    await expect(dbsqlLane.locator('.status-completed')).toBeVisible({ timeout: 35_000 });

    const scorecard = page.getByRole('table', { name: 'Lakebase and DBSQL result comparison' });
    await expect(scorecard).toBeVisible();
    const throughputRow = scorecard.getByRole('row').filter({ hasText: 'Average throughput' });
    await expect(throughputRow).not.toContainText('—');
    await expect(page.getByText(/P95: .* lower/i)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('oltp-side-by-side-completed.png'), fullPage: true });
  });

  test('runs the matched five-million-row OLAP comparison', async ({ page }, testInfo) => {
    test.setTimeout(150_000);
    await page.goto('/');
    await page.getByRole('button', { name: 'Compare engines', exact: true }).click();
    await page.getByRole('button', { name: /Five-million-row scan and join/ }).click();
    await expect(page.getByText('Five million fact rows, account and product joins', { exact: false })).toBeVisible();

    const duration = page
      .getByText('Per-engine duration', { exact: true })
      .locator('xpath=ancestor::label')
      .locator('input');
    await duration.focus();
    await duration.press('Home');
    await page.getByRole('button', { name: 'Run matched comparison', exact: true }).click();

    const lakebaseLane = page.locator('.comparison-lane.lakebase');
    const dbsqlLane = page.locator('.comparison-lane.dbsql');
    await expect(lakebaseLane.getByText('running', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(lakebaseLane.locator('.status-completed')).toBeVisible({ timeout: 70_000 });
    await expect(dbsqlLane.getByText('running', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(dbsqlLane.locator('.status-completed')).toBeVisible({ timeout: 70_000 });

    const scorecard = page.getByRole('table', { name: 'Lakebase and DBSQL result comparison' });
    await expect(scorecard.getByRole('row').filter({ hasText: 'Completed operations' })).not.toContainText('—');
    await expect(page.getByText(/P95: .* lower/i)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('olap-side-by-side-completed.png'), fullPage: true });
  });

  test('comparison remains contained on a 375px viewport', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Compare engines', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Lakebase and DBSQL, side by side' })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: testInfo.outputPath('comparison-mobile-375.png'), fullPage: true });
  });
});
