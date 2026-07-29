import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  OperationError,
  operationsByName,
  type OperationContext,
} from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const SOURCE_ID = 'axiom-polaris';
const LINK_SOURCE = 'axiom-managed-v1';

const graph = {
  components: [
    {
      slug: 'axiom-one',
      status: 'active',
      component_type: 'service',
      aliases: ['one'],
      live: {
        systemd_unit: 'one.service',
        port: 1234,
      },
    },
    {
      slug: 'axiom-two',
      status: 'degraded',
      component_type: 'provider',
      aliases: [],
    },
  ],
  links: [
    {
      from_slug: 'axiom-one',
      to_slug: 'axiom-two',
      link_type: 'depends-on',
      strength: 'critical',
      impact: 'must_inspect',
    },
  ],
};

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config)
     VALUES ($1, $1, '{}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [SOURCE_ID],
  );
});

function context(
  overrides: Partial<OperationContext> = {},
  selectedEngine: BrainEngine = engine,
): OperationContext {
  return {
    engine: selectedEngine,
    config: {} as OperationContext['config'],
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: true,
    sourceId: SOURCE_ID,
    auth: {
      token: 'test-token',
      clientId: 'gbrain_cl_axiom_test',
      clientName: 'polaris-axiom-sync',
      scopes: ['read', 'write'],
      sourceId: SOURCE_ID,
      allowedSources: [SOURCE_ID],
    },
    ...overrides,
  };
}

function invoke(
  graphValue: unknown,
  ctx: OperationContext = context(),
): Promise<unknown> {
  return operationsByName.reconcile_axiom_graph.handler(ctx, {
    graph_json: JSON.stringify(graphValue),
  });
}

