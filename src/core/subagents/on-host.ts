/**
 * A subagent on another host (subagent_run `host`), or a Claude Code subagent of a session
 * that runs on another host: the run is a SESSION there, started the way a task's session
 * starts (`SESSION_START` → the session runner's own spawn path, Walnut's session context,
 * the Walnut MCP mount, the user's settings, skills, hooks and MCP servers on that host,
 * the CLI's own default model), so it has every tool a task session there has. The only
 * differences from a task: no task and no board row (the session is a lane, kept out of
 * every list and of the host's capacity count), its answer comes back into the caller's
 * turn, and its `walnut` calls act for the caller (acp-caller-sid.ts setCallerAlias).
 *
 * Its permission level is the caller's: full access when the caller runs with it, Auto
 * when the caller is in Auto, else Don't Ask (never a mode that would wait on a person,
 * since nobody watches this session).
 *
 * On another host than the caller's (`spec.away`) it works in a copy of the caller's work
 * there (work-copy.ts); the files it names (its out folder, absolute paths in its answer)
 * are copied back into the caller's task directory with host_copy's own job, and the copy,
 * the session and its transcript are removed when it ends, however it ends.
 */
import crypto from 'node:crypto'
import path from 'node:path'
import { log } from '../../logging/index.js'
import { engineCaps } from '../agents/engine-registry.js'
import type { SessionMode } from '../types.js'
import { LightSubagentError, RESUME_PROMPT, SUBAGENT_LANE_PREFIX, type LightRunResult, type LightRunSpec, type ReturnedFile } from './types.js'
import type { WorkCopy } from './work-copy.js'

const LOCAL = '__local__'
export { SUBAGENT_LANE_PREFIX }
/** What comes back of one run at most. */
const MAX_FILES = 20
const MAX_TOTAL_BYTES = 4 * 1024 ** 3
const COPY_WAIT_MS = 60_000
/** Copying back stops this long before the run's own limit. */
const COPY_MARGIN_MS = 20_000
/** Two hosts' clocks may differ this much: a file written in the run's first moments still counts as its own. */
const CLOCK_SLACK_MS = 2 * 60_000
const PROGRESS_TEXT_MAX = 20_000

/** The modes that never wait on a person: the subagent runs in the caller's when it is one. */
export function subagentMode(fullAccess: boolean, parentMode: SessionMode | undefined): SessionMode {
  if (fullAccess) return 'bypass'
  return parentMode === 'auto' ? 'auto' : 'dontAsk'
}

/** How often a turn cut off by a restart looks at its session (cutOffAnswer). */
let resumeCheckMs = 3_000
export function _setResumeCheckMsForTest(ms: number | null): void { resumeCheckMs = ms ?? 3_000 }

/** After a stop that came between a start and its spawn, the session is stopped again this much later. */
let lateStopCheckMs = 10_000
export function _setLateStopCheckMsForTest(ms: number | null): void { lateStopCheckMs = ms ?? 10_000 }

/** Tests: start the session another way (the real one starts a CLI on a host). */
type Starter = (data: Record<string, unknown>) => void
let starterOverride: Starter | null = null
export function _setSubagentStarterForTest(fn: Starter | null): void { starterOverride = fn }

/**
 * What a session subagent starts with: a task session's start, taskless and in a lane.
 * Never a `profile`: a profile is how a session is cut down (slim settings, a tool list,
 * a replaced prompt), and this one has every tool a task session has.
 */
export function sessionStartData(o: {
  sessionId: string; lane: string; host: string; cwd: string; message: string; title: string
  mode: SessionMode; model?: string; effort?: string; engine?: import('../types.js').SessionEngine
}): Record<string, unknown> {
  const native = !o.engine || engineCaps(o.engine).runtimeKind === 'native'
  return {
    taskId: '', message: o.message, cwd: o.cwd, title: o.title, lane: o.lane, mode: o.mode,
    ...(o.host !== LOCAL ? { host: o.host } : {}),
    ...(o.model ? { model: o.model } : {}),
    ...(o.effort ? { effort: o.effort } : {}),
    // An ACP engine names its own session id at establish (no preassigned one).
    engine: native ? 'claude' : o.engine, ...(native ? { preassignedSessionId: o.sessionId } : {}),
    // The lane turn framed it as Walnut's already (lane-turn.ts frameForSource): not framed twice.
    attributed: true, attributionSource: 'subagent', namingMessage: o.title,
  }
}

