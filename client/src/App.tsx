import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Badge, Button } from '@databricks/appkit-ui/react';
import {
  Activity,
  ArrowRight,
  BarChart3,
  BookOpen,
  Check,
  CircleAlert,
  Clock3,
  Database,
  Gauge,
  GitCompareArrows,
  Layers3,
  Play,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Square,
  TerminalSquare,
  Zap,
} from 'lucide-react';

type Engine = 'lakebase' | 'dbsql' | 'ltap';
type Tab = 'setup' | 'scenarios' | 'compare';

interface Scenario {
  id: string;
  name: string;
  engine: Engine;
  category: 'OLTP' | 'OLAP' | 'LTAP' | 'Search' | 'Observability';
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
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
}

interface Readiness {
  id: string;
  label: string;
  state: 'ready' | 'action' | 'blocked';
  detail: string;
}

interface Overview {
  scenarios: Scenario[];
  runs: Run[];
  activeRunId: string | null;
  activeMetrics: Metric[];
  readiness: Readiness[];
  target: { database: string; postgres_version: string; accounts: number; products: number; history_rows: number };
  endpoint: { branch: string; endpoint: string; poolSize: number; autoscaling: string };
}

const EMPTY: Overview = {
  scenarios: [],
  runs: [],
  activeRunId: null,
  activeMetrics: [],
  readiness: [],
  target: { database: 'databricks_postgres', postgres_version: '17', accounts: 0, products: 0, history_rows: 0 },
  endpoint: { branch: 'benchmark', endpoint: 'primary', poolSize: 80, autoscaling: '1–4 CU' },
};

const n = (value: number | string | null | undefined) => Number(value ?? 0);
const compact = (value: number) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);

