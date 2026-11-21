/**
 * The service's side of the launcher (service-launcher-script.ts): what a service started by it
 * (WALNUT_LAUNCHER_DIR set) writes and reads in that dir. Both daemon twins use it (the JS twin
 * through daemon-cron-runtime.cjs), and so will the merged service.
 *
 *  - `heartbeat`: `<epoch s> <busy until, epoch s> <pid>` every BEAT_MS, written whole (temp, rename)
 *    and async. A blocked event loop writes none, which is what the launcher's stall check catches;
 *    busy(seconds) says one long thing is under way (a migration, a big adoption) so it waits.
 *  - `ready`: written once the service serves (sessions adopted, port listening): the launcher
 *    commits a trial only then.
 *  - `leaving`: written just before a planned exit (the service prepared for an update an older
 *    Walnut runs, which ends it with code 1 so a plain unit restarts it): the launcher counts it as
 *    no crash, so a new version in its probation is not put back for it.
 *  - versions: once a version is the good one, every staged version but the current, the good and
 *    the one a pending switch asks for goes (pruneDaemonServiceVersions keeps any a process runs and
 *    any staged in the last hour). The launcher's seed is not kept: it is only a fallback.
 *  - ready only after the core flow answers: the service asks itself, over its own port, hello (its
 *    instance and build) and status of a session it adopted (`ready(info, check)`); one that is up but
 *    answers wrong never writes ready, and the launcher puts the version before it back.
 *  - facts(): the launcher's state and its last put-back, for hello (the host's Settings row and
 *    Walnut Health on the server).
 *
 * Nothing here throws into the service, and nothing blocks it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { pruneDaemonServiceVersions } from './daemon-service-artifact.js'

export const BEAT_MS = 5_000
export const READY_RETRY_MS = 2_000
const FACTS_MS = 30_000

export type LauncherPhase = 'committed' | 'trial' | 'probation'

export interface LauncherRollback { at: number; from: string; to: string; build?: string; reason: string }

/** What a host says of its launcher: the version it runs, the one it goes back to, where a switch stands. */
export interface LauncherFacts {
  current: string
  good: string
  phase: LauncherPhase
  /** When the phase began (epoch s): a probation ends PROBATION_SECONDS after it. */
  since: number
  build?: string
  goodBuild?: string
  rollback?: LauncherRollback
}

function keyValues(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split('\n')) {
    const at = line.indexOf('=')
    if (at > 0 && !out.has(line.slice(0, at))) out.set(line.slice(0, at), line.slice(at + 1))
  }
  return out
}

const PHASES: readonly string[] = ['committed', 'trial', 'probation']

/** `launcher/state` and `launcher/rollback` as facts, or null when the state says nothing usable. */
export function parseLauncherFacts(stateText: string, rollbackText = ''): LauncherFacts | null {
  const s = keyValues(stateText)
  const current = s.get('current') ?? ''
  const phase = s.get('phase') ?? ''
  if (!current.startsWith('/') || !PHASES.includes(phase)) return null
  const facts: LauncherFacts = {
    current, good: s.get('good') ?? '', phase: phase as LauncherPhase, since: Number(s.get('since')) || 0,
    ...(s.get('build') ? { build: s.get('build') } : {}),
    ...(s.get('good_build') ? { goodBuild: s.get('good_build') } : {}),
  }
  const r = keyValues(rollbackText)
  const at = Number(r.get('at'))
  if (at > 0 && r.get('from') && r.get('reason')) {
    facts.rollback = { at, from: r.get('from')!, to: r.get('to') ?? '', reason: r.get('reason')!, ...(r.get('build') ? { build: r.get('build') } : {}) }
  }
  return facts
}

/** The launcher's facts in `dir`, read async; null when there is no launcher state there. */
export async function readLauncherFacts(dir: string): Promise<LauncherFacts | null> {
  const [state, rollback] = await Promise.all(['state', 'rollback'].map((name) => fs.promises.readFile(path.join(dir, name), 'utf8').catch(() => '')))
  return parseLauncherFacts(state!, rollback)
}

