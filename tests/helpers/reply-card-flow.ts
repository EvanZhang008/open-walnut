/**
 * A real turn end, walked the way the tests of a reply's card lines need it
 * (tests/e2e/reply-card-real-flow.test.ts, tests/e2e/reply-card-one-decision.test.ts): nothing is
 * called by hand. He types through the phone's send route, the line leaves the queue as when a CLI
 * takes and answers it, the turn ends with the event the runner emits (its data, its destinations),
 * and the status question is the one the turn-complete hook arms, five seconds later, asked of a
 * session that records what it is asked and answers what the test set.
 *
 * One flow per test file (a file's modules are its own). The file mocks constants.js and the daemon
 * file reader itself, before it imports this.
 */
import { expect, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { CLAUDE_HOME, WALNUT_HOME } from '../../src/constants.js'
import { encodeProjectPath } from '../../src/core/session-history.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { markProcessing, removeProcessed, type QueuedMessage } from '../../src/core/session-message-queue.js'
import { parseHinted } from '../../src/core/hints/hint-format.js'
import { readThreads } from '../../src/core/org/threads-store.js'
import { replyTagNow } from '../../src/core/org/reply-card-switch.js'
import { settleStatusQuestion, STATUS_SETTLE_MS } from '../../src/core/sessions/status-question.js'
import type { OrgThread } from '../../src/core/org/threads-model.js'
import type { StatusReport } from '../../src/core/user-status.js'
import { executeOp } from '../../src/ops/executor.js'
import { LOCAL_ORIGIN } from '../../src/lib/caller-origin.js'
import '../../src/ops/index.js'

/** Each status question the session was asked: its words, when, and the task's threads and stored report as they were at that moment. */
export interface Asked { prompt: string; at: number; threads: OrgThread[]; report?: StatusReport }

/** The flow's server, task and session, and what the session answers the status question with. */
export const flow = {
  base: '',
  taskId: '',
  sid: '',
  asked: [] as Asked[],
  /** The session's answer to the next status questions: its lines, or what it answers to the question's own words. */
  statusAnswer: 'FOR_USER_STATE: working\nFOR_USER_NOW: Planning the garden.' as string | ((prompt: string) => string),
}

let turnGen = 0
let seq = 0

/** A server, a task he turned Threads on for, and its session, which records each status question. */
export async function startFlow(opts: { sid: string; title: string; project: string }): Promise<void> {
  process.env.WALNUT_THREAD_JOIN_SECS = '0'
  process.env.WALNUT_THREAD_REOPEN_SECS = '0'
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  vi.spyOn(sessionRunner as unknown as { processNext(sessionId: string, mode?: string): Promise<void> }, 'processNext').mockResolvedValue(undefined)
  const server = await startServer({ port: 0, dev: true })
  flow.sid = opts.sid
  flow.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  flow.taskId = (await addTask({ title: opts.title, project: opts.project })).task.id
  await createSessionRecord(flow.sid, flow.taskId, opts.project, WALNUT_HOME)
  await updateSessionRecord(flow.sid, { process_status: 'idle' })
  await updateTaskRaw(flow.taskId, { phase: 'IN_PROGRESS', session_id: flow.sid }, { source: 'test' })
  // He turns Threads on for the task, as its menu does.
  const on = await fetch(`${flow.base}/api/tasks/${flow.taskId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threads_on: true }) })
  expect(on.status).toBe(200)
  const fake = {
    sessionId: flow.sid, detach: () => {}, kill: () => {}, get active() { return false },
    askSideQuestion: async (prompt: string) => {
      const report = (await getTask(flow.taskId).catch(() => null))?.status_report
      flow.asked.push({ prompt, at: Date.now(), threads: structuredClone((await readThreads(flow.taskId)).threads), ...(report ? { report: structuredClone(report) } : {}) })
      return typeof flow.statusAnswer === 'function' ? flow.statusAnswer(prompt) : flow.statusAnswer
    },
  }
  ;(sessionRunner as unknown as { sessions: Map<string, unknown> }).sessions.set(flow.sid, fake)
}

export async function stopFlow(): Promise<void> {
  delete process.env.WALNUT_THREAD_JOIN_SECS
  delete process.env.WALNUT_THREAD_REOPEN_SECS
  await settleStatusQuestion(flow.sid, 10_000)
  ;(sessionRunner as unknown as { sessions: Map<string, unknown> }).sessions.delete(flow.sid)
  await stopServer()
  vi.restoreAllMocks()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
}

/** The experiment, with the reminder switch as the test wants it (on: what production runs with the tag). */
export async function setTag(on: boolean, more: Record<string, boolean> = { threads_reminder: true }): Promise<void> {
  const put = await fetch(`${flow.base}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ experimental: { threads_reply_tag: on, ...more } }) })
  expect(put.status).toBe(200)
  await vi.waitFor(() => { expect(replyTagNow()).toBe(on) }, { timeout: 5000 })
}

