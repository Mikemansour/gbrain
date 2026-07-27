/**
 * Regression test (b): scripts/run-unit-shard.sh exclusion symmetry.
 *
 * Pins the contract that the local fast-loop unit-shard script:
 *   1. EXCLUDES *.slow.test.ts (those run via scripts/run-slow-tests.sh).
 *   2. EXCLUDES *.serial.test.ts (those run via scripts/run-serial-tests.sh
 *      after the parallel pass).
 *   3. Includes plain *.test.ts files (the fast-loop unit set).
 *
 * Without this guard, a future refactor that drops one of the `-not -name`
 * clauses from the find expression would cause slow OR serial files to
 * run inside the parallel pass — silently undoing the quarantine and
 * re-introducing the contention flakes that motivated v0.26.4.
 */

import { describe, it, expect } from 'bun:test';
import { execFileSync } from 'child_process';
import { resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const SHARD_SH = resolve(REPO_ROOT, 'scripts/run-unit-shard.sh');

function dryRunList(profile = 'all'): string[] {
  const out = execFileSync('bash', [SHARD_SH, `--profile=${profile}`, '--dry-run-list'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: { ...process.env, SHARD: '' },
  });
  return out.split('\n').map(s => s.trim()).filter(Boolean);
}

function batchedDryRunList(): string[] {
  const out = execFileSync(
    'bash',
    [SHARD_SH, '--batch-size=25', '--max-concurrency=2', '--dry-run-list'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env: { ...process.env, SHARD: '' },
    },
  );
  return out.split('\n').map(s => s.trim()).filter(Boolean);
}

function shardedDryRunList(profile: 'heavy' | 'light', shard: number, total: number): string[] {
  const out = execFileSync(
    'bash',
    [SHARD_SH, `--profile=${profile}`, '--dry-run-list'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env: { ...process.env, SHARD: `${shard}/${total}` },
    },
  );
  return out.split('\n').map(s => s.trim()).filter(Boolean);
}

describe('run-unit-shard.sh exclusion symmetry', () => {
  it('lists at least one plain *.test.ts file', () => {
    const files = dryRunList();
    expect(files.length).toBeGreaterThan(0);
    expect(files.some(f => /\.test\.ts$/.test(f) && !/\.(slow|serial)\.test\.ts$/.test(f))).toBe(true);
  });

  it('excludes every *.slow.test.ts file', () => {
    const files = dryRunList();
    const leaks = files.filter(f => /\.slow\.test\.ts$/.test(f));
    expect(leaks).toEqual([]);
  });

  it('excludes every *.serial.test.ts file', () => {
    const files = dryRunList();
    const leaks = files.filter(f => /\.serial\.test\.ts$/.test(f));
    expect(leaks).toEqual([]);
  });

  it('excludes the test/e2e/ subtree', () => {
    const files = dryRunList();
    const leaks = files.filter(f => f.startsWith('test/e2e/'));
    expect(leaks).toEqual([]);
  });

  it('batch and concurrency controls do not change dry-run selection', () => {
    expect(batchedDryRunList()).toEqual(dryRunList());
  });

  it('heavy and light profiles are disjoint and cover the full unit set', () => {
    const all = dryRunList();
    const heavy = dryRunList('heavy');
    const light = dryRunList('light');
    const heavySet = new Set(heavy);
    expect(heavy.length).toBeGreaterThan(0);
    expect(light.length).toBeGreaterThan(0);
    expect(light.filter(file => heavySet.has(file))).toEqual([]);
    expect([...heavy, ...light].sort()).toEqual(all);
  });

  it('weighted shards are disjoint and exactly cover each profile', () => {
    const total = 8;
    for (const profile of ['heavy', 'light'] as const) {
      const all = dryRunList(profile);
      const sharded = Array.from(
        { length: total },
        (_, index) => shardedDryRunList(profile, index + 1, total),
      ).flat();
      expect(new Set(sharded).size).toBe(sharded.length);
      expect(sharded.sort()).toEqual(all);
    }
  });

  it('rejects an unknown profile', () => {
    expect(() => execFileSync('bash', [SHARD_SH, '--profile=unknown', '--dry-run-list'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env: { ...process.env, SHARD: '' },
      stdio: 'pipe',
    })).toThrow();
  });
});