describe('reconcile_axiom_graph', () => {
  test('is a remote write operation exposed through its dedicated CLI transport', () => {
    const op = operationsByName.reconcile_axiom_graph;
    expect(op.scope).toBe('write');
    expect(op.mutating).toBeTrue();
    expect(op.localOnly).not.toBeTrue();
    expect(op.cliHints?.stdin).toBe('graph_json');
    expect(op.cliHints?.name).toBe('reconcile-axiom-graph');
  });

  test('rejects local, unscoped, wrong-client, and widened-source callers', async () => {
    const validAuth = context().auth!;
    const rejected = [
      context({ remote: false }),
      context({ auth: undefined }),
      context({ auth: { ...validAuth, clientName: 'other-client' } }),
      context({ auth: { ...validAuth, sourceId: 'default' } }),
      context({ sourceId: 'default' }),
      context({
        auth: {
          ...validAuth,
          allowedSources: [SOURCE_ID, 'default'],
        },
      }),
      context({ auth: { ...validAuth, scopes: ['admin'] } }),
    ];

    for (const ctx of rejected) {
      try {
        await invoke(graph, ctx);
        throw new Error('expected permission rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(OperationError);
        expect((error as OperationError).code).toBe('permission_denied');
      }
    }
    expect(await engine.getPage('axiom-one', { sourceId: SOURCE_ID })).toBeNull();
  });

  test('strictly rejects unknown fields and non-loopback health metadata', async () => {
    await expect(invoke({ ...graph, extra: true })).rejects.toThrow(
      /unsupported fields/,
    );
    await expect(invoke({
      ...graph,
      components: [
        {
          ...graph.components[0],
          unexpected: 'field',
        },
        graph.components[1],
      ],
    })).rejects.toThrow(/unsupported fields/);
    await expect(invoke({
      ...graph,
      components: [
        {
          ...graph.components[0],
          live: {
            port: 1234,
            health_endpoint: 'https://example.test/health',
          },
        },
        graph.components[1],
      ],
    })).rejects.toThrow(/loopback HTTP URL/);
    await expect(invoke({
      ...graph,
      links: [
        graph.links[0],
        graph.links[0],
      ],
    })).rejects.toThrow(/must be unique/);
  });

  test('preserves existing page content/frontmatter/timeline and converges managed edges', async () => {
    await engine.putPage(
      'axiom-one',
      {
        type: 'infrastructure',
        title: 'Existing title',
        compiled_truth: '# Existing\n\nKeep this body byte-for-byte.',
        timeline: '2026-07-01: Existing timeline',
        frontmatter: {
          type: 'infrastructure',
          title: 'Existing title',
          owner: 'operator',
          aliases: ['legacy'],
          status: 'old',
          port: 9999,
          health_endpoint: 'http://127.0.0.1:9999/old',
        },
      },
      { sourceId: SOURCE_ID },
    );
    await engine.putPage(
      'axiom-stale',
      {
        type: 'infrastructure',
        title: 'Stale',
        compiled_truth: '# Stale',
        frontmatter: {},
      },
      { sourceId: SOURCE_ID },
    );
    await engine.addLink(
      'axiom-one',
      'axiom-stale',
      'old managed edge',
      'obsolete',
      LINK_SOURCE,
      undefined,
      undefined,
      { fromSourceId: SOURCE_ID, toSourceId: SOURCE_ID },
    );
    await engine.addLink(
      'axiom-one',
      'axiom-stale',
      'ordinary knowledge',
      'contains',
      'manual',
      undefined,
      undefined,
      { fromSourceId: SOURCE_ID, toSourceId: SOURCE_ID },
    );

    const receipt = await invoke(graph) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      source_id: SOURCE_ID,
      graph_sha256: createHash('sha256')
        .update(JSON.stringify(graph))
        .digest('hex'),
      components: 2,
      links: 1,
      pages_created: 1,
      pages_updated: 1,
      managed_links_removed: 1,
      verified_managed_edges: 1,
      committed_atomically: true,
    });

    const preserved = await engine.getPage('axiom-one', { sourceId: SOURCE_ID });
    expect(preserved).not.toBeNull();
    expect(preserved!.title).toBe('Existing title');
    expect(preserved!.compiled_truth).toBe('# Existing\n\nKeep this body byte-for-byte.');
    expect(preserved!.timeline).toBe('2026-07-01: Existing timeline');
    expect(preserved!.frontmatter.owner).toBe('operator');
    expect(preserved!.frontmatter.aliases).toEqual(['legacy', 'one']);
    expect(preserved!.frontmatter.status).toBe('active');
    expect(preserved!.frontmatter.port).toBe(1234);
    expect(preserved!.frontmatter.health_endpoint).toBeUndefined();

    const rows = await engine.executeRaw<{
      from_slug: string;
      to_slug: string;
      link_type: string;
      link_source: string;
      context: string;
    }>(
      `SELECT f.slug AS from_slug, t.slug AS to_slug, l.link_type,
              l.link_source, l.context
         FROM links l
         JOIN pages f ON f.id = l.from_page_id
         JOIN pages t ON t.id = l.to_page_id
        WHERE f.source_id = $1 AND t.source_id = $1
        ORDER BY l.link_source, f.slug, t.slug, l.link_type`,
      [SOURCE_ID],
    );
    expect(rows).toEqual([
      {
        from_slug: 'axiom-one',
        to_slug: 'axiom-two',
        link_type: 'depends-on',
        link_source: LINK_SOURCE,
        context:
          'axiom-managed-v1:{"impact":"must_inspect","strength":"critical"}',
      },
      {
        from_slug: 'axiom-one',
        to_slug: 'axiom-stale',
        link_type: 'contains',
        link_source: 'manual',
        context: 'ordinary knowledge',
      },
    ]);

    await invoke({
      ...graph,
      components: [
        {
          ...graph.components[0],
          aliases: ['renamed-one'],
        },
        graph.components[1],
      ],
    });
    const renamed = await engine.getPage('axiom-one', { sourceId: SOURCE_ID });
    expect(renamed!.frontmatter.aliases).toEqual(['legacy', 'renamed-one']);
    expect(renamed!.frontmatter.axiom_managed_aliases).toEqual(['renamed-one']);
  });

  test('never mutates identical slugs in a neighboring source', async () => {
    const otherSource = 'neighbor-source';
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ($1, $1, '{}'::jsonb)`,
      [otherSource],
    );
    for (const component of graph.components) {
      await engine.putPage(
        component.slug,
        {
          type: 'note',
          title: `Neighbor ${component.slug}`,
          compiled_truth: `# Neighbor\n\n${component.slug}`,
          timeline: 'unchanged',
          frontmatter: { owner: 'neighbor' },
        },
        { sourceId: otherSource },
      );
    }

    await invoke(graph);

    for (const component of graph.components) {
      const page = await engine.getPage(component.slug, {
        sourceId: otherSource,
      });
      expect(page!.compiled_truth).toBe(`# Neighbor\n\n${component.slug}`);
      expect(page!.timeline).toBe('unchanged');
      expect(page!.frontmatter).toEqual({ owner: 'neighbor' });
    }
  });

  test('refuses pre-existing managed provenance that crosses source boundaries', async () => {
    const otherSource = 'neighbor-source';
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ($1, $1, '{}'::jsonb)`,
      [otherSource],
    );
    await engine.putPage(
      'axiom-one',
      {
        type: 'infrastructure',
        title: 'Axiom one',
        compiled_truth: '# One',
        frontmatter: {},
      },
      { sourceId: SOURCE_ID },
    );
    await engine.putPage(
      'axiom-two',
      {
        type: 'note',
        title: 'Neighbor two',
        compiled_truth: '# Neighbor two',
        frontmatter: {},
      },
      { sourceId: otherSource },
    );
    await engine.addLink(
      'axiom-one',
      'axiom-two',
      'cross-source managed edge',
      'depends-on',
      LINK_SOURCE,
      undefined,
      undefined,
      { fromSourceId: SOURCE_ID, toSourceId: otherSource },
    );

    await expect(invoke(graph)).rejects.toThrow(/source boundary/);
    expect(
      await engine.getPage('axiom-two', { sourceId: otherSource }),
    ).toMatchObject({
      compiled_truth: '# Neighbor two',
    });
  });

  test('rolls back every page and edge when a mid-transaction link write fails', async () => {
    const rollbackGraph = {
      components: [
        ...graph.components,
        {
          slug: 'axiom-three',
          status: 'active',
          component_type: 'service',
          aliases: [],
        },
      ],
      links: [
        graph.links[0],
        {
          from_slug: 'axiom-two',
          to_slug: 'axiom-three',
          link_type: 'depends-on',
          strength: 'critical',
          impact: 'must_inspect',
        },
      ],
    };
    const failingEngine = {
      transaction: <T>(fn: (tx: BrainEngine) => Promise<T>): Promise<T> =>
        engine.transaction(async tx => {
          let linkWrites = 0;
          const faulting = new Proxy(tx as BrainEngine, {
            get(target, property) {
              if (property === 'addLink') {
                return async (...args: unknown[]) => {
                  linkWrites += 1;
                  if (linkWrites === 2) {
                    throw new Error('injected managed-link failure');
                  }
                  return (target.addLink as (...inner: unknown[]) => Promise<void>)(
                    ...args,
                  );
                };
              }
              const value = Reflect.get(target, property, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
          return fn(faulting);
        }),
    } as BrainEngine;

    await expect(
      invoke(rollbackGraph, context({}, failingEngine)),
    ).rejects.toThrow(/injected managed-link failure/);

    for (const component of rollbackGraph.components) {
      expect(
        await engine.getPage(component.slug, { sourceId: SOURCE_ID }),
      ).toBeNull();
    }
    const [{ count }] = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM links`,
    );
    expect(Number(count)).toBe(0);
  });
});