/** The words the subagent reads before the caller's prompt. */
export function subagentPreamble(o: { host: string; copy: WorkCopy | null }): string {
  const where = o.host === LOCAL ? 'the machine Walnut runs on' : o.host
  const lines = [
    `[Walnut] You are a subagent of another Walnut session, run on ${where} with the same tools and permissions a task's session has there. `
      + 'Your last message is your whole answer: it goes back to that session, which sees nothing else of this conversation. '
      + 'Your `walnut` calls act for that session (a `subagent_run` of yours runs as its own, in its folder: use your Agent tool for subagents of your own here).',
  ]
  if (o.copy) {
    lines.push(`You work in a copy of its work, set up for you here: ${o.copy.cwd}.`)
    for (const l of o.copy.lines) lines.push(`- ${l}`)
    lines.push(`Put every file the session should get back (videos, screenshots, logs, reports) in ${o.copy.outDir}, or name its absolute path in your answer: `
      + 'those files are copied back to it. Everything here, this copy included, is removed when you end, so commit nothing you need to keep: describe the change in your answer instead.')
  }
  return lines.join('\n')
}

/** What one turn of a subagent's session gets from its run (registry.ts). */
export interface SubagentTurnSpec {
  signal: AbortSignal
  /** This turn's own limit (epoch ms). */
  deadlineAt: number
  onProgress: LightRunSpec['onProgress']
}

/**
 * What of a subagent's session outlives this server (registry.ts writes it to disk): a deploy
 * restarts the server while the session runs on in its host's daemon, and the next server
 * takes it up from here.
 */
export interface SubagentSessionState {
  runtimeId: string
  callerSid: string
  sessionId?: string
  copy: WorkCopy | null
  placed: boolean
  started: boolean
  activeAt: number
  used: string[]
  returned: Array<[string, string]>
}

/** How long an ACP engine's first start may take before its session record exists (personal-ai-lane.ts waits as long). */
const ACP_START_WAIT_MS = 90_000

/**
 * One subagent: a hidden session (a lane: no task, no board row, no list) that lives past its
 * answer, so its caller (subagent_send) and the user (its conversation in the Background tasks
 * panel) can talk to it again, with its context. The first turn places the work copy (on another
 * host) and starts the session the way a task's session starts; every later turn is a message
 * into the same session. `close` stops it and removes everything of it.
 */
export class SubagentSession {
  /** Its session's record id, once it started. */
  sessionId?: string
  /** When its session last did anything (a turn the user wrote in its conversation counts too). */
  activeAt = Date.now()
  private copy: WorkCopy | null = null
  private placed = false
  private readonly runId: string
  private readonly lane: string
  /** Names already used in the caller's folder for this run's files, and what came back (path -> size:mtime). */
  private readonly used = new Set<string>()
  private readonly returned = new Map<string, string>()
  private progress: LightRunSpec['onProgress'] | null = null
  private answerSoFar = ''
  private tokens: number | undefined
  private sub: string | null = null
  /** Its record's write (native) or its start (ACP), once begun: from then on the session is retired when it closes. */
  private recording: Promise<unknown> | null = null
  private started = false
  private closing: Promise<boolean> | null = null

  constructor(private readonly spec: LightRunSpec) {
    this.runId = spec.runId ?? spec.runtimeId
    this.lane = `${SUBAGENT_LANE_PREFIX}${spec.runtimeId}`
  }

  get closed(): boolean { return !!this.closing }

  /** What the next server needs to take this session up again (restore). */
  state(): SubagentSessionState {
    return {
      runtimeId: this.spec.runtimeId, callerSid: this.spec.callerSid,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      copy: this.copy, placed: this.placed, started: this.started, activeAt: this.activeAt,
      used: [...this.used], returned: [...this.returned],
    }
  }

  /**
   * This server's session of a subagent a server before it started (registry.ts restore):
   * the session ran on in its host's daemon, so it is taken up as it is, never started again.
   */
  static async restore(spec: LightRunSpec, saved: SubagentSessionState): Promise<SubagentSession> {
    const s = new SubagentSession({ ...spec, runtimeId: saved.runtimeId, callerSid: saved.callerSid })
    s.copy = saved.copy
    s.placed = saved.placed
    s.started = saved.started
    if (saved.activeAt) s.activeAt = saved.activeAt
    for (const u of saved.used) s.used.add(u)
    for (const [k, v] of saved.returned) s.returned.set(k, v)
    s.sessionId = saved.sessionId
    // A native start written down whose CLI never spawned (the server stopped first): never started.
    if (s.sessionId && engineCaps(spec.engine).runtimeKind === 'native') {
      const { getSessionByClaudeId } = await import('../session-tracker.js')
      const rec = await getSessionByClaudeId(s.sessionId).catch(() => undefined)
      if (rec && !rec.pid && rec.status_reason === 'awaiting_spawn') s.started = false
    }
    // An ACP engine that had not named its session before the restart: it is found by its lane.
    if (!s.sessionId && s.started) {
      const { getSessionByLane } = await import('../session-tracker.js')
      s.sessionId = (await getSessionByLane(s.lane).catch(() => null))?.claudeSessionId
    }
    if (s.sessionId) {
      ;(await import('../sessions/acp-caller-sid.js')).setCallerAlias(s.sessionId, saved.callerSid)
      await s.watch(s.sessionId)
      await s.hearEnd(s.sessionId)
    }
    return s
  }

