export type Engine = 'lakebase' | 'dbsql' | 'ltap';

export type ScenarioId =
  | 'lakebase-point-lookup'
  | 'lakebase-transfer'
  | 'lakebase-mixed'
  | 'lakebase-operational-join'
  | 'lakebase-olap-scan'
  | 'dbsql-point-lookup'
  | 'dbsql-olap-scan'
  | 'dbsql-window-analysis'
  | 'cdf-freshness'
  | 'sync-serving'
  | 'ltap-closed-loop'
  | 'search-keyword'
  | 'search-vector'
  | 'search-hybrid'
  | 'telemetry-diagnosis'
  | 'otel-correlation';

export interface ScenarioDefinition {
  id: ScenarioId;
  name: string;
  engine: Engine;
  category: 'OLTP' | 'OLAP' | 'LTAP' | 'Search' | 'Observability';
  question: string;
  method: string;
  expected: string;
  runnable: boolean;
  prerequisite?: 'cdf' | 'sync' | 'search' | 'telemetry' | 'otel';
  defaultConcurrency: number;
  defaultDurationSeconds: number;
  tags: string[];
}

export const LAKEBASE_LOAD_SCENARIOS = new Set<ScenarioId>([
  'lakebase-point-lookup',
  'lakebase-transfer',
  'lakebase-mixed',
  'lakebase-operational-join',
  'lakebase-olap-scan',
  'search-keyword',
  'search-vector',
  'search-hybrid',
]);

export const LTAP_SCENARIOS = new Set<ScenarioId>([
  'cdf-freshness',
  'sync-serving',
  'ltap-closed-loop',
  'telemetry-diagnosis',
]);

