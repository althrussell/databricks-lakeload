import { describe, expect, it, vi } from 'vitest';
import { WarehouseAnalyticsClient } from './warehouse-analytics';

type RequestInput = {
  path: string;
  method: 'GET' | 'POST';
  headers: Headers;
  raw: false;
  payload?: unknown;
};

describe('WarehouseAnalyticsClient', () => {
  it('executes on the currently selected warehouse', async () => {
    const request = vi
      .fn<(input: RequestInput) => Promise<unknown>>()
      .mockResolvedValue({ statement_id: 's1', status: { state: 'SUCCEEDED' } });
    const client = new WarehouseAnalyticsClient({ request }, () => 'warehouse-b');

    await client.query('SELECT 1');

    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][0].path).toBe('/api/2.0/sql/statements');
    expect(request.mock.calls[0][0].payload).toMatchObject({ warehouse_id: 'warehouse-b', statement: 'SELECT 1' });
  });

  it('surfaces statement execution failures', async () => {
    const request = vi.fn<(input: RequestInput) => Promise<unknown>>().mockResolvedValue({
      statement_id: 's2',
      status: { state: 'FAILED', error: { error_code: 'PERMISSION_DENIED', message: 'Cannot use warehouse' } },
    });
    const client = new WarehouseAnalyticsClient({ request }, () => 'warehouse-a');

    await expect(client.query('SELECT 1')).rejects.toThrow('PERMISSION_DENIED: Cannot use warehouse');
  });

  it('maps inline SQL statement rows by manifest column name', async () => {
    const request = vi.fn<(input: RequestInput) => Promise<unknown>>().mockResolvedValue({
      statement_id: 's3',
      status: { state: 'SUCCEEDED' },
      manifest: { schema: { columns: [{ name: 'found' }, { name: 'lag_ms' }] } },
      result: { data_array: [['4', '1250.5']] },
    });
    const client = new WarehouseAnalyticsClient({ request }, () => 'warehouse-a');

    await expect(client.queryRows('SELECT 4 AS found, 1250.5 AS lag_ms')).resolves.toEqual([
      { found: '4', lag_ms: '1250.5' },
    ]);
  });
});
