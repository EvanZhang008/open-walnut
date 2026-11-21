/**
 * A plugin script (exec.script) that outlives the daemon that started it ('host-script-detach-v1'):
 * the server names the run (`scriptId`, `hs-...`) and asks with `detach`; its text goes to it on
 * fd 3 from a file, its stdout and stderr go to files, and the detached-run.ts wrapper writes its
 * exit status. When the daemon restarts mid-run, the server asks again with the same id: the
 * next daemon answers with that run's result (following it to its end first), never a second run.
 * A finished run's result is kept RESULT_KEEP_MS for such a late ask.
 *
 * On disk, per run: `<root>/<scriptId>/` with `script`, `out`, `err`, `exit`, `meta.json` (what a
 * later daemon needs: the deadline, the output cap, the mark, the wrapper's pid) and, once ended,
 * `result.json`. A daemon starts by following every run with no result (its deadline holds).
 *
 * The answer is the one runBoundedScript gives a run with pipes (host-script-core.ts): stdout after
 * the mark the login shell prints, at most `maxOutputBytes` (more ends the run, `truncated`), the end
 * of stderr, `timedOut` past the deadline.
 *
 * Bundled into host-exec-core (the binary daemon and the host-exec-core.cjs sidecar).
 */
import fs from 'node:fs'
import path from 'node:path'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { detachedChild, exitOf, readExitFile, wrapperArgv } from './detached-run.js'
import { ROLLBACK_NOTE, installStopScript, registerRun, registryFile, unregisterRun } from './detached-registry.js'
import { SCRIPT_STDERR_TAIL, type ScriptResult } from './host-script-core.js'

export const SCRIPT_ID_RE = /^hs-[A-Za-z0-9_-]{4,64}$/
/** How long a finished run's result is kept for a late ask (the caller's daemon restarted). */
/** Said in a let-go run's stderr: nothing stopped it, and it may still run. */
const LET_GO_NOTE = 'the host could not confirm this process was still the script, so Walnut stopped following it at its deadline without signalling it; it may still run'
/** ps with no answer at adoption is asked again this many times, this far apart, before the run is followed unverified. */
const ADOPT_PS_TRIES = 10
const ADOPT_PS_RETRY_MS = 1_000
export const RESULT_KEEP_MS = 10 * 60_000
const KILL_GRACE_MS = 5_000
/** What a login profile may print before the mark; past it, everything is stdout (host-script-core.ts). */
const PREAMBLE_MAX = 1024 * 1024
const CAP_CHECK_MS = 250

export interface DetachedScriptDeps {
  spawn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess
  killGroup: (pid: number, signal: NodeJS.Signals | 0) => void
  /** Where each run keeps its files. */
  root: string
  registryDir: string
  processStart: (pid: number) => Promise<string | null>
  pidAlive: (pid: number) => boolean
  now?: () => number
}

export interface DetachedStart {
  scriptId: string
  script: string
  command: string
  argv: string[]
  env: NodeJS.ProcessEnv
  cwd: string
  mark: string
  timeoutMs: number
  maxOutputBytes: number
}

interface Meta { scriptId: string; startedAt: number; timeoutMs: number; maxOutputBytes: number; mark: string; pid?: number; lstart?: string; daemonPid: number }

interface Run {
  id: string
  dir: string
  meta: Meta
  pid: number | null
  timedOut: boolean
  truncated: boolean
  signalled: boolean
  rollback: boolean
  /** Adopted with no start to check its pid, and past its deadline: no longer followed, never signalled. */
  letGo?: boolean
  ended: boolean
  /** Its result once it ended; settled by `settle` (follow), so a second ask while it starts waits for the same one. */
  done: Promise<ScriptResult>
  settle: (r: ScriptResult) => void
  stop: () => void
}

const files = (dir: string) => ({
  script: path.join(dir, 'script'), out: path.join(dir, 'out'), err: path.join(dir, 'err'),
  exit: path.join(dir, 'exit'), meta: path.join(dir, 'meta.json'), result: path.join(dir, 'result.json'),
})

function readTail(file: string, max: number): string {
  try {
    const size = fs.statSync(file).size
    const len = Math.min(size, max)
    const buf = Buffer.alloc(len)
    const fd = fs.openSync(file, 'r')
    try { fs.readSync(fd, buf, 0, len, size - len) } finally { fs.closeSync(fd) }
    return buf.toString('utf8')
  } catch { return '' }
}

