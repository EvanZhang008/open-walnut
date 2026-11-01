/**
 * The agent route of `ai.run`: a real session the daemon owns, hidden from the user's lists.
 *
 * The session is a lane (`ai:<caller>:<key>`, no task), so it is kept out of the default session
 * lists and the host capacity count, survives a server restart, and is cold-resumed after an idle
 * reap like any other session. One-shot runs stop and archive it after the turn; a conversation
 * keeps it. The turn runs through runLaneTurn, the same turn runner the Personal AI uses.
 *
 * It starts slim: the caller's system prompt REPLACES the coding-agent one, only the tools `needs`
 * names exist (`--tools`), they are pre-approved (`--allowedTools`), and the mode is `dontAsk`,
 * so anything else is denied instead of waiting on a person who is not there. Never bypass.
 */
import crypto from 'node:crypto'
import { log } from '../../logging/index.js'
import { AiError, type AiCaller, type AiNeeds } from './ai-types.js'
import { callerKey } from './ai-policy.js'

export const AI_LANE_PREFIX = 'ai:'

export function aiLaneKey(caller: AiCaller, key: string): string {
  return `${AI_LANE_PREFIX}${encodeURIComponent(callerKey(caller))}:${key}`
}

/** Characters an op name or command prefix may carry into a permission rule. */
const OP_NAME = /^[A-Za-z0-9_.-]{1,80}$/
const COMMAND_PREFIX = /^[A-Za-z0-9_./ =:@+-]{1,120}$/

export interface AgentPermissions {
  tools: string[]
  allowedTools: string[]
}

