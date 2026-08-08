import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Badge, Button, Card, CardContent, Skeleton } from '@databricks/appkit-ui/react';
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Boxes,
  Clock3,
  Database,
  Gauge,
  History,
  Play,
  RotateCw,
  ServerCog,
  ShieldCheck,
  Square,
  Waves,
  Zap,
} from 'lucide-react';

type Scenario = 'mixed-oltp' | 'read-heavy' | 'write-heavy' | 'complex-queries';

interface Run {
  id: string;
  scenario: Scenario;
  status: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
  concurrency: number;
  duration_seconds: number;
  ramp_seconds: number;
  requested_by: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  total_operations: string | number;
  total_errors: string | number;
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
}

interface Overview {
  runs: Run[];
  activeRunId: string | null;
  activeMetrics: Metric[];
  target: {
    database: string;
    postgres_version: string;
    accounts: number;
    products: number;
    history_rows: number;
  };
  endpoint: { branch: string; endpoint: string; poolSize: number };
}

const EMPTY_OVERVIEW: Overview = {
  runs: [],
  activeRunId: null,
  activeMetrics: [],
  target: { database: 'databricks_postgres', postgres_version: '17', accounts: 0, products: 0, history_rows: 0 },
  endpoint: { branch: 'benchmark', endpoint: 'primary', poolSize: 80 },
};

const scenarios: Record<Scenario, { name: string; description: string; mix: string }> = {
  'mixed-oltp': { name: 'Mixed OLTP', description: 'Balanced reads, writes and bounded joins', mix: '55R / 35W / 10C' },
  'read-heavy': { name: 'Read heavy', description: 'Indexed point lookups with light writes', mix: '85R / 10W / 5C' },
  'write-heavy': {
    name: 'Write heavy',
    description: 'Transactional transfers and history inserts',
    mix: '20R / 70W / 10C',
  },
  'complex-queries': {
    name: 'Complex queries',
    description: 'Bounded joins and operational aggregates',
    mix: '25R / 15W / 60C',
  },
};

function number(value: string | number | null | undefined) {
  return Number(value ?? 0);
}

