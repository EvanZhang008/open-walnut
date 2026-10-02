/**
 * The ONE way Walnut reads a file macOS keeps behind Full Disk Access.
 *
 * Full Disk Access has no API and no dialog: a program either has it or gets a bare
 * "Operation not permitted", and the only grant is a human adding the program in
 * System Settings. So WHICH program does the reading decides what the user has to
 * add, and every feature that needs a protected file goes through here so that it
 * is always the same one.
 *
 * Two routes, both running src/data/walnut-reader.swift:
 *
 *   Walnut.app   `Walnut --reader-bridge read|probe <path>`. Preferred. Sessions
 *                already run as Walnut (`Walnut --session-host`), so this is the SAME
 *                grant that stops the "would like to access data from other apps"
 *                popups there: one row in System Settings, Walnut, for everything.
 *   helper       the standalone `walnut-reader`, compiled into WALNUT_HOME/cache, for
 *                installs with no Walnut.app (or one too old to know the flag).
 *
 * The move from the helper to Walnut must not take anything away: a user who granted
 * the helper long ago would otherwise see Screen Time go dark the moment Walnut.app
 * learned the flag. So while Walnut is refused, a helper that is ALREADY BUILT and
 * still answers is used instead (the stand-in), and Walnut is asked again once a
 * minute, so a grant takes over on its own. Only an existing helper: compiling one
 * just to ask it would mint a new program nobody granted.
 *
 * Nothing here can put a dialog on screen (Full Disk Access never prompts), but the
 * app route still obeys nativeHelpersAllowed(): a test server would otherwise run
 * the user's real Walnut.app against the user's real files.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CLOUD_MODE, WALNUT_HOME } from '../constants.js';
import { log } from '../logging/index.js';
import { findDesktopAppWith } from '../providers/desktop-app.js';
import {
  ensureHelper,
  existingHelperBinary,
  helperFailure,
  nativeHelpersAllowed,
  type HelperSpec,
  type HelperUnavailable,
} from './helper-build.js';

/** Must match desktop/ReaderBridge.swift (a test reads both). */
export const READER_BRIDGE_FLAG = '--reader-bridge';

export const READER_SPEC: HelperSpec = {
  name: 'walnut-reader',
  /** Bumped only if walnut-reader.swift changes in behavior, which it is designed never to do. */
  version: 'v1',
  /** Version-free on purpose: a certificate-signed grant is remembered against this
   *  string, so it must not move when the version does. */
  identifier: 'dev.openwalnut.reader',
  // The source's entry point is `@main`, because Walnut.app compiles the same file.
  parseAsLibrary: true,
};

/** walnut-reader's exit codes (src/data/walnut-reader.swift). */
export const EXIT_BAD_INPUT = 2;
export const EXIT_NO_PERMISSION = 3;

/** One read: a multi-megabyte database copy fits easily. */
const READ_TIMEOUT_MS = 60_000;
/** More than this from one file is a sign we are pointed at the wrong thing. */
export const MAX_READ_BYTES = 256 * 1024 * 1024;
/** How often a refused Walnut is asked again while the stand-in answers. */
const APP_RETRY_MS = 60_000;

export interface ReaderRoute {
  kind: 'app' | 'helper';
  /** `[program, ...leading args]`: `[helper]` or `[Walnut, '--reader-bridge']`. */
  cmd: readonly string[];
  /** What the user adds in System Settings → Full Disk Access: the app BUNDLE for
   *  the app route (that is what the file picker selects), the binary otherwise. */
  grantTarget: string;
}

/**
 * Where a protected read goes right now, or null when it cannot happen on this box
 * (see readerUnavailable()). Resolving the helper route may compile it once.
 */
export async function readerRoute(): Promise<ReaderRoute | null> {
  if (process.platform === 'darwin' && !CLOUD_MODE && nativeHelpersAllowed()) {
    const found = await findDesktopAppWith(READER_BRIDGE_FLAG);
    if (found) return { kind: 'app', cmd: [found.executable, READER_BRIDGE_FLAG], grantTarget: found.app };
  }
  const bin = await ensureHelper(READER_SPEC, 'walnut-reader.swift');
  return bin ? { kind: 'helper', cmd: [bin], grantTarget: bin } : null;
}

/**
 * The Walnut.app that reads protected files here, or null when the helper does (or
 * nothing can). Never builds anything, so a report that only needs the NAME of the
 * program to grant does not pay a first-run compile.
 */
export async function readerGrantApp(): Promise<string | null> {
  if (process.platform !== 'darwin' || CLOUD_MODE || !nativeHelpersAllowed()) return null;
  return (await findDesktopAppWith(READER_BRIDGE_FLAG))?.app ?? null;
}

