/**
 * `aiRun` (src/core/ai/ai-run.ts) with both routes swapped for recorders: which route a request
 * takes, what each route is handed, the conversation that persists between calls, the format
 * parse and its one repair, the caller's switch, budget and concurrency, and cancellation.
 * The model itself is never reached (setAiDirectOverride / setAiAgentOverride).
 */
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-ai-run'))

import { CONFIG_FILE, WALNUT_HOME } from '../../../src/constants.js'
import { aiEnd, aiRun } from '../../../src/core/ai/ai-run.js'
import { setAiDirectOverride, type DirectCall } from '../../../src/core/ai/ai-direct.js'
import { setAiAgentOverride, type AgentCall } from '../../../src/core/ai/ai-agent.js'
import { _setAiSpendDirForTesting, callerSpend, setCallerSettings, MAX_AGENT_RUNS } from '../../../src/core/ai/ai-policy.js'
import { _setAiConversationsDirForTesting, conversationTurns } from '../../../src/core/ai/ai-conversations.js'
import type { AiCaller } from '../../../src/core/ai/ai-types.js'

const caller: AiCaller = { kind: 'plugin', id: 'tickets', name: 'Tickets', homeDir: '/data/tickets' }
let directCalls: DirectCall[] = []
let agentCalls: AgentCall[] = []
let directAnswers: string[] = []

function writeConfig(extra: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
  fs.writeFileSync(CONFIG_FILE, yaml.dump({ version: 1, user: { name: 'Ada' }, ...extra }), 'utf-8')
}

beforeEach(() => {
  const dir = path.join(WALNUT_HOME, 'local', 'ai', String(Math.random()).slice(2))
  _setAiSpendDirForTesting(dir)
  _setAiConversationsDirForTesting(path.join(dir, 'conversations'))
  writeConfig()
  directCalls = []
  agentCalls = []
  directAnswers = []
  setAiDirectOverride(async (call) => {
    directCalls.push(call)
    call.onText?.('Hel')
    call.onText?.('lo')
    return { text: directAnswers.shift() ?? 'Hello', engine: 'claude', model: 'sonnet', costUsd: 0.01 }
  })
  setAiAgentOverride(async (call) => {
    agentCalls.push(call)
    return { text: 'Agent answer', engine: 'claude', costUsd: 0.2, sessionId: 'sid-1' }
  })
})

afterEach(() => {
  setAiDirectOverride(null)
  setAiAgentOverride(null)
})

describe('route', () => {
  it('a plain request is one direct answer, streamed, with the default system prompt', async () => {
    const deltas: string[] = []
    const result = await aiRun(caller, { prompt: 'Summarize this ticket', context: { title: 'Login fails' }, onText: (d) => deltas.push(d) })
    expect(result).toMatchObject({ text: 'Hello', route: 'direct', engine: 'claude', model: 'sonnet', costUsd: 0.01 })
    expect(result.conversation).toBeUndefined()
    expect(deltas.join('')).toBe('Hello')
    expect(agentCalls).toHaveLength(0)
    expect(directCalls[0].prompt).toContain('"title": "Login fails"')
    expect(directCalls[0].system).toMatch(/helpful assistant/)
    expect(directCalls[0].effort).toBe('normal')
    expect(directCalls[0].timeoutMs).toBe(60_000)
    expect(directCalls[0].ledgerAgentId).toBe('plugin:tickets')
  })

  it('any need makes it a one-shot agent run in the caller\'s folder', async () => {
    const result = await aiRun(caller, { prompt: 'Summarize T-123 with its comments', needs: { ops: ['tickets_get'] } })
    expect(result.route).toBe('agent')
    expect(directCalls).toHaveLength(0)
    const call = agentCalls[0]
    expect(call.oneShot).toBe(true)
    expect(call.cwd).toBe('/data/tickets')
    expect(call.lane).toMatch(/^ai:plugin%3Atickets:run-/)
    expect(call.system).toContain('walnut tools call <op>')
    expect(call.system).toContain('tickets_get')
    expect(call.timeoutMs).toBe(10 * 60_000)
  })

  it('a cwd in needs wins over the caller folder; a timeout is capped, never raised', async () => {
    await aiRun(caller, { prompt: 'run tests', needs: { cwd: '/ws/q1', commands: ['python3 -m pytest'] }, timeoutMs: 99 * 60_000 })
    expect(agentCalls[0].cwd).toBe('/ws/q1')
    expect(agentCalls[0].timeoutMs).toBe(10 * 60_000)
    await aiRun(caller, { prompt: 'quick', timeoutMs: 5_000 })
    expect(directCalls[0].timeoutMs).toBe(5_000)
  })
})

