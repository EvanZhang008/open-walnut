import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-notice-delivery'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { addTask } from '../../src/core/task-manager.js'
import { getQueue } from '../../src/core/session-message-queue.js'
import { updateSessionRecord } from '../../src/core/session-tracker.js'
import { flushSubtaskNotices, queueSubtaskNotice } from '../../src/core/sessions/subtask-notices.js'
import { sendTaskNews } from '../../src/core/task-news.js'

let server: Server
let daemon: MockDaemon
let sid: string
let taskId: string
let port: number
const received: Array<{ uuid: string; message: string }> = []

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  const cli = path.join(WALNUT_HOME, 'notice-cli.cjs')
  await fs.writeFile(cli, `
const readline = require('node:readline')
const args = process.argv.slice(2)
const sid = args[args.indexOf('--session-id') + 1]
const seen = new Set()
const fs = require('node:fs')
const out = (event) => process.stdout.write(JSON.stringify({ session_id: sid, ...event }) + '\\n')
out({ type: 'system', subtype: 'init', cwd: process.cwd(), tools: [], model: 'test' })
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  const msg = JSON.parse(line)
  if (msg.type !== 'user' || seen.has(msg.uuid)) return
  seen.add(msg.uuid)
  fs.appendFileSync('received.jsonl', JSON.stringify({ uuid: msg.uuid, text: msg.message.content }) + '\\n')
  out({ type: 'command_lifecycle', command_uuid: msg.uuid, state: 'queued' })
  out({ type: 'command_lifecycle', command_uuid: msg.uuid, state: 'started' })
  out({ type: 'assistant', message: { id: msg.uuid, role: 'assistant', content: [{ type: 'text', text: 'Received ' + msg.uuid }] } })
  out({ type: 'command_lifecycle', command_uuid: msg.uuid, state: 'completed' })
})
setTimeout(() => process.exit(0), 120000).unref()
`)
  daemon = await createMockDaemon()
  daemon.setCliCommand(cli)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
  taskId = (await addTask({ title: 'Notice delivery parent', project: 'Test' })).task.id
  sid = (await sessionRunner.startSession({ taskId, cwd: WALNUT_HOME, message: 'Ready', project: 'Test', preassignedSessionId: randomUUID() })).claudeSessionId
}, 120_000)

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon?.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('subtask notices through the server, queue and CLI stdin', () => {
  it('delivers successive edges of the same child once each under distinct UUIDs', async () => {
    const child = (await addTask({ title: 'Notice delivery child', project: 'Test', parent_task_id: taskId })).task
    for (let round = 0; round < 3; round++) {
      await updateSessionRecord(sid, { process_status: 'running' })
      // An error edge: one that wakes (a waiting, stopped or blocked edge asks nothing and rides the
      // parent's next message instead, sessions/wake-policy.ts; pinned below).
      await queueSubtaskNotice({
        parentTaskId: taskId, child: { id: child.id, title: child.title }, kind: 'error',
        lastWords: { text: `Round ${round}: ${'long evidence '.repeat(100)}${String.fromCodePoint(0x6d88, 0x606f)}` },
      })
      await flushSubtaskNotices()
      await vi.waitFor(async () => {
        expect(daemon.getCommandHistoryFor('send').filter((c) => String(c.payload.message).includes(`Round ${round}:`))).toHaveLength(1)
        expect(await getQueue(sid)).toEqual([])
        const read = (await fs.readFile(path.join(WALNUT_HOME, 'received.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
        expect(read.filter((r) => String(r.text).includes(`Round ${round}:`))).toHaveLength(1)
      }, { timeout: 20_000 })
      const sent = daemon.getCommandHistoryFor('send').find((c) => String(c.payload.message).includes(`Round ${round}:`))!
      received.push({ uuid: String(sent.payload.uuid), message: String(sent.payload.message) })
    }
    expect(new Set(received.map((r) => r.uuid)).size).toBe(3)
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/task/${taskId}`)
    expect(res.status).toBe(200)
    expect((await res.json()).sessions.some((s: { claudeSessionId: string }) => s.claudeSessionId === sid)).toBe(true)
  }, 90_000)

  it('the same watch news told again after it ran reaches the CLI again, under a new uuid', async () => {
    // 2026-11-20: "CR-1001 3 checks failed" told again seven hours later (a new revision) went
    // out under the first telling's uuid, and Claude Code skipped it as a duplicate.
    const news = '<walnut-message kind="trigger" from="Walnut: change watch">CR-1001 3 checks failed</walnut-message>'
    const uuids: string[] = []
    for (let round = 0; round < 2; round++) {
      await sendTaskNews('change-watch', sid, news, taskId, 'change-watch-0123456789abcdef')
      await vi.waitFor(async () => {
        const read = (await fs.readFile(path.join(WALNUT_HOME, 'received.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
        expect(read.filter((r) => String(r.text).includes('CR-1001 3 checks failed'))).toHaveLength(round + 1)
        expect(await getQueue(sid)).toEqual([])
      }, { timeout: 20_000 })
      const sent = daemon.getCommandHistoryFor('send').filter((c) => String(c.payload.message).includes('CR-1001 3 checks failed'))
      uuids.push(String(sent[sent.length - 1].payload.uuid))
    }
    expect(new Set(uuids).size).toBe(2)
  }, 60_000)

  it('a waiting edge into a running parent is held for its next message, never written into the CLI', async () => {
    const child = (await addTask({ title: 'Notice held child', project: 'Test', parent_task_id: taskId })).task
    await updateSessionRecord(sid, { process_status: 'running' })
    await queueSubtaskNotice({
      parentTaskId: taskId, child: { id: child.id, title: child.title }, kind: 'waiting',
      waitUntil: '2026-11-01T09:00:00.000Z', lastWords: { text: 'Held round: parked on a review' },
    })
    await flushSubtaskNotices()
    const { heldNoticeKeys } = await import('../../src/core/sessions/held-notices.js')
    await vi.waitFor(() => expect(heldNoticeKeys(sid)).toContain('riding-notices'), { timeout: 10_000 })
    expect(daemon.getCommandHistoryFor('send').filter((c) => String(c.payload.message).includes('Held round:'))).toHaveLength(0)
    expect(await getQueue(sid)).toEqual([])
  }, 30_000)
})
