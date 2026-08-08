import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Badge,
  Button,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@databricks/appkit-ui/react';
import {
  Activity,
  ArchiveRestore,
  Boxes,
  Check,
  CircleAlert,
  CircleHelp,
  Columns3,
  Database,
  GitBranch,
  Gauge,
  History,
  Play,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Square,
  Target,
  Trash2,
  Trophy,
  Waves,
  Zap,
} from 'lucide-react';

type View = 'live' | 'compare' | 'branches' | 'runs' | 'setup';
type Engine = 'lakebase' | 'dbsql' | 'ltap';

interface Scenario {
  id: string;
  name: string;
  engine: Engine;
  category: string;
  question: string;
  method: string;
  expected: string;
  runnable: boolean;
  prerequisite?: string;
  defaultConcurrency: number;
  defaultDurationSeconds: number;
  tags: string[];
}

interface Run {
  id: string;
  scenario: string;
  engine: Engine;
  status: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
  concurrency: number;
  duration_seconds: number;
  ramp_seconds: number;
  execution_model: 'closed' | 'open';
  target_rps: number | null;
  created_at: string;
  total_operations: number | string;
  total_errors: number | string;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  error_message: string | null;
}

interface Metric {
  recorded_at: string;
  elapsed_seconds: number;
  active_users: number;
  operations: number;
  errors: number;
  reads: number;
  writes: number;
  complex_queries: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  database_tps: number;
  commits: number;
  rollbacks: number;
  rows_inserted: number;
  rows_updated: number;
  rows_deleted: number;
  connections_active: number;
  connections_idle: number;
  connections_total: number;
  locks_waiting: number;
  locks_total: number;
  cache_hit_pct: number;
  database_bytes: number;
}

interface Branch {
  name?: string;
  create_time?: string;
  spec?: { source_branch?: string; ttl?: string; no_expiry?: boolean };
  status?: {
    branch_id?: string;
    current_state?: string;
    logical_size_bytes?: number | string;
    source_branch?: string;
    default?: boolean;
    is_protected?: boolean;
  };
}

interface BranchOperation {
  id: string;
  kind: 'snapshot' | 'restore';
  branch_name: string;
  source_branch: string;
  phase: 'branch' | 'compute';
  create_compute: boolean;
  status: 'queued' | 'running' | 'completed' | 'failed';
  message: string | null;
  created_at: string;
  completed_at: string | null;
}

interface Readiness {
  id: string;
  label: string;
  state: 'ready' | 'action' | 'blocked';
  detail: string;
}

interface SqlWarehouse {
  id: string;
  name: string;
  state: string;
  clusterSize: string;
  warehouseType: string;
  serverless: boolean;
}

interface DataDestination {
  mode: 'existing-schema' | 'create-schema' | 'create-catalog-schema';
  catalog: string;
  schema: string;
}

interface ResetOperation {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  message: string;
  branch_count: number;
  requested_by: string;
  created_at: string;
  completed_at: string | null;
}

interface Overview {
  scenarios: Scenario[];
  runs: Run[];
  activeRunId: string | null;
  activeMetrics: Metric[];
  readiness: Readiness[];
  branches: Branch[];
  branchOperations: BranchOperation[];
  resetOperation: ResetOperation | null;
  target: { database: string; postgres_version: string; accounts: number; products: number; history_rows: number };
  sqlWarehouse: SqlWarehouse;
  dataDestination: DataDestination;
  endpoint: { project: string; branch: string; endpoint: string; poolSize: number; autoscaling: string };
}

const EMPTY: Overview = {
  scenarios: [],
  runs: [],
  activeRunId: null,
  activeMetrics: [],
  readiness: [],
  branches: [],
  branchOperations: [],
  resetOperation: null,
  target: { database: 'databricks_postgres', postgres_version: '17', accounts: 0, products: 0, history_rows: 0 },
  sqlWarehouse: {
    id: '',
    name: 'SQL warehouse not loaded',
    state: 'UNKNOWN',
    clusterSize: 'Unknown size',
    warehouseType: 'Unknown type',
    serverless: false,
  },
  dataDestination: { mode: 'create-schema', catalog: 'main', schema: 'lakeload' },
  endpoint: { project: 'lakeload', branch: 'benchmark', endpoint: 'primary', poolSize: 80, autoscaling: '1–4 CU' },
};

interface RunDetails {
  run: Run;
  metrics: Metric[];
}

interface ComparisonPreset {
  id: 'oltp' | 'olap' | 'best-fit';
  eyebrow: string;
  title: string;
  question: string;
  lakebaseScenario: string;
  dbsqlScenario: string;
  concurrency: number;
  duration: number;
  ramp: number;
  method: string;
  interpretation: string;
  matched: boolean;
  minimumHistoryRows?: number;
}

const COMPARISON_PRESETS: ComparisonPreset[] = [
  {
    id: 'oltp',
    eyebrow: 'OLTP challenge',
    title: 'Indexed request serving',
    question: 'Which engine should sit on the synchronous application request path?',
    lakebaseScenario: 'lakebase-point-lookup',
    dbsqlScenario: 'dbsql-point-lookup',
    concurrency: 10,
    duration: 20,
    ramp: 3,
    method: 'The same primary-key lookup, key range, concurrency, duration, and warm-state policy on both engines.',
    interpretation:
      'Compare throughput and tail latency. Lakebase is built for concurrent, low-latency request serving.',
    matched: true,
  },
  {
    id: 'olap',
    eyebrow: 'OLAP challenge',
    title: 'Five-million-row scan and join',
    question: 'Which engine should scan fact history and aggregate across dimensions?',
    lakebaseScenario: 'lakebase-olap-scan',
    dbsqlScenario: 'dbsql-olap-scan',
    concurrency: 1,
    duration: 20,
    ramp: 0,
    method: 'Five million fact rows, account and product joins, grouped aggregation, and matched client pressure.',
    interpretation:
      'Compare completed analytical queries and latency. DBSQL is built for parallel analytical execution.',
    matched: true,
    minimumHistoryRows: 5_000_000,
  },
  {
    id: 'best-fit',
    eyebrow: 'Engine-fit story',
    title: 'Transactions beside analytics',
    question: 'How do Lakebase and DBSQL divide operational and analytical work?',
    lakebaseScenario: 'lakebase-mixed',
    dbsqlScenario: 'dbsql-olap-scan',
    concurrency: 2,
    duration: 20,
    ramp: 2,
    method:
      'Lakebase runs mixed application traffic; DBSQL runs the wide historical scan. These are intentionally different jobs.',
    interpretation:
      'This is an architecture comparison, not a speed race: each engine runs the workload it is designed to serve.',
    matched: false,
    minimumHistoryRows: 5_000_000,
  },
];

const value = (input: number | string | null | undefined) => Number(input ?? 0);
const compact = (input: number) =>
  new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(input);
const bytes = (input: number) =>
  input <= 0 ? '—' : `${(input / 1_048_576).toFixed(input > 1_073_741_824 ? 0 : 1)} MB`;
const metricKeys: Array<keyof Metric> = [
  'elapsed_seconds',
  'active_users',
  'operations',
  'errors',
  'reads',
  'writes',
  'complex_queries',
  'p50_ms',
  'p95_ms',
  'p99_ms',
  'database_tps',
  'commits',
  'rollbacks',
  'rows_inserted',
  'rows_updated',
  'rows_deleted',
  'connections_active',
  'connections_idle',
  'connections_total',
  'locks_waiting',
  'locks_total',
  'cache_hit_pct',
  'database_bytes',
];

const HELP = {
  lakebaseEngine:
    'Runs the workload directly against Lakebase PostgreSQL. Use it for concurrent transactions, indexed lookups, and application request paths.',
  dbsqlEngine:
    'Runs the workload on the selected Databricks SQL warehouse. Use it for scans, joins, aggregations, and analytical concurrency.',
  concurrentUsers:
    'The number of virtual users allowed to issue requests at the same time. In closed loop, each user waits for its request to finish before sending another.',
  duration: 'How long LakeLoad applies the configured workload after the ramp period begins.',
  ramp: 'How long LakeLoad takes to increase from zero to the configured concurrency or target rate. Use a ramp to observe scaling behavior.',
  closedLoop:
    'Maintains a fixed number of virtual users. Each user sends its next request only after the previous request finishes, so achieved throughput changes with latency.',
  targetRate:
    'Schedules a requested arrival rate in operations per second, independent of response completion. Use it to increase demand until latency or errors show saturation.',
  targetArrivalRate:
    'The number of operations LakeLoad attempts to start each second. Actual completed throughput can be lower when the system or client pool is saturated.',
  workloadTps: 'Operations completed by the load generator during the latest one-second sample.',
  p50: 'Median request latency. Half of completed requests were faster and half were slower.',
  p95: '95th-percentile request latency. 95% of completed requests were this fast or faster.',
  p99: '99th-percentile request latency. This exposes slow tail requests that averages can hide.',
  databaseTps: 'PostgreSQL transactions committed or rolled back during the latest one-second sample.',
  connections: 'Total PostgreSQL sessions open against the benchmark endpoint, including active and idle sessions.',
  cacheHit: 'Percentage of PostgreSQL block reads served from shared buffers instead of storage.',
  errorRate: 'Failed workload operations divided by all attempted operations in the latest sample.',
  autoscaling: 'The minimum and maximum compute units available to the Lakebase endpoint as demand changes.',
  activeSessions: 'PostgreSQL sessions currently executing work compared with all open sessions.',
  lockWaits: 'Sessions waiting for a PostgreSQL lock. Sustained waits can indicate transaction contention.',
  sequentialComparison:
    'LakeLoad runs Lakebase first and DBSQL second so the two engines do not compete for load-generator capacity.',
  matchedWorkload:
    'Both engines receive the same query shape, data range, client count, duration, and ramp. Compute architecture still differs by design.',
  bestFitWorkload:
    'Each engine receives the job it is designed to serve: operational requests on Lakebase and analytical processing on DBSQL.',
  averageThroughput: 'Total completed operations divided by measured elapsed time for the run.',
  completedOperations: 'All workload operations that completed successfully during the run.',
  estimatedWallTime: 'Lakebase and DBSQL run sequentially, with a short handoff between them.',
  snapshot:
    'Creates a copy-on-write Lakebase branch from the current benchmark state. The source branch and active workload continue running.',
  restore:
    'Creates a new isolated read-write branch from the selected snapshot and provisions dedicated compute for it.',
  logicalSize: 'The logical database size represented by the branch. Copy-on-write storage can use less physical storage.',
  benchmarkSeed: 'The deterministic seed keeps generated values and workload choices repeatable across runs.',
  setupPath: 'Choose whether the App service principal uses an existing schema or creates the missing schema and catalog.',
  catalog: 'The Unity Catalog catalog that contains the three Delta benchmark tables used by DBSQL.',
  schema: 'The Unity Catalog schema where LakeLoad creates its three prefixed Delta tables.',
  validateDestination:
    'Checks that the App service principal can access the destination and create and remove a temporary Delta table. It creates the catalog or schema when that setup path is selected.',
  fixedLakebase:
    'This Lakebase database is attached to the Databricks App resource and stores the PostgreSQL benchmark dataset.',
  warehouse:
    'The SQL warehouse that runs Delta preparation, DBSQL workloads, and the DBSQL side of engine comparisons.',
  warehouseState: 'RUNNING starts queries immediately. A stopped warehouse adds startup time to preparation and benchmark runs.',
  readiness: 'A live preflight check of the resources and preview features required by LakeLoad scenarios.',
  hardReset:
    'Deletes LakeLoad benchmark rows, its three Delta tables, run history, telemetry, snapshots, and restore branches. It keeps the App and base resources.',
} as const;

