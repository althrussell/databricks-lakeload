import { expect, test } from '@playwright/test';

const acceptanceEnabled = Boolean(process.env.PLAYWRIGHT_BASE_URL && process.env.RUN_HARD_RESET_ACCEPTANCE);

test('hard reset deletes only LakeLoad test state and supports clean preparation', async ({ page }, testInfo) => {
  test.skip(!acceptanceEnabled, 'set PLAYWRIGHT_BASE_URL and RUN_HARD_RESET_ACCEPTANCE=1');
  test.setTimeout(300_000);
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();

  await expect
    .poll(
      async () => {
        const response = await page.request.get('/api/lakeload/overview');
        const body = (await response.json()) as { branchOperations: Array<{ status: string }> };
        return body.branchOperations.filter((operation) => ['queued', 'running'].includes(operation.status)).length;
      },
      { timeout: 300_000 }
    )
    .toBe(0);

  const before = await page.request.get('/api/lakeload/overview');
  const beforeBody = (await before.json()) as { sqlWarehouse: { id: string } };
  await page.getByRole('button', { name: 'Hard reset', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Reset LakeLoad to an empty state?' })).toBeVisible();
  const confirm = page.getByRole('button', { name: 'Delete all test data', exact: true });
  await expect(confirm).toBeDisabled();
  await page.getByRole('textbox', { name: 'Hard reset confirmation' }).fill('RESET LAKELOAD');
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.getByRole('dialog')).not.toBeVisible();

  try {
    await expect
      .poll(
        async () => {
          const response = await page.request.get('/api/lakeload/overview');
          return ((await response.json()) as { resetOperation: { status: string } | null }).resetOperation?.status;
        },
        { timeout: 180_000 }
      )
      .toBe('completed');

    const emptyResponse = await page.request.get('/api/lakeload/overview');
    const empty = (await emptyResponse.json()) as {
      target: { accounts: number; products: number; history_rows: number };
      runs: unknown[];
      branches: Array<{ name?: string }>;
      sqlWarehouse: { id: string };
    };
    expect(empty.target).toMatchObject({ accounts: 0, products: 0, history_rows: 0 });
    expect(empty.runs).toHaveLength(0);
    expect(empty.branches.some((branch) => /\/(demo|snapshot|restore)-/.test(branch.name ?? ''))).toBeFalsy();
    expect(empty.sqlWarehouse.id).toBe(beforeBody.sqlWarehouse.id);
    await page.screenshot({ path: testInfo.outputPath('hard-reset-completed.png'), fullPage: true });
  } finally {
    const prepared = await page.request.post('/api/lakeload/setup', { timeout: 120_000 });
    expect(prepared.ok(), await prepared.text()).toBeTruthy();
  }

  await expect
    .poll(async () => {
      const response = await page.request.get('/api/lakeload/overview');
      return ((await response.json()) as { target: { history_rows: number } }).target.history_rows;
    })
    .toBe(5_000_000);
});