export const SCENARIOS: ScenarioDefinition[] = [
  {
    id: 'lakebase-point-lookup',
    name: 'Indexed point lookup',
    engine: 'lakebase',
    category: 'OLTP',
    question: 'How does latency behave as concurrent application sessions rise?',
    method: 'Seeded account and product primary-key lookups over the same 1M/10K key ranges used in Delta.',
    expected: 'Lakebase is designed for low-latency, high-concurrency operational access.',
    runnable: true,
    defaultConcurrency: 50,
    defaultDurationSeconds: 30,
    tags: ['concurrency', 'p99', 'indexed'],
  },
  {
    id: 'lakebase-transfer',
    name: 'Transactional transfer',
    engine: 'lakebase',
    category: 'OLTP',
    question: 'Can the database sustain multi-statement writes without breaking the balance invariant?',
    method: 'Debit, credit, and audit insert in one PostgreSQL transaction; verify total balance after the run.',
    expected: 'Lakebase provides PostgreSQL transactions, constraints, and row-level concurrency.',
    runnable: true,
    defaultConcurrency: 30,
    defaultDurationSeconds: 30,
    tags: ['transactions', 'writes', 'invariant'],
  },
  {
    id: 'lakebase-mixed',
    name: 'Mixed application traffic',
    engine: 'lakebase',
    category: 'OLTP',
    question: 'What happens when reads, writes, and bounded operational joins share the endpoint?',
    method: '55% point reads, 35% transfers, and 10% bounded joins with a deterministic seed.',
    expected: 'This models an application endpoint more closely than a single-query microbenchmark.',
    runnable: true,
    defaultConcurrency: 50,
    defaultDurationSeconds: 45,
    tags: ['mixed', 'application', 'throughput'],
  },
  {
    id: 'lakebase-operational-join',
    name: 'Operational join',
    engine: 'lakebase',
    category: 'OLTP',
    question: 'How quickly can Lakebase answer a bounded join near the current transaction?',
    method: 'Use the account/time index to join one account to its latest 20 events and aggregate that bounded window.',
    expected: 'Bounded operational joins belong close to the application state.',
    runnable: true,
    defaultConcurrency: 20,
    defaultDurationSeconds: 30,
    tags: ['join', 'bounded', 'operational'],
  },
  {
    id: 'lakebase-olap-scan',
    name: 'PostgreSQL analytical scan',
    engine: 'lakebase',
    category: 'OLAP',
    question: 'How does an operational database behave when asked to scan and aggregate five million events?',
    method: 'Scan five million PostgreSQL history rows, join account and product dimensions, then aggregate.',
    expected:
      'Lakebase can execute the query, but wide scans compete with operational compute and are not its primary serving path.',
    runnable: true,
    defaultConcurrency: 1,
    defaultDurationSeconds: 30,
    tags: ['scan', 'five-million', 'comparison'],
  },
  {
    id: 'dbsql-point-lookup',
    name: 'Delta point lookup',
    engine: 'dbsql',
    category: 'OLAP',
    question: 'What is the cost of using an analytical engine for individual application lookups?',
    method: 'Issue the same seeded account-and-product primary-key filters against equivalent Delta tables.',
    expected:
      'DBSQL can answer the query, but its scheduling model is designed for analytics rather than request serving.',
    runnable: true,
    defaultConcurrency: 4,
    defaultDurationSeconds: 30,
    tags: ['comparison', 'lookup', 'delta'],
  },
  {
    id: 'dbsql-olap-scan',
    name: 'Large analytical scan',
    engine: 'dbsql',
    category: 'OLAP',
    question: 'Which engine should scan and aggregate a large fact table?',
    method: 'Scan the Delta events table, join dimensions, and aggregate by region and category.',
    expected: 'DBSQL is designed for parallel scans, joins, and analytical aggregation.',
    runnable: true,
    defaultConcurrency: 2,
    defaultDurationSeconds: 30,
    tags: ['scan', 'join', 'aggregation'],
  },
  {
    id: 'dbsql-window-analysis',
    name: 'Windowed customer ranking',
    engine: 'dbsql',
    category: 'OLAP',
    question: 'How should a wide window function over customer history be executed?',
    method: 'Aggregate event history and rank customers within each region using a window function.',
    expected: 'DBSQL handles wide analytical windows without consuming operational database capacity.',
    runnable: true,
    defaultConcurrency: 2,
    defaultDurationSeconds: 30,
    tags: ['window', 'ranking', 'analytics'],
  },
  {
    id: 'cdf-freshness',
    name: 'Lakebase CDF freshness',
    engine: 'ltap',
    category: 'LTAP',
    question: 'How long does a committed PostgreSQL change take to become queryable in Delta?',
    method: 'Write a tagged transaction, poll its CDF destination, and record commit-to-Delta lag.',
    expected: 'CDF supplies incremental operational changes to the lakehouse without batch extracts.',
    runnable: false,
    prerequisite: 'cdf',
    defaultConcurrency: 1,
    defaultDurationSeconds: 60,
    tags: ['cdf', 'freshness', 'audit'],
  },
  {
    id: 'sync-serving',
    name: 'Synced-table serving',
    engine: 'ltap',
    category: 'LTAP',
    question: 'How quickly can curated Delta data return to an operational PostgreSQL query path?',
    method: 'Update a Delta profile row, poll the Lakebase synced table, then measure its indexed lookup latency.',
    expected: 'Synced tables bring governed lakehouse data into low-latency application serving.',
    runnable: false,
    prerequisite: 'sync',
    defaultConcurrency: 25,
    defaultDurationSeconds: 60,
    tags: ['sync', 'serving', 'freshness'],
  },
  {
    id: 'ltap-closed-loop',
    name: 'Closed-loop order enrichment',
    engine: 'ltap',
    category: 'LTAP',
    question: 'Can one flow combine transactions, lakehouse analytics, and operational serving?',
    method: 'Create an order, capture it through CDF, enrich in DBSQL, sync its score back, and read it in checkout.',
    expected: 'The loop keeps OLTP and OLAP on the engine designed for each job while sharing governed data.',
    runnable: false,
    prerequisite: 'cdf',
    defaultConcurrency: 10,
    defaultDurationSeconds: 120,
    tags: ['ltap', 'closed-loop', 'enrichment'],
  },
  {
    id: 'search-keyword',
    name: 'Keyword search',
    engine: 'lakebase',
    category: 'Search',
    question: 'Can the application combine PostgreSQL state with ranked text search?',
    method: 'Use lakebase_text to rank product title and description matches.',
    expected: 'Lakebase Search avoids a second operational search datastore.',
    runnable: false,
    prerequisite: 'search',
    defaultConcurrency: 20,
    defaultDurationSeconds: 30,
    tags: ['search', 'keyword', 'ranking'],
  },
  {
    id: 'search-vector',
    name: 'Vector search',
    engine: 'lakebase',
    category: 'Search',
    question: 'Can semantic retrieval execute beside mutable application data?',
    method: 'Use lakebase_vector with deterministic embeddings and an indexed nearest-neighbor query.',
    expected: 'Vector retrieval and PostgreSQL filters execute in one operational transaction boundary.',
    runnable: false,
    prerequisite: 'search',
    defaultConcurrency: 20,
    defaultDurationSeconds: 30,
    tags: ['search', 'vector', 'semantic'],
  },
  {
    id: 'search-hybrid',
    name: 'Hybrid RRF search',
    engine: 'lakebase',
    category: 'Search',
    question: 'How does hybrid ranking improve retrieval over keyword or vector search alone?',
    method: 'Fuse keyword and vector result ranks with reciprocal rank fusion.',
    expected: 'Hybrid search combines exact and semantic relevance while preserving PostgreSQL filters.',
    runnable: false,
    prerequisite: 'search',
    defaultConcurrency: 20,
    defaultDurationSeconds: 30,
    tags: ['search', 'hybrid', 'rrf'],
  },
  {
    id: 'telemetry-diagnosis',
    name: 'Telemetry diagnosis',
    engine: 'ltap',
    category: 'Observability',
    question: 'How quickly can a live query be correlated with plans, waits, and resource telemetry in Delta?',
    method: 'Issue a tagged PostgreSQL probe, poll the advanced telemetry tables, and record capture freshness.',
    expected: 'Lakebase telemetry joins query statistics, active sessions, plans, waits, DDL, logs, and compute signals.',
    runnable: false,
    prerequisite: 'telemetry',
    defaultConcurrency: 1,
    defaultDurationSeconds: 60,
    tags: ['plans', 'waits', 'delta'],
  },
  {
    id: 'otel-correlation',
    name: 'Trace and database correlation',
    engine: 'ltap',
    category: 'Observability',
    question: 'Can operators connect application throughput and p99 changes to database traces?',
    method: 'Propagate a run ID through OpenTelemetry attributes and compare traces to one-second benchmark metrics.',
    expected: 'OpenTelemetry exposes the request path behind a throughput or latency change.',
    runnable: false,
    prerequisite: 'otel',
    defaultConcurrency: 20,
    defaultDurationSeconds: 30,
    tags: ['otel', 'traces', 'correlation'],
  },
];

export const scenarioById = new Map(SCENARIOS.map((scenario) => [scenario.id, scenario]));
