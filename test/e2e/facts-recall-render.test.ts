/**
 * v0.31 E2E — `gbrain recall --today` markdown render against real Postgres.
 * Mostly a parity check: same shape as the PGLite test, on PG.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupDB, teardownDB, hasDatabase, getEngine } from './helpers.ts';
import { runRecall } from '../../src/commands/recall.ts';
import { loadConfig, isThinClient } from '../../src/core/config.ts';
import { resolveSourceId } from '../../src/core/source-resolver.ts';

const RUN = hasDatabase();
const d = RUN ? describe : describe.skip;

beforeAll(async () => { if (RUN) await setupDB(); });
afterAll(async () => { if (RUN) await teardownDB(); });

d('gbrain recall --today (Postgres)', () => {
  test('renders markdown with kind icons', async () => {
    if (!RUN) return;
    const engine = getEngine();
    const eventInsert = await engine.insertFact(
      { fact: 'render-event', kind: 'event', entity_slug: 'render-pg-e', source: 'test' },
      { source_id: 'default' },
    );
    const preferenceInsert = await engine.insertFact(
      { fact: 'render-pref', kind: 'preference', entity_slug: 'render-pg-p', source: 'test' },
      { source_id: 'default' },
    );
    expect(eventInsert.status).toBe('inserted');
    expect(preferenceInsert.status).toBe('inserted');

    // Pin transaction visibility before exercising the CLI renderer. This
    // turns cross-file DB contamination into a precise setup failure instead
    // of the misleading "missing icon" symptom that originally hid it.
    const seeded = await engine.listFactsSince('default', new Date(0), {
      activeOnly: true,
      limit: 50,
    });
    expect(seeded.map(row => row.fact).sort()).toEqual(['render-event', 'render-pref']);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const seededToday = await engine.listFactsSince('default', todayStart, {
      activeOnly: true,
      limit: 50,
    });
    expect(
      seededToday
        .map(row => ({ fact: row.fact, sourceId: row.source_id }))
        .sort((a, b) => a.fact.localeCompare(b.fact)),
    ).toEqual([
      { fact: 'render-event', sourceId: 'default' },
      { fact: 'render-pref', sourceId: 'default' },
    ]);
    const config = loadConfig();
    expect({
      thinClient: isThinClient(config),
      resolvedSourceId: await resolveSourceId(engine, null),
    }).toEqual({
      thinClient: false,
      resolvedSourceId: 'default',
    });

    const origWrite = process.stdout.write.bind(process.stdout);
    let captured = '';
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stdout.write;
    try {
      await runRecall(engine, ['--today']);
    } finally {
      process.stdout.write = origWrite;
    }

    expect(captured).toContain('Hot memory — ');
    expect(captured).toContain('📅');  // event icon
    expect(captured).toContain('🎯');  // preference icon
  });
});