const METRIC_HELP: Partial<Record<MetricKey, string>> = {
  operations: HELP.workloadTps,
  database_tps: HELP.databaseTps,
  p50_ms: HELP.p50,
  p95_ms: HELP.p95,
  p99_ms: HELP.p99,
  connections_active: 'PostgreSQL sessions currently executing a query or transaction.',
  connections_idle: 'Open PostgreSQL sessions waiting for the next client request.',
  connections_total: HELP.connections,
  rows_inserted: 'Rows inserted into PostgreSQL during the latest one-second sample.',
  rows_updated: 'Rows updated in PostgreSQL during the latest one-second sample.',
  rows_deleted: 'Rows deleted from PostgreSQL during the latest one-second sample.',
  reads: 'Read operations completed by the selected workload in the latest sample.',
  writes: 'Insert, update, or delete operations completed by the selected workload in the latest sample.',
  complex_queries: 'Bounded joins or aggregate queries completed by the workload in the latest sample.',
  cache_hit_pct: HELP.cacheHit,
  locks_waiting: HELP.lockWaits,
};

export default function App() {
  const [view, setView] = useState<View>('live');
  const [overview, setOverview] = useState<Overview>(EMPTY);
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedScenarioId, setSelectedScenarioId] = useState('lakebase-mixed');
  const [engineFilter, setEngineFilter] = useState<'lakebase' | 'dbsql'>('lakebase');
  const [concurrency, setConcurrency] = useState(50);
  const [duration, setDuration] = useState(60);
  const [ramp, setRamp] = useState(10);
  const [executionModel, setExecutionModel] = useState<'closed' | 'open'>('closed');
  const [targetRps, setTargetRps] = useState(500);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; message: string } | null>(null);
  const selectedRunRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/lakeload/overview');
      const body = (await response.json()) as Overview & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Overview failed (${response.status})`);
      setOverview(body);
      if (body.activeRunId) {
        selectedRunRef.current = body.activeRunId;
        setSelectedRunId(body.activeRunId);
        setMetrics(body.activeMetrics.map(normalizeMetric));
      } else if (body.runs.length === 0) {
        selectedRunRef.current = null;
        setSelectedRunId(null);
        setMetrics([]);
      } else if (!selectedRunRef.current || !body.runs.some((run) => run.id === selectedRunRef.current)) {
        selectedRunRef.current = body.runs[0].id;
        setSelectedRunId(body.runs[0].id);
      }
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'LakeLoad could not refresh.' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 1_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    if (!selectedRunId || selectedRunId === overview.activeRunId) return;
    void fetch(`/api/lakeload/runs/${selectedRunId}`)
      .then(async (response) => {
        const body = (await response.json()) as { metrics?: Metric[]; error?: string };
        if (!response.ok) throw new Error(body.error ?? 'Run details could not load.');
        setMetrics((body.metrics ?? []).map(normalizeMetric));
      })
      .catch((error) => setNotice({ kind: 'error', message: error instanceof Error ? error.message : String(error) }));
  }, [overview.activeRunId, selectedRunId]);

  const selectedScenario =
    overview.scenarios.find((scenario) => scenario.id === selectedScenarioId) ?? overview.scenarios[0];
  const selectedRun = overview.runs.find((run) => run.id === selectedRunId) ?? overview.runs[0];
  const latest = metrics.at(-1);
  const live = selectedRun?.status === 'running';
  const progress =
    live && latest
      ? Math.min(100, (latest.elapsed_seconds / selectedRun.duration_seconds) * 100)
      : selectedRun?.status === 'completed'
        ? 100
        : 0;
  const errorRate = latest ? (latest.errors / Math.max(1, latest.operations + latest.errors)) * 100 : 0;

  function chooseScenario(scenario: Scenario) {
    setSelectedScenarioId(scenario.id);
    setConcurrency(scenario.defaultConcurrency);
    setDuration(scenario.defaultDurationSeconds);
  }

  async function launch() {
    if (!selectedScenario?.runnable) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch('/api/lakeload/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scenario: selectedScenario.id,
          concurrency,
          durationSeconds: duration,
          rampSeconds: ramp,
          executionModel,
          targetRps: executionModel === 'open' ? targetRps : undefined,
        }),
      });
      const body = (await response.json()) as { runId?: string; error?: string };
      if (!response.ok || !body.runId) throw new Error(body.error ?? 'Run could not start.');
      selectedRunRef.current = body.runId;
      setSelectedRunId(body.runId);
      setMetrics([]);
      setView('live');
      await refresh();
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    if (!overview.activeRunId) return;
    await fetch(`/api/lakeload/runs/${overview.activeRunId}`, { method: 'DELETE' });
    await refresh();
  }

  async function prepare() {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch('/api/lakeload/setup', { method: 'POST' });
      const body = (await response.json()) as { message?: string; error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Benchmark data preparation failed.');
      setNotice({ kind: 'success', message: body.message ?? 'Lakebase and DBSQL datasets are ready.' });
      await refresh();
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function branchAction(input: Record<string, unknown>) {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch('/api/lakeload/branches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const body = (await response.json()) as { branchName?: string; error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Branch operation could not start.');
      setNotice({
        kind: 'success',
        message: `${input.kind === 'snapshot' ? 'Snapshot' : 'Restore'} started: ${body.branchName}`,
      });
      await refresh();
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function removeBranch(branchId: string) {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/lakeload/branches/${branchId}`, { method: 'DELETE' });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Branch could not be removed.');
      setNotice({ kind: 'success', message: `${branchId} is being removed.` });
      await refresh();
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <TooltipProvider delayDuration={250} skipDelayDuration={100}>
      <div className="app-shell">
      <aside className="side-rail">
        <div className="brand-mark">
          <Waves />
        </div>
        <nav aria-label="Primary navigation">
          <RailButton label="Live telemetry" active={view === 'live'} onClick={() => setView('live')}>
            <Activity />
          </RailButton>
          <RailButton label="Compare engines" active={view === 'compare'} onClick={() => setView('compare')}>
            <Columns3 />
          </RailButton>
          <RailButton label="Branch lab" active={view === 'branches'} onClick={() => setView('branches')}>
            <GitBranch />
          </RailButton>
          <RailButton label="Run history" active={view === 'runs'} onClick={() => setView('runs')}>
            <History />
          </RailButton>
          <RailButton label="Settings" active={view === 'setup'} onClick={() => setView('setup')}>
            <Settings2 />
          </RailButton>
        </nav>
        <div className="rail-spacer" />
        <Explained title="Lakebase connection" description="The App can connect to its Lakebase control database.">
          <span className="connection-dot" role="status" tabIndex={0} aria-label="Lakebase connected" />
        </Explained>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div>
            <span className="eyebrow">Databricks Lakebase</span>
            <h1>LakeLoad</h1>
          </div>
          <div className="target-pill">
            <span className="target-icon">
              <Database />
            </span>
            <span>
              <b>
                {overview.endpoint.project} / {overview.endpoint.branch}
              </b>
              <small>
                {overview.endpoint.endpoint} · PostgreSQL {overview.target.postgres_version}
              </small>
            </span>
            <ShieldCheck className="target-ok" />
          </div>
        </header>
        {notice && (
          <div className={`notice-banner ${notice.kind}`} role="status">
            <CircleAlert />
            <span>{notice.message}</span>
            <button aria-label="Dismiss message" onClick={() => setNotice(null)}>
              ×
            </button>
          </div>
        )}
        {loading ? (
          <LoadingState />
        ) : view === 'live' ? (
          <LiveConsole
            overview={overview}
            metrics={metrics}
            latest={latest}
            selectedRun={selectedRun}
            selectedScenario={selectedScenario}
            selectedScenarioId={selectedScenarioId}
            engineFilter={engineFilter}
            setEngineFilter={setEngineFilter}
            chooseScenario={chooseScenario}
            concurrency={concurrency}
            setConcurrency={setConcurrency}
            duration={duration}
            setDuration={setDuration}
            ramp={ramp}
            setRamp={setRamp}
            executionModel={executionModel}
            setExecutionModel={setExecutionModel}
            targetRps={targetRps}
            setTargetRps={setTargetRps}
            busy={busy}
            launch={launch}
            stop={stop}
            progress={progress}
            errorRate={errorRate}
          />
        ) : view === 'compare' ? (
          <ComparisonView overview={overview} onOpenSetup={() => setView('setup')} />
        ) : view === 'branches' ? (
          <BranchLab
            overview={overview}
            metrics={metrics}
            latest={latest}
            busy={busy}
            onAction={branchAction}
            onRemove={removeBranch}
          />
        ) : view === 'runs' ? (
          <RunHistory
            overview={overview}
            selectedRunId={selectedRunId}
            onSelect={(id) => {
              selectedRunRef.current = id;
              setSelectedRunId(id);
              setView('live');
            }}
          />
        ) : (
          <SetupView overview={overview} busy={busy} onPrepare={prepare} onWarehouseChanged={refresh} />
        )}
      </main>
      </div>
    </TooltipProvider>
  );
}

type LiveConsoleProps = {
  overview: Overview;
  metrics: Metric[];
  latest?: Metric;
  selectedRun?: Run;
  selectedScenario?: Scenario;
  selectedScenarioId: string;
  engineFilter: 'lakebase' | 'dbsql';
  setEngineFilter: (value: 'lakebase' | 'dbsql') => void;
  chooseScenario: (scenario: Scenario) => void;
  concurrency: number;
  setConcurrency: (value: number) => void;
  duration: number;
  setDuration: (value: number) => void;
  ramp: number;
  setRamp: (value: number) => void;
  executionModel: 'closed' | 'open';
  setExecutionModel: (value: 'closed' | 'open') => void;
  targetRps: number;
  setTargetRps: (value: number) => void;
  busy: boolean;
  launch: () => Promise<void>;
  stop: () => Promise<void>;
  progress: number;
  errorRate: number;
};