  /** This server stops and the session runs on: its bus subscription goes, everything else stays. */
  async detach(): Promise<void> {
    if (this.sub) { (await import('../event-bus.js')).bus.unsubscribe(this.sub); this.sub = null }
    if (this.hearSub) { (await import('../event-bus.js')).bus.unsubscribe(this.hearSub); this.hearSub = null }
  }

  /** One turn: the first prompt, or a later message. Its answer, with the files it named copied back. */
  async turn(prompt: string, t: SubagentTurnSpec): Promise<LightRunResult> {
    if (this.closing) throw new LightSubagentError('stopped', 'This subagent was closed', 409)
    const spec = this.spec
    const work: string[] = []
    const first = !this.placed
    if (first) {
      if (spec.away) {
        const { placeWorkCopy } = await import('./work-copy.js')
        this.copy = await placeWorkCopy({ runId: this.runId, fromHost: spec.away.fromHost, fromCwd: spec.away.fromCwd, toHost: spec.host, signal: t.signal })
        work.push(...this.copy.lines)
      }
      this.placed = true
      spec.onState?.()
      if (t.signal.aborted) throw new LightSubagentError('stopped', 'The run was stopped', 409)
      // The copy took time: the user may have revoked the grant there since.
      await spec.stillGranted?.()
    }
    // The preamble goes with the message that starts the session.
    const message = !this.started && !this.sessionId ? `${subagentPreamble({ host: spec.host, copy: this.copy })}\n\n${prompt}` : prompt
    this.progress = t.onProgress
    this.answerSoFar = ''
    let answer: string
    try {
      answer = await this.runTurn(message, t)
    } finally {
      this.progress = null
    }
    return this.finish(answer, t, work)
  }

  /** Whether a restart left it a session to take up (its start reached its host). */
  get taken(): boolean { return !!this.sessionId && this.started }

  /**
   * The turn a restart cut off (registry.ts restore): its session ran on in its host's daemon. Its
   * own end is waited for (the session runner reattached it, and an ACP engine replays its journal
   * once attached); only once the session reads idle with no end seen is it asked again
   * (RESUME_PROMPT). Never asked while it is still in that turn: a message into a turn joins it,
   * and every answer after would be taken for the message before it.
   */
  async resume(t: SubagentTurnSpec): Promise<LightRunResult> {
    if (this.closing) throw new LightSubagentError('stopped', 'This subagent was closed', 409)
    this.progress = t.onProgress
    this.answerSoFar = ''
    let answer: string
    try {
      answer = (await this.cutOffAnswer(t)) ?? await this.runTurn(RESUME_PROMPT, t)
    } finally {
      this.progress = null
    }
    return this.finish(answer, t, [])
  }

  /** The end of the turn a restart cut off, heard from the moment the session is taken up (it may come before resume asks). */
  private heard: { result: string | null } | null = null
  private hearSub: string | null = null
  private async hearEnd(sid: string): Promise<void> {
    const { bus, EventNames } = await import('../event-bus.js')
    const { isQuietTurn } = await import('../sessions/quiet-turn.js')
    this.hearSub = `subagent-heard-${this.spec.runtimeId}`
    bus.subscribe(this.hearSub, (event) => {
      const d = event.data as { sessionId?: string; result?: string; teamActive?: boolean; errorKind?: string; turnGen?: unknown }
      // A quiet turn of Walnut's own (an idle compaction) is not its answer.
      if (d?.sessionId !== sid || this.heard || isQuietTurn(sid, d.turnGen)) return
      if (event.name === EventNames.SESSION_RESULT) { if (!d.teamActive) this.heard = { result: String(d.result ?? '').trim() } }
      else if (d.errorKind !== 'delivery_failed') this.heard = { result: null }
    }, { global: true, interest: [EventNames.SESSION_RESULT, EventNames.SESSION_ERROR] })
  }