/** Where stdout starts in the out file: just past the mark; null while the mark is not there yet. */
function stdoutStart(outFile: string, mark: string): number | null {
  try {
    const fd = fs.openSync(outFile, 'r')
    try {
      const want = Buffer.from(`${mark}\n`)
      const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, PREAMBLE_MAX + want.length))
      fs.readSync(fd, buf, 0, buf.length, 0)
      const at = buf.indexOf(want)
      return at >= 0 ? at + want.length : null
    } finally { fs.closeSync(fd) }
  } catch { return null }
}

export function createDetachedScripts(deps: DetachedScriptDeps) {
  const now = deps.now ?? Date.now
  const runs = new Map<string, Run>()
  let scriptPut = false

  function resultOf(run: Run, status: number | null, signal: string | null): ScriptResult {
    const f = files(run.dir)
    const stderr = readTail(f.err, SCRIPT_STDERR_TAIL)
    const start = stdoutStart(f.out, run.meta.mark)
    let size = 0
    try { size = fs.statSync(f.out).size } catch { /* none */ }
    // The mark never came: the login shell ended (an `exit` in a profile) or hung before the script.
    if (start === null && size <= PREAMBLE_MAX && !run.timedOut) {
      return { code: 255, stdout: '', stderr: `${stderr}walnut: the login shell never started the script`.slice(-SCRIPT_STDERR_TAIL), timedOut: false, truncated: false }
    }
    const from = start ?? 0
    const len = Math.max(0, Math.min(size - from, run.meta.maxOutputBytes))
    const buf = Buffer.alloc(len)
    try {
      const fd = fs.openSync(f.out, 'r')
      try { fs.readSync(fd, buf, 0, len, from) } finally { fs.closeSync(fd) }
    } catch { /* gone */ }
    const truncated = run.truncated || size - from > run.meta.maxOutputBytes
    const end = status !== null ? exitOf(status, run.signalled) : { code: null, signal }
    return {
      code: run.timedOut || truncated ? null : end.code,
      stdout: buf.toString('utf8'),
      stderr: (run.rollback ? `${stderr}\nwalnut: ${ROLLBACK_NOTE}` : run.letGo ? `${stderr}\nwalnut: ${LET_GO_NOTE}` : stderr).slice(-SCRIPT_STDERR_TAIL),
      timedOut: run.timedOut,
      truncated,
    }
  }

  /** Follow a run to its end: its deadline, its output cap, then its result on disk. */
  function follow(run: Run, child: ChildProcess): void {
    const f = files(run.dir)
    let killTimer: ReturnType<typeof setTimeout> | undefined
    run.stop = () => {
      if (run.ended || run.pid === null) return
      run.signalled = true
      try { deps.killGroup(run.pid, 'SIGTERM') } catch { /* gone */ }
      killTimer ??= setTimeout(() => {
        if (run.ended || run.pid === null) return
        try { deps.killGroup(run.pid, 0); deps.killGroup(run.pid, 'SIGKILL') } catch { /* the group is empty */ }
      }, KILL_GRACE_MS)
      killTimer.unref?.()
    }
    const deadline = setTimeout(() => { run.timedOut = true; run.stop() }, Math.max(0, run.meta.startedAt + run.meta.timeoutMs - now()))
    deadline.unref?.()
    let markAt: number | null = null
    let looking = false
    const cap = setInterval(() => {
      if (run.ended || looking) return
      looking = true
      void fs.promises.stat(f.out).then((st) => {
        if (run.ended || st.size <= run.meta.maxOutputBytes) return
        markAt ??= stdoutStart(f.out, run.meta.mark)
        if (st.size - (markAt ?? 0) > run.meta.maxOutputBytes) { run.truncated = true; run.stop() }
      }, () => {}).finally(() => { looking = false })
    }, CAP_CHECK_MS)
    cap.unref?.()
    const settle = run.settle
    child.on('error', (err) => {
      if (run.ended) return
      run.ended = true
      clearTimeout(deadline); clearInterval(cap)
      settle({ code: null, stdout: '', stderr: err.message, timedOut: false, truncated: false })
    })
    child.on('exit', (_code: number | null, signal: string | null) => {
      if (run.ended) return
      run.ended = true
      clearTimeout(deadline); clearInterval(cap)
      if (killTimer) clearTimeout(killTimer)
      void (async () => {
        const result = resultOf(run, await readExitFile(f.exit), signal)
        try { await fs.promises.writeFile(f.result, JSON.stringify({ ...result, endedAt: now() }), { mode: 0o600 }) } catch { /* kept in memory */ }
        settle(result)
        for (const file of [f.script, f.exit, `${f.exit}.t`]) { try { await fs.promises.unlink(file) } catch { /* gone */ } }
        await unregisterRun(deps.registryDir, 'host-script', run.id)
      })()
    })
  }

  async function list(run: Run): Promise<void> {
    if (run.pid === null) return
    if (!scriptPut) { scriptPut = true; void installStopScript(deps.registryDir) }
    const lstart = await deps.processStart(run.pid)
    if (!lstart || run.ended) return
    // The start a later daemon checks before it adopts or signals this pid (fromDisk).
    run.meta.lstart = lstart
    await fs.promises.writeFile(files(run.dir).meta, JSON.stringify(run.meta), { mode: 0o600 }).catch(() => {})
    await registerRun(deps.registryDir, { kind: 'host-script', id: run.id, pid: run.pid, pgid: run.pid, lstart, noteFile: files(run.dir).err, note: `walnut: ${ROLLBACK_NOTE}` })
    if (run.ended) await unregisterRun(deps.registryDir, 'host-script', run.id)
  }

  function newRun(id: string, dir: string, meta: Meta): Run {
    let settle: (r: ScriptResult) => void = () => {}
    const done = new Promise<ScriptResult>((resolve) => { settle = resolve })
    return { id, dir, meta, pid: meta.pid ?? null, timedOut: false, truncated: false, signalled: false, rollback: false, ended: false, done, settle, stop: () => {} }
  }

  /** A run on disk: its kept result, or (no result yet) the run followed from here. */
  async function fromDisk(id: string): Promise<ScriptResult | null> {
    const dir = path.join(deps.root, id)
    const f = files(dir)
    try {
      const kept = JSON.parse(await fs.promises.readFile(f.result, 'utf8')) as ScriptResult & { endedAt?: number }
      const { endedAt: _e, ...result } = kept
      return result
    } catch { /* no result yet */ }
    let meta: Meta
    try { meta = JSON.parse(await fs.promises.readFile(f.meta, 'utf8')) as Meta } catch { return null }
    if (runs.has(id)) return runs.get(id)!.done
    const run = newRun(id, dir, meta)
    runs.set(id, run)
    const pid = run.pid
    let alive = pid !== null && deps.pidAlive(pid)
    // Signalled only when the process holding its pid started when the listed one did; ps with no
    // answer is asked again (never read as "killed"), and a run with no start recorded (its daemon died
    // right after the spawn) is followed but never signalled, and let go past its deadline.
    let verified = false
    if (alive) {
      let listed: string | null = meta.lstart ?? null
      if (!listed) { try { listed = /^lstart=(.*)$/m.exec(await fs.promises.readFile(registryFile(deps.registryDir, 'host-script', id), 'utf8'))?.[1] ?? null } catch { /* not listed */ } }
      if (listed) {
        let nowStart: string | null = null
        for (let i = 0; i < ADOPT_PS_TRIES && nowStart === null && deps.pidAlive(pid!); i++) {
          nowStart = await deps.processStart(pid!)
          if (nowStart === null) await new Promise((r) => setTimeout(r, ADOPT_PS_RETRY_MS))
        }
        if (nowStart !== null) { verified = nowStart === listed; alive = verified } else alive = deps.pidAlive(pid!)
      }
    }
    if (!verified) run.pid = null
    const letGo = meta.startedAt + meta.timeoutMs + 60_000
    const wrapperAlive = () => {
      if (!alive || pid === null || !deps.pidAlive(pid)) return false
      if (verified || now() < letGo) return true
      run.letGo = true
      return false
    }
    follow(run, detachedChild({ exitFile: f.exit, wrapperAlive, killedBy: () => (run.letGo ? null : 'SIGKILL'), signalled: () => run.signalled }))
    return run.done
  }

  async function start(s: DetachedStart): Promise<ScriptResult> {
    const dir = path.join(deps.root, s.scriptId)
    const f = files(dir)
    await fs.promises.mkdir(deps.root, { recursive: true, mode: 0o700 })
    try {
      await fs.promises.mkdir(dir, { mode: 0o700 })
    } catch (err) {
      // The same run asked again (its first answer was lost): its result, never a second run.
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        const earlier = runs.get(s.scriptId)?.done ?? await fromDisk(s.scriptId)
        if (earlier) return earlier
      }
      throw err
    }
    const meta: Meta = { scriptId: s.scriptId, startedAt: now(), timeoutMs: s.timeoutMs, maxOutputBytes: s.maxOutputBytes, mark: s.mark, daemonPid: process.pid }
    await fs.promises.writeFile(f.script, s.script, { mode: 0o600 })
    await fs.promises.writeFile(f.meta, JSON.stringify(meta), { mode: 0o600 })
    const [scriptFh, outFh, errFh] = await Promise.all([fs.promises.open(f.script, 'r'), fs.promises.open(f.out, 'a', 0o600), fs.promises.open(f.err, 'a', 0o600)])
    const run = newRun(s.scriptId, dir, meta)
    runs.set(s.scriptId, run)
    let child: ChildProcess
    const closeFiles = () => { void Promise.all([scriptFh.close(), outFh.close(), errFh.close()]).catch(() => {}) }
    try {
      const w = wrapperArgv(s.command, s.argv, f.exit)
      child = deps.spawn(w.cmd, w.args, { cwd: s.cwd, detached: true, stdio: ['ignore', outFh.fd, errFh.fd, scriptFh.fd], env: s.env })
    } catch (err) {
      closeFiles()
      run.ended = true
      runs.delete(s.scriptId)
      const failed = { code: null, stdout: '', stderr: (err as Error).message, timedOut: false, truncated: false }
      run.settle(failed)
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
      return failed
    }
    // Closed once the child holds its own copies (Bun hands the fds over when it starts it).
    child.once('spawn', closeFiles)
    child.once('error', closeFiles)
    run.pid = typeof child.pid === 'number' ? child.pid : null
    if (run.pid !== null) {
      meta.pid = run.pid
      void fs.promises.writeFile(f.meta, JSON.stringify(meta), { mode: 0o600 }).catch(() => {})
      void list(run)
    }
    follow(run, detachedChild({ exitFile: f.exit, wrapper: child, signalled: () => run.signalled }))
    return run.done
  }

  /** Results past RESULT_KEEP_MS go, with their files. */
  async function prune(): Promise<void> {
    let names: string[] = []
    try { names = await fs.promises.readdir(deps.root) } catch { return }
    for (const name of names) {
      if (!SCRIPT_ID_RE.test(name) || (runs.has(name) && !runs.get(name)!.ended)) continue
      const dir = path.join(deps.root, name)
      let at: number
      try { at = (await fs.promises.stat(files(dir).result)).mtimeMs } catch { continue }
      if (now() - at > RESULT_KEEP_MS) {
        runs.delete(name)
        await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    }
  }

  /** Every run an earlier daemon here left with no result is followed from here (its deadline holds). */
  async function adoptAll(): Promise<number> {
    let names: string[] = []
    try { names = await fs.promises.readdir(deps.root) } catch { return 0 }
    let n = 0
    for (const name of names) {
      if (!SCRIPT_ID_RE.test(name) || runs.has(name)) continue
      if (await fs.promises.access(files(path.join(deps.root, name)).result).then(() => true, () => false)) continue
      if (await fromDisk(name)) n++
    }
    return n
  }

  return {
    start,
    /** The result of a run of this id here (running, or kept), else null. */
    resultOf: (id: string): Promise<ScriptResult | null> => runs.get(id)?.done ?? fromDisk(id),
    adoptAll,
    prune,
    running: (): number => { let n = 0; for (const r of runs.values()) if (!r.ended) n++; return n },
    /** A rollback: every running one is stopped, its answer saying why (detached-registry.ts ROLLBACK_NOTE). */
    endForRollback: (): number => {
      let n = 0
      for (const r of runs.values()) if (!r.ended && !r.rollback) { r.rollback = true; r.stop(); n++ }
      return n
    },
  }
}

export type DetachedScripts = ReturnType<typeof createDetachedScripts>
