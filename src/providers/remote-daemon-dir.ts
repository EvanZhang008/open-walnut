/**
 * Where the session daemon keeps its runtime files on a remote host.
 *
 * The default is /tmp/open-walnut, and until now everything assumed it works.
 * It does not always: /tmp can be read-only, mounted noexec (the daemon binary
 * and the gateway shims cannot run there), full, or hold an open-walnut dir that
 * another user owns. When it is unusable the daemon moves to
 * $HOME/.cache/open-walnut instead of failing the connect.
 *
 * One ssh round trip (buildDaemonDirProbeScript, run through `sh -s`) answers
 * all of it: is a daemon already alive in either dir (that one wins, so a
 * reconnect never strands a running daemon), can /tmp/open-walnut be created,
 * written and executed from, and how much space is left. The cache dir is only
 * created when /tmp failed, so a healthy host never grows a stray ~/.cache dir.
 *
 * Streams are unaffected: a production daemon keeps them under
 * ~/.open-walnut/tmp/streams whichever dir it runs from, and the start env pins
 * WALNUT_STREAMS_DIR there (daemonDirEnv) so even an older daemon build cannot
 * derive a different place.
 */

import path from 'node:path'
import { shq } from './remote-sh.js'

export const PROD_REMOTE_DAEMON_DIR = '/tmp/open-walnut'
/** Relative to $HOME on the host. Both daemon twins recognise it as a production dir. */
export const FALLBACK_DAEMON_SUBDIR = '.cache/open-walnut'
/** Below this the host gets a readiness problem that names the number. */
export const MIN_DAEMON_FREE_MB = 200

export type DirStatus =
  | 'ok' | 'read-only' | 'noexec' | 'full' | 'permission-denied' | 'not-a-directory' | 'no-home' | 'unusable'
  /** Another user owns it, or it is a symlink: someone else could swap the daemon under us. */
  | 'not-owned'
  /** Not tested (an attach-only ephemeral server never writes to a shared host). */
  | 'unchecked'

export interface DirProbe {
  path?: string
  status: DirStatus
  freeMb?: number
  /** A daemon answers from this dir right now (pid alive, port file present). */
  live: boolean
}

export interface DaemonDirProbe {
  /** Raw `uname -m`. */
  arch?: string
  home?: string
  tmp: DirProbe
  cache: DirProbe
}

export interface DaemonDirChoice {
  path: string
  /** True when the daemon runs from the $HOME fallback, not /tmp. */
  fallback: boolean
  /** Why /tmp was not used, as a clause ("/tmp is read-only"). Fallback or unusable only. */
  reason?: string
  /** Free space where the chosen dir lives. */
  freeMb?: number
  /** Neither dir passed the check: the start will most likely fail. */
  unusable?: boolean
}

const PROBE_HEADER = 'walnut-dir-probe v1'
const PROBE_DONE = 'walnut-dir-probe-done'

export interface DirProbeScriptOpts {
  /** Create/write/exec test. False = only look for a live daemon and free space. */
  writeTest?: boolean
  /** Test seams: absolute dirs instead of the real ones. */
  tmpDir?: string
  cacheDir?: string
  minFreeMb?: number
}

