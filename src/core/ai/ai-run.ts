/**
 * `ai.run`: the one entry for a plugin, an App or Walnut itself (docs/plan/plugin-ai.md).
 *
 * Route: a request that names `needs` (ops, files, commands, a cwd) runs as an agent session on
 * the daemon (ai-agent.ts); everything else is one direct answer (ai-direct.ts). A `conversation`
 * key keeps the turns (ai-conversations.ts): a direct call replays them, an agent conversation
 * keeps its session. Limits and spend are per caller (ai-policy.ts).
 */
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { log } from '../../logging/index.js'
import { AiError, type AiCaller, type AiRunRequest, type AiRunResult } from './ai-types.js'
import { boundHistory, buildDirectPrompt, buildTurnText, DEFAULT_SYSTEM, formatInstruction, parseFormatted } from './ai-prompt.js'
import {
  acquireRunSlot, AGENT_TIMEOUT_MS, assertCallerMayRun, DIRECT_MAX_TIMEOUT_MS, DIRECT_TIMEOUT_MS, recordSpend,
} from './ai-policy.js'
import { appendTurns, conversationLanes, conversationTurns, forgetConversation, noteConversationLane } from './ai-conversations.js'
import { runDirect } from './ai-direct.js'
import { aiLaneKey, retireLane, runAgent } from './ai-agent.js'

const MAX_PROMPT_CHARS = 200_000
const MAX_SYSTEM_CHARS = 20_000
const CONVERSATION_KEY = /^[A-Za-z0-9_.:@/-]{1,120}$/

function needsAgent(request: AiRunRequest): boolean {
  const needs = request.needs
  return !!needs && ((needs.ops?.length ?? 0) > 0 || (needs.commands?.length ?? 0) > 0 || !!needs.files || !!needs.cwd)
}

/** Throws `ai_bad_request` for a request no route can take. */
export function validateRequest(request: AiRunRequest): void {
  if (!request || typeof request.prompt !== 'string' || !request.prompt.trim()) {
    throw new AiError('ai_bad_request', 'ai.run needs a prompt')
  }
  const contextChars = request.context === undefined ? 0
    : typeof request.context === 'string' ? request.context.length : JSON.stringify(request.context).length
  if (request.prompt.length + contextChars > MAX_PROMPT_CHARS) {
    throw new AiError('ai_bad_request', `The prompt and context together may hold at most ${MAX_PROMPT_CHARS} characters`)
  }
  if (request.system !== undefined && (typeof request.system !== 'string' || request.system.length > MAX_SYSTEM_CHARS)) {
    throw new AiError('ai_bad_request', `system must be text of at most ${MAX_SYSTEM_CHARS} characters`)
  }
  if (request.format !== undefined && (!request.format || typeof request.format.schema !== 'object' || request.format.schema === null)) {
    throw new AiError('ai_bad_request', 'format must be { schema: <JSON Schema object> }')
  }
  if (request.conversation !== undefined && !CONVERSATION_KEY.test(request.conversation)) {
    throw new AiError('ai_bad_request', 'conversation must be 1-120 letters, digits or _ . : @ / -')
  }
  if (request.effort !== undefined && !['quick', 'normal', 'deep'].includes(request.effort)) {
    throw new AiError('ai_bad_request', 'effort must be quick, normal or deep')
  }
  for (const field of ['ops', 'commands'] as const) {
    const list = request.needs?.[field]
    if (list !== undefined && (!Array.isArray(list) || list.some((item) => typeof item !== 'string' || !item.trim()))) {
      throw new AiError('ai_bad_request', `needs.${field} must be a list of names`)
    }
  }
  const cwd = request.needs?.cwd
  if (cwd !== undefined && (typeof cwd !== 'string' || !path.isAbsolute(cwd))) {
    throw new AiError('ai_bad_request', 'needs.cwd must be an absolute folder')
  }
  if (request.needs?.files !== undefined && !['read', 'edit'].includes(request.needs.files)) {
    throw new AiError('ai_bad_request', "needs.files must be 'read' or 'edit'")
  }
}

function capTimeout(requested: number | undefined, fallback: number, max: number): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) return fallback
  return Math.min(Math.max(1_000, Math.floor(requested)), max)
}

function systemFor(request: AiRunRequest, agent: boolean): string {
  const base = request.system?.trim() || DEFAULT_SYSTEM
  if (!agent) return base
  const needs = request.needs ?? {}
  const lines = [base, '', 'You run inside an app, with no person watching this session. Do only what the request asks.']
  if (needs.ops?.length) lines.push(`Use \`walnut tools call <op> '<json>'\` for these ops: ${needs.ops.join(', ')}. \`walnut tools help <op>\` shows an op's arguments.`)
  if (needs.commands?.length) lines.push(`You may run commands starting with: ${needs.commands.join('; ')}.`)
  if (needs.files) lines.push(needs.files === 'edit' ? 'You may read and edit files in the working folder.' : 'You may read files in the working folder; do not edit anything.')
  lines.push('Anything else you try is denied. End with the answer itself, as your final message.')
  return lines.join('\n')
}