/** He types in the task's chat (the phone's send route). The message waits in the session's queue. */
export async function say(text: string, threadId?: string): Promise<void> {
  const res = await fetch(`${flow.base}/api/v1/sessions/${flow.sid}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, ...(threadId ? { threadId } : {}) }) })
  expect(res.status, await res.clone().text()).toBe(202)
}

/** The CLI takes what waits, as the runner hands it over (one line of every waiting row): the rows it now holds, as it read them. */
export async function cliTakes(): Promise<QueuedMessage[]> {
  const rows = await markProcessing(flow.sid)
  expect(rows.length).toBeGreaterThan(0)
  return rows
}

/** The words of the `threads` hint on a line the CLI read. */
export const hintOf = (row: QueuedMessage): string => parseHinted(row.message).hints.find((h) => h.kind === 'threads')?.text ?? ''
/** The thread his message went to: the one its hint names first. */
export const filedUnder = (row: QueuedMessage): string => {
  const m = /th-[0-9a-f]{6,32}/.exec(hintOf(row))
  if (!m) throw new Error(`no thread named in:\n${row.message}`)
  return m[0]
}

/** The chat as its CLI writes it: his lines as they reached the model, then the answer. */
async function writeChat(rows: Array<{ type: 'user' | 'assistant'; text: string }>): Promise<void> {
  const lines = rows.map((r) => {
    seq += 1
    return {
      type: r.type, uuid: `${flow.sid.slice(0, 8)}-0000-4000-8000-${String(seq).padStart(12, '0')}`, timestamp: new Date(Date.now() + seq).toISOString(),
      message: r.type === 'user' ? { role: 'user', content: [{ type: 'text', text: r.text }] } : { id: `msg-${seq}`, role: 'assistant', content: [{ type: 'text', text: r.text }] },
    }
  })
  const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(WALNUT_HOME))
  await fs.mkdir(dir, { recursive: true })
  await fs.appendFile(path.join(dir, `${flow.sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

/** The CLI starts answering the lines it holds: the runner settles them, and they leave the queue (before the Stop hook runs). */
export async function cliAnswers(rows: QueuedMessage[]): Promise<void> {
  await removeProcessed(flow.sid, rows.map((r) => r.id))
}

/**
 * The turn ends as a real one does: the CLI answered the lines it held, so they leave the queue
 * (the runner settles them before the result), its transcript holds the reply, and the runner emits
 * the result with the turn's last words. Answers when it ended.
 */
export async function turnEnds(rows: QueuedMessage[], reply: string): Promise<number> {
  await writeChat([...rows.map((r) => ({ type: 'user' as const, text: r.message })), { type: 'assistant' as const, text: reply }])
  await cliAnswers(rows)
  turnGen += 1
  const at = Date.now()
  bus.emit(EventNames.SESSION_RESULT, { sessionId: flow.sid, taskId: flow.taskId, turnGen, result: reply, isError: false, totalCost: 0.01 * turnGen, costDelta: 0.01, duration: 1200 }, ['main-ai', 'session-runner'], { source: 'session-runner' })
  return at
}

/** The status question the turn-complete hook armed for the turn that just ended, once it is asked and its answer stored. */
export async function questionAfter(endedAt: number, maxMs = 15_000): Promise<Asked> {
  const before = flow.asked.length
  await vi.waitFor(() => { expect(flow.asked.length).toBeGreaterThan(before) }, { timeout: maxMs, interval: 100 })
  const q = flow.asked[before]
  // The armed one: it waits out the settle time, which no call made by hand does.
  expect(q.at - endedAt).toBeGreaterThanOrEqual(STATUS_SETTLE_MS - 250)
  await settleStatusQuestion(flow.sid, 10_000)
  return q
}

/** The session's Stop hook asks Walnut whether the turn may end, with the shape of the reply's last lines. */
export async function stopHook(tail: string): Promise<{ decision?: string; reason?: string }> {
  const r = await executeOp('open_items', { hook: 'stop', last_lines: tail }, { apiBase: `${flow.base}/api/v1`, callerSid: flow.sid, origin: LOCAL_ORIGIN })
  expect(r.ok, JSON.stringify(r)).toBe(true)
  return (r as { result: { decision?: string; reason?: string } }).result
}

export const of = (threads: OrgThread[], id: string) => threads.find((t) => t.id === id)
/** The threads the question lists (`t1 "its title" (its state, ...)`), by the title it shows each under. */
export const listed = (prompt: string): string[] => [...prompt.matchAll(/\bt\d+ "([^"]*)" \(/g)].map((m) => m[1])