/** One POSIX sh script (run through `sh -s`) printing `key=value` lines between a header and a done line. */
export function buildDaemonDirProbeScript(opts: DirProbeScriptOpts = {}): string {
  const tmp = shq(opts.tmpDir ?? PROD_REMOTE_DAEMON_DIR)
  const cache = opts.cacheDir ? shq(opts.cacheDir) : `"\${HOME:+$HOME/${FALLBACK_DAEMON_SUBDIR}}"`
  const min = opts.minFreeMb ?? MIN_DAEMON_FREE_MB
  const check = opts.writeTest === false ? 'echo unchecked' : 'w_check "$1"'
  return [
    'umask 077',
    `T=${tmp}`,
    `C=${cache}`,
    `echo '${PROBE_HEADER}'`,
    'echo "arch=$(uname -m 2>/dev/null)"',
    'echo "home=$HOME"',
    // The error text of a failed mkdir or write says which kind of unusable.
    'w_reason() { case "$1" in *[Rr]ead-only*) echo read-only;; *"No space"*|*[Qq]uota*) echo full;; '
      + '*[Pp]ermission*|*"not permitted"*) echo permission-denied;; *"Not a directory"*|*"File exists"*) echo not-a-directory;; *) echo unusable;; esac; }',
    'w_check() {',
    '  d=$1',
    '  [ -n "$d" ] || { echo no-home; return; }',
    '  if [ -e "$d" ] && [ ! -d "$d" ]; then echo not-a-directory; return; fi',
    '  e=$(mkdir -p "$d" 2>&1) || { w_reason "$e"; return; }',
    // A dir another user owns (or a symlink someone planted) is theirs to swap
    // the daemon in: never use it, even when it happens to be writable.
    '  if [ -L "$d" ] || [ ! -O "$d" ]; then echo not-owned; return; fi',
    '  chmod 700 "$d" 2>/dev/null',
    '  f="$d/.walnut-probe-$$"',
    `  e=$( (printf '#!/bin/sh\\nexit 0\\n' > "$f") 2>&1) || { rm -f "$f" 2>/dev/null; w_reason "$e"; return; }`,
    '  chmod 700 "$f" 2>/dev/null',
    '  if "$f" >/dev/null 2>&1; then r=ok; else r=noexec; fi',
    '  rm -f "$f" 2>/dev/null',
    '  echo "$r"',
    '}',
    // Free space of the dir, or of its parent when it does not exist yet.
    'w_free() { t=$1; [ -d "$t" ] || t=$(dirname "$t"); df -Pk "$t" 2>/dev/null | awk \'NR==2 { print int($4 / 1024) }\'; }',
    // Only a dir we own can hold OUR live daemon (a planted pid file must not steer the connect).
    'w_live() { if [ -d "$1" ] && [ ! -L "$1" ] && [ -O "$1" ] && [ -O "$1/daemon.pid" ]; then p=$(cat "$1/daemon.pid" 2>/dev/null); '
      + 'if [ -n "$p" ] && [ -s "$1/daemon.port" ] && kill -0 "$p" 2>/dev/null; then echo 1; return; fi; fi; echo 0; }',
    `w_status() { ${check}; }`,
    'tl=$(w_live "$T")',
    'cl=0; [ -n "$C" ] && cl=$(w_live "$C")',
    'ts=$(w_status "$T")',
    'tf=$(w_free "$T")',
    'echo "tmp_path=$T"',
    'echo "tmp_live=$tl"',
    'echo "tmp=$ts"',
    'echo "tmp_free_mb=$tf"',
    'echo "cache_path=$C"',
    'echo "cache_live=$cl"',
    // The cache dir is only created when /tmp cannot take the daemon.
    `if [ "$tl" != 1 ] && { [ "$ts" != ok ] && [ "$ts" != unchecked ] || [ "\${tf:-999999}" -lt ${min} ] || [ "$cl" = 1 ]; }; then`,
    '  echo "cache=$(w_status "$C")"',
    '  [ -n "$C" ] && echo "cache_free_mb=$(w_free "$C")"',
    'else',
    '  echo "cache=unchecked"',
    'fi',
    `echo '${PROBE_DONE}'`,
  ].join('\n')
}

const STATUSES = new Set<DirStatus>(['ok', 'read-only', 'noexec', 'full', 'permission-denied', 'not-a-directory', 'no-home', 'unusable', 'not-owned', 'unchecked'])

function asStatus(v: string | undefined): DirStatus {
  return v && STATUSES.has(v as DirStatus) ? v as DirStatus : 'unusable'
}

function asMb(v: string | undefined): number | undefined {
  if (!v || !/^\d+$/.test(v)) return undefined
  return parseInt(v, 10)
}

