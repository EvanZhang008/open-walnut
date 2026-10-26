/**
 * Fold prewarm: prepare the next daemon's fold checkpoints while the running
 * daemon still serves.
 *
 * Why: replacing the local daemon (a deploy that changes daemon code) makes the
 * new daemon adopt every live CLI by folding its stream file before it listens.
 * Checkpoints keep that short, but a checkpoint FORMAT change rejects all of
 * them. On 2026-10-26 the new daemon folded 8.8 GB that way (one 3.2 GB stream
 * took 354s): 7 minutes with no local sessions, every message failing with
 * "port file not created within 10s".
 *
 * So before stopping a daemon of another version, the server runs the NEW
 * binary with `--prewarm-folds`. It folds each registered session's stream and
 * writes `<stream>.jsonl.fold.next`, which the old daemon never writes, and the
 * new daemon's adopt then folds only what came after. The prewarm is best
 * effort: a failure or the deadline just lets the upgrade go ahead as before,
 * and a run cut short still saves how far it got (every 256 MB, and at its own
 * deadline), so the adopt has that much less to fold.
 *
 * One prewarm per daemon dir: a lock file names the running one, and a second
 * server (a deploy restarts the server every few minutes) waits for it instead
 * of folding the same gigabytes again. It runs in its own process group so a
 * server restart does not end it halfway through a whale stream.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

/** A stream smaller than this folds fast enough at boot (fold-checkpoint-core MIN_BYTES). */
export const FOLD_PREWARM_MIN_BYTES = 8 * 1024 * 1024
/** Upper bound on one prewarm; past it the upgrade goes ahead without it. */
export const FOLD_PREWARM_MAX_MS = 10 * 60_000
/** The child stops this long before the deadline, saving its progress, so the
 *  backstop kill never has to cut a fold in the middle. */
const CHILD_DEADLINE_MARGIN_MS = 20_000
const LOCK_FILE = 'fold-prewarm.json'
const POLL_MS = 1000

export interface FoldPrewarmResult {
  /** 'ran': this call ran it; 'waited': another server's prewarm ran it. */
  outcome: 'ran' | 'waited'
  sessions?: number
  written?: number
  /** Streams the child's deadline stopped part way (their progress is saved). */
  cut?: number
  ms: number
}

/** True when a session in the daemon's registry has a stream worth preparing. */
export async function registryNeedsFoldPrewarm(daemonDir: string): Promise<boolean> {
  let sessions: Record<string, { jsonlPath?: unknown }>
  try {
    const raw = await fs.promises.readFile(path.join(daemonDir, 'sessions.json'), 'utf-8')
    const data = JSON.parse(raw) as { sessions?: unknown }
    if (!data || typeof data.sessions !== 'object' || !data.sessions || Array.isArray(data.sessions)) return false
    sessions = data.sessions as Record<string, { jsonlPath?: unknown }>
  } catch {
    return false
  }
  for (const entry of Object.values(sessions)) {
    const jsonlPath = entry && entry.jsonlPath
    if (typeof jsonlPath !== 'string' || !jsonlPath) continue
    try {
      if ((await fs.promises.stat(jsonlPath)).size >= FOLD_PREWARM_MIN_BYTES) return true
    } catch { /* gone: nothing to prepare */ }
  }
  return false
}

function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false
  try { process.kill(pid, 0); return true } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM' }
}

interface PrewarmLock { pid: number; version: string; startedAt: number }

function readLock(file: string): PrewarmLock | null {
  try {
    const lock = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<PrewarmLock>
    if (typeof lock.pid !== 'number' || typeof lock.version !== 'string' || typeof lock.startedAt !== 'number') return null
    return lock as PrewarmLock
  } catch {
    return null
  }
}

/**
 * Run (or wait for) the prewarm of `binaryPath` against the daemon dir. Resolves
 * when it is over; rejects when it failed. Never stops or touches a daemon.
 */
export async function runFoldPrewarm(opts: {
  binaryPath: string
  version: string
  daemonDir: string
  env: NodeJS.ProcessEnv
  stderrFd?: number | null
  maxMs?: number
}): Promise<FoldPrewarmResult> {
  const startedAt = Date.now()
  const maxMs = opts.maxMs ?? FOLD_PREWARM_MAX_MS
  const lockFile = path.join(opts.daemonDir, LOCK_FILE)
  const held = readLock(lockFile)
  if (held && held.version === opts.version && held.pid !== process.pid && pidAlive(held.pid)
    && startedAt - held.startedAt < maxMs) {
    const deadline = held.startedAt + maxMs
    while (pidAlive(held.pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, POLL_MS))
    return { outcome: 'waited', ms: Date.now() - startedAt }
  }

  const isSourceScript = opts.binaryPath.endsWith('.cjs') || opts.binaryPath.endsWith('.js')
  const [cmd, args] = isSourceScript
    ? [process.execPath, [opts.binaryPath, '--prewarm-folds']]
    : [opts.binaryPath, ['--prewarm-folds']]
  const child = spawn(cmd, args, {
    detached: true,
    cwd: opts.daemonDir,
    stdio: ['ignore', 'pipe', opts.stderrFd ?? 'ignore'],
    // The child's own clock: it outlives this server (detached), so a restart
    // mid-run must not leave it folding past the deadline.
    env: { ...opts.env, WALNUT_FOLD_PREWARM_DEADLINE: String(startedAt + Math.max(maxMs / 2, maxMs - CHILD_DEADLINE_MARGIN_MS)) },
  })
  const pid = child.pid ?? 0
  if (pid > 1) {
    try {
      fs.writeFileSync(lockFile, JSON.stringify({ pid, version: opts.version, startedAt }), { mode: 0o600 })
    } catch { /* a missing lock only costs a second server a duplicate prewarm */ }
  }
  let out = ''
  child.stdout?.on('data', (chunk: Buffer) => { if (out.length < 4096) out += chunk.toString() })
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Only the child we spawned, never a group or a pid we did not start.
        child.kill('SIGTERM')
        reject(new Error(`fold prewarm exceeded ${Math.round(maxMs / 1000)}s`))
      }, maxMs)
      timer.unref?.()
      child.once('error', (err) => { clearTimeout(timer); reject(err) })
      child.once('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode) })
    })
    if (code !== 0) throw new Error(`fold prewarm exited with code ${code}`)
    let summary: { sessions?: number; written?: number; cut?: number } = {}
    try { summary = JSON.parse(out.trim().split('\n').pop() || '{}') } catch { /* counts are informational */ }
    return { outcome: 'ran', sessions: summary.sessions, written: summary.written, cut: summary.cut, ms: Date.now() - startedAt }
  } finally {
    const lock = readLock(lockFile)
    if (lock && lock.pid === pid) { try { fs.unlinkSync(lockFile) } catch { /* already gone */ } }
  }
}
