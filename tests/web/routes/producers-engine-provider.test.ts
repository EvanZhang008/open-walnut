/**
 * Background PRODUCERS × engine selection (`config.agent.provider`).
 *
 * Chat is not the only thing that writes into the Personal AI's MAIN conversation —
 * cron, the heartbeat, and triage all run main-agent turns. C5 routes those three
 * through the conversation's lane session when the flag is on. Each producer is a
 * FORK, so the two things worth asserting per producer are the same two:
 *
 *   - flag OFF (default) → the in-process loop runs and no lane is touched
 *   - flag ON            → the turn is delivered to the lane, the loop is never
 *                          called, and the producer still persists what the user
 *                          needs to see
 *
 * What's real: Express server, the cron service + its deps, the heartbeat runner,
 * the triage dispatch path, chat history, session records, the lane modules.
 * What's mocked: constants.js (temp dir), the agent loop (spy), and the
 * 'session-runner' bus subscriber — a fake that answers a lane turn with a
 * synthetic session:result and NEVER spawns a `claude`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import yaml from 'js-yaml'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())

const runAgentLoop = vi.fn(async (userContent: string | unknown[], history: unknown[]) => ({
  messages: [
    ...(history as Array<{ role: string; content: unknown }>),
    { role: 'user', content: typeof userContent === 'string' ? [{ type: 'text', text: userContent }] : userContent },
    { role: 'assistant', content: [{ type: 'text', text: 'in-process response' }] },
  ],
  newMessages: [
    { role: 'user', content: typeof userContent === 'string' ? [{ type: 'text', text: userContent }] : userContent },
    { role: 'assistant', content: [{ type: 'text', text: 'in-process response' }] },
  ],
  response: 'in-process response',
  aborted: false,
}))

vi.mock('../../../src/agent/loop.js', () => ({ runAgentLoop }))

import type { Server as HttpServer } from 'node:http'
import { WALNUT_HOME, CONFIG_FILE, HEARTBEAT_FILE } from '../../../src/constants.js'
import { startServer, stopServer, getHeartbeatHandle } from '../../../src/web/server.js'
import { bus, EventNames, type BusEvent } from '../../../src/core/event-bus.js'
import type { SessionStartEvent, SessionSendEvent } from '../../../src/core/event-types.js'
import * as chatHistory from '../../../src/core/chat-history.js'
import { markProcessing, removeProcessed } from '../../../src/core/session-message-queue.js'

let server: HttpServer
let started: SessionStartEvent[] = []
let sent: SessionSendEvent[] = []
/** What the fake CLI "answers" with; null = never answer (simulates a stall). */
let laneReply: string | null = 'lane answer'

/**
 * Consume a session's queued messages, the way a real delivery would. Tracked in
 * `inFlightDrains` so teardown can await it: a message left 'pending' when the
 * server goes down is exactly what the local daemon's reconnect redelivery would
 * later cold-`--resume` into a REAL `claude` spawn (observed: 2 spawns leaked from
 * this file before the drain existed).
 */
const inFlightDrains = new Set<Promise<void>>()

function drainQueue(sessionId: string): void {
  const p = (async () => {
    try {
      const batch = await markProcessing(sessionId)
      if (batch.length > 0) await removeProcessed(sessionId, batch.map((m) => m.id))
    } catch { /* the store may be torn down between tests */ }
  })()
  inFlightDrains.add(p)
  void p.finally(() => inFlightDrains.delete(p))
}

/**
 * Fake session-runner: records SESSION_START / SESSION_SEND, drains the message
 * queue (as a real delivery would), and answers each with a synthetic
 * session:result on the next tick — the shape runLaneTurn waits for.
 */
function installFakeRunner(): void {
  bus.subscribe('session-runner', (event: BusEvent) => {
    let sid: string | undefined
    if (event.name === EventNames.SESSION_START) {
      const d = event.data as SessionStartEvent
      started.push(d)
      sid = d.preassignedSessionId
    } else if (event.name === EventNames.SESSION_SEND) {
      const d = event.data as SessionSendEvent
      sent.push(d)
      sid = d.sessionId
    }
    if (!sid) return
    drainQueue(sid)
    if (laneReply === null) return
    const answer = laneReply
    setTimeout(() => {
      bus.emit(EventNames.SESSION_RESULT, { sessionId: sid!, result: answer, isError: false },
        ['main-ai', 'session-runner'], { source: 'session-runner' })
    }, 5)
  })
}

