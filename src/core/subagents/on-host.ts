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
import { LightSubagentError, type LightRunResult, type LightRunSpec, type ReturnedFile } from './types.js'
import type { WorkCopy } from './work-copy.js'

const LOCAL = '__local__'
/** The lane of a subagent's session (core/sessions: a lane is kept out of the lists and the capacity count). */
export const SUBAGENT_LANE_PREFIX = 'subagent:'
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
  mode: SessionMode; model?: string; effort?: string
}): Record<string, unknown> {
  return {
    taskId: '', message: o.message, cwd: o.cwd, title: o.title, lane: o.lane, mode: o.mode,
    ...(o.host !== LOCAL ? { host: o.host } : {}),
    ...(o.model ? { model: o.model } : {}),
    ...(o.effort ? { effort: o.effort } : {}),
    engine: 'claude', preassignedSessionId: o.sessionId,
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

export async function runOnHost(spec: LightRunSpec): Promise<LightRunResult> {
  const runId = spec.runId ?? spec.runtimeId
  const left = await import('./left-runs.js')
  let copy: WorkCopy | null = null
  const work: string[] = []
  try {
    if (spec.away) {
      const { placeWorkCopy } = await import('./work-copy.js')
      copy = await placeWorkCopy({ runId, fromHost: spec.away.fromHost, fromCwd: spec.away.fromCwd, toHost: spec.host, signal: spec.signal })
      work.push(...copy.lines)
    }
    if (spec.signal.aborted) throw new LightSubagentError('stopped', 'The run was stopped', 409)
    const cwd = copy?.cwd ?? spec.cwd
    let result: LightRunResult
    // The copy took time: the user may have revoked the grant there since.
    await spec.stillGranted?.()
    if (engineCaps(spec.engine).runtimeKind === 'native') {
      result = await runInSession({ ...spec, cwd }, copy, runId)
    } else {
      // Another engine: its worker on that host, in the copy (light-subagent-acp.ts).
      const { runAcpLight } = await import('../../providers/light-subagent-acp.js')
      const prompt = copy ? `${subagentPreamble({ host: spec.host, copy })}\n\n${spec.prompt}` : spec.prompt
      result = await runAcpLight({ ...spec, cwd, prompt })
    }
    const files = copy && spec.away ? await bringBack(spec, copy, result.answer) : { files: [], notes: [] }
    work.push(...files.notes)
    const answer = files.files.length || files.notes.length
      ? `${result.answer}\n\n[Walnut] ${files.files.length ? `Files copied back to ${spec.away!.fromHost === LOCAL ? 'this machine' : spec.away!.fromHost}:\n${files.files.map((f) => `- ${f.from} -> ${f.to}`).join('\n')}` : ''}${files.notes.length ? `\n${files.notes.join('\n')}` : ''}`
      : result.answer
    const done: LightRunResult = { ...result, answer, ...(files.files.length ? { files: files.files } : {}), ...(work.length ? { work } : {}) }
    // The caller has it now; removing the copy below never costs it the answer.
    spec.onAnswer?.(done)
    return done
  } finally {
    if (copy) {
      const { removeWorkCopy } = await import('./work-copy.js')
      const gone = await removeWorkCopy(copy, runId)
      if (!gone) log.agent.warn('subagent on host: its copy is still on the host; the next sweep removes it', { runId, host: copy.host, dir: copy.runDir })
    }
    await left.settleLeft(runId).catch(() => {})
    // Something could not be removed (a host offline): the sweep comes back for it.
    if (left.listLeftRuns().some((r) => r.id === runId)) left.scheduleLeftRunsSweep()
  }
}

/** The run as a session on its host; its answer is its turn's result. */
async function runInSession(spec: LightRunSpec, copy: WorkCopy | null, runId: string): Promise<LightRunResult> {
  const { bus, EventNames } = await import('../event-bus.js')
  const { runLaneTurn } = await import('../sessions/lane-turn.js')
  const { setCallerAlias, clearCallerAlias } = await import('../sessions/acp-caller-sid.js')
  const left = await import('./left-runs.js')
  const sessionId = crypto.randomUUID()
  const lane = `${SUBAGENT_LANE_PREFIX}${spec.runtimeId}`
  const mode = subagentMode(spec.fullAccess, spec.parentMode)
  const title = `Subagent ${spec.runtimeId}`
  const message = `${subagentPreamble({ host: spec.host, copy })}\n\n${spec.prompt}`
  // Its calls act for the parent from its first line on.
  setCallerAlias(sessionId, spec.callerSid)
  let answerSoFar = ''
  let tokens: number | undefined
  const sub = `subagent-${spec.runtimeId}`
  bus.subscribe(sub, (event) => {
    const d = event.data as { sessionId?: string; delta?: string; toolName?: string; parentToolUseId?: string; inputTokens?: number }
    if (d?.sessionId !== sessionId || d.parentToolUseId) return
    if (event.name === EventNames.SESSION_TEXT_DELTA && typeof d.delta === 'string') {
      answerSoFar += d.delta
      spec.onProgress({ kind: 'text', text: answerSoFar.slice(-PROGRESS_TEXT_MAX) })
    } else if (event.name === EventNames.SESSION_TOOL_USE && d.toolName) {
      answerSoFar = ''
      spec.onProgress({ kind: 'tool', toolName: d.toolName })
    } else if (event.name === EventNames.SESSION_USAGE_UPDATE && typeof d.inputTokens === 'number' && d.inputTokens > 0) {
      tokens = d.inputTokens
      spec.onProgress({ kind: 'tokens', tokens })
    }
  }, { global: true, interest: [EventNames.SESSION_TEXT_DELTA, EventNames.SESSION_TOOL_USE, EventNames.SESSION_USAGE_UPDATE] })
  /** Its record's write, once begun: from then on the session is retired, whichever way the run ends. */
  let recording: Promise<unknown> | null = null
  let started = false
  let retiring: Promise<void> | null = null
  const retire = (reason: string): Promise<void> => {
    if (!recording) return Promise.resolve()
    const made = recording
    retiring ??= (async () => {
      // A stop while the record is still being written retires it once it is there.
      await made.catch(() => {})
      const { getSessionByClaudeId } = await import('../session-tracker.js')
      const spawned = !!(await getSessionByClaudeId(sessionId).catch(() => null))?.pid
      let gone = await retireSubagentSession(sessionId, reason, spec.cwd)
      // Started but not spawned yet when it was stopped: the CLI the runner may spawn after the
      // stop is stopped and its files removed too (the sweep has it otherwise).
      if (started && !spawned && reason === 'subagent_stopped') {
        await new Promise((r) => setTimeout(r, lateStopCheckMs).unref?.())
        gone = (await retireSubagentSession(sessionId, reason, spec.cwd)) && gone
      }
      // Kept for the sweep while its host could not be reached.
      if (gone) await left.dropLeftSession(runId)
    })().catch((err: unknown) => {
      log.agent.warn('subagent on host: retiring its session failed; the sweep tries again', { sessionId, error: err instanceof Error ? err.message : String(err) })
    })
    return retiring
  }
  const onAbort = () => { void retire('subagent_stopped') }
  spec.signal.addEventListener('abort', onAbort, { once: true })
  try {
    const { createSessionRecord } = await import('../session-tracker.js')
    // A stop ends the wait at once: the session is being stopped (onAbort), and the turn's own
    // watch ends with its death in the background.
    let rejectStop!: (e: Error) => void
    const stopped = new Promise<never>((_r, reject) => { rejectStop = reject })
    stopped.catch(() => {})
    const onStop = () => rejectStop(new LightSubagentError('stopped', 'The run was stopped', 409))
    if (spec.signal.aborted) onStop()
    else spec.signal.addEventListener('abort', onStop, { once: true })
    const turnP = runLaneTurn('subagent', lane, message, {
      source: 'subagent',
      timeoutMs: Math.max(60_000, spec.deadlineAt - Date.now()),
      target: {
        // `firstMessage`: the message framed as Walnut's (sessions/send-frame.ts), never as the user's.
        resolve: async (firstMessage) => {
          if (spec.signal.aborted) throw new LightSubagentError('stopped', 'The run was stopped', 409)
          // Named for the sweep before it exists, then the record (as ai-agent.ts mints a lane), then the start.
          await left.noteLeft(runId, { sessionId, sessionCwd: spec.cwd })
          recording = createSessionRecord(sessionId, '', '', spec.cwd, {
            title, lane, mode, ...(spec.host !== LOCAL ? { host: spec.host } : {}),
            initialProcessStatus: 'idle', initialStatusReason: 'awaiting_spawn',
          })
          await recording
          if (spec.signal.aborted) throw new LightSubagentError('stopped', 'The run was stopped', 409)
          const start = sessionStartData({ sessionId, lane, host: spec.host, cwd: spec.cwd, message: firstMessage, title, mode, model: spec.model, effort: spec.effort })
          await spec.stillGranted?.()
          started = true
          if (starterOverride) starterOverride(start)
          else bus.emit(EventNames.SESSION_START, start as never, ['session-runner'], { source: 'subagent' })
          return { sessionId, created: true, engine: 'claude' }
        },
        catchUp: async (_sid, m) => ({ message: m }),
      },
    })
    turnP.catch(() => {})
    const turn = await Promise.race([turnP, stopped]).finally(() => spec.signal.removeEventListener('abort', onStop))
    if (spec.signal.aborted) throw new LightSubagentError('stopped', 'The run was stopped', 409)
    if (turn.resultText === null) {
      const where = spec.host === LOCAL ? 'this machine' : spec.host
      const why = turn.failure === 'timeout' ? 'it ran out of its time'
        : turn.failure === 'died' ? `its Claude Code process on ${where} ended before it answered`
          : turn.failure === 'stalled' ? 'it went silent for 15 minutes'
            : `its session on ${where} did not answer (${turn.failure ?? 'unknown'})`
      throw new LightSubagentError(turn.failure === 'timeout' ? 'timed_out' : 'engine_error', `Claude Code on ${where}: ${why}`)
    }
    return { answer: turn.resultText.trim(), ...(tokens ? { tokens } : {}), warnings: [] }
  } finally {
    spec.signal.removeEventListener('abort', onAbort)
    bus.unsubscribe(sub)
    clearCallerAlias(sessionId)
    // Its session is gone before its folder is removed: a CLI still in its turn could write there again.
    await retire(spec.signal.aborted ? 'subagent_stopped' : 'subagent_done')
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

/**
 * The files the run named, copied back into the caller's task directory: everything in its
 * out folder (two levels deep), and every absolute path its answer names that is a file there.
 * A file that could not come back is a note, never a failure of the run.
 */
async function bringBack(spec: LightRunSpec, copy: WorkCopy, answer: string): Promise<{ files: ReturnedFile[]; notes: string[] }> {
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
  const found: Array<{ from: string; size: number }> = []
  let total = 0
  for (const p of named) {
    if (found.length >= MAX_FILES) { notes.push(`More than ${MAX_FILES} files were named: the rest stayed and were removed with the copy.`); break }
    const at = await probe(copy.host, p).catch(() => ({ at: 'missing' as const, size: undefined }))
    if (at.at !== 'file' || at.size === undefined) continue
    if (total + at.size > MAX_TOTAL_BYTES) { notes.push(`${p} was not copied back: over ${MAX_TOTAL_BYTES / 1024 ** 3} GB in all.`); continue }
    total += at.size
    found.push({ from: p, size: at.size })
  }
  if (found.length === 0) return { files: [], notes }
  if (!spec.parentTaskId) return { files: [], notes: [`${found.length} file(s) were named, but the calling session has no task directory to copy them into.`] }
  const { taskDirForHost } = await import('../sessions/task-dir-place.js')
  const taskDir = await taskDirForHost(spec.parentTaskId, fromHost)
  if (!taskDir) return { files: [], notes: [`${found.length} file(s) were named, but the task directory on ${fromHost} is not known.`] }
  const dest = `${taskDir}/subagents/${spec.runId ?? spec.runtimeId}`
  await new DaemonFileReader(fromHost).ensureDir(dest)
  const { copyBetweenHosts, copyResult } = await import('../hosts/host-copy.js')
  const used = new Set<string>()
  const files: ReturnedFile[] = []
  // The copies end before the run's own limit, so its answer is never lost to a slow copy.
  const until = spec.deadlineAt - COPY_MARGIN_MS
  for (const [i, f] of found.entries()) {
    if (spec.signal.aborted) break
    if (Date.now() >= until) { notes.push(`The run's time was nearly up: ${found.length - i} file(s) were not copied back (${found.slice(i, i + 3).map((x) => x.from).join(', ')}).`); break }
    const to = `${dest}/${freeName(path.posix.basename(f.from), used)}`
    try {
      let r = await copyBetweenHosts({ from_host: copy.host, from: f.from, to_host: fromHost, to }, spec.parentSid)
      while (r.running && !spec.signal.aborted && Date.now() < until) {
        r = await copyResult({ copy_id: r.copyId, wait_ms: Math.max(1_000, Math.min(COPY_WAIT_MS, until - Date.now())) }, spec.parentSid)
      }
      if (r.running) { notes.push(`${f.from} was still copying to ${to} when the run had to end (host_copy_result copy_id ${String(r.copyId)}).`); continue }
      files.push({ from: f.from, to: String(r.to ?? to), bytes: typeof r.bytes === 'number' ? r.bytes : f.size })
    } catch (err) {
      notes.push(`${f.from} was not copied back: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { files, notes }
}