/** Why readerRoute() answered null. */
export function readerUnavailable(): HelperUnavailable {
  return helperFailure(READER_SPEC.name) ?? 'not_macos';
}

// ── the stand-in ────────────────────────────────────────────────────────────

let standIn: string | null = null;
let lastAppAsk = 0;

/** The helper answering while Walnut is refused, for status and UI; null when
 *  Walnut itself (or the helper as the only route) is answering. */
export function readerStandIn(): string | null {
  return standIn;
}

/** Tests, and a WALNUT_HOME swap. */
export function resetProtectedReader(): void {
  standIn = null;
  lastAppAsk = 0;
}

// ── "has this route ever worked here" ───────────────────────────────────────

/**
 * Whether a route has completed a read on this machine before. A denial after a
 * success is a STALE grant (the program changed under its row, which needs remove
 * + re-add), and a denial with no success is a missing one (add it). The TCC
 * database cannot be read to tell them apart, so this is how.
 *
 * One marker per route, because the two are different programs to macOS: the
 * helper having worked says nothing about Walnut. The helper keeps the marker name
 * it always had, so an existing install's history is not lost.
 */
function grantMarker(kind: ReaderRoute['kind']): string {
  return path.join(WALNUT_HOME, 'cache', kind === 'app' ? 'walnut-app-fda-ok' : 'screentime-grant-ok');
}

export async function routeEverSucceeded(kind: ReaderRoute['kind']): Promise<boolean> {
  try {
    await fsp.access(grantMarker(kind));
    return true;
  } catch {
    return false;
  }
}

async function markSucceeded(kind: ReaderRoute['kind']): Promise<void> {
  try {
    await fsp.mkdir(path.dirname(grantMarker(kind)), { recursive: true });
    await fsp.writeFile(grantMarker(kind), new Date().toISOString());
  } catch {
    // A missing marker only degrades a message; never fail a good read for it.
  }
}

// ── running it ──────────────────────────────────────────────────────────────

export interface ReaderResult {
  /** walnut-reader's exit code; null when it never ran to an exit (spawn failure,
   *  timeout, size cap). */
  code: number | null;
  stderr: string;
  bytes: number;
  /** The bytes, when `collect` asked for them in memory. */
  data?: Buffer;
}

export interface ProtectedReadResult extends ReaderResult {
  route: ReaderRoute | null;
  /** True when the stand-in answered because Walnut is refused. */
  viaStandIn: boolean;
}

export interface ProtectedReadOptions {
  /** `read` only: stream the bytes into this file (created/truncated; removed on failure). */
  dst?: string;
  /** `read` only: return the bytes in memory instead. */
  collect?: boolean;
  /** Default MAX_READ_BYTES. */
  maxBytes?: number;
  /**
   * Ask the CURRENT route first, even inside the stand-in's minute. The Permission
   * Doctor needs that while its fix dialog polls: a grant has to show up on the next
   * tick, not up to a minute later.
   */
  preferCurrent?: boolean;
}

/**
 * `read` or `probe` one absolute path through the current route, with the stand-in
 * fallback. Never throws; `code` says what happened (0 ok, 2 bad input or missing,
 * 3 no permission, 4 read failed, null did not run).
 */
export async function runProtectedReader(
  sub: 'read' | 'probe',
  file: string,
  opts: ProtectedReadOptions = {},
): Promise<ProtectedReadResult> {
  const route = await readerRoute();
  if (!route) return { code: null, stderr: 'no reader on this host', bytes: 0, route: null, viaStandIn: false };
  const args = [sub, file];

  if (route.kind === 'app' && standIn && !opts.preferCurrent && Date.now() - lastAppAsk < APP_RETRY_MS) {
    const r = await runReader([standIn], args, opts);
    if (seesPast(r.code)) return { ...r, route, viaStandIn: true };
    standIn = null; // it lost its grant too (or broke); Walnut's answer below is the real one
  }

  const r = await runReader(route.cmd, args, opts);
  if (route.kind === 'app') lastAppAsk = Date.now();
  if (r.code === 0) {
    if (route.kind === 'app' && standIn) {
      log.web.info('Walnut has Full Disk Access now; the walnut-reader helper is retired', { retired: standIn });
      standIn = null;
    }
    await markSucceeded(route.kind);
    return { ...r, route, viaStandIn: false };
  }
  if (r.code === EXIT_NO_PERMISSION && route.kind === 'app') {
    const helper = existingHelperBinary(READER_SPEC);
    if (helper) {
      const h = await runReader([helper], args, opts);
      if (seesPast(h.code)) {
        if (!standIn) {
          log.web.info('Walnut has no Full Disk Access yet, reading through the granted walnut-reader helper', {
            helper,
            note: 'Settings → macOS Access → Full Disk Access moves the grant to Walnut',
          });
        }
        standIn = helper;
        if (h.code === 0) await markSucceeded('helper');
        return { ...h, route, viaStandIn: true };
      }
    }
  }
  return { ...r, route, viaStandIn: false };
}

