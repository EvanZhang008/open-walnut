/**
 * The restore drill's boot check: the restored copy started once as a real server, then stopped.
 *
 * After the restore and the file and database checks (restore-drill.ts), the drill starts the
 * full server program on the copy as a child process, in the boot policy's trial column
 * (src/core/boot-policy.ts; entered only through the ticket of src/core/trial-start/ticket.ts):
 * HTTP, the databases and their migrations, nothing that acts, every outward door closed. It
 * listens on loopback, on a port the OS picks (never 3456). Through it the drill reads back the
 * newest task and a note, exactly as the restored files hold them (the same read-back the leader
 * switch's trial does, src/core/trial-start/read-back.ts), stops it, and checks every database
 * again after the boot's migrations.
 *
 * Kept apart from everything live: its data home is the copy (its own instance lock,
 * server.lock.json, is there), and its user home, XDG folders, temp dir, session daemon folder
 * and task folders are all inside the drill's folder, removed with it. Paths in the copy's
 * config.yaml that name the live data home are pointed at the copy first, as a restore in place
 * would have them. A drill killed mid-boot leaves a server that stops by itself (its parent is
 * gone, commands/web-trial.ts); the next drill removes the folder.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { ephemeralChildEnv } from '../../commands/ephemeral-snapshot.js';
import { TRIAL_SERVER_FILE, type TrialServerInfo } from '../../commands/web-trial.js';
import { inspectSqliteOffThread } from '../../lib/sqlite.js';
import { pickReadBackNote, readBackThroughServer } from '../trial-start/read-back.js';
import { TRIAL_NONCE_ENV, TRIAL_START_FLAG, writeTrialTicket } from '../trial-start/ticket.js';
import { alive, serverCommand, stopPid, tail } from '../trial-start/process.js';
import { capProblems, type DrillCheck } from './restore-drill-checks.js';

/** How long the copy may take to boot (migrations of a large home take a while). */
export const BOOT_TIMEOUT_MS = 180_000;
/** How long it may take to stop before it is killed. */
const STOP_GRACE_MS = 15_000;
/** The production Walnut's port: the trial server never listens on it. */
const PRODUCTION_PORT = 3456;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Environment variables a trial server must not inherit: each would make it some other kind of server. */
const DROPPED_ENV = [
  'WALNUT_LEADER_TRIAL', 'WALNUT_LEADER_SWITCH_COMMIT', 'WALNUT_ROLE', 'WALNUT_HOST_SERVER', 'WALNUT_HOST_SERVER_PORT',
  'WALNUT_CLOUD_MODE', 'WALNUT_BIND_ADDRESS', 'OPEN_WALNUT_EXIT_ON_ORPHAN', 'WALNUT_TERMINAL_SESSION_ID',
];

/** The child's env: the copy as its home, and every other place it may write inside `sandbox`. */
export function trialChildEnv(base: NodeJS.ProcessEnv, home: string, sandbox: string, nonce: string): NodeJS.ProcessEnv {
  const env = ephemeralChildEnv(base, home, path.join(sandbox, 'daemon'));
  for (const k of DROPPED_ENV) delete env[k];
  // Opt-ins of an ephemeral server (a leader switch, backups, a standby copy) are not the drill's.
  for (const k of Object.keys(env)) if (k.startsWith('WALNUT_EPHEMERAL_')) delete env[k];
  Object.assign(env, {
    HOME: path.join(sandbox, 'user-home'),
    XDG_STATE_HOME: path.join(sandbox, 'xdg', 'state'),
    XDG_CONFIG_HOME: path.join(sandbox, 'xdg', 'config'),
    XDG_CACHE_HOME: path.join(sandbox, 'xdg', 'cache'),
    XDG_DATA_HOME: path.join(sandbox, 'xdg', 'data'),
    TMPDIR: path.join(sandbox, 'tmp'), TMP: path.join(sandbox, 'tmp'), TEMP: path.join(sandbox, 'tmp'),
    [TRIAL_NONCE_ENV]: nonce,
  });
  return env;
}

/**
 * Point every string in the copy's config.yaml that names the live data home at the copy.
 * Returns how many it changed (0: the file is left as it is).
 */
