import { describe, expect, it } from 'vitest';
import { isLakeLoadTestBranch } from './routes';

describe('hard reset branch scope', () => {
  it('matches only LakeLoad snapshot and restore branches', () => {
    expect(isLakeLoadTestBranch({ name: 'projects/lakeload/branches/snapshot-demo01' })).toBe(true);
    expect(isLakeLoadTestBranch({ status: { branch_id: 'restore-demo01' } })).toBe(true);
    expect(isLakeLoadTestBranch({ name: 'projects/lakeload/branches/production' })).toBe(false);
    expect(isLakeLoadTestBranch({ name: 'projects/lakeload/branches/benchmark' })).toBe(false);
    expect(isLakeLoadTestBranch({ name: 'projects/lakeload/branches/snapshot_' })).toBe(false);
  });
});