/** `needs` → the engine's own permission controls. Pure; throws on anything it cannot express safely. */
export function agentPermissions(needs: AiNeeds, cwd: string, resolveOp: (name: string) => string): AgentPermissions {
  const tools = new Set<string>()
  const allowed: string[] = []
  for (const raw of needs.ops ?? []) {
    if (!OP_NAME.test(raw)) throw new AiError('ai_bad_request', `Not an op name: ${JSON.stringify(raw)}`)
    const op = resolveOp(raw)
    tools.add('Bash')
    allowed.push(`Bash(walnut tools call ${op}:*)`, `Bash(walnut tools help ${op})`)
  }
  for (const raw of needs.commands ?? []) {
    const command = raw.trim()
    if (!COMMAND_PREFIX.test(command) || /[;&|`$<>]/.test(command)) {
      throw new AiError('ai_bad_request', `A command prefix may hold only plain words: ${JSON.stringify(raw)}`)
    }
    tools.add('Bash')
    allowed.push(`Bash(${command}:*)`)
  }
  const files = needs.files ?? (needs.cwd ? 'read' : undefined)
  if (files) {
    // `//` starts an absolute path in a Claude Code permission rule.
    const under = `/${cwd.replace(/\/+$/, '')}/**`
    for (const tool of ['Read', 'Grep', 'Glob']) tools.add(tool)
    // Reads inside the working folder are allowed by the CLI itself; a bare `Grep`/`Glob` rule
    // would let them search the whole disk.
    allowed.push(`Read(${under})`)
    if (files === 'edit') {
      tools.add('Edit')
      tools.add('Write')
      allowed.push(`Edit(${under})`, `Write(${under})`)
    }
  }
  return { tools: [...tools], allowedTools: allowed }
}

export interface AgentCall {
  caller: AiCaller
  lane: string
  oneShot: boolean
  system: string
  /** The message a NEW lane starts with (history replay plus this turn). */
  firstMessage: string
  /** The message into an EXISTING lane (this turn only: the session has the rest). */
  message: string
  needs: AiNeeds
  cwd: string
  effort: 'quick' | 'normal' | 'deep'
  timeoutMs: number
  onText?: (delta: string) => void
  signal?: AbortSignal
  /** Told the lane this run uses, before it starts (ai.end retires every lane a conversation used). */
  noteLane?: (lane: string) => Promise<void>
}

export interface AgentAnswer {
  text: string
  engine: string
  model?: string
  costUsd?: number
  sessionId: string
}

export type AgentRunner = (call: AgentCall) => Promise<AgentAnswer>

let override: AgentRunner | null = null

/** Tests that do not run a daemon swap the whole route out. */
export function setAiAgentOverride(fn: AgentRunner | null): void {
  override = fn
}

const CLI_MODEL: Partial<Record<AgentCall['effort'], string>> = { quick: 'haiku', deep: 'opus' }

async function resolveOpName(caller: AiCaller, name: string): Promise<string> {
  const { getOp } = await import('../../ops/registry.js')
  if (getOp(name) || caller.kind !== 'plugin') return name
  const { pluginOpName } = await import('../plugins/ids.js')
  try {
    const owned = pluginOpName(caller.id, name)
    if (getOp(owned)) return owned
  } catch { /* not a plugin op name */ }
  return name
}

/**
 * The lane of one grant: a conversation keeps its session only while what that session was
 * started with (prompt, tools, rules, folder, model) stays the same. A call with other `needs`
 * gets a session of its own, which reads the conversation's turns once (ai-run.ts), so a
 * narrower call never inherits a wider session and a wider one is never silently refused.
 */
export function grantedLane(base: string, call: Pick<AgentCall, 'system' | 'cwd' | 'effort'>, permissions: AgentPermissions): string {
  const grant = crypto.createHash('sha256')
    .update(JSON.stringify([call.system, call.cwd, call.effort, [...permissions.tools].sort(), [...permissions.allowedTools].sort()]))
    .digest('hex')
    .slice(0, 12)
  return `${base}|${grant}`
}

/** One turn at a time per lane: a second call would join the running turn and share its answer. */
const laneChains = new Map<string, Promise<unknown>>()
function onLane<T>(lane: string, work: () => Promise<T>): Promise<T> {
  const next = (laneChains.get(lane) ?? Promise.resolve()).then(work, work)
  const settled = next.catch(() => undefined)
  laneChains.set(lane, settled)
  void settled.then(() => { if (laneChains.get(lane) === settled) laneChains.delete(lane) })
  return next
}

async function mintLane(call: AgentCall, permissions: AgentPermissions): Promise<{ sessionId: string; created: boolean }> {
  const { getSessionByLane, createSessionRecord } = await import('../session-tracker.js')
  const existing = await getSessionByLane(call.lane)
  if (existing) return { sessionId: existing.claudeSessionId, created: false }
  const { bus, EventNames } = await import('../event-bus.js')
  const sessionId = crypto.randomUUID()
  const profile = {
    systemPrompt: call.system,
    systemPromptMode: 'replace' as const,
    slim: true,
    ...(permissions.tools.length > 0 ? { tools: permissions.tools } : {}),
    ...(permissions.allowedTools.length > 0 ? { allowedTools: permissions.allowedTools } : {}),
  }
  const model = CLI_MODEL[call.effort]
  const title = `${call.caller.name ?? call.caller.id} AI`
  // The record first, so a second call in the spawn window finds this lane (personal-ai-lane.ts).
  await createSessionRecord(sessionId, '', '', call.cwd, {
    title, profile, lane: call.lane, mode: 'dontAsk',
    ...(model ? { cliModel: model } : {}),
    initialProcessStatus: 'idle', initialStatusReason: 'awaiting_spawn',
  })
  bus.emit(EventNames.SESSION_START, {
    taskId: '', message: call.firstMessage, cwd: call.cwd, title, profile, lane: call.lane,
    mode: 'dontAsk', ...(model ? { model } : {}), preassignedSessionId: sessionId,
  }, ['session-runner'], { source: 'ai-run' })
  return { sessionId, created: true }
}

/** Stop and archive a lane: its session is done (a one-shot run, or `ai.end`). */
export async function retireLane(lane: string, reason: string): Promise<boolean> {
  const { getSessionByLane, updateSessionRecord } = await import('../session-tracker.js')
  const record = await getSessionByLane(lane)
  if (!record) return false
  try {
    const { terminateSession } = await import('../sessions/session-lifecycle.js')
    await terminateSession(record.claudeSessionId, { force: true })
  } catch (error) {
    log.session.warn('ai lane: stop failed, archiving anyway', {
      lane, sessionId: record.claudeSessionId, error: error instanceof Error ? error.message : String(error),
    })
  }
  await updateSessionRecord(record.claudeSessionId, { archived: true, archive_reason: reason })
  return true
}

export async function runAgent(call: AgentCall): Promise<AgentAnswer> {
  if (override) return override(call)
  const { getConfig } = await import('../config-manager.js')
  const { resolveDefaultEngine } = await import('../agents/default-engine.js')
  const { isAcpEngine } = await import('../agents/engine-registry.js')
  const { claudeCliAvailable } = await import('../../model/providers/default-provider.js')
  const engine = resolveDefaultEngine(await getConfig())
  // Only Claude Code can be told "exactly these tools, deny the rest" today. An ACP default
  // engine (Codex) still gets agent jobs on Claude Code when it is installed.
  if (!claudeCliAvailable()) {
    throw new AiError('ai_no_engine', isAcpEngine(engine)
      ? 'This needs Claude Code: agent jobs from apps do not run on your default engine yet.'
      : 'This needs a coding engine. Install Claude Code.')
  }

  const ops = new Map<string, string>()
  for (const name of call.needs.ops ?? []) {
    if (OP_NAME.test(name)) ops.set(name, await resolveOpName(call.caller, name))
  }
  const permissions = agentPermissions(call.needs, call.cwd, (name) => ops.get(name) ?? name)
  const lane = grantedLane(call.lane, call, permissions)
  await call.noteLane?.(lane)
  return onLane(lane, () => runTurn({ ...call, lane }, permissions))
}

async function runTurn(call: AgentCall, permissions: AgentPermissions): Promise<AgentAnswer> {
  if (call.signal?.aborted) throw new AiError('ai_aborted', 'The call was cancelled')
  const { runLaneTurn } = await import('../sessions/lane-turn.js')
  const { bus, EventNames } = await import('../event-bus.js')
  let costUsd = 0
  let model: string | undefined
  const subscription: { name: string | null } = { name: null }
  let laneSessionId = ''
  const fail = (code: ConstructorParameters<typeof AiError>[0], message: string) => Object.assign(new AiError(code, message), { costUsd })

  // A cancel stops the work: a one-shot session is stopped outright, a conversation's turn is interrupted.
  const stop = () => {
    if (call.oneShot) {
      void retireLane(call.lane, 'ai_run_cancelled').catch(() => undefined)
    } else if (laneSessionId) {
      bus.emit(EventNames.SESSION_INTERRUPT, { sessionId: laneSessionId }, ['session-runner'], { source: 'ai-run' })
    }
  }
  const watch = (sessionId: string) => {
    laneSessionId = sessionId
    const name = `ai-run-${crypto.randomUUID()}`
    bus.subscribe(name, (event) => {
      const data = event.data as { sessionId?: string; delta?: string; costDelta?: number; model?: string }
      if (data?.sessionId !== sessionId) return
      if (event.name === EventNames.SESSION_TEXT_DELTA && typeof data.delta === 'string') call.onText?.(data.delta)
      if (event.name === EventNames.SESSION_RESULT) {
        if (typeof data.costDelta === 'number') costUsd += data.costDelta
        if (data.model) model = data.model
      }
    }, { global: true, interest: [EventNames.SESSION_TEXT_DELTA, EventNames.SESSION_RESULT] })
    subscription.name = name
    // Cancelled while the lane was being made: nothing was listening for the session id yet.
    if (call.signal?.aborted) stop()
  }

  call.signal?.addEventListener('abort', stop, { once: true })
  try {
    const turn = await runLaneTurn(`ai-${call.caller.id}`, call.lane, call.message, {
      source: 'ai-run',
      timeoutMs: call.timeoutMs,
      onSessionId: watch,
      target: {
        resolve: async () => {
          const minted = await mintLane(call, permissions)
          return { sessionId: minted.sessionId, created: minted.created, engine: 'claude' }
        },
        catchUp: async (_sessionId, message) => ({ message }),
      },
    })
    if (call.signal?.aborted) throw fail('ai_aborted', 'The call was cancelled')
    if (turn.resultText === null) {
      if (turn.failure === 'timeout' || turn.failure === 'stalled') {
        stop()
        throw fail('ai_timeout', `No answer within ${Math.round(call.timeoutMs / 1000)} s`)
      }
      throw fail(turn.failure === 'busy' ? 'ai_busy' : 'ai_failed', `The agent session did not answer (${turn.failure ?? 'unknown'})`)
    }
    return { text: turn.resultText.trim(), engine: 'claude', ...(model ? { model } : {}), costUsd, sessionId: turn.sessionId }
  } catch (error) {
    if (error instanceof AiError) throw error
    throw fail('ai_failed', error instanceof Error ? error.message : String(error))
  } finally {
    call.signal?.removeEventListener('abort', stop)
    if (subscription.name) bus.unsubscribe(subscription.name)
    if (call.oneShot) {
      void retireLane(call.lane, 'ai_run_done').catch((error) => log.session.warn('ai lane: retire failed', {
        lane: call.lane, error: error instanceof Error ? error.message : String(error),
      }))
    }
  }
}
