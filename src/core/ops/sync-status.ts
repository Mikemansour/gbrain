/**
 * Sync operation cluster — pure move from operations.ts (v0.46.x tranche 2).
 * Op consts stay module-private; `syncStatusOperations` below lists them in
 * EXACTLY the order they appear in the canonical `operations` array in
 * ../operations.ts. Never import from '../operations.ts' here (cycle).
 */

import { OperationError, type Operation } from './contract.ts';

// --- Sync ---

const sync_brain: Operation = {
  name: 'sync_brain',
  description: 'Sync git repo to brain (incremental)',
  params: {
    repo: { type: 'string', description: 'Path to git repo (optional if configured)' },
    dry_run: { type: 'boolean', description: 'Preview changes without applying' },
    full: { type: 'boolean', description: 'Full re-sync (ignore checkpoint)' },
    no_pull: { type: 'boolean', description: 'Skip git pull' },
    no_embed: { type: 'boolean', description: 'Skip embedding generation' },
  },
  mutating: true,
  scope: 'admin',
  localOnly: true,
  handler: async (ctx, p) => {
    const { performSync } = await import('../../commands/sync.ts');
    // #2830: thread ctx.sourceId (D7 pattern, same as revert_version /
    // put_page) so a no-`repo` call resolves the CALLER's sync anchor.
    // Without it, performSync read the default source's repo_path/last_commit
    // and silently synced against the wrong repo on multi-source brains.
    const sourceOpts = ctx.sourceId ? { sourceId: ctx.sourceId } : {};
    return performSync(ctx.engine, {
      repoPath: p.repo as string | undefined,
      dryRun: ctx.dryRun || (p.dry_run as boolean) || false,
      noEmbed: (p.no_embed as boolean) || false,
      noPull: (p.no_pull as boolean) || false,
      full: (p.full as boolean) || false,
      ...sourceOpts,
    });
  },
  cliHints: { name: 'sync', hidden: true },
};

const run_dream_cycle: Operation = {
  name: 'run_dream_cycle',
  description:
    'Run the GBrain maintenance cycle inside the serving process. Uses only the configured/default source path; remote callers cannot supply a host filesystem path.',
  params: {
    phases: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional allowlisted cycle phases. Omit to run the full configured cycle.',
    },
    dry_run: { type: 'boolean', description: 'Preview without filesystem or database writes' },
  },
  mutating: true,
  scope: 'admin',
  area: 'sync',
  handler: async (ctx, p) => {
    const { ALL_PHASES, runCycle } = await import('../cycle.ts');
    const requested = p.phases as unknown;
    let phases: (typeof ALL_PHASES)[number][] | undefined;
    if (requested !== undefined) {
      if (!Array.isArray(requested)) {
        throw new OperationError('invalid_params', 'Invalid phases: expected an array of cycle phase names.');
      }
      const allowed = new Set<string>(ALL_PHASES);
      const invalid = requested.filter((phase): boolean => typeof phase !== 'string' || !allowed.has(phase));
      if (invalid.length > 0) {
        throw new OperationError(
          'invalid_params',
          `Invalid cycle phase(s): ${invalid.map(String).join(', ')}.`,
        );
      }
      phases = requested as (typeof ALL_PHASES)[number][];
    }

    const { getDefaultSourcePath } = await import('../source-resolver.ts');
    const brainDir = (await ctx.engine.getConfig('sync.repo_path'))
      ?? (await getDefaultSourcePath(ctx.engine))
      ?? null;
    const yieldToLoop = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); };

    return runCycle(ctx.engine, {
      brainDir,
      dryRun: ctx.dryRun || (p.dry_run as boolean) || false,
      phases,
      pull: false,
      sourceId: ctx.sourceId,
      yieldBetweenPhases: yieldToLoop,
      yieldDuringPhase: yieldToLoop,
    });
  },
};


// Ops in EXACTLY the canonical `operations` array order.
export const syncStatusOperations: Operation[] = [sync_brain, run_dream_cycle];
