import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Badge, Button } from '@databricks/appkit-ui/react';
import {
  Activity,
  ArchiveRestore,
  Boxes,
  Check,
  CircleAlert,
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
  Trash2,
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
        <span className="connection-dot" title="Lakebase connected" />
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
              <button
                className={props.engineFilter === 'lakebase' ? 'active' : ''}
                onClick={() => props.setEngineFilter('lakebase')}
              >
                Lakebase
              </button>
              <button
                className={props.engineFilter === 'dbsql' ? 'active' : ''}
                onClick={() => props.setEngineFilter('dbsql')}
              >
                DBSQL
              </button>
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
            />
            <Range
              label="Duration"
              value={props.duration}
              min={10}
              max={300}
              step={10}
              onChange={props.setDuration}
              suffix=" sec"
            />
            <Range label="Ramp" value={props.ramp} min={0} max={60} step={5} onChange={props.setRamp} suffix=" sec" />
          </div>
          <div className="model-row">
            <div className="segmented">
              <button
                className={props.executionModel === 'closed' ? 'active' : ''}
                onClick={() => props.setExecutionModel('closed')}
              >
                Closed loop
              </button>
              <button
                className={props.executionModel === 'open' ? 'active' : ''}
                onClick={() => props.setExecutionModel('open')}
              >
                Target rate
              </button>
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
          />
          <MetricCard icon={<Gauge />} label="P99 latency" value={value(props.latest?.p99_ms).toFixed(0)} unit="ms" />
          <MetricCard
            icon={<Database />}
            label="Database tx"
            value={compact(value(props.latest?.database_tps))}
            unit="tx/s"
          />
          <MetricCard
            icon={<Activity />}
            label="Connections"
            value={String(value(props.latest?.connections_total))}
            unit="open"
          />
          <MetricCard
            icon={<ShieldCheck />}
            label="Cache hit"
            value={value(props.latest?.cache_hit_pct).toFixed(1)}
            unit="%"
          />
          <MetricCard icon={<CircleAlert />} label="Error rate" value={props.errorRate.toFixed(2)} unit="%" />
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
        <DataStat label="Accounts" value={compact(value(overview.target.accounts))} />
        <DataStat label="History" value={compact(value(overview.target.history_rows))} />
        <DataStat label="Size" value={bytes(value(latest?.database_bytes))} />
      </div>
      <div className="endpoint-detail">
        <span>Compute</span>
        <b>{overview.endpoint.autoscaling} autoscaling</b>
      </div>
      <div className="endpoint-detail">
        <span>Active sessions</span>
        <b>
          {value(latest?.connections_active)} / {value(latest?.connections_total)}
        </b>
      </div>
      <div className="endpoint-detail">
        <span>Lock waits</span>
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
            Sequential execution
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
          <Badge variant="outline">{preset.matched ? 'matched workload' : 'best-fit workloads'}</Badge>
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
          />
          <Range
            label="Per-engine duration"
            value={duration}
            min={10}
            max={60}
            step={5}
            onChange={setDuration}
            suffix=" sec"
          />
          <Range label="Ramp" value={ramp} min={0} max={20} step={1} onChange={setRamp} suffix=" sec" />
        </div>
        <div className="comparison-launch">
          <span>
            Estimated wall time <b>{duration * 2 + 2}s</b>
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

      <ComparisonScorecard preset={preset} lakebase={lakebase} dbsql={dbsql} />
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
        <ComparisonKpi label="Average throughput" value={run ? averageTps.toFixed(1) : '—'} unit="ops/s" />
        <ComparisonKpi label="P95 latency" value={run ? value(run.p95_ms).toFixed(0) : '—'} unit="ms" />
        <ComparisonKpi label="P99 latency" value={run ? value(run.p99_ms).toFixed(0) : '—'} unit="ms" />
        <ComparisonKpi label="Error rate" value={run ? errorRate.toFixed(2) : '—'} unit="%" />
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

function ComparisonKpi({ label, value: displayValue, unit }: { label: string; value: string; unit: string }) {
  return (
    <div>
      <span>{label}</span>
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
  const observation = comparisonObservation(preset, left, right);
  return (
    <section className="comparison-scorecard surface">
      <div className="section-heading">
        <div>
          <span className="section-kicker">Measured result</span>
          <h2>Engine-fit evidence</h2>
        </div>
        <Badge variant="outline">conditions matter</Badge>
      </div>
      <div className="comparison-table" role="table" aria-label="Lakebase and DBSQL result comparison">
        <div className="comparison-row comparison-head" role="row">
          <span>Measure</span>
          <span>Lakebase</span>
          <span>DBSQL</span>
        </div>
        <ComparisonRow label="Average throughput" left={comparisonTps(lakebase)} right={comparisonTps(dbsql)} />
        <ComparisonRow
          label="P95 latency"
          left={left ? `${value(left.p95_ms).toFixed(0)} ms` : '—'}
          right={right ? `${value(right.p95_ms).toFixed(0)} ms` : '—'}
        />
        <ComparisonRow
          label="P99 latency"
          left={left ? `${value(left.p99_ms).toFixed(0)} ms` : '—'}
          right={right ? `${value(right.p99_ms).toFixed(0)} ms` : '—'}
        />
        <ComparisonRow
          label="Completed operations"
          left={left ? compact(value(left.total_operations)) : '—'}
          right={right ? compact(value(right.total_operations)) : '—'}
        />
      </div>
      <div className="comparison-observation">
        <Activity />
        <div>
          <strong>{observation.title}</strong>
          <p>{observation.detail}</p>
        </div>
      </div>
    </section>
  );
}

function ComparisonRow({ label, left, right }: { label: string; left: string; right: string }) {
  return (
    <div className="comparison-row" role="row">
      <span>{label}</span>
      <strong>{left}</strong>
      <strong>{right}</strong>
    </div>
  );
}

function comparisonTps(details: RunDetails | null) {
  if (!details?.run) return '—';
  const elapsed = Math.max(1, value(details.metrics.at(-1)?.elapsed_seconds) || details.run.duration_seconds);
  return `${(value(details.run.total_operations) / elapsed).toFixed(1)} ops/s`;
}

function comparisonObservation(preset: ComparisonPreset, lakebase?: Run, dbsql?: Run) {
  if (!lakebase || !dbsql) return { title: 'Run both engines to create evidence.', detail: preset.interpretation };
  if (!preset.matched) return { title: 'Use each engine for its intended job.', detail: preset.interpretation };
  const lakebaseP95 = Math.max(0.01, value(lakebase.p95_ms));
  const dbsqlP95 = Math.max(0.01, value(dbsql.p95_ms));
  const winner = lakebaseP95 <= dbsqlP95 ? 'Lakebase' : 'DBSQL';
  const ratio = Math.max(lakebaseP95, dbsqlP95) / Math.min(lakebaseP95, dbsqlP95);
  return {
    title: `${winner} recorded ${ratio.toFixed(1)}× lower p95 in this run.`,
    detail: `${preset.interpretation} This observation applies to the displayed data scale, compute sizes, cache state, and client settings.`,
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
          <h2>Snapshot the database while it is under load</h2>
          <p>
            Capture the benchmark branch in seconds, then restore that state into an isolated branch with its own
            compute. The active workload keeps running.
          </p>
        </div>
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
      </section>
      <div className="branch-live-strip">
        <MetricCard icon={<Zap />} label="Live TPS" value={compact(value(latest?.operations))} unit="ops/s" />
        <MetricCard icon={<Gauge />} label="Live p99" value={value(latest?.p99_ms).toFixed(0)} unit="ms" />
        <MetricCard
          icon={<Activity />}
          label="Connections"
          value={String(value(latest?.connections_total))}
          unit="open"
        />
        <MetricCard icon={<Boxes />} label="Branches" value={String(overview.branches.length)} unit="total" />
      </div>
      <section className="branch-canvas surface">
        <div className="section-heading">
          <div>
            <span className="section-kicker">Live topology</span>
            <h2>Branch lineage</h2>
          </div>
          <Badge variant="outline">refreshes every second</Badge>
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
        <Badge variant="outline">seed 424242</Badge>
      </div>
      <div className="history-table" role="table" aria-label="Recent benchmark runs">
        <div className="history-row history-head" role="row">
          <span>Scenario</span>
          <span>Engine</span>
          <span>Users</span>
          <span>Operations</span>
          <span>P95</span>
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
        <div>
          <span className="section-kicker">Environment settings</span>
          <h2>Configure and prepare</h2>
          <p>
            Choose the DBSQL compute under test, then create deterministic Lakebase and Delta datasets. Preparation is
            idempotent.
          </p>
        </div>
        <Button size="lg" className="launch-button" disabled={busy} onClick={() => void onPrepare()}>
          {busy ? <RefreshCw className="spin" /> : <Database />} Prepare all data
        </Button>
      </div>
      <WarehouseSettings overview={overview} busy={busy} onChanged={onWarehouseChanged} />
      <div className="section-heading">
        <div>
          <span className="section-kicker">Environment</span>
          <h2>Capability readiness</h2>
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
          <span>SQL warehouse</span>
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
            <small>size</small>
          </span>
          <span>
            <b>{selected.serverless ? 'Serverless' : selected.warehouseType}</b>
            <small>type</small>
          </span>
          <span>
            <b className={`warehouse-state state-${selected.state.toLowerCase()}`}>{selected.state}</b>
            <small>state</small>
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
          <h2>Hard reset all test data</h2>
          <p>
            Permanently remove Lakebase and Delta benchmark rows, run history, telemetry, and every LakeLoad
            snapshot/restore branch.
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
            The dedicated <code>main.lakeload</code> Delta schema
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
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
        <span className={`chart-live ${live ? 'active' : ''}`}>
          <i /> {live ? '1s LIVE' : 'RECORDED'}
        </span>
      </header>
      <div className="chart-legend">
        {series.map((item) => (
          <span key={item.key}>
            <i className={item.tone} />
            {item.label}
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
}: {
  icon: ReactNode;
  label: string;
  value: string;
  unit: string;
}) {
  return (
    <div className="metric-card">
      <span className="metric-icon">{icon}</span>
      <span className="metric-label">{label}</span>
      <strong>
        {displayValue}
        <small>{unit}</small>
      </strong>
    </div>
  );
}
function DataStat({ label, value: displayValue }: { label: string; value: string }) {
  return (
    <div>
      <strong>{displayValue}</strong>
      <span>{label}</span>
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
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="range-control">
      <span>
        <b>{label}</b>
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
    <button
      className={`rail-button ${active ? 'active' : ''}`}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      {children}
    </button>
  );
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
