import { expect, test } from '@playwright/test';

const acceptanceEnabled = Boolean(process.env.PLAYWRIGHT_BASE_URL && process.env.RUN_DESTINATION_ACCEPTANCE);

test('an existing Unity Catalog schema can be selected and restored', async ({ page }) => {
  test.skip(!acceptanceEnabled, 'set PLAYWRIGHT_BASE_URL and RUN_DESTINATION_ACCEPTANCE=1');
  const overviewResponse = await page.request.get('/api/lakeload/overview');
  const before = (await overviewResponse.json()) as {
    dataDestination: {
      mode: 'existing-schema' | 'create-schema' | 'create-catalog-schema';
      catalog: string;
      schema: string;
    };
  };
  const optionsResponse = await page.request.get(
    `/api/lakeload/data-destinations?catalog=${encodeURIComponent(before.dataDestination.catalog)}`
  );
  const options = (await optionsResponse.json()) as { catalogs: string[]; schemas: string[] };
  expect(options.catalogs).toContain(before.dataDestination.catalog);
  expect(options.schemas).toContain(before.dataDestination.schema);

  try {
    const selected = await page.request.post('/api/lakeload/data-destination', {
      data: { ...before.dataDestination, mode: 'existing-schema' },
    });
    expect(selected.ok(), await selected.text()).toBeTruthy();
    const changed = (await (await page.request.get('/api/lakeload/overview')).json()) as {
      dataDestination: { mode: string };
    };
    expect(changed.dataDestination.mode).toBe('existing-schema');
  } finally {
    const restored = await page.request.post('/api/lakeload/data-destination', { data: before.dataDestination });
    expect(restored.ok(), await restored.text()).toBeTruthy();
  }
});
