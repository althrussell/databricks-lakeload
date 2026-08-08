import { describe, expect, it } from 'vitest';
import { LatencyHistogram } from './histogram';

describe('LatencyHistogram', () => {
  it('tracks counts and monotonic quantiles', () => {
    const histogram = new LatencyHistogram();
    [1, 2, 3, 5, 8, 13, 21, 34, 55, 89].forEach((value) => histogram.observe(value));
    const snapshot = histogram.snapshot();

    expect(snapshot.count).toBe(10);
    expect(snapshot.p50Ms).toBeLessThanOrEqual(snapshot.p95Ms);
    expect(snapshot.p95Ms).toBeLessThanOrEqual(snapshot.p99Ms);
    expect(snapshot.maxMs).toBe(89);
  });

  it('resets an interval without changing the bucket contract', () => {
    const histogram = new LatencyHistogram();
    histogram.observe(10);
    histogram.reset();
    const snapshot = histogram.snapshot();

    expect(snapshot.count).toBe(0);
    expect(snapshot.counts.every((value) => value === 0)).toBe(true);
  });

  it('reports measured percentiles rather than bucket ceilings', () => {
    const histogram = new LatencyHistogram();
    [11, 12, 13, 14, 16, 17, 18, 19, 35, 36].forEach((value) => histogram.observe(value));
    const snapshot = histogram.snapshot();

    expect(snapshot.p50Ms).toBe(16);
    expect(snapshot.p95Ms).toBe(36);
    expect(snapshot.p99Ms).toBe(36);
  });
});