export default function App() {
  const [tab, setTab] = useState<Tab>('setup');
  const [overview, setOverview] = useState<Overview>(EMPTY);
  const [selectedScenarioId, setSelectedScenarioId] = useState('lakebase-point-lookup');
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [concurrency, setConcurrency] = useState(50);
  const [durationSeconds, setDuration] = useState(30);
  const [rampSeconds, setRamp] = useState(5);
  const [executionModel, setExecutionModel] = useState<'closed' | 'open'>('closed');
  const [targetRps, setTargetRps] = useState(100);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/lakeload/overview');
      const body = (await response.json()) as Overview & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Overview failed (${response.status})`);
      setOverview(body);
      if (body.activeRunId) {
        setSelectedRunId(body.activeRunId);
        setMetrics(body.activeMetrics.map(normalizeMetric));
      } else if (!selectedRunId && body.runs[0]) {
        setSelectedRunId(body.runs[0].id);
      }
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'LakeLoad could not load.' });
    } finally {
      setLoading(false);
    }
  }, [selectedRunId]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!selectedRunId || selectedRunId === overview.activeRunId) return;
    void fetch(`/api/lakeload/runs/${selectedRunId}`)
      .then(async (response) => {
        const body = (await response.json()) as { metrics?: Metric[]; error?: string };
        if (!response.ok) throw new Error(body.error ?? 'Run details could not load.');
        setMetrics((body.metrics ?? []).map(normalizeMetric));
      })
      .catch((error) => setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) }));
  }, [overview.activeRunId, selectedRunId]);

  const selectedScenario = overview.scenarios.find((item) => item.id === selectedScenarioId) ?? overview.scenarios[0];
  const selectedRun = overview.runs.find((item) => item.id === selectedRunId) ?? overview.runs[0];
  const latest = metrics.at(-1);
  const lakebaseCompare = overview.runs.find((run) => run.engine === 'lakebase' && run.status === 'completed');
  const dbsqlCompare = overview.runs.find((run) => run.engine === 'dbsql' && run.status === 'completed');

  function selectScenario(scenario: Scenario) {
    setSelectedScenarioId(scenario.id);
    setConcurrency(scenario.defaultConcurrency);
    setDuration(scenario.defaultDurationSeconds);
  }

  async function prepare() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/lakeload/setup', { method: 'POST' });
      const body = (await response.json()) as { message?: string; error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Setup stopped.');
      setMessage({ kind: 'success', text: body.message ?? 'Benchmark datasets are ready.' });
      await refresh();
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function launch() {
    if (!selectedScenario) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/lakeload/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scenario: selectedScenario.id,
          concurrency,
          durationSeconds,
          rampSeconds,
          executionModel,
          targetRps: executionModel === 'open' ? targetRps : undefined,
        }),
      });
      const body = (await response.json()) as { runId?: string; error?: string };
      if (!response.ok || !body.runId) throw new Error(body.error ?? 'Run could not start.');
      setSelectedRunId(body.runId);
      setMetrics([]);
      await refresh();
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    if (!overview.activeRunId) return;
    await fetch(`/api/lakeload/runs/${overview.activeRunId}`, { method: 'DELETE' });
    await refresh();
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-symbol" aria-hidden="true"><Layers3 /></span>
          <div><p>Databricks Lakebase</p><h1>LakeLoad</h1></div>
        </div>
        <div className="environment" aria-label="Benchmark target">
          <span className="status-dot" />
          <div><strong>{overview.endpoint.branch}/{overview.endpoint.endpoint}</strong><small>PostgreSQL {overview.target.postgres_version} · {overview.endpoint.autoscaling}</small></div>
        </div>
      </header>

      <nav className="tabs" aria-label="LakeLoad sections">
        <TabButton active={tab === 'setup'} onClick={() => setTab('setup')} icon={<Settings2 />}>Setup</TabButton>
        <TabButton active={tab === 'scenarios'} onClick={() => setTab('scenarios')} icon={<Activity />}>Scenarios</TabButton>
        <TabButton active={tab === 'compare'} onClick={() => setTab('compare')} icon={<GitCompareArrows />}>Compare</TabButton>
        <a className="docs-link" href="https://github.com/althrussell/databricks-lakeload/blob/main/docs/customer-guide.md" target="_blank" rel="noreferrer"><BookOpen /> Customer guide</a>
      </nav>

      <main>
        {message && <div className={`notice ${message.kind}`} role="status"><CircleAlert /> <span>{message.text}</span><button onClick={() => setMessage(null)} aria-label="Dismiss message">×</button></div>}
        {loading ? <LoadingState /> : tab === 'setup' ? (
          <SetupView overview={overview} busy={busy} onPrepare={() => void prepare()} />
        ) : tab === 'scenarios' ? (
          <ScenarioView
            overview={overview}
            selectedScenario={selectedScenario}
            onSelect={selectScenario}
            concurrency={concurrency}
            setConcurrency={setConcurrency}
            duration={durationSeconds}
            setDuration={setDuration}
            ramp={rampSeconds}
            setRamp={setRamp}
            executionModel={executionModel}
            setExecutionModel={setExecutionModel}
            targetRps={targetRps}
            setTargetRps={setTargetRps}
            busy={busy}
            onLaunch={() => void launch()}
            onStop={() => void stop()}
            selectedRun={selectedRun}
            setSelectedRunId={setSelectedRunId}
            metrics={metrics}
            latest={latest}
          />
        ) : (
          <CompareView lakebase={lakebaseCompare} dbsql={dbsqlCompare} scenarios={overview.scenarios} />
        )}
      </main>
    </div>
  );
}

function SetupView({ overview, busy, onPrepare }: { overview: Overview; busy: boolean; onPrepare: () => void }) {
  const ready = overview.readiness.filter((item) => item.state === 'ready').length;
  return <>
    <section className="page-intro">
      <div><p className="kicker">Environment readiness</p><h2>Prepare the benchmark</h2><p>LakeLoad owns its PostgreSQL schemas. The installer binds Lakebase and DBSQL resources; preview features remain explicit setup steps.</p></div>
      <Button size="lg" onClick={onPrepare} disabled={busy}>{busy ? <RefreshCw className="spin" /> : <Database />} {busy ? 'Preparing data' : 'Prepare all data'}</Button>
    </section>
    <section className="summary-strip">
      <Summary label="Checks ready" value={`${ready}/${overview.readiness.length}`} detail="Live preflight" />
      <Summary label="Lakebase rows" value={compact(n(overview.target.accounts) + n(overview.target.products) + n(overview.target.history_rows))} detail="Operational dataset" />
      <Summary label="DBSQL target" value="5M+" detail="Delta fact rows" />
      <Summary label="Seed" value="424242" detail="Repeatable generation" />
    </section>
    <section className="panel">
      <div className="panel-heading"><div><p className="kicker">Preflight</p><h3>Feature readiness</h3></div><Badge variant="outline">live checks</Badge></div>
      <div className="readiness-list">
        {overview.readiness.map((item) => <div className="readiness-row" key={item.id}>
          <StateIcon state={item.state} />
          <div><strong>{item.label}</strong><p>{item.detail}</p></div>
          <span className={`state-label ${item.state}`}>{item.state === 'action' ? 'setup required' : item.state}</span>
        </div>)}
      </div>
    </section>
  </>;
}

type ScenarioViewProps = {
  overview: Overview; selectedScenario?: Scenario; onSelect: (scenario: Scenario) => void;
  concurrency: number; setConcurrency: (value: number) => void; duration: number; setDuration: (value: number) => void;
  ramp: number; setRamp: (value: number) => void; executionModel: 'closed' | 'open'; setExecutionModel: (value: 'closed' | 'open') => void;
  targetRps: number; setTargetRps: (value: number) => void; busy: boolean; onLaunch: () => void; onStop: () => void;
  selectedRun?: Run; setSelectedRunId: (id: string) => void; metrics: Metric[]; latest?: Metric;
};

function ScenarioView(props: ScenarioViewProps) {
  const { overview, selectedScenario, onSelect, selectedRun, latest } = props;
  const errorRate = latest ? n(latest.errors) / Math.max(1, n(latest.operations) + n(latest.errors)) * 100 : 0;
  return <>
    <section className="page-intro compact"><div><p className="kicker">Scenario catalog</p><h2>Test the right engine for the job</h2><p>OLTP and OLAP results use the same seed and record the conditions needed to explain the result.</p></div></section>
    <div className="workbench">
      <section className="scenario-catalog panel" aria-label="Benchmark scenarios">
        {overview.scenarios.map((scenario) => <button key={scenario.id} className={`scenario-item ${selectedScenario?.id === scenario.id ? 'selected' : ''}`} onClick={() => onSelect(scenario)}>
          <span className={`engine-mark ${scenario.engine}`}>{scenario.engine}</span>
          <span><strong>{scenario.name}</strong><small>{scenario.question}</small></span>
          {!scenario.runnable && <Badge variant="outline">guided</Badge>}
          <ArrowRight />
        </button>)}
      </section>
      <aside className="configuration panel">
        {selectedScenario && <>
          <div className="panel-heading"><div><p className="kicker">{selectedScenario.category}</p><h3>{selectedScenario.name}</h3></div><span className={`engine-pill ${selectedScenario.engine}`}>{selectedScenario.engine}</span></div>
          <p className="method">{selectedScenario.method}</p>
          <div className="expectation"><ShieldCheck /><span><strong>What this shows</strong>{selectedScenario.expected}</span></div>
          <fieldset><legend>Arrival model</legend><div className="segmented"><button className={props.executionModel === 'closed' ? 'active' : ''} onClick={() => props.setExecutionModel('closed')}>Closed loop</button><button className={props.executionModel === 'open' ? 'active' : ''} onClick={() => props.setExecutionModel('open')}>Target rate</button></div></fieldset>
          <Range label="Concurrency" value={props.concurrency} min={1} max={150} onChange={props.setConcurrency} />
          {props.executionModel === 'open' && <Range label="Target ops/s" value={props.targetRps} min={1} max={1000} step={10} onChange={props.setTargetRps} />}
          <Range label="Duration (seconds)" value={props.duration} min={10} max={300} step={10} onChange={props.setDuration} />
          <Range label="Ramp (seconds)" value={props.ramp} min={0} max={60} step={5} onChange={props.setRamp} />
          {overview.activeRunId ? <Button variant="destructive" size="lg" onClick={props.onStop}><Square /> Stop run</Button> : <Button size="lg" onClick={props.onLaunch} disabled={props.busy || !selectedScenario.runnable}><Play /> {selectedScenario.runnable ? 'Run scenario' : `Set up ${selectedScenario.prerequisite}`}</Button>}
        </>}
      </aside>
    </div>
    <section className="panel live-panel">
      <div className="panel-heading"><div><p className="kicker">Live result</p><h3>{selectedRun ? scenarioName(overview.scenarios, selectedRun.scenario) : 'No run selected'}</h3></div>{selectedRun && <span className={`state-label ${selectedRun.status === 'completed' ? 'ready' : selectedRun.status === 'failed' ? 'blocked' : 'action'}`}>{selectedRun.status}</span>}</div>
      <div className="metric-strip">
        <Metric icon={<Zap />} label="Throughput" value={compact(n(latest?.operations))} unit="ops/s" />
        <Metric icon={<Clock3 />} label="P50" value={n(latest?.p50_ms).toFixed(0)} unit="ms" />
        <Metric icon={<Gauge />} label="P95" value={n(latest?.p95_ms).toFixed(0)} unit="ms" />
        <Metric icon={<Activity />} label="P99" value={n(latest?.p99_ms).toFixed(0)} unit="ms" />
        <Metric icon={<CircleAlert />} label="Errors" value={errorRate.toFixed(2)} unit="%" />
      </div>
      <Telemetry metrics={props.metrics} />
      <div className="run-ledger" role="table" aria-label="Recent benchmark runs">
        <div className="ledger-row head" role="row"><span>Scenario</span><span>Engine</span><span>Users</span><span>Operations</span><span>P95</span><span>Status</span></div>
        {overview.runs.slice(0, 10).map((run) => <button className={`ledger-row ${selectedRun?.id === run.id ? 'selected' : ''}`} role="row" key={run.id} onClick={() => props.setSelectedRunId(run.id)}><span>{scenarioName(overview.scenarios, run.scenario)}</span><span>{run.engine}</span><span>{run.concurrency}</span><span>{compact(n(run.total_operations))}</span><span>{n(run.p95_ms).toFixed(0)} ms</span><span>{run.status}</span></button>)}
      </div>
    </section>
  </>;
}

function CompareView({ lakebase, dbsql, scenarios }: { lakebase?: Run; dbsql?: Run; scenarios: Scenario[] }) {
  return <>
    <section className="page-intro compact"><div><p className="kicker">Engine comparison</p><h2>Place each workload where it fits</h2><p>Lakebase serves concurrent transactions. DBSQL scans and reshapes analytical data. LTAP connects both paths.</p></div></section>
    <section className="comparison-grid">
      <ComparisonCard title="Lakebase / OLTP" run={lakebase} scenarios={scenarios} icon={<Database />} guidance="Use for point reads, writes, constraints, transactions, and application concurrency." />
      <ComparisonCard title="DBSQL / OLAP" run={dbsql} scenarios={scenarios} icon={<BarChart3 />} guidance="Use for large scans, wide joins, windows, BI, and multi-dimensional aggregation." />
    </section>
    <section className="panel ltap-panel">
      <div className="panel-heading"><div><p className="kicker">Closed-loop LTAP</p><h3>Operational data out, enriched data back</h3></div><Badge variant="outline">freshness measured at every boundary</Badge></div>
      <div className="ltap-flow">
        <FlowStep icon={<TerminalSquare />} label="1. Commit" detail="Lakebase order transaction" />
        <ArrowRight />
        <FlowStep icon={<Activity />} label="2. Capture" detail="Lakebase CDF to Delta" />
        <ArrowRight />
        <FlowStep icon={<BarChart3 />} label="3. Enrich" detail="DBSQL profile and score" />
        <ArrowRight />
        <FlowStep icon={<Layers3 />} label="4. Sync" detail="Delta table to Lakebase" />
        <ArrowRight />
        <FlowStep icon={<Search />} label="5. Serve" detail="Indexed checkout lookup" />
      </div>
      <p className="flow-note">The CDF and sync scenarios record commit time, Delta arrival, enrichment completion, Lakebase visibility, and end-to-end lag. Setup stays disabled until both previews are ready.</p>
    </section>
  </>;
}

function ComparisonCard({ title, run, scenarios, icon, guidance }: { title: string; run?: Run; scenarios: Scenario[]; icon: ReactNode; guidance: string }) {
  return <article className="panel comparison-card"><div className="comparison-title"><span>{icon}</span><div><p className="kicker">Latest completed</p><h3>{title}</h3></div></div>{run ? <><strong className="comparison-scenario">{scenarioName(scenarios, run.scenario)}</strong><div className="comparison-metrics"><Summary label="Operations" value={compact(n(run.total_operations))} detail={`${run.concurrency} concurrent`} /><Summary label="P50" value={`${n(run.p50_ms).toFixed(0)} ms`} detail="median" /><Summary label="P99" value={`${n(run.p99_ms).toFixed(0)} ms`} detail="tail" /></div></> : <div className="empty"><Activity /><span>Run a completed {title.split('/')[0].trim()} scenario to populate this comparison.</span></div>}<p className="guidance">{guidance}</p></article>;
}

function Telemetry({ metrics }: { metrics: Metric[] }) {
  const width = 800, height = 180, pad = 16;
  const points = (key: 'operations' | 'p95_ms') => {
    const max = Math.max(1, ...metrics.map((item) => n(item[key])));
    return metrics.map((item, index) => `${pad + index / Math.max(1, metrics.length - 1) * (width - 2 * pad)},${height - pad - n(item[key]) / max * (height - 2 * pad)}`).join(' ');
  };
  return <div className="telemetry"><div className="chart-heading"><span>One-second intervals</span><span><i className="legend throughput" /> throughput <i className="legend latency" /> p95</span></div>{metrics.length > 1 ? <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Throughput and p95 latency over time"><polyline className="line throughput" points={points('operations')} /><polyline className="line latency" points={points('p95_ms')} /></svg> : <div className="empty"><Activity /><span>Run a scenario to see throughput and latency over time.</span></div>}</div>;
}

function TabButton({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: ReactNode; children: ReactNode }) { return <button className={active ? 'active' : ''} onClick={onClick}>{icon}{children}</button>; }
function Summary({ label, value, detail }: { label: string; value: string; detail: string }) { return <div className="summary"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>; }
function Metric({ icon, label, value, unit }: { icon: ReactNode; label: string; value: string; unit: string }) { return <div className="metric"><span>{icon}{label}</span><strong>{value}<small>{unit}</small></strong></div>; }
function StateIcon({ state }: { state: Readiness['state'] }) { return <span className={`state-icon ${state}`}>{state === 'ready' ? <Check /> : <CircleAlert />}</span>; }
function FlowStep({ icon, label, detail }: { icon: ReactNode; label: string; detail: string }) { return <div className="flow-step"><span>{icon}</span><strong>{label}</strong><small>{detail}</small></div>; }
function Range({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void }) { return <label className="range"><span><strong>{label}</strong><output>{value}</output></span><input type="range" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} /></label>; }
function LoadingState() { return <div className="loading" aria-label="Loading LakeLoad"><span /><span /><span /></div>; }
function scenarioName(scenarios: Scenario[], id: string) { return scenarios.find((item) => item.id === id)?.name ?? id; }
function normalizeMetric(metric: Metric): Metric { return { ...metric, elapsed_seconds: n(metric.elapsed_seconds), active_users: n(metric.active_users), operations: n(metric.operations), errors: n(metric.errors), p50_ms: n(metric.p50_ms), p95_ms: n(metric.p95_ms), p99_ms: n(metric.p99_ms) }; }
