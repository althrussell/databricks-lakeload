const BOUNDS_MS = [
  1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987, 1597, 2584, 4181, 6765, 10946, 30000,
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
  private count = 0;
  private sumMs = 0;
  private minMs = Number.POSITIVE_INFINITY;
  private maxMs = 0;

  observe(valueMs: number) {
    const value = Math.max(0, valueMs);
    const index = BOUNDS_MS.findIndex((bound) => value <= bound);
    this.counts[index === -1 ? this.counts.length - 1 : index] += 1;
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
    this.count = 0;
    this.sumMs = 0;
    this.minMs = Number.POSITIVE_INFINITY;
    this.maxMs = 0;
  }

  private quantile(q: number) {
    if (this.count === 0) return 0;
    const target = Math.max(1, Math.ceil(this.count * q));
    let cumulative = 0;
    for (let index = 0; index < this.counts.length; index += 1) {
      cumulative += this.counts[index];
      if (cumulative >= target) return BOUNDS_MS[index];
    }
    return BOUNDS_MS[BOUNDS_MS.length - 1];
  }
}
