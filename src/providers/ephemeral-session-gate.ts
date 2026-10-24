// A test server may resume, attach to or write into only sessions its own confirmed spawns minted.
// Ownership lives in memory: a restarted test server treats its own earlier sessions as copied.
// A fork of a copied session is refused too: the fork would run real tools with the user's context.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { IS_EPHEMERAL, WALNUT_HOME, isValidSessionUuid } from '../constants.js'
import { resolveAgentCommand } from './agent-command-map.js'

export class InheritedSessionRefusedError extends Error {
  readonly code = 'inherited_session'
  constructor(readonly sessionId: string, readonly cmd: string) {
    super(`inherited_session: this test server did not start session ${sessionId || '(unnamed)'}; start a new session instead.`)
    this.name = 'InheritedSessionRefusedError'
  }
}

/** Which daemon a command goes to: its host, its socket's URL and the instance that answered hello. */
export interface GateScope { host: string; url?: string | null; instance?: string | null }

/** One send's own record of what it may confirm; settle accepts only the same object. */
export type GateAttempt =
  | { kind: 'start'; host: string; sid: string; instance: string }
  | { kind: 'acp'; host: string; rt: string; adapter: string; thread?: string }
  | { kind: 'acpNew'; host: string; rt: string; adapter: string; generation: number }

let inherited: Set<string> | null = null
const own = new Set<string>()
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
export function armEphemeralSessionGate(ids: Iterable<string>): void {
  inherited = new Set([...ids].filter(Boolean))
}

/** A test server sharing the user's real HOME never writes files other sessions read (team inboxes). */
export function refuseRealHomeWrite(what: string, enabled: boolean = IS_EPHEMERAL): void {
  if (enabled && !insideTmp(process.env.HOME)) throw new InheritedSessionRefusedError('', what)
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
  throw new InheritedSessionRefusedError(id, cmd)
}

/** Throws before `cmd` is sent if it may not run; returns the attempt its reply may confirm. */
export function gateSessionCommand(scope: GateScope, cmd: string, params: Record<string, unknown>, enabled: boolean = IS_EPHEMERAL): GateAttempt | undefined {
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
      if (resumed !== undefined && !own.has(k(host, resumed))) refuse(resumed, cmd)
      if (resumed !== undefined && !fork) {
        if (sid !== resumed || minted !== undefined) refuse(sid, cmd)
        return undefined // an own session: nothing new to own
      }
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
      own.add(k(host, to))
      return undefined
    }
    case 'cron.supervision':
      // Reading the state is free; turning supervision on or off is a write.
      if (params.enabled !== undefined && !own.has(k(host, sid))) refuse(sid, cmd)
      return undefined
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
export function settleSessionCommand(scope: GateScope, cmd: string, params: Record<string, unknown>, result: unknown, attempt: GateAttempt | undefined, enabled: boolean = IS_EPHEMERAL): void {
  if (!attempt || skipped(scope, enabled)) return
  cmd = canonical(cmd, params) ?? cmd
  const r = (result ?? {}) as Record<string, any>
  const ok = r.ok === true
  if (attempt.kind === 'start') {
    const key = k(attempt.host, attempt.sid)
    if (pending.get(key) !== attempt) return
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
  for (const m of [own, ownThreads, runtimeAdapter, runtimeGeneration, pending, fixtureDaemons]) m.clear()
}