  private async cutOffAnswer(t: SubagentTurnSpec): Promise<string | null> {
    const sid = this.sessionId!
    const { bus, EventNames } = await import('../event-bus.js')
    if (this.hearSub) { bus.unsubscribe(this.hearSub); this.hearSub = null }
    if (this.heard) return this.heard.result
    const { getSessionByClaudeId } = await import('../session-tracker.js')
    const native = engineCaps(this.spec.engine).runtimeKind === 'native'
    const { isQuietTurn } = await import('../sessions/quiet-turn.js')
    return new Promise<string | null>((resolve, reject) => {
      const name = `subagent-resume-${this.spec.runtimeId}`
      let done = false
      let idleSeen = 0
      const finish = (fn: () => void) => {
        if (done) return
        done = true
        bus.unsubscribe(name)
        clearInterval(tick)
        t.signal.removeEventListener('abort', onAbort)
        fn()
      }
      const onAbort = () => finish(() => reject(new LightSubagentError('stopped', 'The run was stopped', 409)))
      bus.subscribe(name, (event) => {
        const d = event.data as { sessionId?: string; result?: string; teamActive?: boolean; errorKind?: string; turnGen?: unknown }
        if (d?.sessionId !== sid || isQuietTurn(sid, d.turnGen)) return
        if (event.name === EventNames.SESSION_RESULT) {
          if (!d.teamActive) finish(() => resolve(String(d.result ?? '').trim()))
        } else if (d.errorKind !== 'delivery_failed') finish(() => resolve(null))
      }, { global: true, interest: [EventNames.SESSION_RESULT, EventNames.SESSION_ERROR] })
      const check = async () => {
        if (done) return
        if (Date.now() >= t.deadlineAt) { finish(() => reject(new LightSubagentError('timed_out', 'It ran out of its time'))); return }
        const rec = await getSessionByClaudeId(sid).catch(() => undefined)
        if (rec === null) { finish(() => reject(new LightSubagentError('engine_error', 'Its session is gone'))); return }
        // Idle on two looks in a row (a replayed end comes in between): its end was not seen.
        if (rec && rec.process_status !== 'running') { if (++idleSeen >= 2) finish(() => resolve(null)) } else idleSeen = 0
      }
      const tick = setInterval(() => void check(), resumeCheckMs)
      tick.unref?.()
      if (t.signal.aborted) onAbort()
      else t.signal.addEventListener('abort', onAbort, { once: true })
      void check()
      // An ACP session is attached on use: its journal then replays the turn's end.
      if (!native && !starterOverride) {
        void import('../../providers/claude-code-session.js').then((m) => m.sessionRunner.findOrAttachAcpSession(sid)).catch(() => {})
      }
    })
  }

  /** A turn's answer, with the files it named copied back. */
  private async finish(answer: string, t: SubagentTurnSpec, work: string[]): Promise<LightRunResult> {
    const spec = this.spec
    const files = this.copy && spec.away ? await bringBack(spec, this.copy, answer, { used: this.used, returned: this.returned, deadlineAt: t.deadlineAt, signal: t.signal }) : { files: [], notes: [] }
    work.push(...files.notes)
    if (files.files.length) spec.onState?.()
    const text = files.files.length || files.notes.length
      ? `${answer}\n\n[Walnut] ${files.files.length ? `Files copied back to ${spec.away!.fromHost === LOCAL ? 'this machine' : spec.away!.fromHost}:\n${files.files.map((f) => `- ${f.from} -> ${f.to}`).join('\n')}` : ''}${files.notes.length ? `\n${files.notes.join('\n')}` : ''}`
      : answer
    return { answer: text, ...(this.tokens ? { tokens: this.tokens } : {}), warnings: [], ...(files.files.length ? { files: files.files } : {}), ...(work.length ? { work } : {}) }
  }

  /** Stop its session, archive it, remove its transcript and its copy. True when nothing of it is left. */
  close(reason: string): Promise<boolean> {
    this.closing ??= this.retireAll(reason).catch((err: unknown) => {
      log.agent.warn('subagent: closing it failed; the sweep tries again', { runId: this.runId, error: err instanceof Error ? err.message : String(err) })
      return false
    })
    return this.closing
  }