export async function pointConfigAtCopy(home: string, liveHomes: readonly string[]): Promise<number> {
  const file = path.join(home, 'config.yaml');
  let cfg: unknown;
  try { cfg = YAML.parse(await fsp.readFile(file, 'utf8')); } catch { return 0; }
  const roots = [...new Set(liveHomes.map((h) => path.resolve(h)))];
  let changed = 0;
  const fix = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const root = roots.find((r) => v === r || v.startsWith(r + path.sep));
      if (!root) return v;
      changed++;
      return home + v.slice(root.length);
    }
    if (Array.isArray(v)) return v.map(fix);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fix(x)]));
    return v;
  };
  const next = fix(cfg);
  if (changed) await fsp.writeFile(file, YAML.stringify(next), { mode: 0o600 });
  return changed;
}

export interface BootCheckInput {
  /** The drill's folder; the copy is its `home/`. */
  dir: string;
  target: string;
  /** The live data home (paths into it in the copy's config are pointed at the copy). */
  dataDir: string;
  /** The restored files, home-relative. */
  files: readonly string[];
  /** The newest task, as the restored database holds it. */
  task: { id: string; title: string } | null;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Tests: the server's pid, once it answers as the trial it must be (the kill test stops the drill here). */
  onServer?: (pid: number) => void | Promise<void>;
}

export interface BootTimings {
  /** Spawn to answering. */
  startMs: number;
  /** The server's own boot, startServer to listening. */
  serverBootMs?: number;
  readBackMs?: number;
  stopMs?: number;
  totalMs: number;
}

