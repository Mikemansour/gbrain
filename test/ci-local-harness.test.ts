import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ciLocalSource = readFileSync(resolve(import.meta.dir, '../scripts/ci-local.sh'), 'utf8');

describe('ci-local shard harness hardening', () => {
  test('does not splice the runner command with replacement-pattern semantics', () => {
    expect(ciLocalSource).not.toContain('${INNER_CMD/__RUN_PHASES__/$RUN_PHASES_CMD}');
    expect(ciLocalSource).toContain('RUN_PHASES_PREFIX=${INNER_CMD%%__RUN_PHASES__*}');
    expect(ciLocalSource).toContain('RUN_PHASES_SUFFIX=${INNER_CMD#*__RUN_PHASES__}');
    expect(ciLocalSource).toContain('INNER_CMD="${RUN_PHASES_PREFIX}${RUN_PHASES_CMD}${RUN_PHASES_SUFFIX}"');
  });

  test('gives each shard isolated writable state and drops root DAC bypass for unit tests', () => {
    expect(ciLocalSource).toContain('shard_root=/tmp/gbrain-ci-shard-\\${shard}');
    expect(ciLocalSource).toContain('export HOME=\\${shard_root}/home');
    expect(ciLocalSource).toContain('export TMPDIR=\\${shard_root}/tmp');
    expect(ciLocalSource).toContain('--bounding-set=-dac_override,-dac_read_search');
    expect(ciLocalSource).toContain('--inh-caps=-dac_override,-dac_read_search');
    expect(ciLocalSource).toContain('--ambient-caps=-dac_override,-dac_read_search');
  });

  test('keeps complete shard logs in an explicit evidence directory', () => {
    expect(ciLocalSource).toContain('GBRAIN_CI_EVIDENCE_DIR');
    expect(ciLocalSource).toContain(':/evidence');
    expect(ciLocalSource).toContain('log=/evidence/shard-\\${shard}.log');
  });

  test('runs process-isolated serial tests once before the four parallel shards', () => {
    const serialLane = ciLocalSource.indexOf('bash scripts/run-serial-tests.sh');
    const shardFanout = ciLocalSource.indexOf('xargs -P4 -I{}');
    expect(serialLane).toBeGreaterThan(-1);
    expect(shardFanout).toBeGreaterThan(serialLane);
    expect(ciLocalSource).toContain('serial_root=/tmp/gbrain-ci-serial');
  });
});
