import { expect, test, type Locator } from '@playwright/test';

const remoteOnly = !process.env.PLAYWRIGHT_BASE_URL;

async function expectEveryChartToAdvance(charts: Locator, expectedCount: number) {
  await expect(charts).toHaveCount(expectedCount, { timeout: 20_000 });
  const points = async () =>
    charts.evaluateAll((elements) =>
      elements.map((element) =>
        Array.from(element.querySelectorAll('polyline'))
          .map((line) => line.getAttribute('points'))
          .join('|')
      )
    );
  const before = await points();
  await new Promise((resolve) => setTimeout(resolve, 2_300));
  const after = await points();
  expect(after).toHaveLength(expectedCount);
  after.forEach((value, index) =>
    expect(value, `chart ${index + 1} did not receive a new sample`).not.toBe(before[index])
  );
}

test('every graph advances from the one-second live stream', async ({ page }, testInfo) => {
  test.skip(remoteOnly, 'deployed Lakebase acceptance test');
  await page.goto('/');

  const overview = await page.request.get('/api/lakeload/overview');
  const activeRunId = (await overview.json()).activeRunId as string | null;
  if (activeRunId) await page.request.delete(`/api/lakeload/runs/${activeRunId}`);

  await page.getByRole('button', { name: /Simulate load/ }).click();
  try {
    await expect
      .poll(async () => {
        const response = await page.request.get('/api/lakeload/overview');
        return ((await response.json()).activeMetrics as unknown[]).length;
      })
      .toBeGreaterThanOrEqual(3);
    await expect(page.getByText('1s LIVE')).toHaveCount(6, { timeout: 20_000 });
    await expectEveryChartToAdvance(page.locator('.charts-grid svg[aria-label$="updated every second"]'), 6);
    await page.screenshot({ path: testInfo.outputPath('live-console-1440.png'), fullPage: true });

    await page.getByRole('button', { name: 'Branch lab', exact: true }).click();
    await expect(page.getByText('1s LIVE')).toHaveCount(2);
    await expectEveryChartToAdvance(page.locator('.branch-charts svg[aria-label$="updated every second"]'), 2);
    await page.screenshot({ path: testInfo.outputPath('branch-lab-1440.png'), fullPage: true });
  } finally {
    await page.getByRole('button', { name: 'Live telemetry', exact: true }).click();
    const stop = page.getByRole('button', { name: /Stop load/ });
    if (await stop.isVisible()) await stop.click();
    const finalOverview = await page.request.get('/api/lakeload/overview');
    const finalRunId = (await finalOverview.json()).activeRunId as string | null;
    if (finalRunId) await page.request.delete(`/api/lakeload/runs/${finalRunId}`);
  }
});

test('mobile console has no document overflow', async ({ page }, testInfo) => {
  test.skip(remoteOnly, 'deployed Lakebase acceptance test');
  await page.setViewportSize({ width: 375, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Shape the pressure' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
  const fonts = await page.evaluate(() => ({
    body: getComputedStyle(document.body).fontFamily,
    mono: getComputedStyle(document.querySelector('.section-kicker') as Element).fontFamily,
  }));
  expect(fonts.body).toContain('DM Sans');
  expect(fonts.mono).toContain('DM Mono');
  await page.screenshot({ path: testInfo.outputPath('mobile-375.png'), fullPage: true });
});

test('wide console is centered within the space beside the navigation rail', async ({ page }, testInfo) => {
  test.skip(remoteOnly, 'deployed layout acceptance test');
  await page.setViewportSize({ width: 2476, height: 1281 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Shape the pressure' })).toBeVisible();
  const geometry = await page.evaluate(() => {
    const workspace = document.querySelector('.workspace')?.getBoundingClientRect();
    const rail = document.querySelector('.side-rail')?.getBoundingClientRect();
    if (!workspace || !rail) throw new Error('App shell was not rendered');
    return {
      leftGutter: workspace.left - rail.width,
      rightGutter: window.innerWidth - workspace.right,
    };
  });
  expect(Math.abs(geometry.leftGutter - geometry.rightGutter)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('wide-centered-2476.png'), fullPage: true });
});
