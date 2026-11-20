/**
 * Topics on a real server (startServer, dev): the experiment switched on through the config route,
 * a topic made with two tasks that each run a session, and the user's first message waking both
 * through the real session queue.
 *
 *   1. off: GET /api/topics is 404 topics_off;
 *   2. on: POST /api/topics with two tasks and a first message answers the topic and its delivery;
 *   3. each task's session is sent one `topic` envelope holding the message (an agent's row);
 *   4. a session caller posts through the topic_post op as its own member; topic:updated reaches the web.
 *
 * What's real: server, routes, ops, bus, task store, session store, the queue, the session runner.
 * Mocked: constants, the daemon (MockDaemon), the CLI.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-topics-e2e'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { sessionRunner } from '../../../src/providers/claude-code-session.js'
import { createMockDaemon, type MockDaemon } from '../../helpers/mock-daemon.js'
import { addTask } from '../../../src/core/task-manager.js'
import { getSessionByClaudeId } from '../../../src/core/session-tracker.js'
import { executeOp } from '../../../src/ops/index.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'
import { parseWalnutMessage } from '../../../src/core/peers/walnut-message-tag.js'

let server: Server
let daemon: MockDaemon
let port = 0
const MOCK_CLI = path.resolve(import.meta.dirname, '../../providers/mock-claude.mjs')
const queued = new Map<string, string[]>()
const updates: string[] = []
const nodes: Record<string, { taskId: string; sid: string }> = {}

async function startSessionFor(taskId: string): Promise<string> {
  const sid = (await sessionRunner.startSession({ taskId, cwd: WALNUT_HOME, message: 'Ready', project: 'Acme', preassignedSessionId: randomUUID() })).claudeSessionId
  await vi.waitFor(async () => {
    expect((await getSessionByClaudeId(sid))?.process_status).toMatch(/idle|stopped/)
  }, { timeout: 20_000 })
  return sid
}

async function api<T = Record<string, any>>(method: string, p: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) as T }
}

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  daemon = await createMockDaemon()
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  daemon.setCliCommand(MOCK_CLI)
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
  for (const title of ['Marina', 'Orchard']) {
    const taskId = (await addTask({ title, project: 'Acme' })).task.id
    nodes[title] = { taskId, sid: await startSessionFor(taskId) }
  }
  bus.subscribe('test-topics-e2e', (event) => {
    if (event.name === EventNames.TOPIC_UPDATED) { updates.push((event.data as { topicId: string }).topicId); return }
    const d = event.data as { sessionId: string; message?: string }
    queued.set(d.sessionId, [...(queued.get(d.sessionId) ?? []), d.message ?? ''])
  }, { global: true, interest: [EventNames.SESSION_MESSAGE_QUEUED, EventNames.TOPIC_UPDATED] })
}, 150_000)

afterAll(async () => {
  bus.unsubscribe('test-topics-e2e')
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon?.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('topics on a real server', () => {
  it('is off until the experiment is on', async () => {
    const off = await api('GET', '/api/topics')
    expect(off.status).toBe(404)
    expect(off.json.error.code).toBe('topics_off')
    expect((await api('PUT', '/api/config', { experimental: { topics: true } })).status).toBe(200)
    await vi.waitFor(async () => expect((await api('GET', '/api/topics')).status).toBe(200), { timeout: 5000 })
  })

  it('a topic with two tasks: the user\'s first message wakes both sessions, and a member posts by op', async () => {
    const made = await api('POST', '/api/topics', {
      title: 'Launch plan',
      members: [{ kind: 'task', taskId: nodes.Marina.taskId }, { kind: 'task', taskId: nodes.Orchard.taskId }],
      text: 'Where are we on the launch dates?',
    })
    expect(made.status).toBe(201)
    const topic = made.json.topic
    expect(topic.id).toMatch(/^tp-[a-f0-9]{12}$/)
    expect(made.json.delivery.wake).toHaveLength(2)
    expect(made.json.delivery.refused).toEqual([])

    for (const name of ['Marina', 'Orchard']) {
      await vi.waitFor(() => {
        const env = (queued.get(nodes[name].sid) ?? []).map((m) => parseWalnutMessage(m)).find((e) => e?.kind === 'topic')
        expect(env, name).toBeTruthy()
        expect(env!.attrs.about).toBe(topic.id)
        expect(env!.body).toContain('Where are we on the launch dates?')
      }, { timeout: 10_000 })
    }

    const out = await executeOp('topic_post', { id: topic.id, text: 'Dates hold for Tuesday.' }, { apiBase: `http://127.0.0.1:${port}`, origin: '__local__', callerMode: 'session', callerSid: nodes.Marina.sid })
    expect(out.ok, out.ok ? '' : out.message).toBe(true)
    const read = await api('GET', `/api/topics/${topic.id}`)
    const marina = read.json.topic.members.find((m: { name: string }) => m.name === 'Marina')
    const last = read.json.topic.messages.at(-1)
    expect(last).toMatchObject({ author: marina.id, text: 'Dates hold for Tuesday.', via: 'agent', folded: [read.json.topic.members.find((m: { name: string }) => m.name === 'Orchard').id] })
    expect(updates).toContain(topic.id)
    const list = await api('GET', '/api/topics')
    expect(list.json.topics.map((t: { id: string }) => t.id)).toEqual([topic.id])
  }, 60_000)
})
