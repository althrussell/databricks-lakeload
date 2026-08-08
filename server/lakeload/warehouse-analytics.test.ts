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
});