function LiveConsole(props: LiveConsoleProps) {
  const scenarios = props.overview.scenarios.filter(
    (scenario) => scenario.runnable && scenario.engine === props.engineFilter
  );
  return (
    <>
      <section className="hero-grid">
        <div className="run-panel surface">
          <div className="section-heading">
            <div>
              <span className="section-kicker">Workload control</span>
              <h2>Shape the pressure</h2>
            </div>
            <div className="engine-switch">
              <Explained title="Lakebase workloads" description={HELP.lakebaseEngine}>
                <button
                  className={props.engineFilter === 'lakebase' ? 'active' : ''}
                  onClick={() => props.setEngineFilter('lakebase')}
                >
                  Lakebase
                </button>
              </Explained>
              <Explained title="DBSQL workloads" description={HELP.dbsqlEngine}>
                <button
                  className={props.engineFilter === 'dbsql' ? 'active' : ''}
                  onClick={() => props.setEngineFilter('dbsql')}
                >
                  DBSQL
                </button>
              </Explained>
            </div>
          </div>
          <div className="scenario-grid">
            {scenarios.map((scenario) => (
              <button
                key={scenario.id}
                className={`scenario-card ${props.selectedScenarioId === scenario.id ? 'selected' : ''}`}
                onClick={() => props.chooseScenario(scenario)}
                disabled={Boolean(props.overview.activeRunId)}
              >
                <span className="scenario-radio" />
                <strong>{scenario.name}</strong>
                <small>{scenario.question}</small>
                <code>{scenario.tags.slice(0, 3).join(' · ')}</code>
              </button>
            ))}
          </div>
          <div className="controls-grid">
            <Range
              label="Concurrent users"
              value={props.concurrency}
              min={1}
              max={150}
              onChange={props.setConcurrency}
              suffix=" VUs"
              help={HELP.concurrentUsers}
            />
            <Range
              label="Duration"
              value={props.duration}
              min={10}
              max={300}
              step={10}
              onChange={props.setDuration}
              suffix=" sec"
              help={HELP.duration}
            />
            <Range
              label="Ramp"
              value={props.ramp}
              min={0}
              max={60}
              step={5}
              onChange={props.setRamp}
              suffix=" sec"
              help={HELP.ramp}
            />
          </div>
          <div className="model-row">
            <div className="segmented">
              <Explained title="Closed loop" description={HELP.closedLoop}>
                <button
                  className={props.executionModel === 'closed' ? 'active' : ''}
                  onClick={() => props.setExecutionModel('closed')}
                >
                  Closed loop
                </button>
              </Explained>
              <Explained title="Target rate" description={HELP.targetRate}>
                <button
                  className={props.executionModel === 'open' ? 'active' : ''}
                  onClick={() => props.setExecutionModel('open')}
                >
                  Target rate
                </button>
              </Explained>
            </div>
            {props.executionModel === 'open' && (
              <Range
                label="Target arrival rate"
                value={props.targetRps}
                min={10}
                max={2000}
                step={10}
                onChange={props.setTargetRps}
                suffix=" ops/s"
                help={HELP.targetArrivalRate}
              />
            )}
          </div>
          <div className="run-actions">
            <div className="safety-note">
              <ShieldCheck />
              <span>
                Isolated benchmark branch<small>Pool capped at {props.overview.endpoint.poolSize} connections</small>
              </span>
            </div>
            {props.overview.activeRunId ? (
              <Button variant="destructive" size="lg" onClick={() => void props.stop()}>
                <Square /> Stop load
              </Button>
            ) : (
              <Button
                size="lg"
                className="launch-button"
                disabled={props.busy || !props.selectedScenario}
                onClick={() => void props.launch()}
              >
                {props.busy ? <RefreshCw className="spin" /> : <Play />} Simulate load
              </Button>
            )}
          </div>
        </div>
        <DatabaseCore
          overview={props.overview}
          latest={props.latest}
          running={props.selectedRun?.status === 'running'}
        />
      </section>

      <section className="live-section surface">
        <div className="live-header">
          <div className="run-title">
            <span className={`pulse-indicator ${props.selectedRun?.status === 'running' ? 'on' : ''}`} />
            <div>
              <span className="section-kicker">Live database telemetry</span>
              <h2>
                {props.selectedRun
                  ? scenarioName(props.overview.scenarios, props.selectedRun.scenario)
                  : 'Ready for a run'}
              </h2>
            </div>
          </div>
          {props.selectedRun && (
            <div className="run-meta">
              <Badge variant="outline" className={`status-${props.selectedRun.status}`}>
                {props.selectedRun.status}
              </Badge>
              <span>{props.selectedRun.concurrency} VUs</span>
              <span>1-second samples</span>
            </div>
          )}
        </div>
        <div className="progress-track">
          <span style={{ transform: `scaleX(${props.progress / 100})` }} />
        </div>
        <div className="hero-metrics">
          <MetricCard
            icon={<Zap />}
            label="Workload TPS"
            value={compact(value(props.latest?.operations))}
            unit="ops/s"
            description={HELP.workloadTps}
          />
          <MetricCard
            icon={<Gauge />}
            label="P99 latency"
            value={value(props.latest?.p99_ms).toFixed(0)}
            unit="ms"
            description={HELP.p99}
          />
          <MetricCard
            icon={<Database />}
            label="Database tx"
            value={compact(value(props.latest?.database_tps))}
            unit="tx/s"
            description={HELP.databaseTps}
          />
          <MetricCard
            icon={<Activity />}
            label="Connections"
            value={String(value(props.latest?.connections_total))}
            unit="open"
            description={HELP.connections}
          />
          <MetricCard
            icon={<ShieldCheck />}
            label="Cache hit"
            value={value(props.latest?.cache_hit_pct).toFixed(1)}
            unit="%"
            description={HELP.cacheHit}
          />
          <MetricCard
            icon={<CircleAlert />}
            label="Error rate"
            value={props.errorRate.toFixed(2)}
            unit="%"
            description={HELP.errorRate}
          />
        </div>
        <div className="charts-grid">
          <LiveChart
            live={props.selectedRun?.status === 'running'}
            title="Throughput"
            subtitle="Workload operations and database transactions per second"
            metrics={props.metrics}
            series={[
              { key: 'operations', label: 'workload TPS', tone: 'cyan' },
              { key: 'database_tps', label: 'database tx/s', tone: 'green' },
            ]}
          />
          <LiveChart
            live={props.selectedRun?.status === 'running'}
            title="Latency envelope"
            subtitle="Request latency percentiles"
            metrics={props.metrics}
            unit="ms"
            series={[
              { key: 'p50_ms', label: 'p50', tone: 'cyan' },
              { key: 'p95_ms', label: 'p95', tone: 'indigo' },
              { key: 'p99_ms', label: 'p99', tone: 'red' },
            ]}
          />
          <LiveChart
            live={props.selectedRun?.status === 'running'}
            title="Connection pressure"
            subtitle="Active, idle and total PostgreSQL sessions"
            metrics={props.metrics}
            series={[
              { key: 'connections_active', label: 'active', tone: 'cyan' },
              { key: 'connections_idle', label: 'idle', tone: 'indigo' },
              { key: 'connections_total', label: 'total', tone: 'amber' },
            ]}
          />
          <LiveChart
            live={props.selectedRun?.status === 'running'}
            title="Row churn"
            subtitle="Rows changed in each one-second interval"
            metrics={props.metrics}
            series={[
              { key: 'rows_inserted', label: 'inserted', tone: 'green' },
              { key: 'rows_updated', label: 'updated', tone: 'cyan' },
              { key: 'rows_deleted', label: 'deleted', tone: 'red' },
            ]}
          />
          <LiveChart
            live={props.selectedRun?.status === 'running'}
            title="Operation mix"
            subtitle="Reads, writes and bounded complex queries"
            metrics={props.metrics}
            series={[
              { key: 'reads', label: 'reads', tone: 'cyan' },
              { key: 'writes', label: 'writes', tone: 'indigo' },
              { key: 'complex_queries', label: 'complex', tone: 'amber' },
            ]}
          />
          <LiveChart
            live={props.selectedRun?.status === 'running'}
            title="Database health"
            subtitle="Cache efficiency and waiting locks"
            metrics={props.metrics}
            series={[
              { key: 'cache_hit_pct', label: 'cache hit %', tone: 'green' },
              { key: 'locks_waiting', label: 'waiting locks', tone: 'red' },
            ]}
          />
        </div>
      </section>
    </>
  );
}

function DatabaseCore({ overview, latest, running }: { overview: Overview; latest?: Metric; running: boolean }) {
  return (
    <aside className="database-panel surface">
      <div className="section-heading">
        <div>
          <span className="section-kicker">Target database</span>
          <h2>{running ? 'Under load' : 'Standing by'}</h2>
        </div>
        <span className={`live-dot ${running ? 'active' : ''}`}>{running ? 'LIVE' : 'READY'}</span>
      </div>
      <div className={`database-core ${running ? 'active' : ''}`}>
        <span className="core-ring ring-a" />
        <span className="core-ring ring-b" />
        <span className="core-ring ring-c" />
        <Database />
        <strong>{compact(value(latest?.operations))}</strong>
        <small>TPS</small>
      </div>
      <div className="core-stats">
        <DataStat
          label="Accounts"
          value={compact(value(overview.target.accounts))}
          description="Seeded account rows available to Lakebase operational workloads."
        />
        <DataStat
          label="History"
          value={compact(value(overview.target.history_rows))}
          description="Historical transaction rows available to analytical and mixed workloads."
        />
        <DataStat
          label="Size"
          value={bytes(value(latest?.database_bytes))}
          description="Current PostgreSQL database size reported by Lakebase."
        />
      </div>
      <div className="endpoint-detail">
        <HelpLabel label="Compute" description={HELP.autoscaling} />
        <b>{overview.endpoint.autoscaling} autoscaling</b>
      </div>
      <div className="endpoint-detail">
        <HelpLabel label="Active sessions" description={HELP.activeSessions} />
        <b>
          {value(latest?.connections_active)} / {value(latest?.connections_total)}
        </b>
      </div>
      <div className="endpoint-detail">
        <HelpLabel label="Lock waits" description={HELP.lockWaits} />
        <b>{value(latest?.locks_waiting)}</b>
      </div>
    </aside>
  );
}

