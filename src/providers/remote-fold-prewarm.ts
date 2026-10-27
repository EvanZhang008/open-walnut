/**
 * Fold prewarm for a REMOTE daemon upgrade: the remote twin of fold-prewarm.ts.
 *
 * A remote daemon of another version is stopped, the new source deployed and
 * started (DaemonConnection.shouldUpgradeDaemon). The new daemon adopts every
 * live CLI by folding its stream before it listens, and a checkpoint FORMAT
 * change rejects every checkpoint: on 2026-10-26 the local daemon was down for
 * 7 minutes that way, and the always-on dev host carries about 2 GB of live
 * streams (one of 1 GB).
 *
 * So before that stop, one read-only probe asks the host whether any registered
 * stream worth a checkpoint lacks one in the NEW format. Only then is the new
 * source uploaded to its own directory and run with `--prewarm-folds` while the
 * old daemon keeps serving; it writes `<stream>.jsonl.fold.next`, which the new
 * daemon's adopt picks when it reaches further. An ordinary upgrade (same
 * format) costs the one probe and nothing else. Best effort throughout: any
 * failure lets the upgrade go ahead as before.
 *
 * The run is detached on the host and named by a pid file, like the local
 * prewarm's lock: an ssh that drops, or a server restart (every deploy), must
 * neither leave it folding behind a new daemon's boot nor start a second one,
 * so the probe reports a live prewarm and the caller waits for it.
 */
import { shq } from './remote-sh.js'

/** Streams below this fold fast enough at boot (fold-checkpoint-core MIN_BYTES). */
export const REMOTE_FOLD_PREWARM_MIN_BYTES = 8 * 1024 * 1024
/** How long one remote prewarm may fold before the upgrade goes ahead without the rest. */
export const REMOTE_FOLD_PREWARM_MAX_MS = 10 * 60_000
const PROBE_DONE = 'walnut-fold-prewarm-probe-done'
const NEEDED = 'walnut-fold-prewarm-needed'
const RUNNING = 'walnut-fold-prewarm-running'
const GONE = 'walnut-fold-prewarm-gone'
const EXIT = 'walnut-fold-prewarm-exit='
const POLL_MS = 2_000

/** Where the new source runs from: its own dir, so it loads none of the old daemon's sidecars. */
export function remoteFoldPrewarmDir(daemonDir: string): string {
  return `${daemonDir}/fold-prewarm`
}

/** The running prewarm's pid, beside the daemon's own pid file. */
export function remoteFoldPrewarmPidFile(daemonDir: string): string {
  return `${daemonDir}/fold-prewarm.pid`
}

/** Prints RUNNING when the pid file names a live prewarm (a reused pid runs something else). */
function runningCheck(daemonDir: string): string[] {
  const pidFile = shq(remoteFoldPrewarmPidFile(daemonDir))
  return [
    'walnut_pw_live=',
    `walnut_pw_pid=$(cat ${pidFile} 2>/dev/null)`,
    'case "$walnut_pw_pid" in ""|*[!0-9]*) ;; *)',
    `  if kill -0 "$walnut_pw_pid" 2>/dev/null && ps -p "$walnut_pw_pid" -o args= 2>/dev/null | grep -q -- '--prewarm-folds'; then walnut_pw_live=1; echo "${RUNNING} $walnut_pw_pid"; fi ;;`,
    'esac',
  ]
}

/**
 * Read-only: one line per registered stream of at least the checkpoint size
 * whose `.fold` and `.fold.next` are both missing or of another format. A
 * checkpoint file starts with `{"v":<format>,` (fold-checkpoint-core write).
 */
export function buildRemoteFoldPrewarmProbe(daemonDir: string, format: number): string {
  if (!Number.isSafeInteger(format) || format < 0) throw new Error(`invalid fold checkpoint format: ${format}`)
  const registry = shq(`${daemonDir}/sessions.json`)
  const head = `{"v":${format},`
  return [
    ...runningCheck(daemonDir),
    `if [ -r ${registry} ]; then`,
    `  grep -o '"jsonlPath":"[^"]*"' ${registry} | sed 's/^"jsonlPath":"//; s/"$//' | while IFS= read -r p; do`,
    '    [ -f "$p" ] || continue',
    '    s=$(wc -c < "$p" 2>/dev/null | tr -d " ") || continue',
    '    case "$s" in ""|*[!0-9]*) continue;; esac',
    `    [ "$s" -ge ${REMOTE_FOLD_PREWARM_MIN_BYTES} ] || continue`,
    '    ok=',
    '    for c in "$p.fold" "$p.fold.next"; do',
    `      [ -f "$c" ] && [ "$(head -c ${head.length} "$c" 2>/dev/null)" = ${shq(head)} ] && ok=1`,
    '    done',
    `    [ -n "$ok" ] || echo "${NEEDED} $s"`,
    '  done',
    'fi',
    `echo ${PROBE_DONE}`,
  ].join('\n')
}

