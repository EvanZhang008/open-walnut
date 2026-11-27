/**
 * The strip gate of the prompt split (release B): when may this build move the session prompts out
 * of their payloads (session-prompts.ts says what the split is)?
 *
 * A build before the split (release A, b7ef669d75) reads a prompt only from the payload: on a
 * stripped row it resumes a lane without its persona and a fork without its parent's prompt, and
 * nothing refuses it. So the texts leave the payload, by the strip pass and by every later write,
 * only once each build this home can go back to reads the split:
 *
 *   - A deploy on this machine (scripts/dev-prod.sh): its rollbacks start the last-known-good file
 *     and the service launcher's good version (scripts/lib/devprod-launcher.sh). Each is asked the
 *     store-format probe (store-format-probe.ts); every one must answer.
 *   - Elsewhere (npm, the install script's file): going back is to the release before this one. A
 *     build from this one on records its version in the store once it served it; a recorded version
 *     past LAST_RELEASE_WITHOUT_SPLIT and older than this one is a release before this one that
 *     reads the split, so the release just before this one does too. A build of main between two
 *     releases reports the last one (package.json changes only at a release), so a recorded
 *     LAST_RELEASE_WITHOUT_SPLIT proves nothing: the published one of that number cannot read it.
 *     The first release that holds this code therefore never strips: the one before it may be
 *     from before the split. And rows a build before the split wrote since the last open (a person
 *     went back to it) keep the gate closed and start the list again (session-prompt-jobs.ts).
 *
 * It is asked once per open of the store, past the boot burst (session-prompt-jobs.ts). Until it
 * answers, a write keeps each prompt where it is (a stripped one stays stripped); closed, the writer
 * keeps release A's shape (texts and stubs), which every build reads (session-db.ts promptPayloadMode).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Database as DatabaseType } from '../lib/sqlite.js';
import { compareVersions, parseVersion } from './self-update/version-compare.js';
import { getVersion, isVersionKnown } from './version.js';
import { buildReadsPromptSplit } from './store-format-probe.js';

/** The last published release whose build cannot read the split (release A landed after it). */
export const LAST_RELEASE_WITHOUT_SPLIT = '0.6.37';

export interface PromptGate { open: boolean; reason: string; builds?: string[]; olderVersion?: string }

/** This machine's file name in a deploy's dist-bin/ (dev-prod.sh self_target). */
function machineFiles(): string[] {
  const osName = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : null;
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null;
  if (!osName || !arch) return [];
  return [`walnut-${osName}-${arch}`, ...(osName === 'linux' ? [`walnut-${osName}-${arch}-musl`] : [])];
}

function firstFile(dir: string): string | null {
  for (const name of machineFiles()) {
    const file = path.join(dir, 'dist-bin', name);
    try { if (fs.statSync(file).isFile()) return file; } catch { /* not this one */ }
  }
  return null;
}

/**
 * The builds a rollback on this machine starts, as the deploy keeps them: the last-known-good file
 * (dev-prod.sh lkg_file: WALNUT_DEVPROD_LKG_DIR, else the state dir, else the old temp location) and
 * the launcher's good version (`good=<version dir>/run` in its state file; the version dir holds the
 * same dist-bin/ as the stage it was cloned from). None on a machine that never ran the deploy.
 */
export function deployRollbackBuilds(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  const state = env.XDG_STATE_HOME || path.join(home, '.local/state');
  const out: string[] = [];
  const lkg = firstFile(env.WALNUT_DEVPROD_LKG_DIR || path.join(state, 'open-walnut/open-walnut-lkg'))
    ?? (env.WALNUT_DEVPROD_LKG_DIR ? null : firstFile(path.join(env.TMPDIR || '/tmp', 'open-walnut-lkg')));
  if (lkg) out.push(lkg);
  const serviceDir = env.WALNUT_DEVPROD_SERVICE_DIR || path.join(state, 'open-walnut/service');
  let launcher = '';
  try { launcher = fs.readFileSync(path.join(serviceDir, 'launcher/state'), 'utf8'); } catch { /* no launcher here */ }
  const good = /^good=(.+)$/m.exec(launcher)?.[1]?.trim();
  if (good && path.isAbsolute(good)) {
    const file = firstFile(path.dirname(good));
    // A good version whose files are gone cannot be asked: it is still one a put-back may start.
    out.push(file ?? path.join(path.dirname(good), 'dist-bin', machineFiles()[0] ?? 'walnut'));
  }
  return [...new Set(out)];
}

const VERSIONS_TABLE = 'CREATE TABLE IF NOT EXISTS session_store_versions (version TEXT PRIMARY KEY, first_at TEXT NOT NULL, last_at TEXT NOT NULL)';

/** Record that this release served the store (a build before this code records nothing). */
export function noteServedVersion(handle: DatabaseType, version: string, now = new Date().toISOString()): void {
  if (!parseVersion(version)) return;
  handle.exec(VERSIONS_TABLE);
  handle.prepare('INSERT INTO session_store_versions (version, first_at, last_at) VALUES (?, ?, ?) ON CONFLICT(version) DO UPDATE SET last_at = excluded.last_at')
    .run(version, now, now);
}

/** Forget every recorded release (a build before the split served the store since: session-prompt-jobs.ts). */
export function forgetServedVersions(handle: DatabaseType): void {
  handle.exec(VERSIONS_TABLE);
  handle.exec('DELETE FROM session_store_versions');
}

/** The releases that recorded serving the store. */
export function servedVersions(handle: DatabaseType): string[] {
  const has = handle.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_store_versions'").get();
  return has ? handle.prepare('SELECT version FROM session_store_versions').pluck().all() as string[] : [];
}

/** This release's version, when it knows one. */
export function ownVersion(): string | null {
  return isVersionKnown() ? getVersion() : null;
}

/**
 * Is the gate open for `handle`'s store? `rollbackBuilds` and `version` default to this machine's
 * and this build's; `reads` is the probe (tests pass a fake).
 */
export async function promptStripGate(handle: DatabaseType, opts: {
  rollbackBuilds?: string[]; version?: string | null; reads?: (file: string) => Promise<boolean>;
} = {}): Promise<PromptGate> {
  const builds = opts.rollbackBuilds ?? deployRollbackBuilds();
  if (builds.length > 0) {
    const reads = opts.reads ?? ((file: string) => buildReadsPromptSplit(file));
    for (const file of builds) {
      if (!(await reads(file))) return { open: false, reason: `the rollback build ${file} does not read the prompt split`, builds };
    }
    return { open: true, reason: 'every build a rollback here starts reads the prompt split', builds };
  }
  const version = opts.version === undefined ? ownVersion() : opts.version;
  if (!version || !parseVersion(version)) return { open: false, reason: 'this build does not know its version' };
  const older = servedVersions(handle)
    .filter((v) => (compareVersions(v, version) ?? 0) < 0 && (compareVersions(v, LAST_RELEASE_WITHOUT_SPLIT) ?? 0) > 0)
    .sort((a, b) => compareVersions(a, b) ?? 0);
  const olderVersion = older[older.length - 1];
  if (olderVersion) return { open: true, reason: `release ${olderVersion}, which reads the prompt split, served this store before ${version}`, olderVersion };
  return { open: false, reason: `no release before ${version} that reads the prompt split served this store: the release before it may be one that does not` };
}