function ComparisonView({ overview, onOpenSetup }: { overview: Overview; onOpenSetup: () => void }) {
  const [presetId, setPresetId] = useState<ComparisonPreset['id']>('oltp');
  const preset = COMPARISON_PRESETS.find((item) => item.id === presetId) ?? COMPARISON_PRESETS[0];
  const [concurrency, setConcurrency] = useState(preset.concurrency);
  const [duration, setDuration] = useState(preset.duration);
  const [ramp, setRamp] = useState(preset.ramp);
  const [lakebase, setLakebase] = useState<RunDetails | null>(null);
  const [dbsql, setDbsql] = useState<RunDetails | null>(null);
  const [phase, setPhase] = useState<'lakebase' | 'dbsql' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const cancelRequested = useRef(false);
  const ready = !preset.minimumHistoryRows || overview.target.history_rows >= preset.minimumHistoryRows;
  const lakebaseScenario = overview.scenarios.find((scenario) => scenario.id === preset.lakebaseScenario);
  const dbsqlScenario = overview.scenarios.find((scenario) => scenario.id === preset.dbsqlScenario);
  const latestLakebaseId = overview.runs.find(
    (run) => run.scenario === preset.lakebaseScenario && run.status === 'completed'
  )?.id;
  const latestDbsqlId = overview.runs.find(
    (run) => run.scenario === preset.dbsqlScenario && run.status === 'completed'
  )?.id;

  useEffect(() => {
    setConcurrency(preset.concurrency);
    setDuration(preset.duration);
    setRamp(preset.ramp);
    setError('');
  }, [preset]);

  useEffect(() => {
    if (busy) return;
    let cancelled = false;
    async function loadLatest() {
      const [left, right] = await Promise.all([
        latestLakebaseId ? fetchRunDetails(latestLakebaseId) : Promise.resolve(null),
        latestDbsqlId ? fetchRunDetails(latestDbsqlId) : Promise.resolve(null),
      ]);
      if (!cancelled) {
        setLakebase(left);
        setDbsql(right);
      }
    }
    void loadLatest().catch((loadError) => {
      if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError));
    });
    return () => {
      cancelled = true;
    };
  }, [busy, latestDbsqlId, latestLakebaseId, presetId]);

  async function startScenario(scenario: string) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await fetch('/api/lakeload/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scenario,
          concurrency,
          durationSeconds: duration,
          rampSeconds: ramp,
          executionModel: 'closed',
        }),
      });
      const body = (await response.json()) as { runId?: string; error?: string };
      if (response.ok && body.runId) return body.runId;
      if (response.status !== 409 || attempt === 4) throw new Error(body.error ?? 'Comparison run could not start.');
      await pause(1_000);
    }
    throw new Error('Comparison run could not start.');
  }

  async function followRun(runId: string, update: (details: RunDetails) => void) {
    for (let attempt = 0; attempt < duration + 180; attempt += 1) {
      const details = await fetchRunDetails(runId);
      update(details);
      if (['completed', 'cancelled', 'failed'].includes(details.run.status)) return details;
      await pause(1_000);
    }
    throw new Error('Comparison run exceeded its monitoring window.');
  }

  async function runComparison() {
    if (!ready || !lakebaseScenario || !dbsqlScenario) return;
    cancelRequested.current = false;
    setBusy(true);
    setError('');
    setLakebase(null);
    setDbsql(null);
    try {
      setPhase('lakebase');
      const lakebaseRunId = await startScenario(lakebaseScenario.id);
      const lakebaseResult = await followRun(lakebaseRunId, setLakebase);
      if (cancelRequested.current || lakebaseResult.run.status !== 'completed') return;

      await pause(1_000);
      setPhase('dbsql');
      const dbsqlRunId = await startScenario(dbsqlScenario.id);
      await followRun(dbsqlRunId, setDbsql);
    } catch (comparisonError) {
      setError(comparisonError instanceof Error ? comparisonError.message : String(comparisonError));
    } finally {
      setPhase(null);
      setBusy(false);
    }
  }

  async function stopComparison() {
    cancelRequested.current = true;
    const response = await fetch('/api/lakeload/overview');
    const body = (await response.json()) as Overview;
    if (body.activeRunId) await fetch(`/api/lakeload/runs/${body.activeRunId}`, { method: 'DELETE' });
  }

  return (
    <div className="comparison-workspace">
      <section className="comparison-hero surface">
        <div>
          <span className="section-kicker">Engine comparison</span>
          <h2>Lakebase and DBSQL, side by side</h2>
          <p>Run controlled workload pairs, inspect both timelines, and explain which engine fits the job.</p>
        </div>
        <div className="comparison-method">
          <ShieldCheck />
          <span>
            <HelpLabel label="Sequential execution" description={HELP.sequentialComparison} />
            <small>
              DBSQL: {overview.sqlWarehouse.name} · {overview.sqlWarehouse.clusterSize}
            </small>
          </span>
        </div>
      </section>

      <section className="comparison-presets" aria-label="Comparison workload">
        {COMPARISON_PRESETS.map((item) => (
          <button
            key={item.id}
            className={presetId === item.id ? 'active' : ''}
            onClick={() => setPresetId(item.id)}
            disabled={busy}
          >
            <span>{item.eyebrow}</span>
            <strong>{item.title}</strong>
            <small>{item.question}</small>
          </button>
        ))}
      </section>

      <section className="comparison-control surface">
        <div className="comparison-definition">
          <div className="badge-with-help">
            <Badge variant="outline">{preset.matched ? 'matched workload' : 'best-fit workloads'}</Badge>
            <HelpTip
              label={preset.matched ? 'Matched workload' : 'Best-fit workloads'}
              description={preset.matched ? HELP.matchedWorkload : HELP.bestFitWorkload}
            />
          </div>
          <div>
            <strong>{preset.method}</strong>
            <p>{preset.interpretation}</p>
          </div>
        </div>
        <div className="comparison-ranges">
          <Range
            label="Concurrent clients"
            value={concurrency}
            min={1}
            max={50}
            onChange={setConcurrency}
            suffix=" VUs"
            help={HELP.concurrentUsers}
          />
          <Range
            label="Per-engine duration"
            value={duration}
            min={10}
            max={60}
            step={5}
            onChange={setDuration}
            suffix=" sec"
            help={HELP.duration}
          />
          <Range
            label="Ramp"
            value={ramp}
            min={0}
            max={20}
            step={1}
            onChange={setRamp}
            suffix=" sec"
            help={HELP.ramp}
          />
        </div>
        <div className="comparison-launch">
          <span>
            <HelpLabel label="Estimated wall time" description={HELP.estimatedWallTime} />{' '}
            <b>{duration * 2 + 2}s</b>
          </span>
          {!ready ? (
            <Button size="lg" onClick={onOpenSetup}>
              <Database /> Prepare 5M-row dataset
            </Button>
          ) : busy ? (
            <Button variant="destructive" size="lg" onClick={() => void stopComparison()}>
              <Square /> Stop comparison
            </Button>
          ) : (
            <Button
              size="lg"
              className="launch-button"
              disabled={Boolean(overview.activeRunId)}
              onClick={() => void runComparison()}
            >
              <Play /> Run matched comparison
            </Button>
          )}
        </div>
        {error && (
          <div className="comparison-error">
            <CircleAlert /> {error}
          </div>
        )}
      </section>

      <ComparisonScorecard preset={preset} lakebase={lakebase} dbsql={dbsql} />

      <section className="comparison-stage">
        <ComparisonLane
          engine="lakebase"
          title="Lakebase"
          scenario={lakebaseScenario}
          details={lakebase}
          active={phase === 'lakebase'}
        />
        <ComparisonLane
          engine="dbsql"
          title="DBSQL"
          scenario={dbsqlScenario}
          details={dbsql}
          active={phase === 'dbsql'}
        />
      </section>
    </div>
  );
}

function ComparisonLane({
  engine,
  title,
  scenario,
  details,
  active,
}: {
  engine: 'lakebase' | 'dbsql';
  title: string;
  scenario?: Scenario;
  details: RunDetails | null;
  active: boolean;
}) {
  const run = details?.run;
  const metrics = details?.metrics ?? [];
  const latest = metrics.at(-1);
  const elapsed = Math.max(1, value(latest?.elapsed_seconds));
  const completedOperations =
    run && run.status === 'completed'
      ? value(run.total_operations)
      : metrics.reduce((sum, item) => sum + value(item.operations), 0);
  const averageTps = completedOperations / elapsed;
  const errorRate = run
    ? (value(run.total_errors) / Math.max(1, value(run.total_operations) + value(run.total_errors))) * 100
    : 0;
  return (
    <article className={`comparison-lane ${engine}`}>
      <header>
        <span className="comparison-engine-icon">{engine === 'lakebase' ? <Database /> : <Columns3 />}</span>
        <div>
          <span className="section-kicker">{title}</span>
          <h2>{scenario?.name ?? 'Waiting for scenario'}</h2>
          <p>{scenario?.method}</p>
        </div>
        <Badge variant="outline" className={`status-${run?.status ?? 'ready'}`}>
          {active ? 'running' : (run?.status ?? 'ready')}
        </Badge>
      </header>
      <div className="comparison-kpis">
        <ComparisonKpi
          label="Average throughput"
          value={run ? averageTps.toFixed(1) : '—'}
          unit="ops/s"
          description={HELP.averageThroughput}
        />
        <ComparisonKpi
          label="P95 latency"
          value={run ? value(run.p95_ms).toFixed(0) : '—'}
          unit="ms"
          description={HELP.p95}
        />
        <ComparisonKpi
          label="P99 latency"
          value={run ? value(run.p99_ms).toFixed(0) : '—'}
          unit="ms"
          description={HELP.p99}
        />
        <ComparisonKpi
          label="Error rate"
          value={run ? errorRate.toFixed(2) : '—'}
          unit="%"
          description={HELP.errorRate}
        />
      </div>
      <div className="comparison-charts">
        <LiveChart
          live={active}
          title={`${title} throughput`}
          subtitle="Completed operations in each one-second interval"
          metrics={metrics}
          series={[{ key: 'operations', label: 'operations', tone: engine === 'lakebase' ? 'cyan' : 'indigo' }]}
        />
        <LiveChart
          live={active}
          title={`${title} latency`}
          subtitle="Tail latency for the selected workload"
          metrics={metrics}
          unit="ms"
          series={[
            { key: 'p50_ms', label: 'p50', tone: 'cyan' },
            { key: 'p95_ms', label: 'p95', tone: 'indigo' },
            { key: 'p99_ms', label: 'p99', tone: 'red' },
          ]}
        />
      </div>
      {run && (
        <footer>
          <span>{run.concurrency} clients</span>
          <span>{run.duration_seconds}s configured</span>
          <span>{compact(value(run.total_operations))} operations</span>
        </footer>
      )}
    </article>
  );
}

function ComparisonKpi({
  label,
  value: displayValue,
  unit,
  description,
}: {
  label: string;
  value: string;
  unit: string;
  description: string;
}) {
  return (
    <div>
      <HelpLabel label={label} description={description} />
      <strong>
        {displayValue}
        <small>{unit}</small>
      </strong>
    </div>
  );
}

function ComparisonScorecard({
  preset,
  lakebase,
  dbsql,
}: {
  preset: ComparisonPreset;
  lakebase: RunDetails | null;
  dbsql: RunDetails | null;
}) {
  const left = lakebase?.run;
  const right = dbsql?.run;
  const leftRate = comparisonRate(lakebase);
  const rightRate = comparisonRate(dbsql);
  const leftError = left ? runErrorRate(left) : null;
  const rightError = right ? runErrorRate(right) : null;
  const leftGuardrails = comparisonGuardrails(preset, 'lakebase');
  const rightGuardrails = comparisonGuardrails(preset, 'dbsql');
  const verdict = comparisonVerdict(preset, lakebase, dbsql);
  return (
    <section className="comparison-scorecard surface">
      <div className="section-heading">
        <div>
          <span className="section-kicker">Decision</span>
          <h2>Winner and score</h2>
        </div>
        <div className="badge-with-help">
          <Badge variant="outline">workload-specific scoring</Badge>
          <HelpTip
            label="How LakeLoad scores a run"
            description="For matched workloads, p95 latency is the primary signal, error rate is a guardrail, and throughput breaks close results. Best-fit workloads use separate OLTP and OLAP targets."
          />
        </div>
      </div>
      <div className={`comparison-verdict ${verdict.tone}`} role="status" aria-live="polite">
        <span className="verdict-icon">{verdict.tone === 'winner' ? <Trophy /> : <Target />}</span>
        <div>
          <span className="section-kicker">{verdict.eyebrow}</span>
          <h3>{verdict.title}</h3>
          <p>{verdict.detail}</p>
          <div className="verdict-facts">
            {verdict.facts.map((fact) => (
              <span key={fact}>{fact}</span>
            ))}
          </div>
        </div>
      </div>
      <div className="score-guide">
        <div>
          <strong>How to read the ratings</strong>
          <p>Ratings use the selected workload and visible guardrails—not an industry-wide average.</p>
        </div>
        <span className="result-rating stretch">Stretch goal</span>
        <span className="result-rating target">Within target</span>
        <span className="result-rating attention">Outside target</span>
      </div>
      <div className="comparison-table" role="table" aria-label="Lakebase and DBSQL result comparison">
        <div className="comparison-row comparison-head" role="row">
          <span>Measure</span>
          <span>Lakebase</span>
          <span>DBSQL</span>
          <span>Guardrail</span>
        </div>
        <ComparisonRow
          label="Average throughput"
          left={comparisonTps(lakebase)}
          right={comparisonTps(dbsql)}
          description={HELP.averageThroughput}
          leftRating={relativeRating(leftRate, rightRate)}
          rightRating={relativeRating(rightRate, leftRate)}
          guardrail="A 10% lead is material"
        />
        <ComparisonRow
          label="P95 latency"
          left={left ? `${value(left.p95_ms).toFixed(0)} ms` : '—'}
          right={right ? `${value(right.p95_ms).toFixed(0)} ms` : '—'}
          description={HELP.p95}
          leftRating={latencyRating(left?.p95_ms, leftGuardrails.p95Stretch, leftGuardrails.p95Target)}
          rightRating={latencyRating(right?.p95_ms, rightGuardrails.p95Stretch, rightGuardrails.p95Target)}
          guardrail={guardrailLabel(preset, 'p95')}
        />
        <ComparisonRow
          label="P99 latency"
          left={left ? `${value(left.p99_ms).toFixed(0)} ms` : '—'}
          right={right ? `${value(right.p99_ms).toFixed(0)} ms` : '—'}
          description={HELP.p99}
          leftRating={latencyRating(left?.p99_ms, leftGuardrails.p99Stretch, leftGuardrails.p99Target)}
          rightRating={latencyRating(right?.p99_ms, rightGuardrails.p99Stretch, rightGuardrails.p99Target)}
          guardrail={guardrailLabel(preset, 'p99')}
        />
        <ComparisonRow
          label="Error rate"
          left={leftError === null ? '—' : `${leftError.toFixed(2)}%`}
          right={rightError === null ? '—' : `${rightError.toFixed(2)}%`}
          description={HELP.errorRate}
          leftRating={errorRating(leftError)}
          rightRating={errorRating(rightError)}
          guardrail="Stretch ≤0.1% · target <1%"
        />
        <ComparisonRow
          label="Completed operations"
          left={left ? compact(value(left.total_operations)) : '—'}
          right={right ? compact(value(right.total_operations)) : '—'}
          description={HELP.completedOperations}
          leftRating={relativeRating(left ? value(left.total_operations) : null, right ? value(right.total_operations) : null)}
          rightRating={relativeRating(right ? value(right.total_operations) : null, left ? value(left.total_operations) : null)}
          guardrail="Higher at equal duration"
        />
      </div>
    </section>
  );
}

