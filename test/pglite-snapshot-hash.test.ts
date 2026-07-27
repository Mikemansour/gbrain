import { describe, expect, test } from 'bun:test';
import * as crypto from 'node:crypto';

import { computeSnapshotSchemaHash } from '../src/core/pglite-engine.ts';

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
