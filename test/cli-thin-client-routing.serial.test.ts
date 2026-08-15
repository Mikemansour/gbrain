/**
 * Thin-client routing proof for the production GBrain dispatch predicate and
 * the four read routes selected by the separately reviewed Axiom façade.
 *
 * GBrain itself routes every non-localOnly shared operation remotely and
 * refuses every localOnly operation. The Axiom wrapper narrows that larger
 * production surface to `get`, `query`, `graph-query` (rewritten to `graph`),
 * and `whoami`; its own exhaustive allowlist/refusal tests live in
 * axiom-infra. This file must not pretend that GBrain has the same allowlist.
 *
 * The admitted commands are also spawned against a hermetic loopback OAuth +
 * MCP fixture from a nested GBRAIN_HOME. Successful remote requests and a
 * clean local-artifact sweep prove that their thin-client branches return
 * before connectEngine().
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operations } from '../src/core/operations.ts';
import { thinClientOperationDisposition } from '../src/cli.ts';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const CLI_SOURCE = readFileSync(CLI, 'utf8');
describe('production thin-client operation classification', () => {
  test('classifies every shared operation through the predicate used by src/cli.ts', () => {
    expect(operations.length).toBeGreaterThan(80);
    for (const op of operations) {
      expect(thinClientOperationDisposition(op)).toBe(
        op.localOnly ? 'refuse' : 'remote',
      );
    }
  });

  test('the four Axiom-selected read routes are remote-capable in GBrain', () => {
    const byCliName = new Map(
      operations
        .filter(op => op.cliHints?.name)
        .map(op => [op.cliHints!.name!, op]),
    );
    for (const root of ['get', 'query', 'graph', 'whoami']) {
      const op = byCliName.get(root);
      expect(op).toBeDefined();
      expect(thinClientOperationDisposition(op!)).toBe('remote');
    }
  });

  test('production dispatch evaluates the predicate before local connect', () => {
    const predicateUse = CLI_SOURCE.indexOf(
      'thinClientOperationDisposition(op)',
    );
    const sharedThinRoute = CLI_SOURCE.indexOf(
      'await runThinClientRouted(op, params, cfgPre!, cliOpts);',
    );
    const sharedLocalConnect = CLI_SOURCE.indexOf(
      'const engine = await connectEngine();',
      sharedThinRoute,
    );
    expect(predicateUse).toBeGreaterThan(0);
    expect(sharedThinRoute).toBeGreaterThan(predicateUse);
    expect(sharedLocalConnect).toBeGreaterThan(sharedThinRoute);
  });
});

let server: Server;
let port = 0;
let root = '';
let operatorHome = '';
const toolCalls: string[] = [];

beforeAll(async () => {
  server = createServer(
    async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (req.url === '/.well-known/oauth-authorization-server') {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            issuer: `http://127.0.0.1:${port}`,
            token_endpoint: `http://127.0.0.1:${port}/token`,
          }),
        );
        return;
      }
      if (req.url === '/token') {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            access_token: 'fixture-token',
            token_type: 'bearer',
            expires_in: 300,
            scope: 'read',
          }),
        );
        return;
      }
      if (req.url === '/health') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      if (req.url === '/mcp' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (body.id === undefined) {
          res.statusCode = 202;
          res.end();
          return;
        }
        let result: unknown = {};
        if (body.method === 'initialize') {
          result = {
            protocolVersion: body.params?.protocolVersion ?? '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'c1-routing-fixture', version: '1' },
          };
        } else if (body.method === 'tools/call') {
          const operation = String(body.params?.name ?? '');
          toolCalls.push(operation);
          const value = operation === 'get_page'
            ? {
                slug: 'fixture-page',
                title: 'Fixture Page',
                type: 'concept',
                tags: [],
                frontmatter: {},
                compiled_truth: 'remote result',
                timeline: '',
              }
            : operation === 'whoami'
              ? {
                  transport: 'oauth',
                  client_id: 'fixture-client',
                  client_name: 'fixture-client',
                  scopes: ['read'],
                  source_id: 'axiom-polaris',
                  federated_read: ['axiom-polaris'],
                }
              : [];
          result = {
            content: [{ type: 'text', text: JSON.stringify(value) }],
          };
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
        return;
      }
      res.statusCode = 404;
      res.end();
    },
  );
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('failed to bind C1 fixture');
  }
  port = address.port;

  root = mkdtempSync(join(tmpdir(), 'gbrain-c1-routing-'));
  operatorHome = join(root, 'nested', 'operator');
  mkdirSync(join(operatorHome, '.gbrain'), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(operatorHome, '.gbrain', 'config.json'),
    JSON.stringify({
      remote_mcp: {
        issuer_url: `http://127.0.0.1:${port}`,
        mcp_url: `http://127.0.0.1:${port}/mcp`,
        oauth_client_id: 'fixture-client',
      },
    }),
    { mode: 0o600 },
  );
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[]): Promise<RunResult> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.NODE_ENV = 'test';
  env.GBRAIN_HOME = operatorHome;
  env.HOME = join(root, 'unrelated-home');
  env.GBRAIN_REMOTE_CLIENT_SECRET = 'fixture-secret';
  env.GBRAIN_DOCTOR_SKIP_SCOPE_PROBE = '1';
  env.GBRAIN_NO_BANNER = '1';
  env.GBRAIN_SKIP_STARTUP_HOOKS = '1';
  delete env.DATABASE_URL;
  delete env.GBRAIN_DATABASE_URL;

  const proc = Bun.spawn({
    cmd: ['bun', 'run', CLI, ...args],
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function localDatabaseArtifacts(): string[] {
  const gbrainDir = join(operatorHome, '.gbrain');
  return readdirSync(gbrainDir).filter(name =>
    name !== 'config.json' &&
    (
      name.includes('pglite') ||
      name.includes('gbrain-lock') ||
      name.endsWith('-wal') ||
      name.endsWith('.wal')
    ),
  );
}

describe('C1 empirical remote-capable routes', () => {
  test('every admitted route dispatches exactly once to the remote owner', async () => {
    toolCalls.length = 0;
    const commands = [
      ['get', 'fixture-page'],
      ['query', 'fixture query'],
      ['graph', 'axiom-gbrain-http', '--depth', '2', '--direction', 'both'],
      ['whoami'],
    ];
    for (const args of commands) {
      const result = await runCli(args);
      if (result.exitCode !== 0) {
        throw new Error(
          `${args[0]} failed (${result.exitCode}): ${result.stderr || result.stdout}`,
        );
      }
    }
    expect(toolCalls).toEqual(['get_page', 'query', 'traverse_graph', 'whoami']);
    expect(localDatabaseArtifacts()).toEqual([]);
  }, 30_000);

  test('doctor remote proof remains available for future façade review', async () => {
    const result = await runCli(['doctor', '--json']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"mode":"thin-client"');
    expect(result.stdout).toContain(
      `"mcp_url":"http://127.0.0.1:${port}/mcp"`,
    );
    expect(localDatabaseArtifacts()).toEqual([]);
  }, 30_000);
});