type RatingTone = 'stretch' | 'target' | 'attention' | 'lead' | 'trail' | 'neutral';
type ResultRating = { label: string; tone: RatingTone };
type ComparisonGuardrails = {
  p95Stretch: number;
  p95Target: number;
  p99Stretch: number;
  p99Target: number;
};

function ComparisonRow({
  label,
  left,
  right,
  description,
  leftRating,
  rightRating,
  guardrail,
}: {
  label: string;
  left: string;
  right: string;
  description: string;
  leftRating: ResultRating;
  rightRating: ResultRating;
  guardrail: string;
}) {
  return (
    <div className="comparison-row" role="row">
      <HelpLabel label={label} description={description} />
      <ComparisonResult value={left} rating={leftRating} />
      <ComparisonResult value={right} rating={rightRating} />
      <small className="comparison-guardrail">{guardrail}</small>
    </div>
  );
}

function ComparisonResult({ value: displayValue, rating }: { value: string; rating: ResultRating }) {
  return (
    <span className="comparison-result">
      <strong>{displayValue}</strong>
      <em className={`result-rating ${rating.tone}`}>{rating.label}</em>
    </span>
  );
}

function comparisonTps(details: RunDetails | null) {
  const rate = comparisonRate(details);
  return rate === null ? '—' : `${rate.toFixed(1)} ops/s`;
}

function comparisonRate(details: RunDetails | null) {
  if (!details?.run) return null;
  const elapsed = Math.max(1, value(details.metrics.at(-1)?.elapsed_seconds) || details.run.duration_seconds);
  return value(details.run.total_operations) / elapsed;
}

function runErrorRate(run: Run) {
  return (value(run.total_errors) / Math.max(1, value(run.total_operations) + value(run.total_errors))) * 100;
}

function comparisonGuardrails(preset: ComparisonPreset, engine: 'lakebase' | 'dbsql'): ComparisonGuardrails {
  const analytical = preset.id === 'olap' || (preset.id === 'best-fit' && engine === 'dbsql');
  return analytical
    ? { p95Stretch: 5_000, p95Target: 15_000, p99Stretch: 10_000, p99Target: 30_000 }
    : { p95Stretch: 50, p95Target: 100, p99Stretch: 100, p99Target: 250 };
}

function latencyRating(
  input: number | null | undefined,
  stretchThreshold: number,
  targetThreshold: number
): ResultRating {
  if (input === null || input === undefined) return { label: 'No result', tone: 'neutral' };
  const measured = value(input);
  if (measured <= stretchThreshold) return { label: 'Stretch goal', tone: 'stretch' };
  if (measured <= targetThreshold) return { label: 'Within target', tone: 'target' };
  return { label: 'Outside target', tone: 'attention' };
}

function errorRating(input: number | null): ResultRating {
  if (input === null) return { label: 'No result', tone: 'neutral' };
  if (input <= 0.1) return { label: 'Stretch goal', tone: 'stretch' };
  if (input < 1) return { label: 'Within target', tone: 'target' };
  return { label: 'Outside target', tone: 'attention' };
}

function relativeRating(input: number | null, other: number | null): ResultRating {
  if (input === null || other === null) return { label: 'No result', tone: 'neutral' };
  if (input >= other * 1.1) return { label: 'Leads', tone: 'lead' };
  if (other >= input * 1.1) return { label: 'Trails', tone: 'trail' };
  return { label: 'Comparable', tone: 'neutral' };
}

function guardrailLabel(preset: ComparisonPreset, percentile: 'p95' | 'p99') {
  const lakebase = comparisonGuardrails(preset, 'lakebase');
  const dbsql = comparisonGuardrails(preset, 'dbsql');
  const lakebaseStretch = percentile === 'p95' ? lakebase.p95Stretch : lakebase.p99Stretch;
  const lakebaseTarget = percentile === 'p95' ? lakebase.p95Target : lakebase.p99Target;
  const dbsqlTarget = percentile === 'p95' ? dbsql.p95Target : dbsql.p99Target;
  if (lakebaseTarget === dbsqlTarget)
    return `Stretch ≤${formatMilliseconds(lakebaseStretch)} · target ≤${formatMilliseconds(lakebaseTarget)}`;
  return `Lakebase ≤${formatMilliseconds(lakebaseTarget)} · DBSQL ≤${formatMilliseconds(dbsqlTarget)}`;
}

function formatMilliseconds(milliseconds: number) {
  return milliseconds >= 1_000 ? `${milliseconds / 1_000}s` : `${milliseconds}ms`;
}

function comparisonVerdict(preset: ComparisonPreset, lakebase: RunDetails | null, dbsql: RunDetails | null) {
  const left = lakebase?.run;
  const right = dbsql?.run;
  if (!left || !right) {
    if (!preset.matched) {
      return {
        tone: 'pending',
        eyebrow: 'Awaiting both results',
        title: 'Run both workloads to evaluate engine fit',
        detail: 'Lakebase will be rated against an operational latency target and DBSQL against an analytical latency target.',
        facts: ['Lakebase: OLTP target', 'DBSQL: OLAP target', 'Error ceiling: <1%'],
      };
    }
    return {
      tone: 'pending',
      eyebrow: 'Awaiting both results',
      title: 'Run both engines to select a winner',
      detail: 'LakeLoad will score p95 latency first, apply the error ceiling, then use throughput for close results.',
      facts: ['Primary: p95 latency', 'Error ceiling: <1%', 'Tiebreaker: throughput'],
    };
  }

  const leftRate = comparisonRate(lakebase) ?? 0;
  const rightRate = comparisonRate(dbsql) ?? 0;
  const leftError = runErrorRate(left);
  const rightError = runErrorRate(right);
  const leftP95 = Math.max(0.01, value(left.p95_ms));
  const rightP95 = Math.max(0.01, value(right.p95_ms));

  if (!preset.matched) {
    const leftRating = latencyRating(
      leftP95,
      comparisonGuardrails(preset, 'lakebase').p95Stretch,
      comparisonGuardrails(preset, 'lakebase').p95Target
    );
    const rightRating = latencyRating(
      rightP95,
      comparisonGuardrails(preset, 'dbsql').p95Stretch,
      comparisonGuardrails(preset, 'dbsql').p95Target
    );
    return {
      tone: 'split',
      eyebrow: 'Split decision',
      title: 'No single winner for different jobs',
      detail: 'Use Lakebase for the operational request path and DBSQL for the analytical scan. Each result uses its own latency target.',
      facts: [
        `Lakebase OLTP: ${leftRating.label}`,
        `DBSQL OLAP: ${rightRating.label}`,
        `Errors: ${leftError.toFixed(2)}% / ${rightError.toFixed(2)}%`,
      ],
    };
  }

  let winner: 'Lakebase' | 'DBSQL' | 'Near tie';
  if (leftError < 1 && rightError >= 1) winner = 'Lakebase';
  else if (rightError < 1 && leftError >= 1) winner = 'DBSQL';
  else if (leftP95 <= rightP95 / 1.1) winner = 'Lakebase';
  else if (rightP95 <= leftP95 / 1.1) winner = 'DBSQL';
  else if (leftRate >= rightRate * 1.1) winner = 'Lakebase';
  else if (rightRate >= leftRate * 1.1) winner = 'DBSQL';
  else winner = 'Near tie';

  const lowerLatencyEngine = leftP95 <= rightP95 ? 'Lakebase' : 'DBSQL';
  const latencyRatio = Math.max(leftP95, rightP95) / Math.min(leftP95, rightP95);
  const higherRateEngine = leftRate >= rightRate ? 'Lakebase' : 'DBSQL';
  const rateRatio = Math.max(leftRate, rightRate) / Math.max(0.01, Math.min(leftRate, rightRate));
  return {
    tone: winner === 'Near tie' ? 'tie' : 'winner',
    eyebrow: winner === 'Near tie' ? 'Result' : 'Winner',
    title: winner === 'Near tie' ? 'Near tie: results are within 10%' : `${winner} wins: ${preset.title}`,
    detail:
      winner === 'Near tie'
        ? 'Neither engine leads by 10% on the decision metrics. Repeat the test or increase load before drawing a conclusion.'
        : `${winner} leads on the scored result. This decision applies to the displayed data, compute, cache state, and client settings.`,
    facts: [
      `P95: ${lowerLatencyEngine} ${latencyRatio.toFixed(1)}× lower`,
      `Throughput: ${higherRateEngine} ${rateRatio.toFixed(1)}× higher`,
      `Errors: ${leftError.toFixed(2)}% / ${rightError.toFixed(2)}%`,
    ],
  };
}

async function fetchRunDetails(runId: string): Promise<RunDetails> {
  const response = await fetch(`/api/lakeload/runs/${runId}`);
  const body = (await response.json()) as { run?: Run; metrics?: Metric[]; error?: string };
  if (!response.ok || !body.run) throw new Error(body.error ?? 'Run details could not load.');
  return { run: body.run, metrics: (body.metrics ?? []).map(normalizeMetric) };
}

const pause = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