describe('conversation', () => {
  it('a direct conversation replays its earlier turns and stores the new ones', async () => {
    directAnswers = ['Use a heap.', 'Pop the smallest first.']
    await aiRun(caller, { prompt: 'first hint?', conversation: 'attempt:1' })
    const second = await aiRun(caller, { prompt: 'second hint?', conversation: 'attempt:1' })
    expect(second.conversation).toBe('attempt:1')
    expect(directCalls[0].history).toEqual([])
    expect(directCalls[1].history).toEqual([{ role: 'user', text: 'first hint?' }, { role: 'assistant', text: 'Use a heap.' }])
    expect(directCalls[1].prompt).toContain('<conversation_so_far>')
    expect(await conversationTurns(caller, 'attempt:1')).toHaveLength(4)
    // Another key and another caller see nothing of it.
    expect(await conversationTurns(caller, 'attempt:2')).toEqual([])
    expect(await conversationTurns({ kind: 'plugin', id: 'other' }, 'attempt:1')).toEqual([])
  })

  it('an agent conversation keeps its lane and hands a new lane the earlier turns', async () => {
    await aiRun(caller, { prompt: 'plain question', conversation: 't-9' })
    await aiRun(caller, { prompt: 'now look it up', conversation: 't-9', needs: { ops: ['tickets_get'] } })
    const call = agentCalls[0]
    expect(call.oneShot).toBe(false)
    expect(call.lane).toBe('ai:plugin%3Atickets:t-9')
    expect(call.firstMessage).toContain('plain question')
    expect(call.message).toBe('now look it up')
  })

  it('end forgets it', async () => {
    await aiRun(caller, { prompt: 'q', conversation: 'gone' })
    expect((await aiEnd(caller, 'gone')).ended).toBe(true)
    expect(await conversationTurns(caller, 'gone')).toEqual([])
    expect((await aiEnd(caller, 'gone')).ended).toBe(false)
  })
})

describe('format', () => {
  const schema = { type: 'object', required: ['score'], properties: { score: { type: 'integer' } } }

  it('parses the answer into json', async () => {
    directAnswers = ['```json\n{"score": 3}\n```']
    const result = await aiRun(caller, { prompt: 'grade', format: { schema } })
    expect(result.json).toEqual({ score: 3 })
    expect(directCalls[0].turnText).toContain(JSON.stringify(schema))
  })

  it('asks once more with the problem when the answer does not match, then gives up with ai_format', async () => {
    directAnswers = ['{"grade": "B"}', '{"score": 2}']
    const result = await aiRun(caller, { prompt: 'grade', format: { schema } })
    expect(result.json).toEqual({ score: 2 })
    expect(directCalls).toHaveLength(2)
    expect(directCalls[1].turnText).toContain('$.score is missing')
    expect(directCalls[1].history.at(-1)).toEqual({ role: 'assistant', text: '{"grade": "B"}' })
    expect(result.costUsd).toBeCloseTo(0.02)

    directAnswers = ['nope', 'still nope']
    await expect(aiRun(caller, { prompt: 'grade', format: { schema } })).rejects.toMatchObject({ code: 'ai_format' })
  })
})