  private async retireAll(reason: string): Promise<boolean> {
    const left = await import('./left-runs.js')
    let gone = true
    // A start still under way finishes first (watch and the alias check `closing` and stand down).
    await this.recording?.catch(() => {})
    if (this.sub) { (await import('../event-bus.js')).bus.unsubscribe(this.sub); this.sub = null }
    if (this.hearSub) { (await import('../event-bus.js')).bus.unsubscribe(this.hearSub); this.hearSub = null }
    // An ACP engine that had not named its session yet: it is found by its lane (or by the sweep later).
    if (!this.sessionId && this.started && engineCaps(this.spec.engine).runtimeKind !== 'native') {
      const { getSessionByLane } = await import('../session-tracker.js')
      this.sessionId = (await getSessionByLane(this.lane).catch(() => null))?.claudeSessionId
      // Named in the ledger at once: once archived it is no longer found by its lane.
      if (this.sessionId) await left.noteLeft(this.runId, { sessionId: this.sessionId })
    }
    {
      const sessionId = this.sessionId
      if (sessionId) {
        const { getSessionByClaudeId } = await import('../session-tracker.js')
        const spawned = !!(await getSessionByClaudeId(sessionId).catch(() => null))?.pid
        gone = await retireSubagentSession(sessionId, reason, this.cwdOfSession())
        // Started but not spawned yet when it was stopped: the CLI the runner may spawn after the
        // stop is stopped and its files removed too (the sweep has it otherwise).
        if (this.started && !spawned && reason === 'subagent_stopped') {
          await new Promise((r) => setTimeout(r, lateStopCheckMs).unref?.())
          gone = (await retireSubagentSession(sessionId, reason, this.cwdOfSession())) && gone
        }
        // Kept for the sweep while its host could not be reached.
        if (gone) await left.dropLeftSession(this.runId)
        // Its calls act for the caller until its CLI is gone.
        ;(await import('../sessions/acp-caller-sid.js')).clearCallerAlias(sessionId)
      } else if (this.started) {
        gone = false
      }
    }
    // Its session is gone before its folder is removed: a CLI still in its turn could write there again.
    if (this.copy) {
      const { removeWorkCopy } = await import('./work-copy.js')
      const removed = await removeWorkCopy(this.copy, this.runId)
      if (!removed) log.agent.warn('subagent: its copy is still on the host; the next sweep removes it', { runId: this.runId, host: this.copy.host, dir: this.copy.runDir })
      gone = removed && gone
    }
    await left.settleLeft(this.runId).catch(() => {})
    // Something could not be removed (a host offline): the sweep comes back for it.
    if (left.listLeftRuns().some((r) => r.id === this.runId)) left.scheduleLeftRunsSweep()
    return gone
  }

  private cwdOfSession(): string { return this.copy?.cwd ?? this.spec.cwd }

  /** Its progress while a turn of the caller's runs (the panel row), for the session's whole life. */
  private async watch(sessionId: string): Promise<void> {
    const { bus, EventNames } = await import('../event-bus.js')
    if (this.closing) return
    this.sub = `subagent-${this.spec.runtimeId}`
    bus.subscribe(this.sub, (event) => {
      const d = event.data as { sessionId?: string; delta?: string; toolName?: string; parentToolUseId?: string; inputTokens?: number }
      if (d?.sessionId !== sessionId) return
      this.activeAt = Date.now()
      if (d.parentToolUseId) return
      const progress = this.progress
      if (event.name === EventNames.SESSION_TEXT_DELTA && typeof d.delta === 'string') {
        this.answerSoFar += d.delta
        progress?.({ kind: 'text', text: this.answerSoFar.slice(-PROGRESS_TEXT_MAX) })
      } else if (event.name === EventNames.SESSION_TOOL_USE && d.toolName) {
        this.answerSoFar = ''
        progress?.({ kind: 'tool', toolName: d.toolName })
      } else if (event.name === EventNames.SESSION_USAGE_UPDATE && typeof d.inputTokens === 'number' && d.inputTokens > 0) {
        this.tokens = d.inputTokens
        progress?.({ kind: 'tokens', tokens: d.inputTokens })
      }
    }, { global: true, interest: [EventNames.SESSION_TEXT_DELTA, EventNames.SESSION_TOOL_USE, EventNames.SESSION_USAGE_UPDATE] })
  }

  /**
   * The session's first start: as a task's session starts, taskless, in its own lane. All of it is
   * `recording` from its first line, so a close meanwhile waits for it and then retires whatever it made.
   */
  private mint(firstMessage: string, signal: AbortSignal): Promise<string> {
    const made = this.startSession(firstMessage, signal)
    this.recording = made
    return made
  }