function BranchLab({
  overview,
  metrics,
  latest,
  busy,
  onAction,
  onRemove,
}: {
  overview: Overview;
  metrics: Metric[];
  latest?: Metric;
  busy: boolean;
  onAction: (input: Record<string, unknown>) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}) {
  const benchmarkName = `projects/${overview.endpoint.project}/branches/${overview.endpoint.branch}`;
  const snapshots = overview.branches.filter((branch) => branchId(branch).startsWith('snapshot-'));
  const restores = overview.branches.filter((branch) => branchId(branch).startsWith('restore-'));
  const visibleOperations = overview.branchOperations.filter(
    (operation) =>
      operation.status === 'queued' ||
      operation.status === 'running' ||
      overview.branches.some((branch) => branch.name === operation.branch_name)
  );
  const [selectedSnapshot, setSelectedSnapshot] = useState('');
  const [deleteBranch, setDeleteBranch] = useState('');
  const snapshotId = `snapshot-${new Date().toISOString().slice(0, 19).replace(/[-:t]/gi, '')}`.toLowerCase();
  const restoreId = `restore-${new Date().toISOString().slice(0, 19).replace(/[-:t]/gi, '')}`.toLowerCase();
  return (
    <>
      <section className="branch-hero surface">
        <div>
          <span className="section-kicker">Copy-on-write branch lab</span>
          <div className="heading-with-help">
            <h2>Snapshot the database while it is under load</h2>
            <HelpTip label="Lakebase snapshots" description={HELP.snapshot} />
          </div>
          <p>
            Capture the benchmark branch in seconds, then restore that state into an isolated branch with its own
            compute. The active workload keeps running.
          </p>
        </div>
        <Explained title="Capture snapshot" description={HELP.snapshot}>
          <Button
            size="lg"
            className="launch-button"
            disabled={busy}
            onClick={() =>
              void onAction({ kind: 'snapshot', sourceBranch: benchmarkName, branchId: snapshotId, createCompute: false })
            }
          >
            <GitBranch /> Capture snapshot
          </Button>
        </Explained>
      </section>
      <div className="branch-live-strip">
        <MetricCard
          icon={<Zap />}
          label="Live TPS"
          value={compact(value(latest?.operations))}
          unit="ops/s"
          description={HELP.workloadTps}
        />
        <MetricCard
          icon={<Gauge />}
          label="Live p99"
          value={value(latest?.p99_ms).toFixed(0)}
          unit="ms"
          description={HELP.p99}
        />
        <MetricCard
          icon={<Activity />}
          label="Connections"
          value={String(value(latest?.connections_total))}
          unit="open"
          description={HELP.connections}
        />
        <MetricCard
          icon={<Boxes />}
          label="Branches"
          value={String(overview.branches.length)}
          unit="total"
          description="Lakebase branches currently visible to LakeLoad, including production, benchmark, snapshots, and restores."
        />
      </div>
      <section className="branch-canvas surface">
        <div className="section-heading">
          <div>
            <span className="section-kicker">Live topology</span>
            <h2>Branch lineage</h2>
          </div>
          <div className="badge-with-help">
            <Badge variant="outline">refreshes every second</Badge>
            <HelpTip
              label="Live topology refresh"
              description="LakeLoad polls branch state every second while this screen is open."
            />
          </div>
        </div>
        <div className="branch-tree">
          <BranchNode
            type="root"
            name="production"
            state={branchState(overview.branches.find((branch) => branchId(branch) === 'production'))}
            detail="control plane"
          />
          <span className="branch-link" />
          <BranchNode
            type="benchmark"
            name="benchmark"
            state={branchState(overview.branches.find((branch) => branchId(branch) === 'benchmark'))}
            detail={overview.activeRunId ? 'load active' : 'load target'}
            active={Boolean(overview.activeRunId)}
          />
          <span className="branch-split" />
          <div className="branch-children">
            {snapshots.length === 0 ? (
              <div className="branch-empty">
                <GitBranch />
                <strong>No snapshot yet</strong>
                <small>Capture one while the load graph is moving.</small>
              </div>
            ) : (
              snapshots.map((branch) => (
                <div className="snapshot-row" key={branch.name}>
                  <Explained title="Snapshot branch" description={HELP.logicalSize}>
                    <button
                      className={`branch-select ${selectedSnapshot === branch.name ? 'selected' : ''}`}
                      onClick={() => setSelectedSnapshot(branch.name ?? '')}
                    >
                      <BranchNode
                        type="snapshot"
                        name={branchId(branch)}
                        state={branchState(branch)}
                        detail={`${bytes(value(branch.status?.logical_size_bytes))} logical`}
                      />
                      <span className="branch-time">
                        {branch.create_time ? new Date(branch.create_time).toLocaleTimeString() : 'creating'}
                      </span>
                    </button>
                  </Explained>
                  <button
                    className="branch-trash"
                    aria-label={`Remove ${branchId(branch)}`}
                    onClick={() => setDeleteBranch(branchId(branch))}
                  >
                    <Trash2 />
                  </button>
                </div>
              ))
            )}
            {restores.map((branch) => (
              <div className="restore-node" key={branch.name}>
                <BranchNode
                  type="restore"
                  name={branchId(branch)}
                  state={branchState(branch)}
                  detail="isolated restore"
                />
                <button aria-label={`Remove ${branchId(branch)}`} onClick={() => setDeleteBranch(branchId(branch))}>
                  <Trash2 />
                </button>
              </div>
            ))}
          </div>
        </div>
        <div className="branch-actions">
          <div>
            <strong>{selectedSnapshot ? branchId({ name: selectedSnapshot }) : 'Select a snapshot'}</strong>
            <small>
              Restore creates a new branch with dedicated read-write compute. It does not interrupt benchmark.
            </small>
          </div>
          <Explained title="Restore isolated branch" description={HELP.restore}>
            <Button
              size="lg"
              disabled={!selectedSnapshot || busy}
              onClick={() =>
                void onAction({
                  kind: 'restore',
                  sourceBranch: selectedSnapshot,
                  branchId: restoreId,
                  createCompute: true,
                })
              }
            >
              <ArchiveRestore /> Restore isolated branch
            </Button>
          </Explained>
        </div>
        <div className="operation-feed">
          <span className="section-kicker">Operation stream</span>
          {visibleOperations.length === 0 ? (
            <p>No branch operations have run.</p>
          ) : (
            visibleOperations.slice(0, 6).map((operation) => (
              <div key={operation.id}>
                <span className={`operation-state ${operation.status}`} /> <strong>{operation.kind}</strong>
                <code>{branchId({ name: operation.branch_name })}</code>
                <span>{operation.message}</span>
                <time>{new Date(operation.created_at).toLocaleTimeString()}</time>
              </div>
            ))
          )}
        </div>
      </section>
      <section className="branch-charts">
        <LiveChart
          live={Boolean(overview.activeRunId)}
          title="Load during snapshot"
          subtitle="TPS continues while branch state changes"
          metrics={metrics}
          series={[
            { key: 'operations', label: 'workload TPS', tone: 'cyan' },
            { key: 'database_tps', label: 'database tx/s', tone: 'green' },
          ]}
        />
        <LiveChart
          live={Boolean(overview.activeRunId)}
          title="Latency during snapshot"
          subtitle="Watch p95 and p99 while branches are created"
          metrics={metrics}
          unit="ms"
          series={[
            { key: 'p50_ms', label: 'p50', tone: 'cyan' },
            { key: 'p95_ms', label: 'p95', tone: 'indigo' },
            { key: 'p99_ms', label: 'p99', tone: 'red' },
          ]}
        />
      </section>
      <ConfirmDialog
        branchId={deleteBranch}
        onClose={() => setDeleteBranch('')}
        onConfirm={() => {
          void onRemove(deleteBranch);
          setDeleteBranch('');
        }}
      />
    </>
  );
}