export async function checkTrialBoot(input: BootCheckInput): Promise<DrillCheck> {
  const t0 = Date.now();
  const timings: BootTimings = { startMs: 0, totalMs: 0 };
  const problems: string[] = [];
  const sandbox = path.join(input.dir, 'boot');
  for (const d of ['user-home', 'xdg/state', 'xdg/config', 'xdg/cache', 'xdg/data', 'tmp', 'daemon']) {
    await fsp.mkdir(path.join(sandbox, d), { recursive: true, mode: 0o700 });
  }
  const logFile = path.join(sandbox, 'server.log');
  const fail = (why: string, extra: string[] = []): DrillCheck => {
    timings.totalMs = Date.now() - t0;
    const logTail = tail(logFile, 1_500).trim();
    return {
      id: 'boot', ok: false, detail: why, timings: { ...timings },
      problems: capProblems([...problems, ...extra, ...(logTail ? [`server log, last lines: ${logTail}`] : [])]),
    };
  };

  const rewritten = await pointConfigAtCopy(input.target, [input.dataDir, await fsp.realpath(input.dataDir).catch(() => input.dataDir)]);
  const nonce = writeTrialTicket(input.target, 'restore-drill');
  const cmd = serverCommand(['web', TRIAL_START_FLAG, '--_ephemeral-child']);
  const out = fs.openSync(logFile, 'a', 0o600);
  let exited: { code: number | null; signal: string | null } | null = null;
  let child;
  try {
    child = spawn(cmd[0], cmd.slice(1), { env: trialChildEnv(input.env ?? process.env, input.target, sandbox, nonce), stdio: ['ignore', out, out], cwd: sandbox });
  } catch (err) {
    fs.closeSync(out);
    return fail(`The trial server did not start: ${message(err)}`);
  }
  fs.closeSync(out);
  const exitedNow = new Promise<void>((resolve) => {
    child.on('exit', (code, signal) => { exited = { code, signal }; resolve(); });
    child.on('error', (err) => { problems.push(`spawn: ${message(err)}`); exited ??= { code: null, signal: null }; resolve(); });
  });
  const pid = child.pid ?? 0;
  const stop = async (): Promise<{ killed: boolean }> => {
    const s0 = Date.now();
    const r = exited || !alive(pid) ? { killed: false } : await stopPid(pid, STOP_GRACE_MS);
    await Promise.race([exitedNow, sleep(2_000)]);
    timings.stopMs = Date.now() - s0;
    return r;
  };

  try {
    // Up: it wrote where it listens. Down: it exited, or the time ran out.
    const infoFile = path.join(input.target, TRIAL_SERVER_FILE);
    const deadline = t0 + (input.timeoutMs ?? BOOT_TIMEOUT_MS);
    let info: TrialServerInfo | null = null;
    while (!info) {
      if (exited) {
        const e = exited as { code: number | null; signal: string | null };
        return fail(`The restored copy did not boot: the trial server exited during its start (${e.signal ?? `code ${e.code}`})`);
      }
      if (Date.now() > deadline) {
        await stop();
        return fail(`The restored copy did not boot within ${Math.round((input.timeoutMs ?? BOOT_TIMEOUT_MS) / 1000)} s (stopped)`);
      }
      try {
        const got = JSON.parse(await fsp.readFile(infoFile, 'utf8')) as TrialServerInfo;
        if (got.pid === pid) info = got;
      } catch { /* not yet */ }
      if (!info) await sleep(200);
    }
    timings.startMs = Date.now() - t0;
    timings.serverBootMs = info.bootMs;
    // It must be the trial it was started as, or it is stopped before anyone asks it anything.
    const wrong: string[] = [];
    if (info.bootMode !== 'trial' || info.purpose !== 'restore-drill') wrong.push(`it booted as ${info.bootMode}${info.purpose ? ` (${info.purpose})` : ''}, not as the restore drill's trial`);
    if (!info.doorsClosed) wrong.push('its outward doors are not closed');
    if (!(info.port > 0) || info.port === PRODUCTION_PORT) wrong.push(`it listens on port ${info.port}`);
    if (wrong.length) {
      await stop();
      return fail('The trial server was not isolated as it must be, so it was stopped at once', wrong);
    }
    await input.onServer?.(pid);

    const r0 = Date.now();
    const note = pickReadBackNote(input.files);
    const want = {
      task: input.task,
      note: note ? { ...note, content: await fsp.readFile(path.join(input.target, note.rel), 'utf8') } : null,
    };
    const api = async (method: 'GET', urlPath: string) => {
      const res = await fetch(`http://127.0.0.1:${info!.port}${urlPath}`, { method, signal: AbortSignal.timeout(15_000) });
      return { status: res.status, json: await res.json().catch(() => null) };
    };
    const back = await readBackThroughServer(api, want);
    timings.readBackMs = Date.now() - r0;
    problems.push(...back.problems);

    const { killed } = await stop();
    if (killed) problems.push(`it did not stop within ${STOP_GRACE_MS / 1000} s of SIGTERM and was killed`);
    else if (exited && (exited as { code: number | null }).code !== 0) problems.push(`it stopped with ${(exited as { signal: string | null }).signal ?? `code ${(exited as { code: number | null }).code}`}`);

    // The boot ran the migrations: every database must still pass.
    const dbs = input.files.filter((p) => p.endsWith('.sqlite')).sort();
    let passed = 0;
    for (const rel of dbs) {
      const r = await inspectSqliteOffThread(path.join(input.target, rel));
      if (r.ok) passed++;
      else problems.push(`${rel}: ${r.detail ?? 'integrity check failed'} after the boot`);
    }

    timings.totalMs = Date.now() - t0;
    const parts = [
      `Booted the restored copy as a trial server (pid ${pid}, 127.0.0.1:${info.port}, every outward door closed) in ${(timings.startMs / 1000).toFixed(1)} s`,
      back.read.length ? `read back ${back.read.join(' and ')}` : 'nothing to read back (no task, no note)',
      `stopped in ${((timings.stopMs ?? 0) / 1000).toFixed(1)} s`,
      `${passed} of ${dbs.length} databases pass integrity_check after its migrations`,
      ...(rewritten ? [`${rewritten} path(s) in its config.yaml that named the live data home were pointed at the copy first`] : []),
    ];
    return { id: 'boot', ok: problems.length === 0, detail: parts.join('; '), timings: { ...timings }, ...(problems.length ? { problems: capProblems(problems) } : {}) };
  } catch (err) {
    await stop().catch(() => {});
    return fail(`The boot check broke off: ${message(err)}`);
  } finally {
    if (!exited && alive(pid)) await stopPid(pid, STOP_GRACE_MS).catch(() => {});
  }
}
