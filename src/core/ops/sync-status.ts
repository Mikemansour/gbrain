/**
 * Sync operation cluster — pure move from operations.ts (v0.46.x tranche 2).
 * Op consts stay module-private; `syncStatusOperations` below lists them in
 * EXACTLY the order they appear in the canonical `operations` array in
 * ../operations.ts. Never import from '../operations.ts' here (cycle).
 */

import { OperationError, type Operation, type OperationContext } from './contract.ts';

const POLARIS_CYCLE_CLIENT_ID =
  'gbrain_cl_f876448e97e8ea6983d7c7d72411e04bca172ec0111874a9dc764d4791acd2e3';
const POLARIS_CYCLE_CLIENT_NAME = 'polaris-cron-owner';

/**
 * This HTTP operation is the PGLite sole-owner maintenance lane. Admin scope
 * alone is intentionally insufficient: other admin clients must not inherit a
 * direct path around the protected cycle/subagent/budget gates.
 */
function assertProtectedCycleCaller(ctx: OperationContext): string {
  const auth = ctx.auth;
  const sourceId = ctx.sourceId;
  const exactSourceGrant = typeof sourceId === 'string'
    && sourceId.length > 0
    && auth?.sourceId === sourceId
    && Array.isArray(auth.allowedSources)
    && auth.allowedSources.length === 1
    && auth.allowedSources[0] === sourceId;

  if (
    ctx.remote !== true
    || ctx.transport !== 'http'
    || auth?.clientId !== POLARIS_CYCLE_CLIENT_ID
    || auth.clientName !== POLARIS_CYCLE_CLIENT_NAME
    || !auth.scopes.includes('admin')
    || !exactSourceGrant
  ) {
    throw new OperationError(
      'permission_denied',
      'run_dream_cycle is restricted to the dedicated protected maintenance client with an exact single-source grant.',
    );
  }

  return sourceId;
}

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
    'Run the GBrain maintenance cycle inside the serving process. Restricted to the deployment\'s dedicated protected-maintenance OAuth client on an exact single-source PGLite brain.',
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
    const sourceId = assertProtectedCycleCaller(ctx);
    if (ctx.engine.kind !== 'pglite') {
      throw new OperationError(
        'permission_denied',
        'run_dream_cycle is available only on a single-owner PGLite brain.',
      );
    }
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

    const activeSources = await ctx.engine.listAllSources();
    const source = activeSources[0];
    if (
      activeSources.length !== 1
      || source?.id !== sourceId
      || !source.local_path
    ) {
      throw new OperationError(
        'permission_denied',
        `run_dream_cycle requires a single-source brain whose active source exactly matches "${sourceId}" and has a local_path.`,
      );
    }
    const brainDir = source.local_path;
    const yieldToLoop = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); };

    return runCycle(ctx.engine, {
      brainDir,
      dryRun: ctx.dryRun || (p.dry_run as boolean) || false,
      phases: phases ?? ALL_PHASES,
      pull: false,
      sourceId,
      yieldBetweenPhases: yieldToLoop,
      yieldDuringPhase: yieldToLoop,
    });
  },
};


// Ops in EXACTLY the canonical `operations` array order.
export const syncStatusOperations: Operation[] = [sync_brain, run_dream_cycle];