function RunHistory({
  overview,
  selectedRunId,
  onSelect,
}: {
  overview: Overview;
  selectedRunId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="history-section surface">
      <div className="section-heading">
        <div>
          <span className="section-kicker">Run ledger</span>
          <h2>Measured experiments</h2>
        </div>
        <div className="badge-with-help">
          <Badge variant="outline">seed 424242</Badge>
          <HelpTip label="Benchmark seed" description={HELP.benchmarkSeed} />
        </div>
      </div>
      <div className="history-table" role="table" aria-label="Recent benchmark runs">
        <div className="history-row history-head" role="row">
          <span>Scenario</span>
          <span>Engine</span>
          <HelpLabel label="Users" description={HELP.concurrentUsers} />
          <HelpLabel label="Operations" description={HELP.completedOperations} />
          <HelpLabel label="P95" description={HELP.p95} />
          <span>Status</span>
        </div>
        {overview.runs.map((run) => (
          <button
            key={run.id}
            className={`history-row ${selectedRunId === run.id ? 'active' : ''}`}
            role="row"
            onClick={() => onSelect(run.id)}
          >
            <span>
              <b>{scenarioName(overview.scenarios, run.scenario)}</b>
              <small>{new Date(run.created_at).toLocaleString()}</small>
            </span>
            <span>{run.engine}</span>
            <span>{run.concurrency}</span>
            <span>{compact(value(run.total_operations))}</span>
            <span>{value(run.p95_ms).toFixed(0)} ms</span>
            <span>
              <Badge variant="outline" className={`status-${run.status}`}>
                {run.status}
              </Badge>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

function SetupView({
  overview,
  busy,
  onPrepare,
  onWarehouseChanged,
}: {
  overview: Overview;
  busy: boolean;
  onPrepare: () => Promise<void>;
  onWarehouseChanged: () => Promise<void>;
}) {
  return (
    <section className="setup-section surface">
      <div className="setup-hero">
        <div className="prepare-copy">
          <span className="section-kicker">Benchmark data</span>
          <div className="heading-with-help">
            <h2>Prepare benchmark datasets</h2>
            <HelpTip
              label="Prepare benchmark data"
              description="Creates missing deterministic rows in Lakebase and the selected Unity Catalog schema. Existing benchmark rows are kept."
            />
          </div>
          <p>Creates or verifies the fixed-scale datasets used by every Lakebase and DBSQL scenario.</p>
          <div className="prepare-details" aria-label="Preparation details">
            <div>
              <Database />
              <span>
                <b>Lakebase PostgreSQL</b>
                <small>10K accounts · 1K products · 5M history rows</small>
              </span>
            </div>
            <div>
              <Boxes />
              <span>
                <b>Unity Catalog Delta</b>
                <small>
                  1M accounts · 10K products · 5M history rows in {overview.dataDestination.catalog}.
                  {overview.dataDestination.schema}
                </small>
              </span>
            </div>
            <div>
              <Gauge />
              <span>
                <b>Observed preparation time</b>
                <small>About 25 seconds when data exists · 1–2 minutes after Hard Reset</small>
              </span>
            </div>
          </div>
          <p className="prepare-note">
            A stopped {overview.sqlWarehouse.name} warehouse adds startup time. Reruns fill missing seed rows without
            clearing workload changes or run history; use Hard Reset for a clean baseline.
          </p>
        </div>
        <Button size="lg" className="launch-button" disabled={busy} onClick={() => void onPrepare()}>
          {busy ? (
            <>
              <RefreshCw className="spin" /> Preparing data · allow up to 2 min
            </>
          ) : (
            <>
              <Database /> Prepare benchmark data
            </>
          )}
        </Button>
      </div>
      <DataDestinationSettings overview={overview} busy={busy} onChanged={onWarehouseChanged} />
      <WarehouseSettings overview={overview} busy={busy} onChanged={onWarehouseChanged} />
      <div className="section-heading">
        <div>
          <span className="section-kicker">Environment</span>
          <div className="heading-with-help">
            <h2>Capability readiness</h2>
            <HelpTip label="Capability readiness" description={HELP.readiness} />
          </div>
        </div>
        <Badge variant="outline">live preflight</Badge>
      </div>
      <div className="readiness-grid">
        {overview.readiness.map((item) => (
          <article key={item.id} className={`readiness-card ${item.state}`}>
            <span>{item.state === 'ready' ? <Check /> : <CircleAlert />}</span>
            <div>
              <strong>{item.label}</strong>
              <p>{item.detail}</p>
            </div>
            <Badge variant="outline">{item.state === 'action' ? 'setup required' : item.state}</Badge>
          </article>
        ))}
      </div>
      <HardResetSettings overview={overview} busy={busy} onChanged={onWarehouseChanged} />
    </section>
  );
}

function DataDestinationSettings({
  overview,
  busy,
  onChanged,
}: {
  overview: Overview;
  busy: boolean;
  onChanged: () => Promise<void>;
}) {
  const [mode, setMode] = useState<DataDestination['mode']>(overview.dataDestination.mode);
  const [catalog, setCatalog] = useState(overview.dataDestination.catalog);
  const [schema, setSchema] = useState(overview.dataDestination.schema);
  const [catalogs, setCatalogs] = useState<string[]>([]);
  const [schemas, setSchemas] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const loadDestinations = useCallback(async (catalogName: string) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/lakeload/data-destinations?catalog=${encodeURIComponent(catalogName)}`);
      const body = (await response.json()) as { catalogs?: string[]; schemas?: string[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Data destinations could not be loaded.');
      setCatalogs(body.catalogs ?? []);
      setSchemas(body.schemas ?? []);
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (mode !== 'create-catalog-schema') void loadDestinations(catalog);
  }, [catalog, loadDestinations, mode]);

  useEffect(() => {
    setMode(overview.dataDestination.mode);
    setCatalog(overview.dataDestination.catalog);
    setSchema(overview.dataDestination.schema);
  }, [
    overview.dataDestination.catalog,
    overview.dataDestination.mode,
    overview.dataDestination.schema,
  ]);

  async function saveDestination() {
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch('/api/lakeload/data-destination', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, catalog, schema }),
      });
      const body = (await response.json()) as { message?: string; error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Data destination could not be saved.');
      setMessage({ kind: 'success', text: body.message ?? 'Data destination saved.' });
      await onChanged();
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  }

  const unchanged =
    mode === overview.dataDestination.mode &&
    catalog === overview.dataDestination.catalog &&
    schema === overview.dataDestination.schema;

  return (
    <div className="data-destination-settings">
      <div className="destination-heading">
        <span className="warehouse-icon">
          <Database />
        </span>
        <div>
          <span className="section-kicker">Data location</span>
          <h2>Benchmark destinations</h2>
          <p>Lakebase uses the database bound to this App. Choose where DBSQL creates its three Delta tables.</p>
        </div>
      </div>
      <div className="destination-fixed">
        <HelpLabel label="Lakebase PostgreSQL" description={HELP.fixedLakebase} />
        <code>
          {overview.endpoint.project}/{overview.endpoint.branch}/{overview.target.database}
        </code>
        <small>Fixed App resource</small>
      </div>
      <div className="destination-form">
        <label>
          <HelpLabel label="Setup path" description={HELP.setupPath} />
          <select
            aria-label="Destination setup path"
            value={mode}
            disabled={busy || saving}
            onChange={(event) => setMode(event.target.value as DataDestination['mode'])}
          >
            <option value="existing-schema">Use an existing schema</option>
            <option value="create-schema">Create a schema in an existing catalog</option>
            <option value="create-catalog-schema">Create a catalog and schema</option>
          </select>
        </label>
        <label>
          <HelpLabel label="Catalog" description={HELP.catalog} />
          {mode === 'create-catalog-schema' ? (
            <input
              aria-label="Benchmark catalog"
              value={catalog}
              onChange={(event) => setCatalog(event.target.value)}
            />
          ) : (
            <select
              aria-label="Benchmark catalog"
              value={catalog}
              disabled={loading || saving || busy}
              onChange={(event) => {
                setCatalog(event.target.value);
                setSchema('');
              }}
            >
              {!catalogs.includes(catalog) && <option value={catalog}>{catalog}</option>}
              {catalogs.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          )}
        </label>
        <label>
          <HelpLabel label="Schema" description={HELP.schema} />
          {mode === 'existing-schema' ? (
            <select
              aria-label="Benchmark schema"
              value={schema}
              disabled={loading || saving || busy}
              onChange={(event) => setSchema(event.target.value)}
            >
              {!schemas.includes(schema) && schema && <option value={schema}>{schema}</option>}
              {schemas.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          ) : (
            <input aria-label="Benchmark schema" value={schema} onChange={(event) => setSchema(event.target.value)} />
          )}
        </label>
        <Explained title="Validate and save destination" description={HELP.validateDestination}>
          <Button
            disabled={busy || (mode !== 'create-catalog-schema' && loading) || saving || unchanged || !catalog || !schema}
            onClick={() => void saveDestination()}
          >
            {saving ? <RefreshCw className="spin" /> : <ShieldCheck />} Validate and save destination
          </Button>
        </Explained>
      </div>
      <div className="destination-note">
        <ShieldCheck />
        <div className="destination-note-copy">
          <strong>
            Tables created in <code>{catalog}.{schema}</code>
          </strong>
          <div className="destination-table-list" aria-label="LakeLoad Delta tables">
            <code>lakeload_account</code>
            <code>lakeload_product</code>
            <code>lakeload_history</code>
          </div>
          <small>Hard Reset drops these three tables. It keeps the catalog, schema, and every other object.</small>
        </div>
      </div>
      {message && <div className={`warehouse-message ${message.kind}`}>{message.text}</div>}
    </div>
  );
}

function WarehouseSettings({
  overview,
  busy,
  onChanged,
}: {
  overview: Overview;
  busy: boolean;
  onChanged: () => Promise<void>;
}) {
  const [warehouses, setWarehouses] = useState<SqlWarehouse[]>([]);
  const [selectedId, setSelectedId] = useState(overview.sqlWarehouse.id);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const selected = warehouses.find((warehouse) => warehouse.id === selectedId) ?? overview.sqlWarehouse;

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/lakeload/warehouses')
      .then(async (response) => {
        const body = (await response.json()) as {
          warehouses?: SqlWarehouse[];
          selectedWarehouseId?: string;
          error?: string;
        };
        if (!response.ok) throw new Error(body.error ?? 'Warehouses could not be loaded.');
        if (!cancelled) {
          setWarehouses(body.warehouses ?? []);
          setSelectedId(body.selectedWarehouseId ?? overview.sqlWarehouse.id);
        }
      })
      .catch((error) => {
        if (!cancelled) setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [overview.sqlWarehouse.id]);

  async function saveWarehouse() {
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch('/api/lakeload/warehouse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ warehouseId: selectedId }),
      });
      const body = (await response.json()) as { message?: string; error?: string };
      if (!response.ok) throw new Error(body.error ?? 'SQL warehouse could not be selected.');
      setMessage({ kind: 'success', text: body.message ?? 'DBSQL test warehouse updated.' });
      await onChanged();
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="warehouse-settings">
      <div className="warehouse-settings-copy">
        <span className="warehouse-icon">
          <Columns3 />
        </span>
        <div>
          <span className="section-kicker">DBSQL compute target</span>
          <h2>SQL warehouse under test</h2>
          <p>Every DBSQL setup query, workload, and side-by-side comparison uses this warehouse.</p>
        </div>
      </div>
      <div className="warehouse-picker">
        <label>
          <HelpLabel label="SQL warehouse" description={HELP.warehouse} />
          <select
            aria-label="SQL warehouse"
            value={selectedId}
            disabled={loading || saving || busy || Boolean(overview.activeRunId)}
            onChange={(event) => {
              setSelectedId(event.target.value);
              setMessage(null);
            }}
          >
            {!warehouses.some((warehouse) => warehouse.id === overview.sqlWarehouse.id) && overview.sqlWarehouse.id && (
              <option value={overview.sqlWarehouse.id}>{overview.sqlWarehouse.name}</option>
            )}
            {warehouses.map((warehouse) => (
              <option key={warehouse.id} value={warehouse.id}>
                {warehouse.name} · {warehouse.clusterSize} · {warehouse.state.toLowerCase()}
              </option>
            ))}
          </select>
        </label>
        <div className="warehouse-facts">
          <span>
            <b>{selected.clusterSize}</b>
            <HelpLabel label="size" description="The configured SQL warehouse cluster size." />
          </span>
          <span>
            <b>{selected.serverless ? 'Serverless' : selected.warehouseType}</b>
            <HelpLabel
              label="type"
              description="Serverless warehouses start and scale without customer-managed clusters."
            />
          </span>
          <span>
            <b className={`warehouse-state state-${selected.state.toLowerCase()}`}>{selected.state}</b>
            <HelpLabel label="state" description={HELP.warehouseState} />
          </span>
        </div>
        <Button
          onClick={() => void saveWarehouse()}
          disabled={
            loading ||
            saving ||
            busy ||
            !selectedId ||
            selectedId === overview.sqlWarehouse.id ||
            Boolean(overview.activeRunId)
          }
        >
          {saving ? (
            <>
              <RefreshCw className="spin" /> Saving warehouse
            </>
          ) : selectedId === overview.sqlWarehouse.id ? (
            <>
              <Check /> Selected for DBSQL tests
            </>
          ) : (
            <>
              <Check /> Use for DBSQL tests
            </>
          )}
        </Button>
      </div>
      <div className="warehouse-access-note">
        <ShieldCheck />
        <span>
          Only warehouses available to the App service principal are listed.
          <small>Grant the app CAN USE on another warehouse, then reopen Settings to add it.</small>
        </span>
      </div>
      {message && <div className={`warehouse-message ${message.kind}`}>{message.text}</div>}
    </div>
  );
}

function HardResetSettings({
  overview,
  busy,
  onChanged,
}: {
  overview: Overview;
  busy: boolean;
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const reset = overview.resetOperation;
  const resetActive = reset?.status === 'queued' || reset?.status === 'running';

  async function hardReset() {
    setSubmitting(true);
    setError('');
    try {
      const response = await fetch('/api/lakeload/hard-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation }),
      });
      const body = (await response.json()) as { resetId?: string; error?: string };
      if (!response.ok || !body.resetId) throw new Error(body.error ?? 'Hard reset could not start.');
      setOpen(false);
      setConfirmation('');
      await onChanged();
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : String(resetError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="danger-zone">
      <div className="danger-zone-copy">
        <span className="danger-icon">
          <Trash2 />
        </span>
        <div>
          <span className="section-kicker">Danger zone</span>
          <div className="heading-with-help">
            <h2>Hard reset all test data</h2>
            <HelpTip label="Hard reset" description={HELP.hardReset} />
          </div>
          <p>
            Permanently remove Lakebase benchmark rows, the three LakeLoad Delta tables in{' '}
            <code>
              {overview.dataDestination.catalog}.{overview.dataDestination.schema}
            </code>
            , run history, telemetry, and every LakeLoad snapshot/restore branch.
          </p>
          <small>The Lakebase project, benchmark branch, app deployment, and selected warehouse are preserved.</small>
        </div>
      </div>
      {reset && (
        <div className={`reset-status status-${reset.status}`} role="status">
          {resetActive ? <RefreshCw className="spin" /> : reset.status === 'completed' ? <Check /> : <CircleAlert />}
          <span>
            <b>{reset.status === 'completed' ? 'Ready for a clean start' : `Reset ${reset.status}`}</b>
            <small>{reset.message}</small>
          </span>
        </div>
      )}
      <Button
        variant="destructive"
        disabled={busy || resetActive || Boolean(overview.activeRunId)}
        onClick={() => {
          setError('');
          setOpen(true);
        }}
      >
        <Trash2 /> Hard reset
      </Button>
      <dialog open={open} className="confirm-dialog hard-reset-dialog" onCancel={() => setOpen(false)}>
        <span className="section-kicker">Permanent deletion</span>
        <h3>Reset LakeLoad to an empty state?</h3>
        <p>This deletes:</p>
        <ul>
          <li>
            All rows in the dedicated <code>lakeload_bench</code> PostgreSQL schema
          </li>
          <li>
            <code>lakeload_account</code>, <code>lakeload_product</code>, and <code>lakeload_history</code> from{' '}
            <code>
              {overview.dataDestination.catalog}.{overview.dataDestination.schema}
            </code>
          </li>
          <li>All benchmark runs, metrics, snapshots, and restore branches</li>
        </ul>
        <p>
          Type <code>RESET LAKELOAD</code> to continue. This cannot be undone.
        </p>
        <input
          aria-label="Hard reset confirmation"
          autoComplete="off"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          placeholder="RESET LAKELOAD"
        />
        {error && <div className="reset-error">{error}</div>}
        <div>
          <Button
            variant="outline"
            onClick={() => {
              setOpen(false);
              setConfirmation('');
            }}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={confirmation !== 'RESET LAKELOAD' || submitting}
            onClick={() => void hardReset()}
          >
            {submitting ? <RefreshCw className="spin" /> : <Trash2 />} Delete all test data
          </Button>
        </div>
      </dialog>
    </div>
  );
}

type MetricKey = keyof Pick<
  Metric,
  | 'operations'
  | 'database_tps'
  | 'p50_ms'
  | 'p95_ms'
  | 'p99_ms'
  | 'connections_active'
  | 'connections_idle'
  | 'connections_total'
  | 'rows_inserted'
  | 'rows_updated'
  | 'rows_deleted'
  | 'reads'
  | 'writes'
  | 'complex_queries'
  | 'cache_hit_pct'
  | 'locks_waiting'
>;
type Tone = 'cyan' | 'green' | 'indigo' | 'red' | 'amber';

function LiveChart({
  title,
  subtitle,
  metrics,
  series,
  unit = '',
  live = false,
}: {
  title: string;
  subtitle: string;
  metrics: Metric[];
  series: Array<{ key: MetricKey; label: string; tone: Tone }>;
  unit?: string;
  live?: boolean;
}) {
  const [inspectionIndex, setInspectionIndex] = useState<number | null>(null);
  const width = 720,
    height = 220,
    padding = 22;
  const max = Math.max(1, ...metrics.flatMap((metric) => series.map((item) => value(metric[item.key]))));
  const points = (key: MetricKey) =>
    metrics
      .map(
        (metric, index) =>
          `${padding + (index / Math.max(1, metrics.length - 1)) * (width - 2 * padding)},${height - padding - (value(metric[key]) / max) * (height - 2 * padding)}`
      )
      .join(' ');
  const latest = metrics.at(-1);
  const inspected = inspectionIndex === null ? null : metrics[inspectionIndex];
  const inspectedPrevious = inspectionIndex === null ? null : metrics[Math.max(0, inspectionIndex - 1)];
  const inspectedX =
    inspectionIndex === null
      ? padding
      : padding + (inspectionIndex / Math.max(1, metrics.length - 1)) * (width - 2 * padding);

  function inspectAt(clientX: number, bounds: DOMRect) {
    const relativeX = Math.max(0, Math.min(1, (clientX - bounds.left) / Math.max(1, bounds.width)));
    setInspectionIndex(Math.round(relativeX * (metrics.length - 1)));
  }

  function moveInspection(direction: -1 | 1) {
    setInspectionIndex((current) =>
      Math.max(0, Math.min(metrics.length - 1, (current ?? metrics.length - 1) + direction))
    );
  }

  return (
    <article className="telemetry-chart surface">
      <header>
        <div>
          <div className="heading-with-help compact">
            <h3>{title}</h3>
            <HelpTip label={title} description={subtitle} />
          </div>
          <p>{subtitle}</p>
        </div>
        <Explained
          title={live ? 'Live samples' : 'Recorded samples'}
          description={
            live
              ? 'The chart receives a new one-second metric sample while the workload is running.'
              : 'The chart shows samples stored with the selected benchmark run.'
          }
        >
          <span className={`chart-live ${live ? 'active' : ''}`} tabIndex={0}>
            <i /> {live ? '1s LIVE' : 'RECORDED'}
          </span>
        </Explained>
      </header>
      <div className="chart-legend">
        {series.map((item) => (
          <span key={item.key}>
            <i className={item.tone} />
            {item.label}
            <HelpTip label={item.label} description={METRIC_HELP[item.key] ?? subtitle} compact />
            <b>{latest ? `${compact(value(latest[item.key]))}${unit}` : '—'}</b>
          </span>
        ))}
      </div>
      {metrics.length > 1 ? (
        <div className="chart-plot">
          <svg
            className="chart-svg"
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            role="img"
            tabIndex={0}
            aria-label={`${title}, updated every second. Hover or use left and right arrow keys to inspect samples.`}
            onPointerMove={(event) => inspectAt(event.clientX, event.currentTarget.getBoundingClientRect())}
            onPointerLeave={() => setInspectionIndex(null)}
            onFocus={() => setInspectionIndex(metrics.length - 1)}
            onBlur={() => setInspectionIndex(null)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                moveInspection(-1);
              } else if (event.key === 'ArrowRight') {
                event.preventDefault();
                moveInspection(1);
              } else if (event.key === 'Escape') {
                setInspectionIndex(null);
                event.currentTarget.blur();
              }
            }}
          >
            <g className="grid-lines">
              <line x1={padding} y1={padding} x2={width - padding} y2={padding} />
              <line x1={padding} y1={height / 2} x2={width - padding} y2={height / 2} />
              <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} />
            </g>
            {series.map((item) => (
              <polyline key={item.key} className={`chart-line ${item.tone}`} points={points(item.key)} />
            ))}
            {inspected && (
              <g className="chart-inspection" aria-hidden="true">
                <line className="chart-crosshair" x1={inspectedX} y1={padding} x2={inspectedX} y2={height - padding} />
                {series.map((item) => (
                  <circle
                    key={item.key}
                    className={`chart-point ${item.tone}`}
                    cx={inspectedX}
                    cy={height - padding - (value(inspected[item.key]) / max) * (height - 2 * padding)}
                    r="4"
                  />
                ))}
              </g>
            )}
          </svg>
          {inspected && inspectedPrevious && (
            <div
              className={`chart-tooltip ${inspectionIndex !== null && inspectionIndex / metrics.length > 0.6 ? 'align-right' : ''}`}
              style={{ left: `${(inspectedX / width) * 100}%` }}
              role="status"
            >
              <div className="tooltip-time">
                <span>Sample</span>
                <strong>{inspected.elapsed_seconds}s</strong>
              </div>
              {series.map((item) => {
                const currentValue = value(inspected[item.key]);
                const previousValue = value(inspectedPrevious[item.key]);
                return (
                  <div className="tooltip-series" key={item.key}>
                    <i className={item.tone} />
                    <span>{item.label}</span>
                    <strong>{formatChartValue(currentValue, unit)}</strong>
                    <em className={changeTone(currentValue, previousValue)}>
                      {formatChange(currentValue, previousValue)}
                    </em>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <div className="chart-empty">
          <Activity />
          <span>Start a load test to stream this metric.</span>
        </div>
      )}
      <footer>
        <span>0s</span>
        <span>{metrics.length ? `${metrics.at(-1)?.elapsed_seconds}s` : 'waiting'}</span>
      </footer>
    </article>
  );
}

function formatChartValue(input: number, unit: string) {
  const formatted = new Intl.NumberFormat('en', { maximumFractionDigits: 2 }).format(input);
  return `${formatted}${unit}`;
}

function formatChange(current: number, previous: number) {
  if (current === previous) return 'no change';
  if (previous === 0) return 'new';
  const change = ((current - previous) / Math.abs(previous)) * 100;
  return `${change > 0 ? '+' : '−'}${Math.abs(change).toFixed(1)}%`;
}

function changeTone(current: number, previous: number) {
  if (current === previous) return 'flat';
  return current > previous ? 'up' : 'down';
}

function MetricCard({
  icon,
  label,
  value: displayValue,
  unit,
  description,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  unit: string;
  description: string;
}) {
  return (
    <div className="metric-card">
      <span className="metric-icon">{icon}</span>
      <HelpLabel label={label} description={description} className="metric-label" />
      <strong>
        {displayValue}
        <small>{unit}</small>
      </strong>
    </div>
  );
}
function DataStat({
  label,
  value: displayValue,
  description,
}: {
  label: string;
  value: string;
  description: string;
}) {
  return (
    <div>
      <strong>{displayValue}</strong>
      <HelpLabel label={label} description={description} />
    </div>
  );
}
function Range({
  label,
  value: current,
  min,
  max,
  step = 1,
  suffix,
  help,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix: string;
  help: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="range-control">
      <span>
        <b className="range-label">
          {label}
          <HelpTip label={label} description={help} compact />
        </b>
        <output>
          {current}
          {suffix}
        </output>
      </span>
      <input
        type="range"
        value={current}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <small>
        {min}
        {suffix}
        <i />
        {max}
        {suffix}
      </small>
    </label>
  );
}
function RailButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Explained title={label} description={navigationHelp(label)}>
      <button
        className={`rail-button ${active ? 'active' : ''}`}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        onClick={onClick}
      >
        {children}
      </button>
    </Explained>
  );
}

function HelpTip({
  label,
  description,
  compact = false,
}: {
  label: string;
  description: string;
  compact?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={`help-tip ${compact ? 'compact' : ''}`}
          role="button"
          tabIndex={0}
          aria-label={`About ${label}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <CircleHelp />
        </span>
      </TooltipTrigger>
      <TooltipContent className="lakeload-help-tooltip" sideOffset={8} collisionPadding={12}>
        <strong>{label}</strong>
        <p>{description}</p>
      </TooltipContent>
    </Tooltip>
  );
}

function HelpLabel({
  label,
  description,
  className = '',
}: {
  label: string;
  description: string;
  className?: string;
}) {
  return (
    <span className={`help-label ${className}`.trim()}>
      {label}
      <HelpTip label={label} description={description} compact />
    </span>
  );
}

function Explained({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className="lakeload-help-tooltip" sideOffset={8} collisionPadding={12}>
        <strong>{title}</strong>
        <p>{description}</p>
      </TooltipContent>
    </Tooltip>
  );
}

function navigationHelp(label: string) {
  const descriptions: Record<string, string> = {
    'Live telemetry': 'Configure a workload, start or stop load, and inspect one-second Lakebase or DBSQL metrics.',
    'Compare engines': 'Run controlled Lakebase and DBSQL tests side by side and compare throughput and latency.',
    'Branch lab': 'Create snapshots and isolated restore branches while the benchmark workload continues.',
    'Run history': 'Open completed benchmark runs and inspect their recorded metrics.',
    Settings: 'Prepare data, select Unity Catalog and DBSQL resources, check readiness, or reset the environment.',
  };
  return descriptions[label] ?? label;
}
function BranchNode({
  type,
  name,
  state,
  detail,
  active = false,
}: {
  type: string;
  name: string;
  state: string;
  detail: string;
  active?: boolean;
}) {
  return (
    <div className={`branch-node ${type} ${active ? 'active' : ''}`}>
      <span className="branch-node-icon">{type === 'restore' ? <ArchiveRestore /> : <GitBranch />}</span>
      <span>
        <strong>{name}</strong>
        <small>{detail}</small>
      </span>
      <em>{state}</em>
    </div>
  );
}
function ConfirmDialog({
  branchId,
  onClose,
  onConfirm,
}: {
  branchId: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <dialog open={Boolean(branchId)} className="confirm-dialog" onCancel={onClose}>
      <h3>Remove LakeLoad branch?</h3>
      <p>
        This removes <code>{branchId}</code>. Production and the active benchmark branch are never changed.
      </p>
      <div>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="destructive" onClick={onConfirm}>
          <Trash2 /> Remove branch
        </Button>
      </div>
    </dialog>
  );
}
function LoadingState() {
  return (
    <div className="loading-state">
      <span />
      <span />
      <span />
    </div>
  );
}
function scenarioName(scenarios: Scenario[], id: string) {
  return scenarios.find((scenario) => scenario.id === id)?.name ?? id;
}
function branchId(branch?: Branch) {
  return branch?.status?.branch_id ?? branch?.name?.split('/').slice(-1)[0] ?? 'unknown';
}
function branchState(branch?: Branch) {
  return branch?.status?.current_state ?? (branch ? 'READY' : 'UNKNOWN');
}
function normalizeMetric(metric: Metric) {
  const normalized = { ...metric };
  for (const key of metricKeys) normalized[key] = value(metric[key]) as never;
  return normalized;
}
