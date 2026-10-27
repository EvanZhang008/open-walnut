/**
 * Background PRODUCERS — cron and triage.
 *
 * Chat is not the only thing that writes into the Personal AI's MAIN conversation:
 * these two run main-agent turns too, and every one of them is answered by the
 * conversation's LANE session (a `claude` CLI). There is no second engine, so per
 * producer the two things worth asserting are: the turn is delivered to the lane,
 * and the producer still persists what the user needs to see.
 *
 * Exception: a cron "main" turn goes to the current Main task's conversation,
 * not the lane (2026-10-27, routines/main-target.ts). The third producer here is
 * the isolated cron job, which does not join the conversation at all: it starts
 * its own Personal AI session.
 *
 * What's real: Express server, the cron service + its deps,
 * the triage dispatch path, chat history, session records, the lane modules.
 * What's mocked: constants.js (temp dir) and the 'session-runner' bus subscriber —
 * a fake that answers a lane turn with a synthetic session:result and NEVER
 * spawns a `claude`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import yaml from 'js-yaml'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())

import type { Server as HttpServer } from 'node:http'
import { WALNUT_HOME, CONFIG_FILE } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { bus, EventNames, type BusEvent } from '../../../src/core/event-bus.js'
import type { SessionStartEvent, SessionSendEvent } from '../../../src/core/event-types.js'
import type { CronJob } from '../../../src/core/cron/types.js'
import * as chatHistory from '../../../src/core/chat-history.js'
import { markProcessing, removeProcessed } from '../../../src/core/session-message-queue.js'

let server: HttpServer
let started: SessionStartEvent[] = []
/** The bus `source` of each recorded SESSION_START, in the same order. */
let startedSources: string[] = []
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
      startedSources.push(event.source)
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

async function boot(extra: Record<string, unknown> = {}): Promise<void> {
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
  started = []
  startedSources = []
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

async function cronDeps() {
  const { getCronService } = await import('../../../src/web/routes/cron.js')
  const service = getCronService()
  expect(service, 'the server must have registered its CronService').toBeTruthy()
  return service!.getDeps()
}

async function runCronJob(prompt: string, jobName: string): Promise<void> {
  await (await cronDeps()).runMainAgentWithPrompt(prompt, jobName, { id: `job-${jobName}`, name: jobName } as CronJob)
}

async function mainTaskId(): Promise<string> {
  const { ensureMainTask } = await import('../../../src/core/org/org-store.js')
  return (await ensureMainTask()).id
}

describe('cron runMainAgentWithPrompt', () => {
  // 2026-10-27: a "main" routine ran in the old home chat lane session, which
  // has no task. It goes to the current Main task's conversation now.
  it('delivers the prompt to the Main task, never the chat lane', async () => {
    await boot()
    await runCronJob('check the build', 'nightly')

    expect(started).toHaveLength(1)
    expect(started[0].taskId).toBe(await mainTaskId())
    expect(started[0].lane).toBeUndefined()
    expect(started[0].message).toContain('check the build')
    // Nothing is written into the home chat as if the lane had answered.
    const entries = await displayed(await mainConversationId())
    expect(entries.some((c) => c.includes('check the build'))).toBe(false)

    // A second job is sent into that same session, never a second new conversation.
    await runCronJob('second', 'job-b')
    expect(started).toHaveLength(1)
    expect(sent.map((s) => s.sessionId)).toEqual([started[0].preassignedSessionId])
    expect(sent[0].message).toContain('second')
  })
})

// ══════════════════════════════════════════════════════════════════
//  Isolated cron job — its own session, not the conversation's lane
// ══════════════════════════════════════════════════════════════════

describe('cron runIsolatedAgentJob', () => {
  it('starts a Personal AI session for the job and reports the task it created', async () => {
    await boot()
    const deps = await cronDeps()
    const res = await deps.runIsolatedAgentJob({
      job: { id: 'job-iso', name: 'weekly digest' } as CronJob,
      message: 'Summarize the week.',
    })

    expect(res.status).toBe('ok')
    expect(started).toHaveLength(1)
    expect(started[0].message).toBe('Summarize the week.')
    // Not the conversation's lane: an isolated job never joins the main chat.
    expect(started[0].lane).toBeUndefined()
    // walnutAgent: true → the spawn carries the Personal AI's own profile.
    expect(started[0].profile).toBeTruthy()
    expect(startedSources).toEqual(['cron-isolated'])

    const { listTasks } = await import('../../../src/core/task-manager.js')
    const tasks = await listTasks()
    const task = tasks.find((t) => t.title === 'Routine: weekly digest')
    expect(task, 'the isolated job must create its own task').toBeTruthy()
    expect(task!.walnut_agent).toBe(true)
    expect(task!.project).toBe('Routines')
    // Background automation stays off the pinned board.
    expect(task!.pinned).not.toBe(true)
    // The summary is what cron records + announces, so it must name the task.
    expect(res.summary).toContain(task!.id)
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
  it('delivers the triage prompt to the lane and persists the answer', async () => {
    await boot({ agent: { triage: { notify_mode: 'realtime' } } })
    const { addTask } = await import('../../../src/core/task-manager.js')
    const { task } = await addTask({ title: 'Migrate the store' })

    await emitTriageResult(task.id)
    await until(async () => started.length > 0)

    expect(started[0].message).toContain('[Triage Update]')
    expect(started[0].message).toContain('left two TODOs')

    const conv = await mainConversationId()
    await until(async () => (await displayed(conv)).some((c) => c === 'lane answer'))
  })
})
