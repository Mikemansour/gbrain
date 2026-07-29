import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  GBRAIN_RELEASE_MANIFEST,
  loadReleaseIdentity,
} from '../src/core/release-identity.ts';

const SHA = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);
const roots: string[] = [];

function makeRelease(): { root: string; executable: string; manifest: string } {
  const parent = mkdtempSync(join(tmpdir(), 'gbrain-release-identity-'));
  roots.push(parent);
  const root = join(parent, SHA);
  const bin = join(root, 'bin');
  const executable = join(bin, 'gbrain');
  const manifest = join(root, GBRAIN_RELEASE_MANIFEST);
  mkdirSync(bin, { recursive: true });
  writeFileSync(executable, '#!/bin/sh\n');
  chmodSync(executable, 0o555);
  writeFileSync(manifest, JSON.stringify({
    release_sha: SHA,
    content_sha256: DIGEST,
  }));
  chmodSync(manifest, 0o444);
  chmodSync(bin, 0o555);
  chmodSync(root, 0o555);
  return { root, executable, manifest };
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe('compiled GBrain release identity', () => {
  test('development mode has no asserted production identity', () => {
    expect(loadReleaseIdentity(undefined, process.execPath)).toBeNull();
  });

  test('identity is anchored to the sealed executable release', () => {
    const release = makeRelease();
    expect(loadReleaseIdentity(SHA, release.executable)).toEqual({
      release_sha: SHA,
      content_sha256: DIGEST,
      release_root: release.root,
    });
  });

  test('environment mismatch and writable roots fail closed', () => {
    const release = makeRelease();
    expect(() => loadReleaseIdentity('c'.repeat(40), release.executable))
      .toThrow(/expected release directory/);
    chmodSync(release.root, 0o755);
    expect(() => loadReleaseIdentity(SHA, release.executable))
      .toThrow(/read-only directory/);
  });

  test('manifest symlinks and digest drift fail closed', () => {
    const release = makeRelease();
    chmodSync(release.root, 0o755);
    rmSync(release.manifest);
    const outside = join(dirname(release.root), 'outside-manifest');
    writeFileSync(outside, JSON.stringify({
      release_sha: SHA,
      content_sha256: DIGEST,
    }));
    symlinkSync(outside, release.manifest);
    chmodSync(release.root, 0o555);
    expect(() => loadReleaseIdentity(SHA, release.executable)).toThrow();

    chmodSync(release.root, 0o755);
    rmSync(release.manifest);
    writeFileSync(release.manifest, JSON.stringify({
      release_sha: SHA,
      content_sha256: 'invalid',
    }));
    chmodSync(release.manifest, 0o444);
    chmodSync(release.root, 0o555);
    expect(() => loadReleaseIdentity(SHA, release.executable))
      .toThrow(/content digest/);
  });
});