export async function aiRun(caller: AiCaller, request: AiRunRequest): Promise<AiRunResult> {
  validateRequest(request)
  if (request.signal?.aborted) throw new AiError('ai_aborted', 'The call was cancelled')
  await assertCallerMayRun(caller)
  const agent = needsAgent(request)
  const started = Date.now()
  const effort = request.effort ?? 'normal'
  const conversation = request.conversation
  const history = conversation ? boundHistory(await conversationTurns(caller, conversation)) : []
  const turnText = buildTurnText(request)
  const system = systemFor(request, agent)
  const release = await acquireRunSlot(caller, agent ? 'agent' : 'direct', request.signal)
  log.agent.info('ai.run', {
    caller: `${caller.kind}:${caller.id}`, route: agent ? 'agent' : 'direct', effort,
    conversation: conversation ?? null, historyTurns: history.length, promptChars: turnText.length,
  })
  /** Everything this call cost, failed parts included: the budget counts what was spent. */
  let spent = 0
  try {
    let text: string
    let engine: string
    let model: string | undefined
    let costUsd: number | undefined
    if (agent) {
      const cwd = request.needs?.cwd ?? caller.homeDir ?? os.tmpdir()
      const answer = await runAgent({
        caller,
        lane: aiLaneKey(caller, conversation ?? `run-${crypto.randomUUID()}`),
        oneShot: !conversation,
        system,
        firstMessage: buildDirectPrompt(turnText, history),
        message: turnText,
        needs: request.needs ?? {},
        cwd,
        effort,
        timeoutMs: capTimeout(request.timeoutMs, AGENT_TIMEOUT_MS, AGENT_TIMEOUT_MS),
        ...(request.onText ? { onText: request.onText } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
        ...(conversation ? { noteLane: (lane: string) => noteConversationLane(caller, conversation, lane) } : {}),
      })
      ;({ text, engine, model, costUsd } = answer)
    } else {
      const answer = await runDirect({
        system, turnText, history, prompt: buildDirectPrompt(turnText, history), effort,
        timeoutMs: capTimeout(request.timeoutMs, DIRECT_TIMEOUT_MS, DIRECT_MAX_TIMEOUT_MS),
        interactive: request.interactive === true,
        ledgerAgentId: `${caller.kind}:${caller.id}`,
        ...(request.onText ? { onText: request.onText } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      })
      ;({ text, engine, model, costUsd } = answer)
    }
    spent += costUsd ?? 0

    let json: unknown
    if (request.format) {
      try {
        json = parseFormatted(text, request.format.schema)
      } catch (error) {
        // One repair on the direct route: the model sees its answer and the problem.
        if (agent) throw error
        const repairHistory = [...history, { role: 'user' as const, text: turnText }, { role: 'assistant' as const, text }]
        const repairText = `${(error as Error).message}. ${formatInstruction(request.format.schema)}`
        const repaired = await runDirect({
          system, turnText: repairText, history: repairHistory, prompt: buildDirectPrompt(repairText, repairHistory),
          effort, timeoutMs: capTimeout(request.timeoutMs, DIRECT_TIMEOUT_MS, DIRECT_MAX_TIMEOUT_MS),
          interactive: request.interactive === true,
          ledgerAgentId: `${caller.kind}:${caller.id}`,
          ...(request.signal ? { signal: request.signal } : {}),
        })
        spent += repaired.costUsd ?? 0
        costUsd = (costUsd ?? 0) + (repaired.costUsd ?? 0)
        text = repaired.text
        json = parseFormatted(text, request.format.schema)
      }
    }
    if (conversation) {
      await appendTurns(caller, conversation, [{ role: 'user', text: turnText }, { role: 'assistant', text }])
    }
    return {
      text,
      ...(request.format ? { json } : {}),
      route: agent ? 'agent' : 'direct',
      engine,
      ...(model ? { model } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(conversation ? { conversation } : {}),
      durationMs: Date.now() - started,
    }
  } catch (error) {
    if (error instanceof AiError && typeof error.costUsd === 'number') spent += error.costUsd
    log.agent.warn('ai.run failed', {
      caller: `${caller.kind}:${caller.id}`, route: agent ? 'agent' : 'direct',
      code: error instanceof AiError ? error.code : request.signal?.aborted ? 'ai_aborted' : 'ai_failed',
      error: error instanceof Error ? error.message : String(error),
    })
    if (error instanceof AiError) throw error
    if (request.signal?.aborted) throw new AiError('ai_aborted', 'The call was cancelled')
    throw new AiError('ai_failed', error instanceof Error ? error.message : String(error))
  } finally {
    release()
    await recordSpend(caller, spent)
  }
}

/** Forget a conversation and stop its session, if it had one. */
export async function aiEnd(caller: AiCaller, conversation: string): Promise<{ ended: boolean }> {
  if (!CONVERSATION_KEY.test(conversation)) throw new AiError('ai_bad_request', 'Not a conversation key')
  const lanes = await conversationLanes(caller, conversation)
  const retired = await Promise.all(lanes.map((lane) => retireLane(lane, 'ai_end')))
  const forgot = await forgetConversation(caller, conversation)
  return { ended: forgot || retired.some(Boolean) }
}