function compact(value: number) {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function statusClass(status: Run['status']) {
  if (status === 'running') return 'status-running';
  if (status === 'completed') return 'status-completed';
  if (status === 'failed') return 'status-failed';
  return 'status-neutral';
}

export default function App() {
  const [overview, setOverview] = useState<Overview>(EMPTY_OVERVIEW);
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [scenario, setScenario] = useState<Scenario>('mixed-oltp');
  const [concurrency, setConcurrency] = useState(50);
  const [durationSeconds, setDurationSeconds] = useState(60);
  const [rampSeconds, setRampSeconds] = useState(10);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/lakeload/overview');
      if (!response.ok) throw new Error(`Overview request failed (${response.status})`);
      const next = (await response.json()) as Overview;
      setOverview(next);
      if (next.activeRunId) {
        setSelectedRunId(next.activeRunId);
        setMetrics(next.activeMetrics.map(normalizeMetric));
      } else if (!selectedRunId && next.runs[0]) {
        setSelectedRunId(next.runs[0].id);
      }
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load LakeLoad');
    } finally {
      setLoading(false);
    }
  }, [selectedRunId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!selectedRunId || selectedRunId === overview.activeRunId) return;
    void fetch(`/api/lakeload/runs/${selectedRunId}`)
      .then((response) => {
        if (!response.ok) throw new Error('Unable to load run details');
        return response.json() as Promise<{ run: Run; metrics: Metric[] }>;
      })
      .then((result) => setMetrics(result.metrics.map(normalizeMetric)))
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'Unable to load run'));
  }, [overview.activeRunId, selectedRunId]);

  const selectedRun = useMemo(
    () => overview.runs.find((run) => run.id === selectedRunId) ?? overview.runs[0] ?? null,
    [overview.runs, selectedRunId]
  );
  const latest = metrics.at(-1);
  const totalOps = metrics.reduce((sum, metric) => sum + number(metric.operations), 0);
  const totalErrors = metrics.reduce((sum, metric) => sum + number(metric.errors), 0);
  const errorRate = totalOps + totalErrors === 0 ? 0 : (totalErrors / (totalOps + totalErrors)) * 100;
  const progress =
    selectedRun?.status === 'running' && latest
      ? Math.min(100, (number(latest.elapsed_seconds) / selectedRun.duration_seconds) * 100)
      : selectedRun?.status === 'completed'
        ? 100
        : 0;

  async function startRun() {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch('/api/lakeload/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario, concurrency, durationSeconds, rampSeconds }),
      });
      const body = (await response.json()) as { runId?: string; error?: string };
      if (!response.ok || !body.runId) throw new Error(body.error ?? 'Unable to start run');
      setSelectedRunId(body.runId);
      setMetrics([]);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to start run');
    } finally {
      setSubmitting(false);
    }
  }

  async function stopRun() {
    if (!overview.activeRunId) return;
    await fetch(`/api/lakeload/runs/${overview.activeRunId}`, { method: 'DELETE' });
    await refresh();
  }

  return (
    <div className="app-shell">
      <aside className="side-rail">
        <div className="brand-mark">
          <Waves size={22} strokeWidth={2.4} />
        </div>
        <nav aria-label="Primary navigation">
          <button className="rail-button active" aria-label="Live run">
            <Activity size={19} />
          </button>
          <button className="rail-button" aria-label="Run history">
            <History size={19} />
          </button>
          <button className="rail-button" aria-label="Target settings">
            <ServerCog size={19} />
          </button>
        </nav>
        <div className="rail-spacer" />
        <div className="connection-dot" title="Lakebase connected" />
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <div className="eyebrow">DATABRICKS LAKEBASE</div>
            <h1>LakeLoad</h1>
          </div>
          <div className="target-pill">
            <span className="target-icon">
              <Database size={16} />
            </span>
            <span>
              <b>{overview.endpoint.branch}</b>
              <small>
                {overview.endpoint.endpoint} · PostgreSQL {overview.target.postgres_version}
              </small>
            </span>
            <ShieldCheck size={17} className="target-ok" />
          </div>
        </header>

        {error && (
          <div className="error-banner">
            {error}
            <Button variant="ghost" size="sm" onClick={() => void refresh()}>
              <RotateCw size={14} /> Retry
            </Button>
          </div>
        )}

        <section className="hero-grid">
          <div className="run-panel">
            <div className="section-heading">
              <div>
                <span className="section-kicker">WORKLOAD</span>
                <h2>Shape the pressure</h2>
              </div>
              <Badge variant="outline" className="repeatable-badge">
                <Boxes size={13} /> deterministic dataset
              </Badge>
            </div>

            <div className="scenario-grid">
              {(Object.entries(scenarios) as Array<[Scenario, (typeof scenarios)[Scenario]]>).map(([key, value]) => (
                <button
                  key={key}
                  type="button"
                  className={`scenario-card ${scenario === key ? 'selected' : ''}`}
                  onClick={() => setScenario(key)}
                  disabled={Boolean(overview.activeRunId)}
                >
                  <span className="scenario-radio" />
                  <strong>{value.name}</strong>
                  <small>{value.description}</small>
                  <code>{value.mix}</code>
                </button>
              ))}
            </div>

            <div className="controls-grid">
              <RangeControl
                label="Concurrent users"
                value={concurrency}
                min={1}
                max={150}
                step={1}
                suffix=" VUs"
                onChange={setConcurrency}
              />
              <RangeControl
                label="Duration"
                value={durationSeconds}
                min={10}
                max={300}
                step={10}
                suffix=" sec"
                onChange={setDurationSeconds}
              />
              <RangeControl
                label="Ramp"
                value={rampSeconds}
                min={0}
                max={60}
                step={5}
                suffix=" sec"
                onChange={setRampSeconds}
              />
            </div>

            <div className="run-actions">
              <div className="safety-note">
                <ShieldCheck size={16} />
                <span>
                  Isolated benchmark branch
                  <br />
                  <small>Pool capped at {overview.endpoint.poolSize} connections</small>
                </span>
              </div>
              {overview.activeRunId ? (
                <Button variant="destructive" size="lg" onClick={() => void stopRun()}>
                  <Square size={15} fill="currentColor" /> Stop run
                </Button>
              ) : (
                <Button
                  size="lg"
                  className="launch-button"
                  disabled={submitting || loading}
                  onClick={() => void startRun()}
                >
                  {submitting ? <RotateCw className="spin" size={17} /> : <Play size={17} fill="currentColor" />} Launch
                  run
                </Button>
              )}
            </div>
          </div>

          <div className="dataset-panel">
            <div className="section-heading">
              <div>
                <span className="section-kicker">TARGET</span>
                <h2>Ready for load</h2>
              </div>
              <span className="live-dot">LIVE</span>
            </div>
            <div className="database-orbit">
              <Database size={38} />
              <span className="orbit orbit-one" />
              <span className="orbit orbit-two" />
            </div>
            <div className="dataset-stats">
              <DataStat label="Accounts" value={compact(number(overview.target.accounts))} />
              <DataStat label="Products" value={compact(number(overview.target.products))} />
              <DataStat label="Transactions" value={compact(number(overview.target.history_rows))} />
            </div>
            <div className="endpoint-detail">
              <span>Compute</span>
              <b>1–4 CU autoscaling</b>
            </div>
            <div className="endpoint-detail">
              <span>Connection mode</span>
              <b>OAuth pool</b>
            </div>
          </div>
        </section>

        <section className="live-section">
          <div className="live-header">
            <div className="run-title">
              <span className={`pulse-indicator ${selectedRun?.status === 'running' ? 'on' : ''}`} />
              <div>
                <span className="section-kicker">LIVE TELEMETRY</span>
                <h2>{selectedRun ? scenarios[selectedRun.scenario].name : 'Waiting for first run'}</h2>
              </div>
            </div>
            {selectedRun && (
              <div className="run-meta">
                <Badge variant="outline" className={statusClass(selectedRun.status)}>
                  {selectedRun.status}
                </Badge>
                <span>{selectedRun.concurrency} VUs</span>
                <span>{selectedRun.duration_seconds}s</span>
              </div>
            )}
          </div>

          <div className="progress-track">
            <span style={{ width: `${progress}%` }} />
          </div>

          <div className="metrics-grid">
            <MetricCard
              icon={<Zap size={16} />}
              label="Throughput"
              value={compact(number(latest?.operations))}
              unit="ops/s"
              trend="live"
            />
            <MetricCard
              icon={<Clock3 size={16} />}
              label="P50 latency"
              value={number(latest?.p50_ms).toFixed(0)}
              unit="ms"
              trend="median"
            />
            <MetricCard
              icon={<Gauge size={16} />}
              label="P95 latency"
              value={number(latest?.p95_ms).toFixed(0)}
              unit="ms"
              trend="tail"
            />
            <MetricCard
              icon={<Activity size={16} />}
              label="P99 latency"
              value={number(latest?.p99_ms).toFixed(0)}
              unit="ms"
              trend="peak"
            />
            <MetricCard
              icon={<ShieldCheck size={16} />}
              label="Error rate"
              value={errorRate.toFixed(2)}
              unit="%"
              trend={errorRate < 1 ? 'healthy' : 'watch'}
            />
          </div>

          <div className="charts-grid">
            <TelemetryChart
              title="Throughput"
              subtitle="Operations per second"
              metrics={metrics}
              series={[{ key: 'operations', color: '#40d1f5', label: 'ops/s' }]}
            />
            <TelemetryChart
              title="Latency envelope"
              subtitle="Tail behavior in milliseconds"
              metrics={metrics}
              series={[
                { key: 'p50_ms', color: '#40d1f5', label: 'p50' },
                { key: 'p95_ms', color: '#8b7cf6', label: 'p95' },
                { key: 'p99_ms', color: '#ff5f57', label: 'p99' },
              ]}
            />
          </div>
        </section>

        <section className="history-section">
          <div className="section-heading">
            <div>
              <span className="section-kicker">RUN LEDGER</span>
              <h2>Recent experiments</h2>
            </div>
            <span className="muted-caption">Repeatable by seed and configuration</span>
          </div>
          <div className="history-table" role="table" aria-label="Recent load tests">
            <div className="history-row history-head" role="row">
              <span>Scenario</span>
              <span>Users</span>
              <span>Operations</span>
              <span>P95</span>
              <span>Errors</span>
              <span>Status</span>
            </div>
            {overview.runs.slice(0, 8).map((run) => (
              <button
                key={run.id}
                className={`history-row ${selectedRunId === run.id ? 'active' : ''}`}
                onClick={() => setSelectedRunId(run.id)}
                role="row"
              >
                <span>
                  <b>{scenarios[run.scenario].name}</b>
                  <small>{new Date(run.created_at).toLocaleTimeString()}</small>
                </span>
                <span>{run.concurrency}</span>
                <span>{compact(number(run.total_operations))}</span>
                <span>{number(run.p95_ms).toFixed(0)} ms</span>
                <span>{compact(number(run.total_errors))}</span>
                <span>
                  <Badge variant="outline" className={statusClass(run.status)}>
                    {run.status}
                  </Badge>
                </span>
              </button>
            ))}
            {!loading && overview.runs.length === 0 && (
              <div className="empty-history">
                <Waves size={24} />
                <span>Your first run will appear here.</span>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

function normalizeMetric(metric: Metric): Metric {
  return {
    recorded_at: metric.recorded_at,
    elapsed_seconds: number(metric.elapsed_seconds),
    active_users: number(metric.active_users),
    operations: number(metric.operations),
    errors: number(metric.errors),
    reads: number(metric.reads),
    writes: number(metric.writes),
    complex_queries: number(metric.complex_queries),
    p50_ms: number(metric.p50_ms),
    p95_ms: number(metric.p95_ms),
    p99_ms: number(metric.p99_ms),
  };
}

function RangeControl({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="range-control">
      <span>
        <b>{label}</b>
        <output>
          {value}
          {suffix}
        </output>
      </span>
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <small>
        {min}
        {suffix} <i /> {max}
        {suffix}
      </small>
    </label>
  );
}

function DataStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  unit,
  trend,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  unit: string;
  trend: string;
}) {
  return (
    <Card className="metric-card">
      <CardContent>
        <span className="metric-icon">{icon}</span>
        <span className="metric-label">{label}</span>
        <div>
          <strong>{value}</strong>
          <small>{unit}</small>
        </div>
        <span className="metric-trend">
          {trend === 'healthy' ? <ArrowDownRight size={13} /> : <ArrowUpRight size={13} />} {trend}
        </span>
      </CardContent>
    </Card>
  );
}

type MetricKey = 'operations' | 'p50_ms' | 'p95_ms' | 'p99_ms';

function TelemetryChart({
  title,
  subtitle,
  metrics,
  series,
}: {
  title: string;
  subtitle: string;
  metrics: Metric[];
  series: Array<{ key: MetricKey; color: string; label: string }>;
}) {
  const width = 700;
  const height = 220;
  const padding = 24;
  const allValues = metrics.flatMap((metric) => series.map((item) => number(metric[item.key])));
  const max = Math.max(1, ...allValues);
  const points = (key: MetricKey) =>
    metrics
      .map((metric, index) => {
        const x = padding + (index / Math.max(1, metrics.length - 1)) * (width - padding * 2);
        const y = height - padding - (number(metric[key]) / max) * (height - padding * 2);
        return `${x},${y}`;
      })
      .join(' ');

  return (
    <div className="chart-card">
      <div className="chart-heading">
        <div>
          <h3>{title}</h3>
          <span>{subtitle}</span>
        </div>
        <div className="chart-legend">
          {series.map((item) => (
            <span key={item.key}>
              <i style={{ background: item.color }} />
              {item.label}
            </span>
          ))}
        </div>
      </div>
      {metrics.length === 0 ? (
        <div className="chart-empty">
          <Skeleton className="h-full w-full" />
          <span>Launch a run to stream telemetry</span>
        </div>
      ) : (
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title} time series`}>
          <defs>
            <linearGradient id={`fill-${series[0].key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={series[0].color} stopOpacity="0.24" />
              <stop offset="100%" stopColor={series[0].color} stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0.25, 0.5, 0.75, 1].map((ratio) => (
            <line
              key={ratio}
              x1={padding}
              x2={width - padding}
              y1={padding + (height - padding * 2) * ratio}
              y2={padding + (height - padding * 2) * ratio}
              className="grid-line"
            />
          ))}
          {series.map((item) => (
            <polyline
              key={item.key}
              points={points(item.key)}
              fill="none"
              stroke={item.color}
              strokeWidth="3"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
        </svg>
      )}
    </div>
  );
}
