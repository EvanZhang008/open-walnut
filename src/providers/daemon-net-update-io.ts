/**
 * The RemoteDaemonUpdateIo (daemon-service-update.ts) for a host reached over the
 * host network, where there is no SSH: every step is a command of the very daemon
 * the update replaces.
 *
 *   run           exec.run (host-exec-v1): the line as `/bin/sh -c <line>` argv, so the
 *                 login shell (zsh on a Mac) never parses it; a line over an older
 *                 daemon's 8 KB argv word goes as a command. The bytes never ride a
 *                 command line (2026-11-03: a 2 MB argv was refused with E2BIG). The
 *                 login shell runs the user's profile first, and whatever that prints
 *                 shares the output, so the line prints a marker of its own first and
 *                 only what follows it is the answer.
 *   chunk         fs.writePart (fs-write-part-v1): one file per chunk, its size and
 *                 sha256 checked by the host before the file appears.
 *   serviceUpdate the final `walnut daemon update` runs from a script (written with
 *                 fs.writePart) started DETACHED: out of the exec job's process group,
 *                 which the daemon signals when the job ends, and off its pipes,
 *                 because the old daemon exits during the handover and must not take
 *                 the update with it. The script retries while the old daemon answers
 *                 "has active operations" (the very exec.run that started it is one
 *                 such operation); after that refusal the update has put the old
 *                 service config back and the running daemon keeps serving. A script
 *                 a later update replaced stops before its next try, so a server of an
 *                 older build never puts its build back over a newer one. Its result
 *                 is read back with fs.read, from the new daemon once the link is back.
 *
 * Every host the network reaches has these commands: net-v1 (2026-11-01) came after
 * fs-write-part-v1 and host-facts-v1 (2026-10-21) and host-exec-v1 (2026-10-31), so
 * no older fallback is kept.
 */
