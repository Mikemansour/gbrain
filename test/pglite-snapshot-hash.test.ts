import { describe, expect, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { computeSnapshotSchemaHash, isFreshSnapshotDataDir } from '../src/core/pglite-engine.ts';

const migrations = [
  { version: 1, name: 'one', sql: 'SELECT 1' },
  { version: 2, name: 'two', sqlFor: { pglite: 'SELECT 2' } },
];

describe('PGLite snapshot compatibility hash', () => {
  test('is stable for identical schema inputs', () => {
    const first = computeSnapshotSchemaHash(migrations, 'schema', crypto, 1280, 'provider:model');
    const second = computeSnapshotSchemaHash(migrations, 'schema', crypto, 1280, 'provider:model');
    expect(second).toBe(first);
  });

  test('changes when the dimension-sensitive PGLite schema inputs change', () => {
    const baseline = computeSnapshotSchemaHash(migrations, 'schema', crypto, 1280, 'provider:model');
    const differentDimensions = computeSnapshotSchemaHash(migrations, 'schema', crypto, 1536, 'provider:model');
    const differentModel = computeSnapshotSchemaHash(migrations, 'schema', crypto, 1280, 'other:model');
    expect(differentDimensions).not.toBe(baseline);
    expect(differentModel).not.toBe(baseline);
  });
});

describe('persistent snapshot restore eligibility', () => {
  test('accepts only a fresh directory or the engine-owned lock directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-snapshot-fresh-'));
    try {
      expect(isFreshSnapshotDataDir(undefined)).toBe(true);
      expect(isFreshSnapshotDataDir(dir)).toBe(true);
      mkdirSync(join(dir, '.gbrain-lock'));
      writeFileSync(join(dir, '.gbrain-lock', 'lock'), '{}');
      expect(isFreshSnapshotDataDir(dir)).toBe(true);
      writeFileSync(join(dir, 'PG_VERSION'), '16');
      expect(isFreshSnapshotDataDir(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fails closed for a missing or unreadable path', () => {
    expect(isFreshSnapshotDataDir(join(tmpdir(), 'gbrain-snapshot-does-not-exist'))).toBe(false);
  });
});
