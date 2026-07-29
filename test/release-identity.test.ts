import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  GBRAIN_RELEASE_EXECUTABLE,
  GBRAIN_RELEASE_MANIFEST,
  loadReleaseIdentity,
} from '../src/core/release-identity.ts';

const SHA = 'a'.repeat(40);
const CONTENT_DIGEST = 'b'.repeat(64);
const EXECUTABLE_CONTENT = '#!/bin/sh\n';
const EXECUTABLE_DIGEST = createHash('sha256')
  .update(EXECUTABLE_CONTENT)
  .digest('hex');
const roots: string[] = [];

function manifestPayload(overrides: Record<string, unknown> = {}) {
  return {
    release_sha: SHA,
    content_sha256: CONTENT_DIGEST,
    executable: GBRAIN_RELEASE_EXECUTABLE,
    executable_sha256: EXECUTABLE_DIGEST,
    ...overrides,
  };
}

function replaceManifest(manifest: string, payload: Record<string, unknown>): void {
  chmodSync(manifest, 0o644);
  writeFileSync(manifest, JSON.stringify(payload));
  chmodSync(manifest, 0o444);
}

function makeRelease(): { root: string; executable: string; manifest: string } {
  const parent = mkdtempSync(join(tmpdir(), 'gbrain-release-identity-'));
  roots.push(parent);
  const root = join(parent, SHA);
  const bin = join(root, 'bin');
  const executable = join(bin, 'gbrain');
  const manifest = join(root, GBRAIN_RELEASE_MANIFEST);
  mkdirSync(bin, { recursive: true });
  writeFileSync(executable, EXECUTABLE_CONTENT);
  chmodSync(executable, 0o555);
  writeFileSync(manifest, JSON.stringify(manifestPayload()));
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
      content_sha256: CONTENT_DIGEST,
      executable_sha256: EXECUTABLE_DIGEST,
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
    writeFileSync(outside, JSON.stringify(manifestPayload()));
    symlinkSync(outside, release.manifest);
    chmodSync(release.root, 0o555);
    expect(() => loadReleaseIdentity(SHA, release.executable)).toThrow();

    chmodSync(release.root, 0o755);
    rmSync(release.manifest);
    writeFileSync(release.manifest, JSON.stringify(manifestPayload({
      content_sha256: 'invalid',
    })));
    chmodSync(release.manifest, 0o444);
    chmodSync(release.root, 0o555);
    expect(() => loadReleaseIdentity(SHA, release.executable))
      .toThrow(/content digest/);
  });

  test('manifest executable path and digest are exact', () => {
    const release = makeRelease();
    replaceManifest(release.manifest, manifestPayload({
      executable: 'bin/gbrain-copy',
    }));
    expect(() => loadReleaseIdentity(SHA, release.executable))
      .toThrow(/manifest executable must be exactly bin\/gbrain/);

    replaceManifest(release.manifest, manifestPayload({
      executable_sha256: 'c'.repeat(64),
    }));
    expect(() => loadReleaseIdentity(SHA, release.executable))
      .toThrow(/digest does not match the process executable/);

    replaceManifest(release.manifest, manifestPayload({
      executable_sha256: 'invalid',
    }));
    expect(() => loadReleaseIdentity(SHA, release.executable))
      .toThrow(/manifest executable digest is invalid/);
  });

  test('executable content drift fails closed', () => {
    const release = makeRelease();
    chmodSync(release.executable, 0o755);
    writeFileSync(release.executable, `${EXECUTABLE_CONTENT}# drift\n`);
    chmodSync(release.executable, 0o555);
    expect(() => loadReleaseIdentity(SHA, release.executable))
      .toThrow(/digest does not match the process executable/);
  });

  test('writable executable paths and symlinked executables fail closed', () => {
    const writable = makeRelease();
    chmodSync(writable.executable, 0o755);
    expect(() => loadReleaseIdentity(SHA, writable.executable))
      .toThrow(/root-owned non-writable executable/);

    const writableBin = makeRelease();
    chmodSync(join(writableBin.root, 'bin'), 0o755);
    expect(() => loadReleaseIdentity(SHA, writableBin.executable))
      .toThrow(/executable directory must be a real root-owned read-only directory/);

    const linked = makeRelease();
    const outside = join(dirname(linked.root), 'outside-executable');
    writeFileSync(outside, EXECUTABLE_CONTENT);
    chmodSync(outside, 0o555);
    chmodSync(join(linked.root, 'bin'), 0o755);
    rmSync(linked.executable);
    symlinkSync(outside, linked.executable);
    chmodSync(join(linked.root, 'bin'), 0o555);
    expect(() => loadReleaseIdentity(SHA, linked.executable))
      .toThrow();

    const linkedBin = makeRelease();
    const bin = join(linkedBin.root, 'bin');
    const actualBin = join(linkedBin.root, 'actual-bin');
    chmodSync(linkedBin.root, 0o755);
    renameSync(bin, actualBin);
    symlinkSync(actualBin, bin);
    chmodSync(linkedBin.root, 0o555);
    expect(() => loadReleaseIdentity(SHA, linkedBin.executable))
      .toThrow(/executable directory must be a real root-owned read-only directory/);
  });
});