  private async startSession(firstMessage: string, signal: AbortSignal): Promise<string> {
    const spec = this.spec
    const { bus, EventNames } = await import('../event-bus.js')
    const { setCallerAlias } = await import('../sessions/acp-caller-sid.js')
    const left = await import('./left-runs.js')
    const mode = subagentMode(spec.fullAccess, spec.parentMode)
    const title = `Subagent ${spec.runtimeId}`
    const cwd = this.cwdOfSession()
    const native = engineCaps(spec.engine).runtimeKind === 'native'
    const start = sessionStartData({ sessionId: '', lane: this.lane, host: spec.host, cwd, message: firstMessage, title, mode, model: spec.model, effort: spec.effort, engine: spec.engine })
    /** Nothing starts once the run was stopped or closed, whatever await it came in. */
    const go = () => {
      if (signal.aborted || this.closing) throw new LightSubagentError('stopped', 'The run was stopped', 409)
      this.started = true
      spec.onState?.()
      if (starterOverride) starterOverride(start)
      else bus.emit(EventNames.SESSION_START, start as never, ['session-runner'], { source: 'subagent' })
    }
    if (native) {
      const sessionId = crypto.randomUUID()
      start.preassignedSessionId = sessionId
      // Its calls act for the parent from its first line on.
      setCallerAlias(sessionId, spec.callerSid)
      this.sessionId = sessionId
      // Named for the sweep before it exists, then the record (as ai-agent.ts mints a lane), then the start.
      await left.noteLeft(this.runId, { sessionId, sessionCwd: cwd })
      const { createSessionRecord } = await import('../session-tracker.js')
      await createSessionRecord(sessionId, '', '', cwd, {
        title, lane: this.lane, mode, ...(spec.host !== LOCAL ? { host: spec.host } : {}),
        initialProcessStatus: 'idle', initialStatusReason: 'awaiting_spawn',
      })
      await this.watch(sessionId)
      await spec.stillGranted?.()
      go()
      return sessionId
    }
    // An ACP engine names its own session at establish: the record appears under the lane (personal-ai-lane.ts).
    await spec.stillGranted?.()
    // Named by its lane before it starts: a session that comes up after the wait gave up is still found.
    await left.noteLeft(this.runId, { lane: this.lane, sessionCwd: cwd })
    const { waitForLaneRecord } = await import('../sessions/personal-ai-lane.js')
    go()
    const sid = await waitForLaneRecord(this.lane, ACP_START_WAIT_MS, engineCaps(spec.engine).displayName)
    setCallerAlias(sid, spec.callerSid)
    this.sessionId = sid
    spec.onState?.()
    await left.noteLeft(this.runId, { sessionId: sid, sessionCwd: cwd })
    await this.watch(sid)
    return sid
  }

  /** One turn on the session: its answer. A stop ends the wait at once (the run closes it). */
  private async runTurn(message: string, t: SubagentTurnSpec): Promise<string> {
    const spec = this.spec
    const { runLaneTurn } = await import('../sessions/lane-turn.js')
    let rejectStop!: (e: Error) => void
    const stopped = new Promise<never>((_r, reject) => { rejectStop = reject })
    stopped.catch(() => {})
    const onStop = () => rejectStop(new LightSubagentError('stopped', 'The run was stopped', 409))
    if (t.signal.aborted) onStop()
    else t.signal.addEventListener('abort', onStop, { once: true })
    const engine = engineCaps(spec.engine).runtimeKind === 'native' ? 'claude' : spec.engine
    const turnP = runLaneTurn('subagent', this.lane, message, {
      source: 'subagent',
      timeoutMs: Math.max(60_000, t.deadlineAt - Date.now()),
      target: {
        // `firstMessage`: the message framed as Walnut's (sessions/send-frame.ts), never as the user's.
        resolve: async (firstMessage) => {
          if (t.signal.aborted || this.closing) throw new LightSubagentError('stopped', 'The run was stopped', 409)
          if (this.sessionId) return { sessionId: this.sessionId, created: false, engine }
          return { sessionId: await this.mint(firstMessage, t.signal), created: true, engine }
        },
        catchUp: async (_sid, m) => ({ message: m }),
      },
    })
    turnP.catch(() => {})
    const turn = await Promise.race([turnP, stopped]).finally(() => t.signal.removeEventListener('abort', onStop))
    if (t.signal.aborted) throw new LightSubagentError('stopped', 'The run was stopped', 409)
    if (turn.resultText === null) {
      const where = spec.host === LOCAL ? 'this machine' : spec.host
      const name = engineCaps(spec.engine).displayName
      const why = turn.failure === 'timeout' ? 'it ran out of its time'
        : turn.failure === 'died' ? `its ${name} process on ${where} ended before it answered`
          : turn.failure === 'stalled' ? 'it went silent for 15 minutes'
            : `its session on ${where} did not answer (${turn.failure ?? 'unknown'})`
      throw new LightSubagentError(turn.failure === 'timeout' ? 'timed_out' : 'engine_error', `${name} on ${where}: ${why}`)
    }
    return turn.resultText.trim()
  }
}

/** A run's own folder: every path of it holds the run's `xf-<uuid>` entry (work-copy.ts). */
const RUN_ENTRY = /\/xf-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/

