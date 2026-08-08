// Persisted buckets are deliberately compact, while headline percentiles are
// calculated from the observed values. The previous Fibonacci buckets made a
// 35 ms request appear as 55 ms and were too coarse for an OLTP benchmark.
const BOUNDS_MS = [
  0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 7.5, 10, 15, 20, 30, 40, 50, 75, 100,
  150, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 7500, 10000, 15000,
  30000, 60000, 120000,
] as const;

export interface HistogramSnapshot {
  boundsMs: number[];
  counts: number[];
  count: number;
  sumMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export class LatencyHistogram {
  private counts = BOUNDS_MS.map(() => 0);
  private values: number[] = [];
  private count = 0;
  private sumMs = 0;
  private minMs = Number.POSITIVE_INFINITY;
  private maxMs = 0;

  observe(valueMs: number) {
    const value = Math.max(0, valueMs);
    const index = BOUNDS_MS.findIndex((bound) => value <= bound);
    this.counts[index === -1 ? this.counts.length - 1 : index] += 1;
    this.values.push(value);
    this.count += 1;
    this.sumMs += value;
    this.minMs = Math.min(this.minMs, value);
    this.maxMs = Math.max(this.maxMs, value);
  }

  snapshot(): HistogramSnapshot {
    return {
      boundsMs: [...BOUNDS_MS],
      counts: [...this.counts],
      count: this.count,
      sumMs: this.sumMs,
      minMs: this.count === 0 ? 0 : this.minMs,
      maxMs: this.maxMs,
      p50Ms: this.quantile(0.5),
      p95Ms: this.quantile(0.95),
      p99Ms: this.quantile(0.99),
    };
  }

  reset() {
    this.counts = BOUNDS_MS.map(() => 0);
    this.values = [];
    this.count = 0;
    this.sumMs = 0;
    this.minMs = Number.POSITIVE_INFINITY;
    this.maxMs = 0;
  }

  private quantile(q: number) {
    if (this.count === 0) return 0;
    const ordered = [...this.values].sort((left, right) => left - right);
    const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * q) - 1));
    return Math.round(ordered[index] * 100) / 100;
  }
}