/** Null when the reply is not a complete probe (an old stub, a cut-off answer): keep the default dir. */
export function parseDaemonDirProbe(output: string): DaemonDirProbe | null {
  const lines = output.split('\n').map((l) => l.trim())
  const start = lines.indexOf(PROBE_HEADER)
  const done = lines.lastIndexOf(PROBE_DONE)
  if (start < 0 || done < start) return null
  const kv = new Map<string, string>()
  for (const line of lines.slice(start + 1, done)) {
    const eq = line.indexOf('=')
    if (eq > 0) kv.set(line.slice(0, eq), line.slice(eq + 1))
  }
  const cachePath = kv.get('cache_path') || undefined
  return {
    ...(kv.get('arch') ? { arch: kv.get('arch') } : {}),
    ...(kv.get('home') ? { home: kv.get('home') } : {}),
    tmp: { path: kv.get('tmp_path') || PROD_REMOTE_DAEMON_DIR, status: asStatus(kv.get('tmp')), freeMb: asMb(kv.get('tmp_free_mb')), live: kv.get('tmp_live') === '1' },
    cache: { path: cachePath, status: asStatus(kv.get('cache')), freeMb: asMb(kv.get('cache_free_mb')), live: kv.get('cache_live') === '1' },
  }
}

/** Why the daemon is not on /tmp, as a clause ("/tmp is read-only"). */
export function describeTmpProblem(tmp: DirProbe, minFreeMb = MIN_DAEMON_FREE_MB): string {
  switch (tmp.status) {
    case 'read-only': return '/tmp is read-only'
    case 'noexec': return '/tmp is mounted noexec'
    case 'full': return '/tmp is full'
    case 'permission-denied': return '/tmp/open-walnut is not writable (permission denied)'
    case 'not-a-directory': return '/tmp/open-walnut is a file, not a directory'
    case 'not-owned': return '/tmp/open-walnut belongs to another user (or is a symlink)'
    case 'ok':
    case 'unchecked':
      if (typeof tmp.freeMb === 'number' && tmp.freeMb < minFreeMb) return `/tmp is nearly full (${tmp.freeMb} MB free)`
      return 'a daemon started there earlier is still running'
    default: return '/tmp is unusable'
  }
}

/**
 * Pick the dir. A live daemon wins (never strand a running one), then a healthy
 * /tmp, then the $HOME fallback. A low disk alone is a readiness problem, not
 * a reason to move when the fallback is just as full.
 */
export function chooseDaemonDir(probe: DaemonDirProbe, minFreeMb = MIN_DAEMON_FREE_MB): DaemonDirChoice {
  const tmpPath = probe.tmp.path ?? PROD_REMOTE_DAEMON_DIR
  const cachePath = probe.cache.path
  const tmpUsable = probe.tmp.status === 'ok' || probe.tmp.status === 'unchecked'
  const low = (mb?: number) => typeof mb === 'number' && mb < minFreeMb
  const tmpChoice = (): DaemonDirChoice => ({ path: tmpPath, fallback: false, ...(probe.tmp.freeMb !== undefined ? { freeMb: probe.tmp.freeMb } : {}) })
  const cacheChoice = (): DaemonDirChoice => ({
    path: cachePath!, fallback: true, reason: describeTmpProblem(probe.tmp, minFreeMb),
    ...(probe.cache.freeMb !== undefined ? { freeMb: probe.cache.freeMb } : {}),
  })

  if (probe.tmp.live) return tmpChoice()
  if (probe.cache.live && cachePath) return cacheChoice()
  if (tmpUsable && !low(probe.tmp.freeMb)) return tmpChoice()
  if (cachePath && probe.cache.status === 'ok' && (!tmpUsable || !low(probe.cache.freeMb))) return cacheChoice()
  if (tmpUsable) return tmpChoice()
  return { ...tmpChoice(), unusable: true, reason: describeTmpProblem(probe.tmp, minFreeMb) }
}

/**
 * Env for the daemon start when it runs from the fallback: the dir itself, and
 * the production streams dir pinned explicitly. Empty for /tmp (a default
 * install keeps the env-free start it always had).
 */
