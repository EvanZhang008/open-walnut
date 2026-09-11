/**
 * E2E test for the triage notify_mode gate (config.agent.triage.notify_mode).
 *
 * When a triage subagent decides to notify (calls notify_main_agent → the result
 * carries `notification`), the server decides whether to wake the main agent:
 *   - 'realtime' → enqueue a main-agent turn (the expensive path) + push a role:'user'
 *     triage entry to the browser immediately.
 *   - 'off' (default) → NO main-agent turn; store the triage analysis as a UI-only
 *     notification. task.summary etc. were already updated by the subagent's own tools.
 *
 * What's real: server, bus, chat-history, agent-turn-queue. What's mocked: constants
 * (temp dir) and the 'session-runner' subscriber — in 'realtime' the notify turn runs on
 * the conversation's lane session, and a fake runner answers it without spawning a
 * `claude`. We emit subagent:result directly — the subject is the SERVER's gating logic,
 * not the subagent run.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-triage-notify-mode'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { bus, EventNames, type BusEvent } from '../../src/core/event-bus.js'
import type { SessionStartEvent, SessionSendEvent } from '../../src/core/event-types.js'
import { markProcessing, removeProcessed } from '../../src/core/session-message-queue.js'
import { updateConfig } from '../../src/core/config-manager.js'
import { getTriageEntries, getApiMessages } from '../../src/core/chat-history.js'
import { getMainConversationId } from '../../src/core/conversations.js'

let server: HttpServer

/** Drains left in flight; awaited before teardown so no message stays 'pending'. */
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

/** Fake session-runner (registered by NAME after startServer, displacing the real
 *  one): answers every lane start/send with a synthetic session:result. */
function installFakeRunner(): void {
  bus.subscribe('session-runner', (event: BusEvent) => {
    let sid: string | undefined
    if (event.name === EventNames.SESSION_START) sid = (event.data as SessionStartEvent).preassignedSessionId
    else if (event.name === EventNames.SESSION_SEND) sid = (event.data as SessionSendEvent).sessionId
    if (!sid) return
    drainQueue(sid)
    setTimeout(() => {
      bus.emit(EventNames.SESSION_RESULT, { sessionId: sid!, result: 'Triage summarized.', isError: false },
        ['main-ai', 'session-runner'], { source: 'session-runner' })
    }, 5)
  })
}

const TASK_ID = 'notify-mode-task'

/** Emit a triage subagent:result with a notification, as the SubagentRunner would when
 *  a triage agent called notify_main_agent. Targets the server's 'main-ai' subscriber. */
function emitTriageResult(notification: string) {
  bus.emit(EventNames.SUBAGENT_RESULT, {
    runId: `run-${Math.random().toString(36).slice(2)}`,
    agentId: 'turn-complete-triage',
    agentName: 'Turn Complete Triage',
    taskId: TASK_ID,
    result: 'PHASE_SIGNAL: verify-pass. Implemented and verified, not committed.',
    notification,
  }, ['main-ai'], { source: 'subagent-runner-test' })
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  const tasksDir = path.join(WALNUT_HOME, 'tasks')
  await fs.mkdir(tasksDir, { recursive: true })
  await fs.writeFile(
    path.join(tasksDir, 'tasks.json'),
    JSON.stringify({
      version: 1,
      tasks: [{
        id: TASK_ID,
        title: 'Notify mode task',
        status: 'todo', priority: 'none', category: 'Work', project: 'Walnut',
        session_ids: [], active_session_ids: [],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        description: '', summary: '', note: '', subtasks: [],
      }],
    }),
  )
  server = await startServer({ port: 0, dev: true })
  installFakeRunner()
})

afterAll(async () => {
  await Promise.allSettled([...inFlightDrains])
  await stopServer()
  bus.clear()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('triage notify_mode gate', () => {
  it("'off' stores a UI-only triage entry and does NOT enqueue a main-agent turn", async () => {
    await updateConfig({ agent: { triage: { notify_mode: 'off' } } })
    const conversationId = await getMainConversationId('general')

    // A role:'user' triage entry (the realtime path) would land in the model context
    // (tag:'ai'). Capture any agent:* turn signal — none should fire in 'off'.
    let mainTurnSignals = 0
    bus.subscribe('test-off-mode', (event) => {
      if (event.name === 'agent:text-delta' || event.name === 'agent:response') {
        const src = (event.data as Record<string, unknown>)?.source
        if (src === 'triage') mainTurnSignals++
      }
    }, { global: true })

    emitTriageResult('Implemented + verified; not committed. Want me to run code-review and commit?')
    await delay(1500)
    bus.unsubscribe('test-off-mode')

    // The triage analysis was recorded (so the user can still see it / the agent can poll).
    const { entries } = await getTriageEntries(10, TASK_ID, 'general', conversationId)
    expect(entries.length).toBeGreaterThan(0)

    // But NO main-agent turn ran for triage, and nothing triage-authored entered the
    // model context (UI-only notification is tag:'ui', excluded from getApiMessages).
    expect(mainTurnSignals).toBe(0)
    const apiMsgs = await getApiMessages('general', conversationId)
    const triageInContext = apiMsgs.filter((m) =>
      typeof m.content === 'string' && m.content.includes('Triage Analysis'))
    expect(triageInContext.length).toBe(0)
  })

  it("'realtime' pushes a role:'user' triage entry to the browser (the enqueue path runs)", async () => {
    await updateConfig({ agent: { triage: { notify_mode: 'realtime' } } })
    const conversationId = await getMainConversationId('general')

    // realtime immediately broadcasts the triage content as a role:'user' chat entry
    // via CHAT_HISTORY_UPDATED, BEFORE the lane turn runs. That broadcast is
    // deterministic and is the realtime-only signal we assert.
    let userTriageEntry = false
    bus.subscribe('test-realtime-mode', (event) => {
      if (event.name === EventNames.CHAT_HISTORY_UPDATED) {
        const entry = (event.data as Record<string, unknown>)?.entry as Record<string, unknown> | undefined
        if (entry?.source === 'triage' && entry?.role === 'user') userTriageEntry = true
      }
    }, { global: true })

    emitTriageResult('Plan is ready for your review.')
    await delay(1500)
    bus.unsubscribe('test-realtime-mode')

    // The realtime path fired its immediate role:'user' triage broadcast — the 'off'
    // path never emits this (it uses addNotification → role:'assistant', tag:'ui').
    expect(userTriageEntry).toBe(true)
  })
})