/**
 * Stop a subagent's session, archive it, and remove what Claude Code keeps of it on its host:
 * its transcript, and when it ran in a run's own folder, that folder's whole project folder
 * (its subagents and tool results), plus its file history and session env.
 */
export async function retireSubagentSession(sessionId: string, reason: string, cwd?: string): Promise<boolean> {
  const { getSessionByClaudeId, updateSessionRecord } = await import('../session-tracker.js')
  const record = await getSessionByClaudeId(sessionId).catch(() => undefined)
  if (record === null) return true
  if (!record) return false
  let ok = true
  try {
    const { terminateSession } = await import('../sessions/session-lifecycle.js')
    const r = await terminateSession(sessionId, { force: true })
    // pending: its owner did not confirm the CLI ended; hostLost: its host ends it when it reconnects.
    if (r.status !== 'terminated' || r.hostLost) ok = false
  } catch (err) {
    ok = false
    log.agent.warn('subagent on host: its session did not stop, archiving it anyway', { sessionId, error: err instanceof Error ? err.message : String(err) })
  }
  await updateSessionRecord(sessionId, { archived: true, archive_reason: reason } as never).catch(() => {})
  const host = !record.host || record.host === 'local' ? LOCAL : record.host
  const { DaemonFileReader } = await import('../daemon-file-reader.js')
  const reader = new DaemonFileReader(host)
  const rm = (p: string, recursive: boolean) => reader.removePath(p, recursive, 60_000).catch(() => {})
  try {
    const { findTranscript } = await import('../transfer/daemon-transfer-client.js')
    const found = await findTranscript(host, sessionId)
    if (found.kind === 'unreachable') ok = false
    if (found.kind === 'one') {
      const projectDir = path.posix.dirname(found.path)
      // Claude Code names a folder's project after its path, so a run's own folder (its entry's uuid in it) has a project folder of its own.
      const uuid = cwd ? RUN_ENTRY.exec(cwd)?.[1] : undefined
      const own = !!uuid && path.posix.basename(projectDir).includes(uuid)
      if (own) await rm(projectDir, true)
      else { await rm(found.path, false); await rm(`${projectDir}/${sessionId}`, true) }
    }
  } catch (err) {
    ok = false
    log.agent.info('subagent on host: its transcript stays on the host', { sessionId, host, error: err instanceof Error ? err.message : String(err) })
  }
  await rm(`~/.claude/file-history/${sessionId}`, true)
  await rm(`~/.claude/session-env/${sessionId}`, true)
  return ok
}