describe('the caller\'s limits', () => {
  it('counts spend per caller', async () => {
    await aiRun(caller, { prompt: 'a' })
    await aiRun(caller, { prompt: 'b', needs: { files: 'read' } })
    const spend = await callerSpend(caller)
    expect(spend.calls).toBe(2)
    expect(spend.usd).toBeCloseTo(0.21)
  })

  it('refuses when switched off, and when the month\'s budget is used up', async () => {
    await setCallerSettings('tickets', { enabled: false })
    await expect(aiRun(caller, { prompt: 'a' })).rejects.toMatchObject({ code: 'ai_disabled' })
    await setCallerSettings('tickets', { enabled: true, monthlyUsd: 0.015 })
    await aiRun(caller, { prompt: 'a' })
    await aiRun(caller, { prompt: 'b' })
    await expect(aiRun(caller, { prompt: 'c' })).rejects.toMatchObject({ code: 'ai_budget' })
    expect(directCalls).toHaveLength(2)
    // Another plugin has its own budget.
    await expect(aiRun({ kind: 'plugin', id: 'other' }, { prompt: 'c' })).resolves.toMatchObject({ route: 'direct' })
  })

  it('runs at most MAX_AGENT_RUNS agent runs at once; the next waits for a slot', async () => {
    const gates: Array<() => void> = []
    setAiAgentOverride(async (call) => {
      agentCalls.push(call)
      await new Promise<void>((resolve) => gates.push(resolve))
      return { text: 'done', engine: 'claude', sessionId: 's' }
    })
    const runs = Array.from({ length: MAX_AGENT_RUNS + 1 }, (_, i) => aiRun(caller, { prompt: `job ${i}`, needs: { files: 'read' } }))
    await vi.waitFor(() => expect(agentCalls).toHaveLength(MAX_AGENT_RUNS))
    await new Promise((r) => setTimeout(r, 50))
    expect(agentCalls).toHaveLength(MAX_AGENT_RUNS)
    gates.shift()!()
    await vi.waitFor(() => expect(agentCalls).toHaveLength(MAX_AGENT_RUNS + 1))
    while (gates.length) gates.shift()!()
    await expect(Promise.all(runs)).resolves.toHaveLength(MAX_AGENT_RUNS + 1)
  })

  it('a waiter that is cancelled leaves the queue, so the next one still gets the freed slot', async () => {
    const gates: Array<() => void> = []
    setAiAgentOverride(async (call) => {
      agentCalls.push(call)
      await new Promise<void>((resolve) => gates.push(resolve))
      return { text: 'done', engine: 'claude', sessionId: 's' }
    })
    const running = Array.from({ length: MAX_AGENT_RUNS }, (_, i) => aiRun(caller, { prompt: `job ${i}`, needs: { files: 'read' } }))
    await vi.waitFor(() => expect(agentCalls).toHaveLength(MAX_AGENT_RUNS))
    const gone = [new AbortController(), new AbortController()]
    const cancelled = gone.map((c) => aiRun(caller, { prompt: 'gone', needs: { files: 'read' }, signal: c.signal }))
    const waiting = aiRun(caller, { prompt: 'still here', needs: { files: 'read' } })
    await new Promise((r) => setTimeout(r, 30))
    for (const c of gone) c.abort()
    for (const run of cancelled) await expect(run).rejects.toMatchObject({ code: 'ai_aborted' })
    // One slot frees: it must go to the live waiter, not to a cancelled one.
    gates.shift()!()
    await vi.waitFor(() => expect(agentCalls.map((c) => c.message)).toContain('still here'))
    expect(agentCalls.map((c) => c.message)).not.toContain('gone')
    await vi.waitFor(() => expect(gates).toHaveLength(MAX_AGENT_RUNS))
    while (gates.length) gates.shift()!()
    await expect(waiting).resolves.toMatchObject({ text: 'done' })
    await Promise.all(running)
  })

  it('what a failed run cost still counts against the budget', async () => {
    const { AiError } = await import('../../../src/core/ai/ai-types.js')
    setAiAgentOverride(async () => { throw Object.assign(new AiError('ai_timeout', 'No answer within 600 s'), { costUsd: 0.4 }) })
    await expect(aiRun(caller, { prompt: 'slow', needs: { files: 'read' } })).rejects.toMatchObject({ code: 'ai_timeout' })
    expect((await callerSpend(caller)).usd).toBeCloseTo(0.4)
  })

  it('a slot is given back when a run fails', async () => {
    setAiAgentOverride(async () => { throw new Error('daemon gone') })
    for (let i = 0; i < MAX_AGENT_RUNS + 2; i++) {
      await expect(aiRun(caller, { prompt: 'x', needs: { files: 'read' } })).rejects.toMatchObject({ code: 'ai_failed', message: 'daemon gone' })
    }
  })
})

describe('bad requests and cancellation', () => {
  it('names what is wrong', async () => {
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ prompt: '  ' }, /needs a prompt/],
      [{ prompt: 'x', conversation: 'has space' }, /conversation must be/],
      [{ prompt: 'x', effort: 'max' }, /effort must be/],
      [{ prompt: 'x', needs: { cwd: 'relative/dir' } }, /absolute folder/],
      [{ prompt: 'x', needs: { files: 'write' } }, /needs.files/],
      [{ prompt: 'x', format: { schema: null } }, /format must be/],
      [{ prompt: 'x', needs: { ops: 'tickets_get' } }, /needs.ops must be a list/],
      [{ prompt: 'x', needs: { commands: [3] } }, /needs.commands must be a list/],
      [{ prompt: 'x'.repeat(200_001) }, /at most 200000/],
    ]
    for (const [request, message] of bad) {
      await expect(aiRun(caller, request as never)).rejects.toMatchObject({ code: 'ai_bad_request', message: expect.stringMatching(message) })
    }
    expect(directCalls).toHaveLength(0)
  })

  it('an aborted signal never reaches the model', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(aiRun(caller, { prompt: 'x', signal: controller.signal })).rejects.toMatchObject({ code: 'ai_aborted' })
    expect(directCalls).toHaveLength(0)
  })
})