/**
 * Did the reader get past the wall? A read (0), or a clean "no such file" (2), which
 * only a program allowed into the directory can report. A crash, a timeout or a
 * failed read proves nothing either way.
 */
function seesPast(code: number | null): boolean {
  return code === 0 || code === EXIT_BAD_INPUT;
}

/** Spawn one reader command. Never throws. */
function runReader(cmd: readonly string[], args: string[], opts: ProtectedReadOptions): Promise<ReaderResult> {
  const cap = Math.min(opts.maxBytes ?? MAX_READ_BYTES, MAX_READ_BYTES);
  const out = opts.dst ? fs.createWriteStream(opts.dst) : null;
  const chunks: Buffer[] | null = opts.collect ? [] : null;
  const wantsBytes = Boolean(out || chunks);
  return new Promise((resolve) => {
    const child = spawn(cmd[0]!, [...cmd.slice(1), ...args], {
      stdio: ['ignore', wantsBytes ? 'pipe' : 'ignore', 'pipe'],
    });
    let stderr = '';
    let bytes = 0;
    let capped = false;
    let settled = false;
    const done = (code: number | null): void => {
      if (settled) return;
      settled = true;
      const result: ReaderResult = { code: capped ? null : code, stderr, bytes };
      if (chunks && result.code === 0) result.data = Buffer.concat(chunks);
      if (opts.dst && result.code !== 0) {
        void fsp.rm(opts.dst, { force: true }).catch(() => {});
      }
      resolve(result);
    };
    const timer = setTimeout(() => {
      capped = true;
      stderr += ' (timed out)';
      child.kill('SIGKILL');
    }, READ_TIMEOUT_MS);
    child.stderr?.on('data', (d) => { stderr += String(d).slice(0, 500); });
    if (wantsBytes && child.stdout) {
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > cap) {
          if (!capped) {
            capped = true;
            stderr += ' (exceeded the size cap)';
            child.kill('SIGKILL');
          }
          return;
        }
        chunks?.push(chunk);
      });
      if (out) child.stdout.pipe(out);
    }
    // A failed spawn can report both 'error' and 'close'; the stream ends once.
    let finishing = false;
    const finish = (code: number | null): void => {
      if (finishing) return;
      finishing = true;
      clearTimeout(timer);
      // Wait for the file stream to flush, or a caller would open a short file.
      if (out) out.once('close', () => done(code)).end();
      else done(code);
    };
    child.on('error', (err) => {
      stderr += err.message;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

/**
 * Read one protected file into memory, like `fs.readFile`: rejects with an
 * errno-shaped error (`code` EPERM refused, ENOENT missing or not a regular file,
 * EFBIG over `maxBytes`, ENOTSUP no reader on this host, EIO anything else).
 */
export async function readProtectedFile(file: string, maxBytes: number): Promise<Buffer> {
  if (!path.isAbsolute(file)) throw errnoError('EINVAL', `not an absolute path: ${file}`);
  const r = await runProtectedReader('read', file, { collect: true, maxBytes });
  if (r.code === 0 && r.data) return r.data;
  if (!r.route) throw errnoError('ENOTSUP', 'Walnut cannot read protected files on this host');
  if (r.code === EXIT_NO_PERMISSION) {
    throw errnoError('EPERM', `macOS refused the read: ${r.route.grantTarget} needs Full Disk Access`);
  }
  if (r.code === EXIT_BAD_INPUT) throw errnoError('ENOENT', `no such regular file: ${file}`);
  if (r.code === null && r.bytes > maxBytes) throw errnoError('EFBIG', `${file} is larger than ${maxBytes} bytes`);
  throw errnoError('EIO', `could not read ${file}: ${r.stderr.trim() || `exit ${r.code}`}`);
}

function errnoError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

/** The program to add in System Settings for protected reads, without building
 *  anything: Walnut.app, else an already-built helper, else null. */
export async function readerGrantTarget(): Promise<string | null> {
  return (await readerGrantApp()) ?? existingHelperBinary(READER_SPEC);
}
