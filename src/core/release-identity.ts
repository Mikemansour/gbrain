import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const MAX_MANIFEST_BYTES = 16 * 1024;
export const GBRAIN_RELEASE_MANIFEST = 'GBRAIN_RELEASE.json';
export const GBRAIN_RELEASE_EXECUTABLE = 'bin/gbrain';

export interface GBrainReleaseIdentity {
  release_sha: string;
  content_sha256: string;
  executable_sha256: string;
  release_root: string;
}

function fail(message: string): never {
  throw new Error(`GBrain release identity refused: ${message}`);
}

/**
 * Load production identity from the sealed manifest adjacent to the compiled
 * executable. The environment is only an expected value; it can never select
 * a release or supply identity. Source-mode development remains unchanged
 * when GBRAIN_EXPECTED_RELEASE_SHA is absent.
 */
export function loadReleaseIdentity(
  expectedSha: string | undefined = process.env.GBRAIN_EXPECTED_RELEASE_SHA,
  executablePath: string = process.execPath,
): GBrainReleaseIdentity | null {
  if (expectedSha === undefined) return null;
  if (!SHA_RE.test(expectedSha)) fail('expected SHA is invalid');

  const executable = resolve(executablePath);
  const releaseRoot = dirname(dirname(executable));
  if (basename(releaseRoot) !== expectedSha) {
    fail('executable is not rooted in the expected release directory');
  }
  const rootStat = lstatSync(releaseRoot);
  if (
    !rootStat.isDirectory()
    || rootStat.isSymbolicLink()
    || rootStat.uid !== 0
    || (rootStat.mode & 0o222) !== 0
  ) {
    fail('release root must be a real root-owned read-only directory');
  }

  const manifestPath = join(releaseRoot, GBRAIN_RELEASE_MANIFEST);
  const platformFlags = constants as unknown as Record<string, number>;
  const fd = openSync(
    manifestPath,
    constants.O_RDONLY
      | (platformFlags.O_CLOEXEC ?? 0)
      | (platformFlags.O_NOFOLLOW ?? 0),
  );
  let raw: string;
  try {
    const manifestStat = fstatSync(fd);
    if (
      !manifestStat.isFile()
      || manifestStat.uid !== 0
      || (manifestStat.mode & 0o222) !== 0
      || manifestStat.size > MAX_MANIFEST_BYTES
    ) {
      fail('manifest must be a bounded root-owned read-only regular file');
    }
    raw = readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }

  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail('manifest must be a JSON object');
    }
    payload = parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('GBrain release identity refused:')) {
      throw error;
    }
    fail('manifest is not valid JSON');
  }
  if (payload.release_sha !== expectedSha) fail('manifest SHA does not match');
  if (
    typeof payload.content_sha256 !== 'string'
    || !DIGEST_RE.test(payload.content_sha256)
  ) {
    fail('manifest content digest is invalid');
  }
  if (payload.executable !== GBRAIN_RELEASE_EXECUTABLE) {
    fail(`manifest executable must be exactly ${GBRAIN_RELEASE_EXECUTABLE}`);
  }
  if (join(releaseRoot, payload.executable) !== executable) {
    fail('process executable does not match the manifest executable');
  }
  if (
    typeof payload.executable_sha256 !== 'string'
    || !DIGEST_RE.test(payload.executable_sha256)
  ) {
    fail('manifest executable digest is invalid');
  }

  const executableDirStat = lstatSync(dirname(executable));
  if (
    !executableDirStat.isDirectory()
    || executableDirStat.isSymbolicLink()
    || executableDirStat.uid !== 0
    || (executableDirStat.mode & 0o222) !== 0
  ) {
    fail('process executable directory must be a real root-owned read-only directory');
  }

  const executableLstat = lstatSync(executable);
  if (
    !executableLstat.isFile()
    || executableLstat.isSymbolicLink()
    || executableLstat.uid !== 0
    || (executableLstat.mode & 0o222) !== 0
    || (executableLstat.mode & 0o111) === 0
  ) {
    fail('process executable must be a regular root-owned non-writable executable');
  }

  const executableFd = openSync(
    executable,
    constants.O_RDONLY
      | (platformFlags.O_CLOEXEC ?? 0)
      | (platformFlags.O_NOFOLLOW ?? 0),
  );
  let executableDigest: string;
  try {
    const executableStat = fstatSync(executableFd);
    if (
      !executableStat.isFile()
      || executableStat.uid !== 0
      || (executableStat.mode & 0o222) !== 0
      || (executableStat.mode & 0o111) === 0
      || executableStat.dev !== executableLstat.dev
      || executableStat.ino !== executableLstat.ino
    ) {
      fail('process executable must be a stable root-owned non-writable regular file');
    }
    executableDigest = createHash('sha256')
      .update(readFileSync(executableFd))
      .digest('hex');
  } finally {
    closeSync(executableFd);
  }
  if (executableDigest !== payload.executable_sha256) {
    fail('manifest executable digest does not match the process executable');
  }

  return Object.freeze({
    release_sha: expectedSha,
    content_sha256: payload.content_sha256,
    executable_sha256: executableDigest,
    release_root: releaseRoot,
  });
}