async function writeConfig(extra: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true })
  await fs.writeFile(CONFIG_FILE, yaml.dump({
    version: 1,
    user: { name: 'Ada' },
    defaults: { priority: 'none', platform: 'local' },
    provider: { type: 'claude-code' },
    ...extra,
  }), 'utf-8')
}

async function boot(extra: Record<string, unknown>): Promise<void> {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await writeConfig(extra)
  server = await startServer({ port: 0, dev: true })
  // startServer registers the real runner; replacing the subscriber by NAME
  // displaces it, so nothing in this file can reach a real spawn.
  installFakeRunner()
}

/** The conversation every background producer writes into. */
async function mainConversationId(): Promise<string> {
  const { getMainConversationId } = await import('../../../src/core/conversations.js')
  return getMainConversationId('general')
}

async function displayed(conversationId: string): Promise<string[]> {
  const page = await chatHistory.getDisplayEntries(1, 200, 'general', conversationId)
  return page.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
}

/** Poll until `check` passes or the budget runs out (producers are async). */
async function until(check: () => Promise<boolean>, budgetMs = 8000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('condition not met within budget')
}

beforeEach(() => {
  runAgentLoop.mockClear()
  started = []
  sent = []
  laneReply = 'lane answer'
})

afterEach(async () => {
  // Let every fake delivery finish draining BEFORE the server goes down (see
  // drainQueue): a message left 'pending' is exactly what triggers a real spawn.
  await Promise.allSettled([...inFlightDrains])
  await stopServer()
  await new Promise((r) => setTimeout(r, 100))
  bus.clear()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

// ══════════════════════════════════════════════════════════════════
//  Cron — reachable directly through the live CronService's deps
// ══════════════════════════════════════════════════════════════════

async function runCronJob(prompt: string, jobName: string): Promise<void> {
  const { getCronService } = await import('../../../src/web/routes/cron.js')
  const service = getCronService()
  expect(service, 'the server must have registered its CronService').toBeTruthy()
  await service!.getDeps().runMainAgentWithPrompt(prompt, jobName)
}

describe('cron runMainAgentWithPrompt', () => {
  it('flag off (default): runs the in-process loop, touches no lane', async () => {
    await boot({})
    await runCronJob('check the build', 'nightly')

    expect(runAgentLoop).toHaveBeenCalledTimes(1)
    expect(runAgentLoop.mock.calls[0][0]).toBe('[Scheduled Job "nightly"] check the build')
    expect(started).toHaveLength(0)
    const conv = await mainConversationId()
    const { getSessionByLane } = await import('../../../src/core/session-tracker.js')
    expect(await getSessionByLane(`chat:general:${conv}`)).toBeNull()
  })

  it("flag on: delivers the cron-prefixed prompt to the lane, never the loop", async () => {
    await boot({ agent: { provider: 'claude-code' } })
    await runCronJob('check the build', 'nightly')

    expect(runAgentLoop).not.toHaveBeenCalled()
    // First cron turn creates the lane, so the prompt rides the spawn.
    expect(started).toHaveLength(1)
    expect(started[0].message).toBe('[Scheduled Job "nightly"] check the build')
    const conv = await mainConversationId()
    expect(started[0].lane).toBe(`chat:general:${conv}`)

    // Both halves are visible in chat: the trigger and the answer.
    const entries = await displayed(conv)
    expect(entries.some((c) => c.includes('[Scheduled Job "nightly"] check the build'))).toBe(true)
    expect(entries.some((c) => c === 'lane answer')).toBe(true)
  })

  it('flag on: a second job reuses the lane and sends instead of spawning', async () => {
    await boot({ agent: { provider: 'claude-code' } })
    await runCronJob('first', 'job-a')
    await runCronJob('second', 'job-b')

    expect(started).toHaveLength(1)
    expect(sent.map((s) => s.message)).toEqual(['[Scheduled Job "job-b"] second'])
  })

  it('flag on: a failed lane turn fails the job (cron records the error)', async () => {
    // resultText === null must NOT be silently swallowed — the cron system's
    // "last run failed" signal is the only place a stuck Personal AI shows up.
    // (The real timeout is 10 min, so the failure is driven through
    // session:error, which resolves null through the same branch.)
    laneReply = null
    await boot({ agent: { provider: 'claude-code' } })
    const { getCronService } = await import('../../../src/web/routes/cron.js')
    const deps = getCronService()!.getDeps()
    const failSoon = setInterval(() => {
      const sid = started[0]?.preassignedSessionId
      if (sid) bus.emit(EventNames.SESSION_ERROR, { error: 'CLI died', sessionId: sid }, ['main-ai'], { source: 'test' })
    }, 100)
    try {
      await expect(deps.runMainAgentWithPrompt('x', 'doomed')).rejects.toThrow(/cron lane turn/)
    } finally {
      clearInterval(failSoon)
    }
  })
})

// ══════════════════════════════════════════════════════════════════
//  Heartbeat — driven through the runner's own requestNow()
// ══════════════════════════════════════════════════════════════════

async function bootHeartbeat(agent: Record<string, unknown>): Promise<void> {
  // every:'0' disables the periodic timer — requestNow is the only trigger, so
  // the test drives exactly one turn.
  await boot({ heartbeat: { enabled: true, every: '0' }, ...(Object.keys(agent).length ? { agent } : {}) })
  await fs.writeFile(HEARTBEAT_FILE, '- Check whether anything needs attention\n', 'utf-8')
  // startServer kicks the runner off fire-and-forget, so the handle can still be
  // null right after boot.
  await until(async () => getHeartbeatHandle() !== null)
}

describe('heartbeat runAgentTurn', () => {
  it('flag off (default): runs the in-process loop, touches no lane', async () => {
    await bootHeartbeat({})
    getHeartbeatHandle()!.requestNow('manual')
    await until(async () => runAgentLoop.mock.calls.length > 0)
    expect(started).toHaveLength(0)
  })

  it('flag on: delivers the heartbeat prompt to the lane and persists the answer', async () => {
    await bootHeartbeat({ provider: 'claude-code' })
    getHeartbeatHandle()!.requestNow('manual')
    await until(async () => started.length > 0)

    expect(runAgentLoop).not.toHaveBeenCalled()
    expect(started[0].message).toContain('HEARTBEAT.md contents')

    const conv = await mainConversationId()
    await until(async () => (await displayed(conv)).some((c) => c === 'lane answer'))
    const entries = await displayed(conv)
    // The trigger notification is shared with the in-process path.
    expect(entries.some((c) => c.includes('[Heartbeat] Periodic self-check'))).toBe(true)
  })

  it('flag on: a HEARTBEAT_OK answer collapses to the compact "all clear" line', async () => {
    // The silent-heartbeat rule is the whole reason the response text has to come
    // back from the lane at all — it must keep working off the lane's text.
    laneReply = 'HEARTBEAT_OK'
    await bootHeartbeat({ provider: 'claude-code' })
    getHeartbeatHandle()!.requestNow('manual')

    const conv = await mainConversationId()
    await until(async () => (await displayed(conv)).some((c) => c.includes('all clear, nothing needs attention')))
    const entries = await displayed(conv)
    expect(entries.some((c) => c === 'HEARTBEAT_OK')).toBe(false)
  })
})

// ══════════════════════════════════════════════════════════════════
//  Triage — driven by a subagent:result, the way a real session end does
// ══════════════════════════════════════════════════════════════════

async function emitTriageResult(taskId: string): Promise<void> {
  bus.emit(EventNames.SUBAGENT_RESULT, {
    runId: 'run-triage-1',
    agentId: 'turn-complete-triage',
    agentName: 'Turn-complete triage',
    taskId,
    result: 'The session finished the migration and left two TODOs.',
    notification: 'Migration done, two TODOs left.',
  }, ['main-ai'], { source: 'test' })
}

describe('triage main-agent notification', () => {
  it('flag off (default): runs the in-process loop, touches no lane', async () => {
    await boot({ agent: { triage: { notify_mode: 'realtime' } } })
    const { addTask } = await import('../../../src/core/task-manager.js')
    const { task } = await addTask({ title: 'Migrate the store' })

    await emitTriageResult(task.id)
    await until(async () => runAgentLoop.mock.calls.length > 0)
    expect(runAgentLoop.mock.calls[0][0]).toContain('[Triage Update]')
    expect(started).toHaveLength(0)
  })

  it('flag on: delivers the same triage prompt to the lane and persists the answer', async () => {
    await boot({ agent: { provider: 'claude-code', triage: { notify_mode: 'realtime' } } })
    const { addTask } = await import('../../../src/core/task-manager.js')
    const { task } = await addTask({ title: 'Migrate the store' })

    await emitTriageResult(task.id)
    await until(async () => started.length > 0)

    expect(runAgentLoop).not.toHaveBeenCalled()
    expect(started[0].message).toContain('[Triage Update]')
    expect(started[0].message).toContain('left two TODOs')

    const conv = await mainConversationId()
    await until(async () => (await displayed(conv)).some((c) => c === 'lane answer'))
  })
})
