// A test server may resume, attach to or write into only sessions its own confirmed spawns minted.
// Ownership lives in memory: a restarted test server treats its own earlier sessions as copied.
// A fork of a copied session is refused too: the fork would run real tools with the user's context.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { IS_DEMO, IS_EPHEMERAL, WALNUT_HOME, isValidSessionUuid } from '../constants.js'
import { readDemoOwnership, writeDemoOwnership } from './demo-session-ownership.js'
import { resolveAgentCommand } from './agent-command-map.js'
import { assertDemoAdmission } from '../core/sessions/demo-admission.js'
import { ThisServer } from '../core/server-self-name.js'

/**
 * Where a refused session came from, as far as this server knows: `outside` when its own store
 * never held it, `earlier` when the store held it at boot (in a Demo, whose data starts empty,
 * that is the Demo itself before a restart: it began here, and its ownership was not kept).
 */
export type RefusedOrigin = 'outside' | 'earlier'

export class InheritedSessionRefusedError extends Error {
  readonly code = 'inherited_session'
  constructor(readonly sessionId: string, readonly cmd: string, readonly origin: RefusedOrigin = 'outside') {
    // Words a person reads (a parked row, Retry): no code, and no "test server" in the Demo.
    super(inheritedSessionText(sessionId, IS_DEMO, origin))
    this.name = 'InheritedSessionRefusedError'
  }
}

/**
 * The refusal's sentence: plain in the Demo, naming the session on a developer's test server.
 * "Began outside this Demo" only when that is so (2026-11-11 review: it was said of a task that
 * began in this Demo, after its first start failed).
 */
export function inheritedSessionText(sessionId: string, demo: boolean, origin: RefusedOrigin = 'outside'): string {
  if (!demo) return `${ThisServer(false)} did not start session ${sessionId || '(unnamed)'}; start a new session instead.`
  return origin === 'earlier'
    ? 'This conversation started before the Demo last restarted, and the Demo continues only conversations it started since. Start a new task instead.'
    : 'This conversation began outside this Demo, so the Demo cannot continue it. Start a new task instead.'
}

/** The refusal rebuilt from its text (an error that crossed a boundary as words), old wording too. */
export function isInheritedSessionText(message: string): boolean {
  return /^inherited_session:/.test(message)
    || /^This test server did not start session /.test(message)
    || message.startsWith('This conversation began outside this Demo')
    || message.startsWith('This conversation started before the Demo last restarted')
}

/** Which daemon a command goes to: its host, its socket's URL and the instance that answered hello. */
export interface GateScope { host: string; url?: string | null; instance?: string | null }

/** One send's own record of what it may confirm; settle accepts only the same object. */
export type GateAttempt =
  | { kind: 'start'; host: string; sid: string; instance: string }
  | { kind: 'acp'; host: string; rt: string; adapter: string; thread?: string }
  | { kind: 'acpNew'; host: string; rt: string; adapter: string; generation: number }
  | { kind: 'rename'; host: string; from: string; to: string }

let inherited: Set<string> | null = null
let demoSettles: Promise<void> = Promise.resolve()
const own = new Set<string>()
/** Fresh ids this server's own starts minted (passed the gate), confirmed or not. */
const mintedIds = new Set<string>()
const ownThreads = new Set<string>()
const runtimeAdapter = new Map<string, string>()
/** Bumped by every acpStart of a runtime: an older worker's late reply then confirms nothing. */
const runtimeGeneration = new Map<string, number>()
const pending = new Map<string, GateAttempt>()
const fixtureDaemons = new Map<string, string>()

const INPUT_COMMANDS = new Set([
  'send', 'sendRaw', 'appendUserMarker', 'setMode', 'bridgeResume', 'turns.restore',
  'acpSend', 'acpSteer', 'acpRespond', 'acpCancel', 'acpSetConfigOption',
])

