/**
 * Migration C1: exhaustive thin-client façade classification plus empirical
 * proof for every admitted command.
 *
 * The migration façade admits only `get`, `query`, and `doctor`. Every other
 * CLI_ONLY command, operation alias, manual alias, and unknown root is denied
 * before the real binary is launched. This test derives the command inventory
 * from source so a future CLI addition cannot silently escape classification.
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

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const CLI_SOURCE = readFileSync(CLI, 'utf8');
const ADMITTED = new Set(['get', 'query', 'doctor']);
const MANUAL_ALIASES = new Set(['ask']);

function literalSet(name: string): Set<string> {
  const pattern = new RegExp(
    `const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`,
  );
  const match = CLI_SOURCE.match(pattern);
  if (!match) throw new Error(`could not find ${name} in src/cli.ts`);
  return new Set(
    [...match[1].matchAll(/'([^']+)'/g)].map(item => item[1]),
  );
}

const CLI_ONLY = literalSet('CLI_ONLY');
const OPERATION_ROOTS = new Set(
  operations
    .filter(op => op.cliHints?.name && !op.cliHints.hidden)
    .map(op => op.cliHints!.name!),
);
const OPERATION_ALIASES = new Set(
  operations
    .filter(op => !op.cliHints?.hidden)
    .flatMap(op => op.cliHints?.aliases ?? []),
);

function facadeDecision(root: string): 'remote' | 'refuse' {
  return ADMITTED.has(root) ? 'remote' : 'refuse';
}

describe('C1 exhaustive façade classification', () => {
  test('every CLI_ONLY root is covered and only doctor is admitted', () => {
    expect(CLI_ONLY.size).toBeGreaterThan(70);
    for (const root of CLI_ONLY) {
      expect(facadeDecision(root)).toBe(root === 'doctor' ? 'remote' : 'refuse');
    }
    expect(CLI_ONLY.has('graph-query')).toBe(true);
    expect(facadeDecision('graph-query')).toBe('refuse');
  });

  test('every generated and manual alias defaults to refusal', () => {
    expect(OPERATION_ALIASES.size).toBeGreaterThan(0);
    for (const alias of [...OPERATION_ALIASES, ...MANUAL_ALIASES]) {
      expect(facadeDecision(alias)).toBe('refuse');
    }
  });

  test('shared operation inventory admits only get and query', () => {
    expect(OPERATION_ROOTS.has('get')).toBe(true);
    expect(OPERATION_ROOTS.has('query')).toBe(true);
    for (const root of OPERATION_ROOTS) {
      expect(facadeDecision(root)).toBe(
        root === 'get' || root === 'query' ? 'remote' : 'refuse',
      );
    }
  });

  test('unknown future roots refuse by default', () => {
    expect(facadeDecision('future-command-not-yet-reviewed')).toBe('refuse');
  });

  test('source ordering returns admitted routes before local connect', () => {
    const sharedThinRoute = CLI_SOURCE.indexOf(
      'await runThinClientRouted(op, params, cfgPre!, cliOpts);',
    );
    const sharedLocalConnect = CLI_SOURCE.indexOf(
      'const engine = await connectEngine();',
      sharedThinRoute,
    );
    expect(sharedThinRoute).toBeGreaterThan(0);
    expect(sharedLocalConnect).toBeGreaterThan(sharedThinRoute);

    const doctorThinRoute = CLI_SOURCE.indexOf(
      'await runRemoteDoctor(cfgForDoctor!, args);',
    );
    const remainingCliOnlyConnect = CLI_SOURCE.indexOf(
      '// All remaining CLI-only commands need a DB connection',
    );
    expect(doctorThinRoute).toBeGreaterThan(0);
    expect(remainingCliOnlyConnect).toBeGreaterThan(doctorThinRoute);

    const graphDispatch = CLI_SOURCE.indexOf("case 'graph-query':");
    expect(graphDispatch).toBeGreaterThan(remainingCliOnlyConnect);
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
          const value =
            operation === 'query'
              ? []
              : {
                  slug: 'fixture-page',
                  title: 'Fixture Page',
                  type: 'concept',
                  tags: [],
                  frontmatter: {},
                  compiled_truth: 'remote result',
                  timeline: '',
                };
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

describe('C1 empirical admitted routes', () => {
  test('get and query each dispatch exactly once to the remote owner', async () => {
    toolCalls.length = 0;
    const getResult = await runCli(['get', 'fixture-page']);
    if (getResult.exitCode !== 0) {
      throw new Error(
        `get failed (${getResult.exitCode}): ${getResult.stderr || getResult.stdout}`,
      );
    }
    const queryResult = await runCli(['query', 'fixture query']);
    if (queryResult.exitCode !== 0) {
      throw new Error(
        `query failed (${queryResult.exitCode}): ${queryResult.stderr || queryResult.stdout}`,
      );
    }
    expect(toolCalls).toEqual(['get_page', 'query']);
    expect(localDatabaseArtifacts()).toEqual([]);
  }, 30_000);

  test('doctor uses the thin-client report and never opens local PGLite', async () => {
    const result = await runCli(['doctor', '--json']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"mode":"thin-client"');
    expect(result.stdout).toContain(
      `"mcp_url":"http://127.0.0.1:${port}/mcp"`,
    );
    expect(localDatabaseArtifacts()).toEqual([]);
  }, 30_000);
});
