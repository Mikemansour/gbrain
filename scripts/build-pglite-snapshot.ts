#!/usr/bin/env bun
// scripts/build-pglite-snapshot.ts
//
// Tier 3 fast-restore: boot a fresh PGLite, run the full initSchema (forward
// bootstrap + PGLITE_SCHEMA_SQL + every migration), dump the post-init state
// to a tar fixture. Test files that read GBRAIN_PGLITE_SNAPSHOT can skip the
// 1-3 seconds of cold init and load the post-schema state directly.
//
// Output: test/fixtures/pglite-snapshot.tar (binary, gitignored)
//         test/fixtures/pglite-snapshot.version (hex SHA256 of MIGRATIONS SQL)
//
// The version file lets the engine detect snapshot staleness — if the tar's
// recorded version doesn't match the current MIGRATIONS hash, the engine
// ignores the snapshot and runs a normal initSchema.
//
// Run: bun run scripts/build-pglite-snapshot.ts
//      (or: bun run build:pglite-snapshot)
//
// Re-run whenever you touch src/core/migrate.ts or src/schema.sql.

import { writeFileSync, mkdirSync, rmSync, copyFileSync, cpSync } from "node:fs";
import { dirname } from "node:path";
import * as crypto from "node:crypto";

import { PGLiteEngine, computeSnapshotSchemaHash } from "../src/core/pglite-engine.ts";
import { MIGRATIONS } from "../src/core/migrate.ts";
import { PGLITE_SCHEMA_SQL } from "../src/core/pglite-schema.ts";
import {
  DEFAULT_EMBEDDING_DIMENSIONS,
  DEFAULT_EMBEDDING_MODEL,
} from "../src/core/ai/defaults.ts";
import { configureGateway, resetGateway } from "../src/core/ai/gateway.ts";

function computeSchemaHash(model: string, dimensions: number): string {
  return computeSnapshotSchemaHash(
    MIGRATIONS,
    PGLITE_SCHEMA_SQL,
    crypto,
    dimensions,
    model,
  );
}

async function buildVariant(
  model: string,
  dimensions: number,
  catalogDir: string,
): Promise<{ hash: string; tarPath: string; versionPath: string; fixtureDir: string }> {
  const schemaHash = computeSchemaHash(model, dimensions);
  const tarPath = `${catalogDir}/${schemaHash}.tar`;
  const versionPath = `${catalogDir}/${schemaHash}.version`;
  const fixtureDir = `${catalogDir}/${schemaHash}.dir`;
  mkdirSync(fixtureDir, { recursive: true });

  console.log(`[build-pglite-snapshot] ${model}/${dimensions}d hash: ${schemaHash.slice(0, 16)}...`);
  const engine = new PGLiteEngine();
  configureGateway({ embedding_model: model, embedding_dimensions: dimensions, env: {} });

  await engine.connect({ database_path: fixtureDir, engine: "pglite" });
  console.log(`[build-pglite-snapshot] running initSchema (${MIGRATIONS.length} migrations)...`);
  const t0 = Date.now();
  await engine.initSchema();
  console.log(`[build-pglite-snapshot] initSchema completed in ${Date.now() - t0}ms`);

  const dump = await engine.db.dumpDataDir("none");
  const buffer = Buffer.from(await dump.arrayBuffer());
  writeFileSync(tarPath, buffer);
  writeFileSync(versionPath, schemaHash + "\n");
  await engine.disconnect();

  console.log(`[build-pglite-snapshot] wrote ${tarPath} (${buffer.length} bytes) + ${fixtureDir}`);
  return { hash: schemaHash, tarPath, versionPath, fixtureDir };
}

async function main() {
  const fixturePath = "test/fixtures/pglite-snapshot.tar";
  const versionPath = "test/fixtures/pglite-snapshot.version";
  const fixtureDir = "test/fixtures/pglite-snapshot-dir";
  const catalogDir = "test/fixtures/pglite-snapshot-catalog";
  mkdirSync(dirname(fixturePath), { recursive: true });
  rmSync(fixtureDir, { recursive: true, force: true });
  rmSync(catalogDir, { recursive: true, force: true });
  mkdirSync(catalogDir, { recursive: true });

  // Bypass the env-aware short-circuit: these are the authoritative builds.
  delete process.env.GBRAIN_PGLITE_SNAPSHOT;
  delete process.env.GBRAIN_PGLITE_SNAPSHOT_DIR;
  delete process.env.GBRAIN_PGLITE_SNAPSHOT_CATALOG;

  const defaultVariant = await buildVariant(
    DEFAULT_EMBEDDING_MODEL,
    DEFAULT_EMBEDDING_DIMENSIONS,
    catalogDir,
  );
  await buildVariant(
    "openai:text-embedding-3-large",
    1536,
    catalogDir,
  );
  resetGateway();

  // Preserve the legacy single-fixture paths for focused/local callers.
  copyFileSync(defaultVariant.tarPath, fixturePath);
  copyFileSync(defaultVariant.versionPath, versionPath);
  cpSync(defaultVariant.fixtureDir, fixtureDir, { recursive: true });
  console.log(`[build-pglite-snapshot] refreshed legacy default fixture paths`);
}

await main();
