const TERMINAL_STATES = new Set(['SUCCEEDED', 'FAILED', 'CANCELED', 'CLOSED']);

interface ApiClient {
  request(input: {
    path: string;
    method: 'GET' | 'POST';
    headers: Headers;
    raw: false;
    payload?: unknown;
  }): Promise<unknown>;
}

interface StatementResponse {
  statement_id?: string;
  status?: {
    state?: string;
    error?: { error_code?: string; message?: string };
  };
  result?: { data_array?: unknown[][] };
  manifest?: { schema?: { columns?: Array<{ name?: string }> } };
}

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class WarehouseAnalyticsClient {
  constructor(
    private readonly apiClient: ApiClient,
    private readonly selectedWarehouseId: () => string,
    private readonly timeoutMs = 110_000
  ) {}

  query(statement: string, _parameters?: Record<string, unknown>) {
    return this.queryWarehouse(this.selectedWarehouseId(), statement);
  }

  async queryRows(statement: string) {
    const response = await this.query(statement);
    const columns = response.manifest?.schema?.columns?.map((column) => column.name ?? '') ?? [];
    return (response.result?.data_array ?? []).map((values) =>
      Object.fromEntries(columns.map((column, index) => [column, values[index]]))
    );
  }

  async queryWarehouse(warehouseId: string, statement: string) {
    const startedAt = Date.now();
    let response = asStatementResponse(
      await this.apiClient.request({
        path: '/api/2.0/sql/statements',
        method: 'POST',
        headers: new Headers({ 'Content-Type': 'application/json' }),
        raw: false,
        payload: {
          warehouse_id: warehouseId,
          statement,
          wait_timeout: '50s',
          on_wait_timeout: 'CONTINUE',
          disposition: 'INLINE',
          format: 'JSON_ARRAY',
          row_limit: 100,
        },
      })
    );

    while (!TERMINAL_STATES.has(response.status?.state ?? '') && response.statement_id) {
      if (Date.now() - startedAt >= this.timeoutMs) {
        throw new Error(`DBSQL statement ${response.statement_id} exceeded ${this.timeoutMs / 1000} seconds`);
      }
      await pause(500);
      response = asStatementResponse(
        await this.apiClient.request({
          path: `/api/2.0/sql/statements/${response.statement_id}`,
          method: 'GET',
          headers: new Headers(),
          raw: false,
        })
      );
    }

    if (response.status?.state !== 'SUCCEEDED') {
      const code = response.status?.error?.error_code;
      const message =
        response.status?.error?.message ?? `Statement ended in ${response.status?.state ?? 'unknown state'}`;
      throw new Error(code ? `${code}: ${message}` : message);
    }
    return response;
  }
}

function asStatementResponse(value: unknown): StatementResponse {
  if (!value || typeof value !== 'object') throw new Error('DBSQL returned an invalid statement response');
  return value as StatementResponse;
}