/** The probe's answer, or null when it did not finish (no sentinel: not "nothing needed"). */
export function parseRemoteFoldPrewarmProbe(output: string): { streams: number; bytes: number; running: boolean } | null {
  const lines = output.split('\n').map((l) => l.trim())
  if (!lines.includes(PROBE_DONE)) return null
  let streams = 0
  let bytes = 0
  const running = lines.some((l) => l.startsWith(RUNNING + ' '))
  for (const line of lines) {
    if (!line.startsWith(NEEDED + ' ')) continue
    const size = Number(line.slice(NEEDED.length + 1))
    if (!Number.isFinite(size)) continue
    streams++
    bytes += size
  }
  return { streams, bytes, running }
}

export interface RemoteFoldPrewarmCmdOpts {
  daemonDir: string
  /** bun by absolute path, or node found through the user's shell (`preamble`). */
  runtime: 'bun' | 'node'
  execPath?: string
  preamble?: string
  /** The daemon's own dir env (DaemonConnection.dirEnv), so it reads the same registry. */
  env: Record<string, string>
  /** The child's own fold budget; it saves its progress and exits at the end of it. */
  budgetMs: number
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Start the uploaded source with `--prewarm-folds`, detached: it outlives the
 * ssh that started it, writes its summary and exit status next to it, and the
 * pid file names it. The deadline comes from the host's own clock (the Mac's
 * may differ). Its stdin is /dev/null: the script itself rides this shell's stdin.
 */
export function buildRemoteFoldPrewarmStartCmd(opts: RemoteFoldPrewarmCmdOpts): string {
  if (opts.runtime === 'bun' && !opts.execPath) throw new Error("runtime 'bun' requires execPath")
  for (const [key, value] of Object.entries(opts.env)) {
    if (!ENV_KEY_RE.test(key)) throw new Error(`invalid daemon env var name: ${key}`)
    if (value.includes('\n')) throw new Error(`daemon env var ${key} must be single-line`)
  }
  const dir = remoteFoldPrewarmDir(opts.daemonDir)
  const env = Object.entries(opts.env).map(([k, v]) => `${k}=${shq(v)}`)
  env.push('WALNUT_FOLD_PREWARM_DEADLINE="$1"')
  const runner = opts.runtime === 'bun' ? shq(opts.execPath!) : 'node'
  const child = `env ${env.join(' ')} ${runner} ./daemon.cjs --prewarm-folds > out.json 2>> ${shq(`${opts.daemonDir}/fold-prewarm.log`)}; echo $? > rc`
  return [
    ...(opts.runtime === 'node' ? [opts.preamble ?? 'true'] : []),
    `cd ${shq(dir)} || exit 1`,
    'rm -f rc out.json',
    `walnut_pw_dl=$(( $(date +%s) * 1000 + ${Math.max(1000, Math.floor(opts.budgetMs))} ))`,
    `nohup sh -c ${shq(child)} walnut-fold-prewarm "$walnut_pw_dl" < /dev/null > /dev/null 2>&1 &`,
    `echo $! > ${shq(remoteFoldPrewarmPidFile(opts.daemonDir))}`,
    `echo "${RUNNING} $!"`,
  ].join('\n')
}

/** One look at the run: its exit status and summary once it ended, else whether it still runs. */
export function buildRemoteFoldPrewarmPollCmd(daemonDir: string): string {
  const dir = remoteFoldPrewarmDir(daemonDir)
  // Liveness first, then the status file: a run that ends between the two
  // still reads as ended, never as gone.
  return [
    ...runningCheck(daemonDir),
    `if [ -s ${shq(`${dir}/rc`)} ]; then echo "${EXIT}$(cat ${shq(`${dir}/rc`)})"; cat ${shq(`${dir}/out.json`)} 2>/dev/null; echo`,
    `elif [ -z "$walnut_pw_live" ]; then echo ${GONE}; fi`,
  ].join('\n')
}

export type RemoteFoldPrewarmPoll =
  | { state: 'exited'; code: number | null; summary: Record<string, unknown> | null }
  | { state: 'running' }
  | { state: 'gone' }

export function parseRemoteFoldPrewarmPoll(output: string): RemoteFoldPrewarmPoll | null {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean)
  const exitLine = lines.find((l) => l.startsWith(EXIT))
  if (exitLine) {
    const code = Number(exitLine.slice(EXIT.length))
    let summary: Record<string, unknown> | null = null
    for (const line of lines) {
      if (!line.startsWith('{')) continue
      try { summary = JSON.parse(line) as Record<string, unknown> } catch { /* daemon noise */ }
    }
    return { state: 'exited', code: Number.isFinite(code) ? code : null, summary }
  }
  if (lines.some((l) => l.startsWith(RUNNING + ' '))) return { state: 'running' }
  if (lines.includes(GONE)) return { state: 'gone' }
  return null
}