const k = (...parts: string[]) => parts.join('\u0000')
/** A thread one of this server's own ACP runs answered with on `host`, under any adapter. */
function ownsThread(host: string, thread: string): boolean {
  for (const key of ownThreads) {
    const [h, , t] = key.split('\u0000')
    if (h === host && t === thread) return true
  }
  return false
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const pidOk = (v: unknown) => Number.isInteger(v) && (v as number) > 0

function insideTmp(p: string | undefined): boolean {
  if (!p) return false
  try {
    return fs.realpathSync(p).startsWith(fs.realpathSync(os.tmpdir()) + path.sep)
  } catch {
    return false
  }
}

/** Boot of a test server: every session and runtime id its copied store holds. */
export async function armEphemeralSessionGate(ids: Iterable<string>): Promise<void> {
  inherited = new Set([...ids].filter(Boolean))
  if (!IS_DEMO) return
  const saved = await readDemoOwnership(WALNUT_HOME)
  for (const key of saved.own) { own.add(key); inherited.delete(key.slice('__local__\u0000'.length)) }
  // A start this server made before its restart that never ran (Claude Code was not
  // installed yet) is still this server's: its next start under the same id is fresh.
  for (const key of saved.minted ?? []) { mintedIds.add(key); if (!own.has(key)) inherited.delete(key.slice('__local__\u0000'.length)) }
  for (const key of saved.threads) { ownThreads.add(key); inherited.delete(key.split('\u0000').at(-1)!) }
  for (const row of saved.adapters) runtimeAdapter.set(...row)
}

/** A test server sharing the user's real HOME never writes files other sessions read (team inboxes). */
export function refuseRealHomeWrite(what: string, enabled: boolean = IS_EPHEMERAL): void {
  const root = process.env.WALNUT_DEMO_ROOT
  const generation = process.env.WALNUT_DEMO_GENERATION
  const demoHome = IS_DEMO && root && generation && /^[a-zA-Z0-9-]{1,64}$/.test(generation)
    && path.basename(root) === 'open-walnut-demo'
    ? path.resolve(root, 'homes', generation) : null
  let ownDemo = false
  try {
    ownDemo = demoHome !== null && process.env.HOME === demoHome
      && WALNUT_HOME === path.resolve(root!, 'data', generation!) && fs.realpathSync(demoHome) === demoHome
  } catch { /* An unavailable HOME grants no write permission. */ }
  if (enabled && !ownDemo && !insideTmp(process.env.HOME)) throw new InheritedSessionRefusedError('', what)
}

/** Playwright fixture only: skip the gate for this in-process MockDaemon (its URL and instance id). */
export function trustFixtureDaemon(wsUrl: string, instanceId: string, enabled: boolean = IS_EPHEMERAL): void {
  if (!enabled || !instanceId || !/^ws:\/\/127\.0\.0\.1:\d+$/.test(wsUrl) || !insideTmp(process.env.HOME) || !insideTmp(WALNUT_HOME)) {
    throw new Error('trustFixtureDaemon: only a loopback MockDaemon on a test server with a scratch HOME and data dir')
  }
  fixtureDaemons.set(wsUrl, instanceId)
}

const skipped = (s: GateScope, enabled: boolean) =>
  !enabled || (!!s.url && !!s.instance && fixtureDaemons.get(s.url) === s.instance)

const isCopied = (id: string) => inherited === null || inherited.has(id)

/** The daemon command an `agent.<op>` frame runs (the daemon's own resolver); null when it runs none. */
function canonical(cmd: string, params: Record<string, unknown>): string | null {
  if (!cmd.startsWith('agent.')) return cmd
  const route = resolveAgentCommand(params.engine, cmd.slice('agent.'.length))
  return route.ok ? route.cmd : null
}

function refuse(id: string, cmd: string): never {
  throw new InheritedSessionRefusedError(id, cmd, inherited?.has(id) ? 'earlier' : 'outside')
}

/** Throws before `cmd` is sent if it may not run; returns the attempt its reply may confirm. */
export function gateSessionCommand(scope: GateScope, cmd: string, params: Record<string, unknown>, enabled: boolean = IS_EPHEMERAL): GateAttempt | undefined {
  const canonicalCommand = canonical(cmd, params)
  if (canonicalCommand && (INPUT_COMMANDS.has(canonicalCommand)
    || ['start', 'acpStart', 'acpNewSession', 'oneshot.run', 'oneshot.prewarm', 'exec.run'].includes(canonicalCommand))) assertDemoAdmission()
  if (skipped(scope, enabled)) return undefined
  const host = scope.host
  const sid = str(params.sid)
  const routed = canonical(cmd, params)
  if (routed === null) refuse(sid, cmd)
  cmd = routed
  switch (cmd) {
    case 'start': {
      // The runner's contract (ClaudeCodeSession.send): the start's sid is the id it writes,
      // `--session-id <id>` for a new transcript (fork too), `--resume <id>` for a resume.
      const args = Array.isArray(params.args) ? params.args as unknown[] : []
      if (!sid || isCopied(sid)) refuse(sid, cmd)
      if (args.some((a) => typeof a === 'string' && /^(--resume|-r|--session-id)=/.test(a))) refuse(sid, cmd)
      const valueOf = (flags: string[]): string | undefined => {
        const at = args.flatMap((a, i) => (typeof a === 'string' && flags.includes(a) ? [i] : []))
        if (at.length === 0) return undefined
        const v = args[at[0] + 1]
        if (at.length > 1 || typeof v !== 'string' || !v || v.startsWith('-')) refuse(sid, cmd)
        return v
      }
      const resumed = valueOf(['--resume', '-r'])
      const minted = valueOf(['--session-id'])
      const fork = args.includes('--fork-session')
      if (fork && resumed === undefined) refuse(sid, cmd)
      // An id this server minted is its own even when no process of it was confirmed (its first
      // start failed: Claude Code missing, or stopped before it read the line): a fresh UUID this
      // gate let through, so no other Walnut's conversation can sit under it. Resuming it is safe;
      // a proven run makes it owned below.
      const mintedHere = resumed !== undefined && mintedIds.has(k(host, resumed))
      if (resumed !== undefined && !own.has(k(host, resumed)) && !mintedHere) refuse(resumed, cmd)
      if (resumed !== undefined && !fork) {
        if (sid !== resumed || minted !== undefined) refuse(sid, cmd)
        if (own.has(k(host, resumed))) return undefined // an own session: nothing new to own
        if (!scope.instance) refuse(sid, cmd)
        const resumeAttempt: GateAttempt = { kind: 'start', host, sid, instance: scope.instance }
        pending.set(k(host, sid), resumeAttempt)
        return resumeAttempt
      }
      // A fork copies the conversation it names: only a confirmed own one.
      if (fork && !own.has(k(host, resumed!))) refuse(resumed!, cmd)
      if (params.resume === true) refuse(sid, cmd)
      if (!isValidSessionUuid(minted) || minted !== sid || isCopied(minted) || own.has(k(host, minted))) refuse(minted ?? sid, cmd)
      if (!scope.instance) refuse(sid, cmd)
      const attempt: GateAttempt = { kind: 'start', host, sid, instance: scope.instance }
      pending.set(k(host, sid), attempt)
      return attempt
    }
    case 'acpStart': {
      if (!sid || isCopied(sid)) refuse(sid, cmd)
      const adapter = JSON.stringify(Array.isArray(params.adapterCmd) ? params.adapterCmd : [])
      const thread = str(params.providerSessionId)
      if (thread && !ownThreads.has(k(host, adapter, thread))) refuse(thread, cmd)
      const attempt: GateAttempt = { kind: 'acp', host, rt: sid, adapter, ...(thread ? { thread } : {}) }
      pending.set(k(host, sid), attempt)
      runtimeGeneration.set(k(host, sid), (runtimeGeneration.get(k(host, sid)) ?? 0) + 1)
      return attempt
    }
    case 'acpNewSession': {
      const adapter = runtimeAdapter.get(k(host, sid))
      if (!own.has(k(host, sid)) || adapter === undefined) refuse(sid, cmd)
      return { kind: 'acpNew', host, rt: sid, adapter, generation: runtimeGeneration.get(k(host, sid)) ?? 0 }
    }
    case 'rename': {
      // The CLI named another id for an own session: the new id is own unless it is a copied one.
      const from = str(params.oldSid)
      const to = str(params.newSid)
      if (!own.has(k(host, from)) || !isValidSessionUuid(to) || isCopied(to)) refuse(from, cmd)
      return { kind: 'rename', host, from, to }
    }
    case 'cron.supervision':
      // Reading the state is free; turning supervision on or off is a write.
      if (params.enabled !== undefined && !own.has(k(host, sid))) refuse(sid, cmd)
      return undefined
    case 'ports.stop': {
      // Stopping a server signals the host's real processes: only for sessions this server
      // started. The daemon stops a server attributed to ANY of `sids` (one record's ids:
      // an ACP session's runtime id, then its thread id, which names its terminal), so
      // every one of them must be this server's own.
      const sids = Array.isArray(params.sids) ? params.sids.map(str) : []
      // The first must be a session this server started; the rest, its own ids or the
      // threads of its own ACP runs.
      const owned = (s: string, i: number) => !!s && (own.has(k(host, s)) || (i > 0 && ownsThread(host, s)))
      const foreign = sids.length === 0 ? '' : sids.find((s, i) => !owned(s, i))
      if (foreign !== undefined) refuse(foreign, cmd)
      return undefined
    }
    case 'attach': {
      if (own.has(k(host, sid))) return undefined
      const probe = pending.get(k(host, sid))
      if (probe?.kind === 'start') return probe // the lost-reply probe of this very start
      refuse(sid, cmd)
    }
    default:
      if (INPUT_COMMANDS.has(cmd) && !own.has(k(host, sid))) refuse(sid, cmd)
      return undefined
  }
}

/** Confirms what a well-formed ok reply proves for the attempt this send made, and nothing else. */
export function settleSessionCommand(scope: GateScope, cmd: string, params: Record<string, unknown>, result: unknown, attempt: GateAttempt | undefined, enabled: boolean = IS_EPHEMERAL): Promise<void> | void {
  if (!IS_DEMO || !attempt || scope.host !== '__local__') { settleCommand(scope, cmd, params, result, attempt, enabled); return }
  const work = demoSettles.catch(() => {}).then(async () => {
    const beforeOwn = new Set(own)
    const beforeMinted = new Set(mintedIds)
    const beforeThreads = new Set(ownThreads)
    const beforeAdapters = new Map(runtimeAdapter)
    settleCommand(scope, cmd, params, result, attempt, enabled)
    const local = (key: string) => key.startsWith('__local__\u0000')
    const addedOwn = [...own].filter(key => !beforeOwn.has(key))
    const addedMinted = [...mintedIds].filter(key => !beforeMinted.has(key))
    const addedThreads = [...ownThreads].filter(key => !beforeThreads.has(key))
    const changedAdapters = [...runtimeAdapter].filter(([key, value]) => beforeAdapters.get(key) !== value)
    return writeDemoOwnership({ v: 1, home: WALNUT_HOME, own: [...own].filter(local), threads: [...ownThreads].filter(local), adapters: [...runtimeAdapter].filter(([key]) => local(key)), minted: [...mintedIds].filter(local) }).catch(error => {
      if (attempt.kind === 'start') pending.set(k(attempt.host, attempt.sid), attempt)
      for (const key of addedOwn) own.delete(key)
      for (const key of addedMinted) mintedIds.delete(key)
      for (const key of addedThreads) ownThreads.delete(key)
      for (const [key, value] of changedAdapters) {
        if (runtimeAdapter.get(key) !== value) continue
        const prior = beforeAdapters.get(key)
        if (prior === undefined) runtimeAdapter.delete(key); else runtimeAdapter.set(key, prior)
      }
      throw error
    })
  })
  demoSettles = work
  return work
}

function settleCommand(scope: GateScope, cmd: string, params: Record<string, unknown>, result: unknown, attempt: GateAttempt | undefined, enabled: boolean): void {
  if (!attempt || skipped(scope, enabled)) return
  cmd = canonical(cmd, params) ?? cmd
  const r = (result ?? {}) as Record<string, any>
  const ok = r.ok === true
  if (attempt.kind === 'rename') {
    if (ok && own.has(k(attempt.host, attempt.from))) own.add(k(attempt.host, attempt.to))
    return
  }
  if (attempt.kind === 'start') {
    const key = k(attempt.host, attempt.sid)
    if (pending.get(key) !== attempt) return
    // Answered at all: the id is this server's fresh one, whether a process ran or not
    // (a start refused before Claude Code was installed). Only a Demo stores it.
    mintedIds.add(key)
    // Same daemon instance as the start went to: a probe after a daemon change proves nothing.
    const proves = ok && scope.instance === attempt.instance && pidOk(r.pid) && r.adopted !== true
      && typeof r.outputFile === 'string' && path.basename(r.outputFile) === `${attempt.sid}.jsonl`
      && (cmd === 'start' || (r.alive === true && r.state === 'running'))
    if (!proves) {
      if (cmd === 'start') pending.delete(key)
      return
    }
    pending.delete(key)
    own.add(key)
    return
  }
  if (attempt.kind === 'acp') {
    const key = k(attempt.host, attempt.rt)
    if (pending.get(key) !== attempt) return
    pending.delete(key)
    if (attempt.thread) {
      if (ok) { own.add(key); runtimeAdapter.set(key, attempt.adapter) }
      return // a failed load keeps whatever the runtime already owned, nothing more
    }
    const thread = str(r.session?.sessionId)
    if (!ok || !thread || isCopied(thread)) return
    own.add(key)
    runtimeAdapter.set(key, attempt.adapter)
    ownThreads.add(k(attempt.host, attempt.adapter, thread))
    return
  }
  const key = k(attempt.host, attempt.rt)
  const thread = str(r.result?.sessionId)
  const current = (runtimeGeneration.get(key) ?? 0) === attempt.generation && runtimeAdapter.get(key) === attempt.adapter
  if (ok && current && own.has(key) && thread && !isCopied(thread)) ownThreads.add(k(attempt.host, attempt.adapter, thread))
}

/** Test seam. */
export function resetEphemeralSessionGateForTests(ids: Iterable<string> | null = []): void {
  inherited = ids === null ? null : new Set(ids)
  for (const m of [own, mintedIds, ownThreads, runtimeAdapter, runtimeGeneration, pending, fixtureDaemons]) m.clear()
}