/** Absolute paths (or ~/...) an answer names, in order, each once. */
export function pathsNamed(answer: string): string[] {
  const out: string[] = []
  for (const m of answer.matchAll(/(?<![\w/~.$:-])((?:\/|~\/)[^\s`'"<>|()[\]{}*,;]+)/g)) {
    const p = m[1]!.replace(/[.:!?]+$/, '')
    if (p.length > 1 && !p.includes('/../') && !out.includes(p)) out.push(p)
  }
  return out
}

/**
 * `p` as a path under the run's folder when it names a file there by another spelling: the
 * same folder reached through a link (clouddev's /home is a link to /local/home), or ~/...
 * The run's folder name (xf-<uuid>) is its own, so a path holding it is in it.
 */
export function inRunDir(p: string, runDir: string): string {
  const entry = `/${path.posix.basename(runDir)}/`
  const at = p.indexOf(entry)
  return at < 0 ? p : `${runDir}/${p.slice(at + entry.length)}`
}

/** A name under `dir` that `used` does not hold yet: `video.mp4`, `video-2.mp4`, ... */
export function freeName(name: string, used: Set<string>): string {
  const ext = path.posix.extname(name)
  const stem = name.slice(0, name.length - ext.length) || 'file'
  let pick = name || 'file'
  for (let i = 2; used.has(pick); i++) pick = `${stem}-${i}${ext}`
  used.add(pick)
  return pick
}

/** What a subagent's turns share when they bring files back: the names used in the caller's folder, and what came back already. */
interface BringBackState { used: Set<string>; returned: Map<string, string>; deadlineAt: number; signal: AbortSignal }

/**
 * The files the run named, copied back into the caller's task directory: everything in its
 * out folder (two levels deep), and every absolute path its answer names that is a file there.
 * A file that could not come back is a note, never a failure of the run.
 */
async function bringBack(spec: LightRunSpec, copy: WorkCopy, answer: string, o: BringBackState): Promise<{ files: ReturnedFile[]; notes: string[] }> {
  const fromHost = spec.away!.fromHost
  const notes: string[] = []
  const { DaemonFileReader } = await import('../daemon-file-reader.js')
  const reader = new DaemonFileReader(copy.host)
  const named: string[] = []
  const walk = async (dir: string, depth: number) => {
    const entries = await reader.listDirDetailed(dir).catch(() => [])
    for (const e of entries) {
      const p = `${dir}/${e.name}`
      if (e.type === 'dir' && depth < 2) await walk(p, depth + 1)
      else if (e.type === 'file') named.push(p)
    }
  }
  await walk(copy.outDir, 0)
  // Only what the run made: a file in its own folder, or one elsewhere written since it started
  // (a screenshot in /tmp). Any other path the answer names stays where it is, named.
  const outside: string[] = []
  // The target's own clock: its out folder was made right before the run began.
  const since = ((await reader.stat(copy.outDir).catch(() => null))?.mtimeMs ?? spec.startedAt ?? Date.now()) - CLOCK_SLACK_MS
  for (const p of pathsNamed(answer).map((x) => inRunDir(x, copy.runDir))) {
    if (named.includes(p)) continue
    if (p.startsWith(`${copy.runDir}/`)) { named.push(p); continue }
    const st = await reader.stat(p).catch(() => null)
    if (st && st.mtimeMs >= since) named.push(p)
    else if (st) outside.push(p)
  }
  if (outside.length) notes.push(`Not copied back (outside the run's own folder, and not written by it): ${outside.slice(0, 5).join(', ')}${outside.length > 5 ? ', ...' : ''}.`)
  if (named.length === 0) return { files: [], notes }
  const { probe } = await import('../hosts/host-copy-paths.js')
  const found: Array<{ from: string; size: number; key: string }> = []
  let total = 0
  for (const p of named) {
    if (found.length >= MAX_FILES) { notes.push(`More than ${MAX_FILES} files were named: the rest stayed and were removed with the copy.`); break }
    const at = await probe(copy.host, p).catch(() => ({ at: 'missing' as const, size: undefined }))
    if (at.at !== 'file' || at.size === undefined) continue
    // A file an earlier turn brought back, unchanged since: not copied again.
    const key = `${at.size}:${(await reader.stat(p).catch(() => null))?.mtimeMs ?? ''}`
    if (o.returned.get(p) === key) continue
    if (total + at.size > MAX_TOTAL_BYTES) { notes.push(`${p} was not copied back: over ${MAX_TOTAL_BYTES / 1024 ** 3} GB in all.`); continue }
    total += at.size
    found.push({ from: p, size: at.size, key })
  }
  if (found.length === 0) return { files: [], notes }
  if (!spec.parentTaskId) return { files: [], notes: [`${found.length} file(s) were named, but the calling session has no task directory to copy them into.`] }
  const { taskDirForHost } = await import('../sessions/task-dir-place.js')
  const taskDir = await taskDirForHost(spec.parentTaskId, fromHost)
  if (!taskDir) return { files: [], notes: [`${found.length} file(s) were named, but the task directory on ${fromHost} is not known.`] }
  const dest = `${taskDir}/subagents/${spec.runId ?? spec.runtimeId}`
  await new DaemonFileReader(fromHost).ensureDir(dest)
  const { copyBetweenHosts, copyResult } = await import('../hosts/host-copy.js')
  const used = o.used
  const files: ReturnedFile[] = []
  // The copies end before the turn's own limit, so its answer is never lost to a slow copy.
  const until = o.deadlineAt - COPY_MARGIN_MS
  for (const [i, f] of found.entries()) {
    if (o.signal.aborted) break
    if (Date.now() >= until) { notes.push(`The run's time was nearly up: ${found.length - i} file(s) were not copied back (${found.slice(i, i + 3).map((x) => x.from).join(', ')}).`); break }
    const to = `${dest}/${freeName(path.posix.basename(f.from), used)}`
    try {
      let r = await copyBetweenHosts({ from_host: copy.host, from: f.from, to_host: fromHost, to }, spec.parentSid)
      while (r.running && !o.signal.aborted && Date.now() < until) {
        r = await copyResult({ copy_id: r.copyId, wait_ms: Math.max(1_000, Math.min(COPY_WAIT_MS, until - Date.now())) }, spec.parentSid)
      }
      if (r.running) { notes.push(`${f.from} was still copying to ${to} when the run had to end (host_copy_result copy_id ${String(r.copyId)}).`); continue }
      files.push({ from: f.from, to: String(r.to ?? to), bytes: typeof r.bytes === 'number' ? r.bytes : f.size })
      o.returned.set(f.from, f.key)
    } catch (err) {
      notes.push(`${f.from} was not copied back: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { files, notes }
}
