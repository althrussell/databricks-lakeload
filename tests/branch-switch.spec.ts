import { expect, test } from '@playwright/test';

const acceptanceEnabled = Boolean(process.env.PLAYWRIGHT_BASE_URL && process.env.RUN_BRANCH_ACCEPTANCE);

test('creates and switches the inspected branch while benchmark load continues', async ({ page }, testInfo) => {
  test.skip(!acceptanceEnabled, 'set PLAYWRIGHT_BASE_URL and RUN_BRANCH_ACCEPTANCE=1');
  test.setTimeout(240_000);
  await page.goto('/');

  const initialResponse = await page.request.get('/api/lakeload/overview');
  const initial = (await initialResponse.json()) as {
    activeRunId: string | null;
    branchOperations: Array<{ id: string }>;
  };
  if (initial.activeRunId) await page.request.delete(`/api/lakeload/runs/${initial.activeRunId}`);
  const priorOperationIds = new Set(initial.branchOperations.map((operation) => operation.id));
  let branchId = '';

  await page.getByRole('button', { name: /Simulate load/ }).click();
  try {
    await expect
      .poll(async () => {
        const response = await page.request.get('/api/lakeload/overview');
        return ((await response.json()) as { activeRunId: string | null }).activeRunId;
      })
      .not.toBeNull();

    await page.getByRole('button', { name: 'Open Branch Lab', exact: true }).click();
    await expect(page.getByText('Workload branch', { exact: true })).toBeVisible();
    await expect(
      page.getByLabel('Branch workload and inspection roles').getByText('load active', { exact: true })
    ).toBeVisible();
    await page.getByRole('button', { name: 'Create live branch', exact: true }).click();

    let createdOperation: { id: string; branch_name: string; status: string } | null = null;
    await expect
      .poll(
        async () => {
          const response = await page.request.get('/api/lakeload/overview');
          const body = (await response.json()) as {
            activeRunId: string | null;
            branchOperations: Array<{
              id: string;
              kind: string;
              branch_name: string;
              status: string;
            }>;
          };
          createdOperation =
            body.branchOperations.find((item) => item.kind === 'branch' && !priorOperationIds.has(item.id)) ?? null;
          return createdOperation?.id ?? null;
        },
        { timeout: 30_000 }
      )
      .not.toBeNull();

    if (!createdOperation) throw new Error('Live branch operation was not returned');
    branchId = createdOperation.branch_name.split('/').at(-1) ?? '';
    await expect(page.getByRole('combobox', { name: 'Switch branch view' })).toHaveValue(createdOperation.branch_name);
    await expect(page.getByText('The workload remains on benchmark', { exact: false })).toBeVisible();

    const branchCharts = page.locator('.branch-charts svg[aria-label*="updated every second"]');
    await expect(branchCharts).toHaveCount(2);
    const before = await branchCharts.first().locator('polyline').first().getAttribute('points');
    await new Promise((resolve) => setTimeout(resolve, 2_300));
    const after = await branchCharts.first().locator('polyline').first().getAttribute('points');
    expect(after).not.toBe(before);

    await expect
      .poll(
        async () => {
          const response = await page.request.get('/api/lakeload/overview');
          const body = (await response.json()) as {
            activeRunId: string | null;
            branchOperations: Array<{ branch_name: string; status: string }>;
          };
          const current = body.branchOperations.find((item) => item.branch_name === createdOperation.branch_name);
          return { status: current?.status, loadActive: Boolean(body.activeRunId) };
        },
        { timeout: 180_000 }
      )
      .toEqual({ status: 'completed', loadActive: true });

    await page.getByRole('combobox', { name: 'Switch branch view' }).selectOption(createdOperation.branch_name);
    await expect(page.getByRole('heading', { name: branchId, exact: true })).toBeVisible();
    await expect(page.getByText('Live demo branch and dedicated compute are ready', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('live-branch-selected.png'), fullPage: true });
  } finally {
    const overview = await page.request.get('/api/lakeload/overview');
    const activeRunId = ((await overview.json()) as { activeRunId: string | null }).activeRunId;
    if (activeRunId) await page.request.delete(`/api/lakeload/runs/${activeRunId}`);
    if (branchId) await page.request.delete(`/api/lakeload/branches/${branchId}`);
  }
});
