import { describe, expect, it } from 'vitest';
import { SCENARIOS, scenarioById } from './scenarios';

describe('scenario catalog', () => {
  it('has stable unique identifiers and lookup entries', () => {
    expect(new Set(SCENARIOS.map((scenario) => scenario.id)).size).toBe(SCENARIOS.length);
    for (const scenario of SCENARIOS) expect(scenarioById.get(scenario.id)).toBe(scenario);
  });

  it('covers OLTP, OLAP, LTAP, search, and observability', () => {
    expect(new Set(SCENARIOS.map((scenario) => scenario.category))).toEqual(
      new Set(['OLTP', 'OLAP', 'LTAP', 'Search', 'Observability'])
    );
    expect(SCENARIOS.filter((scenario) => scenario.runnable).every((scenario) => ['lakebase', 'dbsql'].includes(scenario.engine))).toBe(true);
    expect(SCENARIOS.filter((scenario) => !scenario.runnable).every((scenario) => Boolean(scenario.prerequisite))).toBe(true);
  });
});