export function daemonDirEnv(choice: DaemonDirChoice | null, home?: string): Record<string, string> {
  if (!choice?.fallback) return {}
  const env: Record<string, string> = { WALNUT_DAEMON_DIR: choice.path }
  if (home) env.WALNUT_STREAMS_DIR = path.posix.join(home, '.open-walnut', 'tmp', 'streams')
  return env
}

/** `~/.cache/open-walnut` rather than the absolute path, for a UI line. */
export function displayDaemonDir(dir: string, home?: string): string {
  if (home && (dir === home || dir.startsWith(home.replace(/\/+$/, '') + '/'))) return '~' + dir.slice(home.replace(/\/+$/, '').length)
  return dir
}

/** The preflight warning for a relocated daemon, or undefined when it runs from /tmp. */
export function daemonDirWarning(choice: DaemonDirChoice | null | undefined, home?: string): string | undefined {
  if (!choice) return undefined
  const reason = (choice.reason ?? '/tmp is unusable').replace(/(\/tmp\/open-walnut|\/tmp)\b/, '`$1`')
  if (choice.unusable) return `Neither \`/tmp/open-walnut\` nor \`~/${FALLBACK_DAEMON_SUBDIR}\` can hold the session daemon (${reason}, and the home fallback failed too).`
  if (!choice.fallback) return undefined
  return `Using \`${displayDaemonDir(choice.path, home)}\` for the session daemon because ${reason}.`
}

/**
 * The production dirs a daemon may be running from on this host, `chosen`
 * first: /tmp/open-walnut and $HOME/.cache/open-walnut. Anything else (a test
 * dir) stands alone.
 */
export function productionDaemonDirs(chosen: string, home?: string | null): string[] {
  const cache = home ? path.posix.join(home, FALLBACK_DAEMON_SUBDIR) : null
  const prod = [PROD_REMOTE_DAEMON_DIR, ...(cache ? [cache] : [])]
  if (!prod.includes(chosen)) return [chosen]
  return [chosen, ...prod.filter((d) => d !== chosen)]
}

export interface LiveDaemonScan {
  dir: string
  pid: number
  port: number
  runtime: 'bun' | 'binary' | 'node' | 'unknown'
}

/**
 * One `sh -s` script: the first of `dirs` (in order) holding a live daemon we
 * own (pid alive, port file present), with the runtime read from the live
 * process's command line.
 */
export function buildLiveDaemonScanScript(dirs: string[]): string {
  return [
    ...dirs.map((d, i) => [
      `d=${shq(d)}`,
      'if [ -d "$d" ] && [ ! -L "$d" ] && [ -O "$d" ]; then',
      '  P=$(cat "$d/daemon.pid" 2>/dev/null); Q=$(cat "$d/daemon.port" 2>/dev/null)',
      '  if [ -n "$P" ] && [ -n "$Q" ] && kill -0 "$P" 2>/dev/null; then',
      '    R=unknown; case "$(ps -o args= -p "$P" 2>/dev/null)" in *daemon-linux-*|*daemon-darwin-*) R=binary;; *bun*) R=bun;; *node*) R=node;; esac',
      `    echo "walnut-live dir=${i} pid=$P port=$Q runtime=$R"; exit 0`,
      '  fi',
      'fi',
    ].join('\n')),
    'echo "walnut-live none"',
  ].join('\n')
}

/** True when the scan ran to its end and found no live daemon in any dir. */
export function liveDaemonScanFoundNone(output: string): boolean {
  return /^walnut-live none\s*$/m.test(output)
}

/** The live daemon the scan found, or null (none, or an unreadable reply). */
export function parseLiveDaemonScan(output: string, dirs: string[]): LiveDaemonScan | null {
  const m = output.match(/^walnut-live dir=(\d+) pid=(\d+) port=(\d+) runtime=(\w+)\s*$/m)
  if (!m) return null
  const dir = dirs[parseInt(m[1], 10)]
  const port = parseInt(m[3], 10)
  if (!dir || !(port > 0 && port < 65536)) return null
  const runtime = m[4] === 'bun' || m[4] === 'binary' || m[4] === 'node' ? m[4] : 'unknown'
  return { dir, pid: parseInt(m[2], 10), port, runtime }
}