async function writeWhole(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.t`
  await fs.promises.writeFile(tmp, text, { mode: 0o600 })
  await fs.promises.rename(tmp, file)
}

function leavingText(pid: number, reason: string): string {
  return `pid=${pid}\nreason=${reason.replace(/[\r\n]+/g, ' ')}\nat=${Math.floor(Date.now() / 1000)}\n`
}

/**
 * Say for the service `pid` that its next exit is planned (a restart someone asked for): the launcher
 * in `dir` counts it as no crash. Async, for a caller that ends the service itself (walnut daemon restart).
 */
export async function markLauncherLeaving(dir: string, pid: number, reason: string): Promise<void> {
  await writeWhole(path.join(dir, 'leaving'), leavingText(pid, reason))
}

/** What a launcher must keep of the staged versions in `stateDir`: what it runs, goes back to and was asked for. */
export async function launcherKeeps(stateDir: string): Promise<string[]> {
  const dir = path.join(stateDir, 'launcher')
  const [facts, request] = await Promise.all([readLauncherFacts(dir), fs.promises.readFile(path.join(dir, 'request'), 'utf8').catch(() => '')])
  return [facts?.current, facts?.good, keyValues(request).get('exe')].filter((exe): exe is string => !!exe && exe.startsWith('/'))
}

/** A staged version younger than this is kept by the launcher's prune (an update may be about to ask for it). */
export const PRUNE_KEEP_NEWER_MS = 60 * 60 * 1000

/** One request to the service's own port, answered (a twin opens its socket the way it can). */
export type DaemonAsk = (cmd: Record<string, unknown>) => Promise<Record<string, unknown>>

interface SocketLike {
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: (() => void) | null
  onclose: (() => void) | null
  send(data: string): void
  close(): void
}
let askId = 900_000_000

/** One request to the daemon's own port over its own WebSocket client (bun's global one, or node's `ws`). */
export function askOwnPort(port: number, WS: new (url: string) => SocketLike, timeoutMs = 10_000): DaemonAsk {
  return (cmd) => new Promise((resolve, reject) => {
    const id = ++askId
    const ws = new WS(`ws://127.0.0.1:${port}`)
    const done = (err: Error | null, answer?: Record<string, unknown>) => {
      clearTimeout(timer)
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
      try { ws.close() } catch { /* closed */ }
      if (err) reject(err); else resolve(answer!)
    }
    const timer = setTimeout(() => done(new Error(`no answer to ${String(cmd.cmd)} in ${timeoutMs} ms`)), timeoutMs)
    ws.onopen = () => ws.send(JSON.stringify({ id, ...cmd }))
    ws.onmessage = (event) => {
      let m: Record<string, unknown>
      try { m = JSON.parse(String(event.data)) as Record<string, unknown> } catch { return }
      if (m.id === id) done(null, m)
    }
    ws.onerror = () => done(new Error('the socket failed'))
    ws.onclose = () => done(new Error('the socket closed before the answer'))
  })
}

/**
 * The core flow answers right: hello as this very daemon (its instance, its build), then status of a
 * session it adopted (exists), or of an unknown one (exists: false). null when it does, else why not.
 */
export async function daemonServesCheck(ask: DaemonAsk, expect: { instanceId: string; version?: string; sid?: string }): Promise<string | null> {
  const hello = await ask({ cmd: 'hello' })
  if (hello.ok !== true) return `hello did not answer ok: ${String(hello.error ?? JSON.stringify(hello)).slice(0, 200)}`
  if (hello.instanceId !== expect.instanceId) return `hello answered as instance ${String(hello.instanceId)}, not ${expect.instanceId}`
  if (expect.version && hello.version !== expect.version) return `hello answered build ${String(hello.version)}, not ${expect.version}`
  const sid = expect.sid ?? `ready-check-${process.pid}-${Date.now()}`
  const status = await ask({ cmd: 'status', sid })
  if (status.ok !== true) return `status did not answer ok: ${String(status.error ?? JSON.stringify(status)).slice(0, 200)}`
  if (status.exists !== (expect.sid !== undefined)) return `status of ${expect.sid ? `the adopted session ${sid}` : 'an unknown session'} answered exists=${String(status.exists)}`
  return null
}

export interface LauncherBeat {
  /**
   * The service serves: the launcher may commit it. With `check`, only once it passes (asked again every
   * READY_RETRY_MS until it does; the launcher's trial time decides when it gave up).
   */
  ready(info: { exe: string; instance?: string }, check?: () => Promise<string | null>): Promise<void>
  /** One long thing for up to `seconds`: the launcher does not take a quiet heartbeat for a stall meanwhile. */
  busy(seconds: number): void
  /** The long thing is over. */
  idle(): void
  /** About to exit on purpose (sync: the exit follows at once). */
  leaving(reason: string): void
  facts(): LauncherFacts | null
  stop(): void
}