import { createHash, randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { RemoteDaemonUpdateIo } from './daemon-service-update.js'
import { installRootLine, laterLines, RUNNER_BEAT_SECONDS, servicePreamble } from './daemon-update-shell.js'
import { PROBATION_FAILED_NAME, PROBATION_REFUSE_SECONDS, probationRecordLines, SNAPSHOT_DIR } from './daemon-update-probation.js'
import { parseUpdateTail, TAIL_FILE, tailSteppedIn, updateSnapshotLines, updateTailLines, type UpdateTail, type UpdateTailOptions } from './daemon-update-tail.js'

export interface NetUpdateConn {
  send(cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
}

export interface NetUpdateIoOptions {
  /** How many times the script runs `walnut daemon update` while the old daemon says it is busy. */
  tries?: number
  /** Seconds between those attempts. */
  pauseSeconds?: number
  /** Seconds the script waits before its first attempt, so the exec.run that started it is over. */
  settleSeconds?: number
  /** How often, and how long at most, the server reads for the script's result. */
  pollMs?: number
  waitMs?: number
  /** Asked right before the detached start: a reason holds the update (nothing changed yet). */
  beforeLaunch?: () => string | null | Promise<string | null>
  /** How long a hold met there is waited out, the upload already on the host, before giving up. */
  holdWaitMs?: number
  /** The file naming the latest update's staging dir (tests point it elsewhere). */
  latestMarker?: string
  /** True once nobody waits for the answer any more (the connection was closed for good). */
  cancelled?: () => boolean
  /** The detached update is running on the host (its staging dir): the link may drop now. */
  onLaunched?: (directory: string) => void
  /** The tail's waits (daemon-update-tail.ts); tests shorten them. */
  tail?: Omit<UpdateTailOptions, 'scope'>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/**
 * Each try of `walnut daemon update` itself asks a busy daemon again for up to 30 s
 * (daemon-service-cli.ts UPDATE_BUSY_WAIT_MS), so every try with its pause, and the
 * last try's own swap, fit in the time the server waits for the answer (UPDATE_WAIT_MS).
 */
export const RUNNER_TRIES = 8
export const RUNNER_PAUSE_SECONDS = 10
/**
 * How long one try of `walnut daemon update` may run before the runner ends it (TERM, then KILL),
 * so the tail always comes. Its own waits (the busy daemon, the bootout, the new daemon's start
 * and stay) fit well inside. 2026-11-04 review 5: a CLI that hung kept its runner, and so every
 * later update, revive and stand-in of the host, waiting for as long as it lived.
 */
export const RUNNER_CLI_MAX_SECONDS = 15 * 60
const POLL_MS = 5_000
export const UPDATE_WAIT_MS = 15 * 60_000
/** An older daemon's longest argv word (host-exec-line.ts ARG_MAX_CHARS). */
const ARGV_WORD_MAX = 8 * 1024
/** exec.run's own cap on a foreground run (host-exec-core.ts FOREGROUND_MAX_MS). */
const FOREGROUND_MAX_MS = 10 * 60_000
const STAGING = /^\/tmp\/open-walnut-update\.[a-zA-Z0-9]+$/
const HOLD_WAIT_MS = 2 * 60_000
export const LAUNCHED = 'walnut-update-started'
/** The launcher found another update's runner still at work on the host, and started nothing. */
export const RUNNER_BUSY = 'walnut-update-busy'
/** One per user: a hyphen, so it never matches STAGING. */
const LATEST_MARKER = '"/tmp/open-walnut-update-latest-$(id -u)"'
const SUPERSEDED = 'rc=superseded'
/** The runner found the last update's probation at work (daemon-update-probation.ts) and changed nothing. */
const PROBING_RC = 'rc=probation'
/** Why an update waits for a probation: the hold's words on every path. */
export const PROBATION_BUSY = 'the last daemon update\'s probation still watches the new daemon on the host, so nothing was changed'

/** The update was held before anything changed on the host (a write in flight, another update at work): ask again later. */
export class NetUpdateHeldError extends Error {
  // By name too: daemon-connection.ts matches it so, as tests replace this module with a double.
  override name = 'NetUpdateHeldError'
}

/**
 * The detached update ran, and no answer came back over the link in time (the host went
 * away during its own update, or nobody waits any more): its staging dir keeps the record
 * (update.done, update.tail) for the server to read once the link is back.
 */
export class NetUpdateUnansweredError extends Error {
  readonly keepStaging = true
  constructor(message: string, readonly directory: string) { super(message) }
}

/** Quote one word for a POSIX shell. */
export function shq(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

const markerWord = (latest?: string) => (latest ? shq(latest) : LATEST_MARKER)

/**
 * The detached script: it writes its pid, waits for the launcher's go (written only once
 * the launcher saw it run in a process group of its own), then runs `command` until it
 * succeeds, fails for another reason, or `tries` busy refusals. Before each try it stops
 * when the latest marker (a file of this user's) names another update's dir: a later
 * launch took over. With a scope, the service config is copied aside before the first try
 * and the tail runs after the last (daemon-update-tail.ts): whatever the update answered, a
 * daemon serves when the script ends, and `update.tail` says what it took. It removes the
 * uploaded executable (the service keeps its own copy) and writes `update.done` last.
 *
 * While it runs it touches update.pid every RUNNER_BEAT_SECONDS (t_later reads that as alive),
 * and a try that runs past RUNNER_CLI_MAX_SECONDS is ended. `build`: the build it installs; one
 * whose probation failed on the host lately (update-probation.failed in the install root) is
 * refused before anything is touched (2026-11-04 review 5).
 */
export function runnerScript(o: {
  directory: string; command: string; executable: string; tries?: number; pauseSeconds?: number; settleSeconds?: number; latest?: string
  tail?: UpdateTailOptions; build?: string; cliMaxSeconds?: number; beatSeconds?: number
}): string {
  const d = shq(o.directory)
  const ownExe = o.executable.startsWith(`${o.directory}/`)
  // A build word the shell can carry as it is; any other is not checked (never quoted wrong).
  const build = o.build && /^[A-Za-z0-9._-]+$/.test(o.build) ? o.build : ''
  const cliMax = o.cliMaxSeconds ?? RUNNER_CLI_MAX_SECONDS
  const refused = JSON.stringify({ ok: false, failure: { code: 'probationFailed', stopped: false, message: 'this build did not stay serving on the host after an update lately (its probation), so the update was not run again' } })
  return [
    '#!/bin/sh',
    '# Walnut daemon update runner (src/providers/daemon-net-update-io.ts), started detached.',
    `d=${d}`,
    `L=${markerWord(o.latest)}`,
    `tvb=${build}`,
    ...laterLines(),
    'echo $$ > "$d/update.pid"',
    // Its heartbeat: alive and not frozen, for t_later (a runner of an older build only wrote it once).
    `( while kill -0 $$ 2>/dev/null && [ -d "$d" ] && [ ! -e "$d/update.done" ]; do sleep ${o.beatSeconds ?? RUNNER_BEAT_SECONDS}; touch "$d/update.pid" 2>/dev/null; done ) </dev/null >/dev/null 2>&1 &`,
    'k=0',
    // No go (the launcher found it in the job's group, or its dir was removed) or none within 10 s: it changes nothing.
    'while [ ! -e "$d/update.go" ]; do k=$((k+1)); [ -e "$d/update.nogo" ] || [ ! -d "$d" ] || [ "$k" -gt 100 ] && exit 0; sleep 0.1; done',
    `sleep ${o.settleSeconds ?? 2}`,
    ...(o.tail ? [
      ...servicePreamble(o.tail.scope),
      // The build a probation here failed within its day: nothing is run, the answer says so.
      `if [ -n "$tvb" ] && [ "$(sed -n 1p "$tb/${PROBATION_FAILED_NAME}" 2>/dev/null)" = "$tvb" ]; then tpa=$(sed -n 2p "$tb/${PROBATION_FAILED_NAME}" 2>/dev/null); case "$tpa" in ""|*[!0-9]*) tpa=0;; esac`,
      `  if [ $(( $(date +%s) - tpa )) -lt ${PROBATION_REFUSE_SECONDS} ]; then printf '%s\\n' ${shq(refused)} > "$d/update.out"; : > "$d/update.err"`,
      ...(ownExe ? [`    rm -f ${shq(o.executable)}`] : []),
      `    printf 'rc=refused tries=0 tail=none\\n' > "$d/update.done.tmp" && mv -f "$d/update.done.tmp" "$d/update.done"; exit 0; fi`,
      'fi',
      // The last update's probation at work, or its copies with time left (its launch raced the
      // probation's start, or a reboot ended it): nothing is touched, its snapshot would take the
      // probation's copies (2026-11-05 reviews 6 and 8). Looked at again under the install lock, by
      // the snapshot (tv_busy). Asked again.
      ...probationRecordLines(),
      `tsb="$tb/${SNAPSHOT_DIR}"`,
      'tv_busy=; t_busy && tv_busy=1',
      ...updateSnapshotLines(o.tail),
      `if [ -n "$tv_busy" ]; then : > "$d/update.out"; echo ${shq(`walnut-update: ${PROBATION_BUSY}`)} > "$d/update.err"`,
      ...(ownExe ? [`  rm -f ${shq(o.executable)}`] : []),
      `  printf '${PROBING_RC} tries=0 tail=none\\n' > "$d/update.done.tmp" && mv -f "$d/update.done.tmp" "$d/update.done"; exit 0; fi`,
    ] : []),
    'n=0; rc=0; tt=none',
    'while :; do',
    '  [ -d "$d" ] || exit 0',
    // A later launch whose runner is at work (t_later: a marker of this user's, its runner alive, not done).
    '  if t_later; then rc=superseded; break; fi',
    '  n=$((n+1))',
    // Watched: one that runs past its time is ended (TERM, then KILL), and the tail still comes. The
    // watch is a process of its own (this shell waits on the try, which reaps it at once), and it is
    // ended as soon as the try is over, so it never signals a pid the try no longer has.
    `  ${o.command} >"$d/update.out" 2>"$d/update.err" &`,
    '  cp=$!; rm -f "$d/update.ended"',
    `  ( cw=0; while kill -0 "$cp" 2>/dev/null; do if [ "$cw" -ge ${cliMax} ]; then : > "$d/update.ended"; kill -TERM "$cp" 2>/dev/null; sleep 5; kill -KILL "$cp" 2>/dev/null; exit 0; fi; sleep 1; cw=$((cw + 1)); done ) </dev/null >/dev/null 2>&1 &`,
    '  cwp=$!',
    '  wait "$cp"',
    '  rc=$?',
    '  kill "$cwp" 2>/dev/null',
    `  [ -e "$d/update.ended" ] && echo "walnut-update: the try was ended after ${cliMax} s" >> "$d/update.err"`,
    '  [ "$rc" -eq 0 ] && break',
    `  [ "$n" -ge ${o.tries ?? RUNNER_TRIES} ] && break`,
    // Asked again: the busy refusal (after it the old service config is back, daemon-service-manager.ts),
    // and the install lock another `walnut daemon` held past the CLI's wait (nothing changed yet).
    `  if grep -q 'File lock timeout' "$d/update.err" 2>/dev/null; then :`,
    `  elif grep -q '"updateRefused"' "$d/update.out" 2>/dev/null && grep -Eq 'has active operations|must finish first' "$d/update.out" 2>/dev/null; then :`,
    '  else break; fi',
    `  sleep ${o.pauseSeconds ?? RUNNER_PAUSE_SECONDS}`,
    'done',
    // A later launch owns the host now: its own tail runs after its own update.
    // Not indented: the tail holds a heredoc (the stand-in's script), whose end line must start the line.
    ...(o.tail ? ['if [ "$rc" != superseded ]; then', ...updateTailLines(o.tail), 'fi'] : []),
    ...(ownExe ? [`rm -f ${shq(o.executable)}`] : []),
    `printf 'rc=%s tries=%s tail=%s\\n' "$rc" "$n" "$tt" > "$d/update.done.tmp" && mv -f "$d/update.done.tmp" "$d/update.done"`,
    '',
  ].join('\n')
}

/**
 * Start the script out of this job's process group: setsid (Linux), else perl's setsid
 * (every Mac has perl; its python3 may be the stub that asks to install developer tools),
 * else bash job control (dash refuses `set -m` without a terminal), else sh's. Then prove
 * it: the script's process group must differ from ours, else it is told no go (it exits
 * before it changed anything; nothing is signalled) and the line fails.
 *
 * Never beside another update's runner still at work (t_later), nor while the last update's
 * probation watches its daemon or its copies have time left (t_busy): it prints RUNNER_BUSY and
 * starts nothing. 2026-11-04 review: a server restarted by a deploy mid-update, or two servers
 * updating one host, started a second runner whose snapshot held the first one's new config;
 * review 6: one inside a probation took its copies, and a build that then failed late had no way
 * back; review 8: so did one after a reboot ended the probation.
 * The check and the marker's move hold a lock of their own (`$L.lock`, this user's), so two
 * launches at once cannot both find the host free.
 */
export function launcherScript(directory: string, latest?: string): string {
  const d = shq(directory)
  return [
    `d=${d}; s="$d/update.sh"; L=${markerWord(latest)}`,
    ...laterLines(),
    installRootLine(),
    ...probationRecordLines(),
    `tsb="$tb/${SNAPSHOT_DIR}"`,
    // A process group: ps, else field 5 of /proc/<pid>/stat (the third after the last ")"), as
    // DAEMON_PID_SH reads it. 2026-11-04 review: a host whose ps has no -p (busybox), or no ps at
    // all, failed every launch as "not detached", every 10 min for good.
    `pg() { pg_g=$(ps -o pgid= -p "$1" 2>/dev/null | tr -d ' ')`,
    `  if [ -z "$pg_g" ] || [ -n "$(printf '%s' "$pg_g" | tr -d 0-9)" ]; then pg_g=; pg_s=$(cat "/proc/$1/stat" 2>/dev/null) && { pg_s=\${pg_s##*) }; set -- $pg_s; pg_g=\${3:-}; }; fi`,
    `  printf '%s' "$pg_g"; }`,
    'll="$L.lock"; li=0',
    'while ! mkdir "$ll" 2>/dev/null; do',
    // A lock that is not this user's dir is no lock to wait for; one whose launcher died is taken,
    // and so is one left empty (a launcher killed between its mkdir and its pid) a minute on.
    '  [ -d "$ll" ] && [ -O "$ll" ] && [ ! -L "$ll" ] || { ll=; break; }',
    // A launcher holds it 20 s at most: one 2 min old is stale whatever its pid (a reused pid
    // would hold every update for good, 2026-11-04 review). Its mtime: wall clock, as it must be.
    '  [ -n "$(find "$ll" -maxdepth 0 -mmin +2 2>/dev/null)" ] && { rm -f "$ll/pid"; rmdir "$ll" 2>/dev/null || { ll=; break; }; continue; }',
    '  lp=$(cat "$ll/pid" 2>/dev/null); case "$lp" in',
    '    ""|*[!0-9]*) [ -n "$(find "$ll" -maxdepth 0 -mmin +1 2>/dev/null)" ] && { rm -f "$ll/pid"; rmdir "$ll" 2>/dev/null || { ll=; break; }; continue; };;',
    '    *) kill -0 "$lp" 2>/dev/null || { rm -f "$ll/pid"; rmdir "$ll" 2>/dev/null || { ll=; break; }; continue; };;',
    '  esac',
    // Still held after the wait (a launch under heavy load): busy, asked again on the server clock, never unlocked.
    `  [ "$li" -ge 150 ] && { : > "$d/update.nogo"; echo "${RUNNER_BUSY} dir=launch-lock pid=$lp"; exit 0; }; li=$((li + 1)); sleep 0.1`,
    'done',
    '[ -n "$ll" ] && echo $$ > "$ll/pid"',
    `if t_later; then : > "$d/update.nogo"; [ -n "$ll" ] && { rm -f "$ll/pid"; rmdir "$ll"; } 2>/dev/null; echo "${RUNNER_BUSY} dir=$tl_d pid=$tl_p"; exit 0; fi`,
    `if t_busy; then : > "$d/update.nogo"; [ -n "$ll" ] && { rm -f "$ll/pid"; rmdir "$ll"; } 2>/dev/null; echo "${RUNNER_BUSY} probation pid=$tp_p"; exit 0; fi`,
    'if command -v setsid >/dev/null 2>&1; then setsid /bin/sh "$s" </dev/null >/dev/null 2>&1 &',
    "elif command -v perl >/dev/null 2>&1; then perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' /bin/sh \"$s\" </dev/null >/dev/null 2>&1 &",
    `elif command -v bash >/dev/null 2>&1; then bash -c 'set -m; /bin/sh "$1" </dev/null >/dev/null 2>&1 &' sh "$s" 2>/dev/null`,
    'else (set -m; /bin/sh "$s" </dev/null >/dev/null 2>&1 &) 2>/dev/null',
    'fi',
    'k=0; while [ ! -s "$d/update.pid" ] && [ "$k" -lt 50 ]; do k=$((k+1)); sleep 0.1; done',
    'r=$(cat "$d/update.pid" 2>/dev/null); case "$r" in ""|*[!0-9]*) r="";; esac',
    'g=""; [ -n "$r" ] && g=$(pg "$r")',
    'm=$(pg $$)',
    // The marker is written in the private dir and renamed into place, never through a name in /tmp.
    `if [ -n "$r" ] && [ -n "$g" ] && [ -n "$m" ] && [ "$g" != "$m" ]; then printf '%s\\n' "$d" > "$d/latest.tmp" && mv -f "$d/latest.tmp" "$L" 2>/dev/null; : > "$d/update.go"; [ -n "$ll" ] && { rm -f "$ll/pid"; rmdir "$ll"; } 2>/dev/null; echo "${LAUNCHED} pid=$r group=$g own=$m"`,
    'else : > "$d/update.nogo"; [ -n "$ll" ] && { rm -f "$ll/pid"; rmdir "$ll"; } 2>/dev/null; echo "walnut-update-not-detached pid=$r group=$g own=$m"; exit 1; fi',
  ].join('\n')
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

export function createNetUpdateIo(conn: NetUpdateConn, opts: NetUpdateIoOptions = {}): RemoteDaemonUpdateIo {
  async function run(command: string, timeoutMs = 30_000): Promise<string> {
    const limit = Math.min(Math.max(timeoutMs, 1_000), FOREGROUND_MAX_MS)
    const mark = `walnut-update-output-${randomBytes(4).toString('hex')}`
    const line = `printf '%s\\n' ${mark}; ${command}`
    const shape = line.length <= ARGV_WORD_MAX ? { argv: ['/bin/sh', '-c', line] } : { command: line }
    const reply = await conn.send('exec.run', {
      jobId: `hx-walnut-update-${randomBytes(6).toString('hex')}`, ...shape, cwd: '/', timeoutMs: limit,
      caller: { task: 'walnut-daemon-update' },
    }, limit + 15_000)
    if (reply.ok !== true) throw new Error(`the host did not run the command: ${String(reply.error ?? reply.code ?? 'no answer')}`)
    const raw = typeof reply.output === 'string' ? reply.output : ''
    const at = raw.indexOf(`${mark}\n`)
    const output = at < 0 ? raw : raw.slice(at + mark.length + 1)
    if (reply.exitCode !== 0 || reply.timedOut === true || reply.killed === true || reply.blocked) {
      const end = reply.timedOut === true ? 'its deadline' : reply.blocked ? 'a dialog' : `exit ${String(reply.exitCode ?? reply.signal)}`
      throw new Error(`the command on the host stopped at ${end}: ${output.trim().slice(-500)}`)
    }
    return output.trim()
  }

  async function writeFile(path: string, data: Buffer): Promise<boolean> {
    const sum = sha256(data)
    try {
      const reply = await conn.send('fs.writePart', { path, offset: 0, data: data.toString('base64'), final: true, size: data.length, sha256: sum }, 60_000)
      return reply.ok === true && reply.done === true && reply.sha256 === sum
    } catch {
      return false
    }
  }

  const readText = netReadText(conn)

  return {
    run,
    chunk: (data, directory, index) => writeFile(`${directory}/chunk_${String(index).padStart(4, '0')}`, data),
    serviceUpdate: (update) => runDetachedUpdate({ run, writeFile, readText }, update, opts),
  }
}

/** What the detached update needs of a host: a line run there, a file written whole, a file read (null: not there, or no answer). */
export interface DetachedUpdateHost {
  run(command: string, timeoutMs?: number): Promise<string>
  writeFile(path: string, data: Buffer): Promise<boolean>
  readText(path: string): Promise<string | null>
}

/**
 * The runner script written into the update's dir and started detached (launcherScript),
 * then its record read until update.done is there. Every way Walnut updates a daemon
 * service runs it: the host network (its link is the daemon that goes away), SSH (a
 * dropped link or a server restart must not cost the tail, 2026-11-04), and this machine
 * (a deploy that stops the server must not stop the update between bootout and bootstrap).
 */
export async function runDetachedUpdate(
  host: DetachedUpdateHost,
  { command, directory, executable, scope, build }: { command: string; directory: string | null; executable: string; scope: 'user' | 'cron'; build?: string },
  opts: NetUpdateIoOptions = {},
): Promise<{ output: string; tail: UpdateTail | null }> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref?.() }))
  // Monotonic: the server's Mac sleeping through the wait is not the host's update taking that long.
  // Monotonic: the waits below are this process's own; the host's runner keeps its own clock.
  const now = opts.now ?? (() => performance.now())
  const { run, writeFile, readText } = host
  if (!directory || !STAGING.test(directory)) throw new Error('the update runs from a staging dir of its own')
  const script = runnerScript({
    directory, command, executable, tries: opts.tries, pauseSeconds: opts.pauseSeconds, settleSeconds: opts.settleSeconds, latest: opts.latestMarker,
    tail: { scope, ...opts.tail }, build,
  })
  if (!(await writeFile(`${directory}/update.sh`, Buffer.from(script)))) throw new Error('the update script could not be put on the host')
  // The upload is on the host: a short hold (a file write, a dropped link) is waited out, not paid for with another upload.
  const holdWait = opts.holdWaitMs ?? HOLD_WAIT_MS
  const holdUntil = now() + holdWait
  let held = (await opts.beforeLaunch?.()) ?? null
  while (held && now() < holdUntil && !opts.cancelled?.()) {
    await sleep(Math.min(2_000, Math.max(50, holdWait / 4)))
    held = (await opts.beforeLaunch?.()) ?? null
  }
  if (held) throw new NetUpdateHeldError(held)
  const said = await run(launcherScript(directory, opts.latestMarker), 30_000).catch((err: Error) => `${err.message}`)
  if (said.includes(RUNNER_BUSY)) throw new NetUpdateHeldError(said.includes(`${RUNNER_BUSY} probation`) ? PROBATION_BUSY : 'another daemon update is still running on the host')
  if (!said.includes(LAUNCHED)) throw new Error(`the update did not start detached from the daemon: ${said.slice(-300)}`)
  opts.onLaunched?.(directory)
  // The old daemon exits during the handover: reads fail until the link is back on the new one.
  const deadline = now() + (opts.waitMs ?? UPDATE_WAIT_MS)
  while (now() < deadline) {
    await sleep(opts.pollMs ?? POLL_MS)
    if (opts.cancelled?.()) throw new NetUpdateUnansweredError('nobody waits for the update any more; it may still finish on the host', directory)
    const record = await readNetUpdateRecord(readText, directory)
    if (record) return answerOfRecord(record)
  }
  throw new NetUpdateUnansweredError(`the update on the host did not report back within ${Math.round((opts.waitMs ?? UPDATE_WAIT_MS) / 1000)} s; it may still finish there`, directory)
}

/** What the runner left in its staging dir: its done line, the update's answer and its stderr, the tail's record. */
export interface NetUpdateRecord { done: string; out: string; err?: string; tail: UpdateTail | null }

/** The record once update.done is there (the runner writes it last), else null. */
export async function readNetUpdateRecord(read: (path: string) => Promise<string | null>, directory: string): Promise<NetUpdateRecord | null> {
  const done = await read(`${directory}/update.done`)
  if (done === null) return null
  return {
    done, out: (await read(`${directory}/update.out`)) ?? '', err: (await read(`${directory}/update.err`)) ?? '',
    tail: parseUpdateTail(await read(`${directory}/${TAIL_FILE}`)),
  }
}

/** The update's answer from the record, for judgeServiceUpdate (daemon-service-update.ts). */
export function answerOfRecord(record: NetUpdateRecord): { output: string; tail: UpdateTail | null } {
  if (record.done.includes(SUPERSEDED)) throw new Error('a later update on the host took over before this one ran')
  // Nothing changed (the last update's probation was at work): a hold, asked again later.
  if (record.done.includes(PROBING_RC)) throw new NetUpdateHeldError(PROBATION_BUSY)
  const at = record.out.indexOf('{')
  // The CLI gave up on the install lock another `walnut daemon` held (its last try): it changed
  // nothing, so a hold asked again later, not a failure with a cooldown (2026-11-04 review).
  if (at < 0 && /File lock timeout/.test(record.err ?? '') && !tailSteppedIn(record.tail)) {
    throw new NetUpdateHeldError('another `walnut daemon` command held the service install lock on the host, so nothing was changed')
  }
  if (at < 0) {
    const after = tailSteppedIn(record.tail) ? `; afterwards on the host: ${record.tail!.words}` : ''
    const said = [record.out.trim(), (record.err ?? '').trim()].filter(Boolean).join(' / ').slice(-300)
    throw new Error(`the update gave no answer Walnut could read (${record.done.trim()}): ${said}${after}`)
  }
  return { output: record.out.slice(at), tail: record.tail }
}

/**
 * fs.read of one text file over the link; null when it is not there or the link is down.
 * `strict`: a link that could not answer throws instead, so "not there" means not there.
 */
export function netReadText(conn: NetUpdateConn, o: { strict?: boolean } = {}): (path: string) => Promise<string | null> {
  return async (path) => {
    let reply: Record<string, unknown>
    try {
      reply = await conn.send('fs.read', { path, encoding: 'utf8' }, 15_000)
    } catch (error) {
      if (o.strict) throw error
      return null
    }
    return reply.ok === true && typeof reply.data === 'string' ? reply.data : null
  }
}