export interface RemoteFoldPrewarmIo {
  daemonDir: string
  format: number
  /** sshExec: a `sh -s` script, its marked output. */
  exec: (script: string, timeoutMs: number) => Promise<string>
  /** Write `content` to `remotePath`. */
  upload: (remotePath: string, content: string) => Promise<void>
  /** The new daemon source (getDaemonSource). */
  source: () => string
  /** A bun that runs on the host, or null to use node. */
  bunPath: () => Promise<string | null>
  preamble: string
  env: Record<string, string>
  /** False once the connection is gone: stop waiting. */
  alive?: () => boolean
  maxMs?: number
  pollMs?: number
}

export type RemoteFoldPrewarmResult =
  | { outcome: 'not-needed' }
  | { outcome: 'waited'; ms: number }
  | { outcome: 'ran'; streams: number; bytes: number; runtime: 'bun' | 'node'; summary: Record<string, unknown> | null; ms: number }

/**
 * Wait for the prewarm the pid file names. A poll the link did not answer is
 * asked again (the run goes on without us); resolves when the run ended.
 */
async function waitForRun(io: RemoteFoldPrewarmIo, until: number): Promise<RemoteFoldPrewarmPoll> {
  const pollMs = io.pollMs ?? POLL_MS
  for (;;) {
    if (io.alive && !io.alive()) throw new Error('the connection closed while the fold prewarm ran')
    let poll: RemoteFoldPrewarmPoll | null = null
    try { poll = parseRemoteFoldPrewarmPoll(await io.exec(buildRemoteFoldPrewarmPollCmd(io.daemonDir), 20_000)) } catch { /* asked again */ }
    if (poll && poll.state !== 'running') return poll
    if (Date.now() >= until) throw new Error(`fold prewarm still running after ${Math.round((io.maxMs ?? REMOTE_FOLD_PREWARM_MAX_MS) / 1000)}s`)
    await new Promise((r) => setTimeout(r, pollMs))
  }
}

async function cleanUp(io: RemoteFoldPrewarmIo): Promise<void> {
  const dir = remoteFoldPrewarmDir(io.daemonDir)
  await io.exec(`rm -rf ${shq(dir)} && rm -f ${shq(remoteFoldPrewarmPidFile(io.daemonDir))}`, 10_000)
    .catch(() => { /* the next prewarm clears it first */ })
}

/** Probe, and when a stream needs it, prepare (or wait for the prewarm already running). */
export async function runRemoteFoldPrewarm(io: RemoteFoldPrewarmIo): Promise<RemoteFoldPrewarmResult> {
  const startedAt = Date.now()
  const maxMs = io.maxMs ?? REMOTE_FOLD_PREWARM_MAX_MS
  const until = startedAt + maxMs
  const probe = parseRemoteFoldPrewarmProbe(await io.exec(buildRemoteFoldPrewarmProbe(io.daemonDir, io.format), 20_000))
  if (!probe) throw new Error('fold prewarm probe did not finish')
  if (probe.running) {
    // Started by an earlier server (a deploy restarted it): its result is ours.
    const end = await waitForRun(io, until)
    if (end.state !== 'running') await cleanUp(io)
    return { outcome: 'waited', ms: Date.now() - startedAt }
  }
  if (probe.streams === 0) return { outcome: 'not-needed' }

  const dir = remoteFoldPrewarmDir(io.daemonDir)
  await io.exec(`rm -rf ${shq(dir)} && mkdir -p ${shq(dir)}`, 10_000)
  let started = false
  let ended = false
  try {
    await io.upload(`${dir}/daemon.cjs`, io.source())
    const bun = await io.bunPath()
    const runtime: 'bun' | 'node' = bun ? 'bun' : 'node'
    await io.exec(buildRemoteFoldPrewarmStartCmd({
      daemonDir: io.daemonDir, runtime, execPath: bun ?? undefined, preamble: io.preamble, env: io.env,
      // The child stops itself first and saves what it folded.
      budgetMs: Math.max(maxMs / 2, maxMs - 30_000),
    }), 20_000)
    started = true
    const end = await waitForRun(io, until)
    ended = true
    if (end.state === 'gone') throw new Error('fold prewarm ended without an exit status')
    if (end.state === 'exited' && end.code !== 0) throw new Error(`fold prewarm exited with code ${end.code ?? 'unknown'}`)
    return {
      outcome: 'ran', streams: probe.streams, bytes: probe.bytes, runtime,
      summary: end.state === 'exited' ? end.summary : null, ms: Date.now() - startedAt,
    }
  } finally {
    // A run still going keeps its files: the next probe finds it by its pid.
    if (!started || ended) await cleanUp(io)
  }
}
