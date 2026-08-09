import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const captureEnabled = Boolean(process.env.PLAYWRIGHT_BASE_URL && process.env.UPDATE_DOC_SCREENSHOTS);
const imageDirectory = path.resolve('docs/images');

async function capture(page: Page, name: string, locator?: Locator) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  const options = { path: path.join(imageDirectory, name), animations: 'disabled' as const, caret: 'hide' as const };
  if (locator) {
    await locator.scrollIntoViewIfNeeded();
    await locator.screenshot(options);
  } else {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(100);
    await page.screenshot({ ...options, fullPage: false });
  }
}

test('captures the complete customer documentation set', async ({ page }) => {
  test.skip(!captureEnabled, 'set PLAYWRIGHT_BASE_URL and UPDATE_DOC_SCREENSHOTS=1');
  test.setTimeout(300_000);
  await mkdir(imageDirectory, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'LakeLoad', exact: true })).toBeVisible();

  const initialResponse = await page.request.get('/api/lakeload/overview');
  const initial = (await initialResponse.json()) as {
    activeRunId: string | null;
    branchOperations: Array<{ id: string }>;
  };
  if (initial.activeRunId) await page.request.delete(`/api/lakeload/runs/${initial.activeRunId}`);

  const priorOperationIds = new Set(initial.branchOperations.map((operation) => operation.id));
  let demoBranchId = '';

  try {
    await capture(page, '01-workload-control.png');

    await page.getByRole('button', { name: /Simulate load/ }).click();
    await expect
      .poll(async () => {
        const response = await page.request.get('/api/lakeload/overview');
        const body = (await response.json()) as { activeMetrics: unknown[] };
        return body.activeMetrics.length;
      })
      .toBeGreaterThanOrEqual(3);
    await capture(page, '02-live-telemetry.png', page.locator('.live-section'));

    await page.getByRole('button', { name: 'Open Branch Lab', exact: true }).click();
    await page.getByRole('button', { name: 'Create live branch', exact: true }).click();

    let branchName = '';
    await expect
      .poll(
        async () => {
          const response = await page.request.get('/api/lakeload/overview');
          const body = (await response.json()) as {
            branchOperations: Array<{ id: string; kind: string; branch_name: string; status: string }>;
          };
          const operation = body.branchOperations.find(
            (item) => item.kind === 'branch' && !priorOperationIds.has(item.id)
          );
          branchName = operation?.branch_name ?? '';
          return operation?.status;
        },
        { timeout: 180_000 }
      )
      .toBe('completed');
    demoBranchId = branchName.split('/').at(-1) ?? '';

    await expect(page.getByRole('combobox', { name: 'Switch branch view' })).toHaveValue(branchName);
    await capture(page, '03-branch-lab.png');
    await capture(page, '04-branch-topology.png', page.locator('.branch-canvas'));
    await capture(page, '05-branch-live-graphs.png', page.locator('.branch-charts'));

    const activeResponse = await page.request.get('/api/lakeload/overview');
    const activeRunId = ((await activeResponse.json()) as { activeRunId: string | null }).activeRunId;
    if (activeRunId) await page.request.delete(`/api/lakeload/runs/${activeRunId}`);
    if (demoBranchId) {
      await page.request.delete(`/api/lakeload/branches/${demoBranchId}`);
      demoBranchId = '';
    }
    const dismissNotice = page.getByRole('button', { name: 'Dismiss message' });
    if (await dismissNotice.isVisible()) await dismissNotice.click();

    await page.getByRole('button', { name: 'Compare engines', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Lakebase and DBSQL, side by side' })).toBeVisible();
    await capture(page, '06-engine-comparison-setup.png');
    await page.getByRole('button', { name: 'Run matched comparison', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop comparison', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Run matched comparison', exact: true })).toBeVisible({
      timeout: 180_000,
    });
    await expect(page.locator('.evidence-quality')).toContainText('Decision-grade pair');
    await capture(page, '07-comparison-winner.png', page.locator('.comparison-scorecard'));
    await capture(page, '08-comparison-lanes.png', page.locator('.comparison-stage'));

    await page.getByRole('button', { name: 'Run history', exact: true }).click();
    await capture(page, '09-run-history.png', page.locator('.history-section'));

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Prepare benchmark datasets' })).toBeVisible();
    await capture(page, '10-prepare-data.png', page.locator('.setup-hero'));
    await capture(page, '11-benchmark-destinations.png', page.locator('.data-destination-settings'));
    await capture(page, '12-sql-warehouse.png', page.locator('.warehouse-settings'));
    await capture(page, '13-capability-readiness.png', page.locator('.readiness-grid'));
    await capture(page, '14-hard-reset.png', page.locator('.danger-zone'));

    await page.getByRole('button', { name: 'Hard reset', exact: true }).click();
    await page.locator('.side-rail').evaluate((element) => {
      (element as HTMLElement).style.visibility = 'hidden';
    });
    await capture(page, '15-hard-reset-confirmation.png', page.locator('.hard-reset-dialog'));
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  } finally {
    const response = await page.request.get('/api/lakeload/overview');
    const overview = (await response.json()) as { activeRunId: string | null };
    if (overview.activeRunId) await page.request.delete(`/api/lakeload/runs/${overview.activeRunId}`);
    if (demoBranchId) await page.request.delete(`/api/lakeload/branches/${demoBranchId}`);
  }
});