/** Start the heartbeat when this process runs under a launcher (`dir`, WALNUT_LAUNCHER_DIR); null otherwise. */
export function startLauncherBeat(opts: {
  dir: string | undefined; pid?: number; everyMs?: number; warn?: (message: string) => void; onPruned?: (removed: string[]) => void
}): LauncherBeat | null {
  const dir = opts.dir
  if (!dir || !path.isAbsolute(dir)) return null
  const pid = opts.pid ?? process.pid
  const warn = opts.warn ?? (() => {})
  let busyUntil = 0
  let facts: LauncherFacts | null = null
  let warned = false
  let writing = false
  const beat = async (): Promise<void> => {
    if (writing) return
    writing = true
    try {
      await writeWhole(path.join(dir, 'heartbeat'), `${Math.floor(Date.now() / 1000)} ${busyUntil} ${pid}\n`)
      warned = false
    } catch (err) {
      if (!warned) warn(`launcher heartbeat not written: ${(err as Error).message}`)
      warned = true
    } finally { writing = false }
  }
  let stopped = false
  let prunedFor = ''
  const refresh = async (): Promise<void> => {
    facts = await readLauncherFacts(dir).catch(() => facts)
    // A version became the good one: the staged versions it no longer needs go, once per good version.
    if (facts && facts.phase === 'committed' && facts.current === facts.good && prunedFor !== facts.good) {
      prunedFor = facts.good
      const root = path.dirname(dir)
      const removed = await launcherKeeps(root).then((keep) => pruneDaemonServiceVersions(root, keep, { keepNewerThanMs: PRUNE_KEEP_NEWER_MS })).catch((err: unknown) => {
        warn(`old daemon versions were not pruned: ${err instanceof Error ? err.message : String(err)}`)
        return []
      })
      if (removed.length) opts.onPruned?.(removed)
    }
  }
  void beat(); void refresh()
  const beats = setInterval(() => void beat(), opts.everyMs ?? BEAT_MS)
  const reads = setInterval(() => void refresh(), FACTS_MS)
  beats.unref?.(); reads.unref?.()
  return {
    async ready(info, check) {
      // Its adoption is over by now: a version that is up but answers wrong gets the plain trial time, not a busy one.
      if (check) { busyUntil = 0; void beat() }
      for (let warnedWhy = ''; check && !stopped;) {
        const why = await check().catch((err: unknown) => `the check failed: ${err instanceof Error ? err.message : String(err)}`)
        if (why === null) break
        if (why !== warnedWhy) warn(`not ready for the launcher yet: ${why}`)
        warnedWhy = why
        await new Promise<void>((resolve) => { const t = setTimeout(resolve, READY_RETRY_MS); t.unref?.() })
      }
      if (stopped) return
      try {
        await writeWhole(path.join(dir, 'ready'), `pid=${pid}\nexe=${info.exe}\ninstance=${info.instance ?? ''}\nat=${Math.floor(Date.now() / 1000)}\n`)
      } catch (err) { warn(`launcher ready mark not written: ${(err as Error).message}`) }
      // The launcher commits within a tick: read its state again soon after.
      setTimeout(() => void refresh(), 2_000).unref?.()
    },
    busy(seconds) { busyUntil = Math.floor(Date.now() / 1000) + Math.max(0, Math.floor(seconds)); void beat() },
    idle() { busyUntil = 0; void beat() },
    leaving(reason) {
      // Sync on purpose: process.exit follows this call, so an async write would never land.
      try {
        const file = path.join(dir, 'leaving')
        fs.writeFileSync(`${file}.t`, leavingText(pid, reason), { mode: 0o600 })
        fs.renameSync(`${file}.t`, file)
      } catch (err) { warn(`launcher leaving mark not written: ${(err as Error).message}`) }
    },
    facts: () => facts,
    stop() { stopped = true; clearInterval(beats); clearInterval(reads) },
  }
}

const clean = (v: unknown, max = 1024): string | null =>
  typeof v === 'string' && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v : null

/** Facts a host sent (hello `launcher`), checked field by field; null when they do not hold together. */
export function launcherFactsFrom(value: unknown): LauncherFacts | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const current = clean(v.current)
  const phase = clean(v.phase, 16)
  if (!current?.startsWith('/') || !phase || !PHASES.includes(phase)) return null
  const facts: LauncherFacts = { current, good: clean(v.good) ?? '', phase: phase as LauncherPhase, since: typeof v.since === 'number' && v.since > 0 ? v.since : 0 }
  const build = clean(v.build, 64); if (build) facts.build = build
  const goodBuild = clean(v.goodBuild, 64); if (goodBuild) facts.goodBuild = goodBuild
  const r = v.rollback as Record<string, unknown> | undefined
  if (r && typeof r === 'object' && typeof r.at === 'number' && r.at > 0 && clean(r.from) && clean(r.reason, 2000)) {
    facts.rollback = { at: r.at, from: clean(r.from)!, to: clean(r.to) ?? '', reason: clean(r.reason, 2000)!, ...(clean(r.build, 64) ? { build: clean(r.build, 64)! } : {}) }
  }
  return facts
}
