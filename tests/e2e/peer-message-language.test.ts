/**
 * A session's message to another task is judged for the user's reply language, through the real
 * server (src/core/hints/reply-language-drift.ts messageLanguageNote; 2026-11-16, the org reflection:
 * 87 of 114 overnight peer notes and replies were English, and each receiver answered on in English).
 *
 *   - an English task_send, a reply (in_reply_to) and a start message get `reply_language`, the
 *     note the op puts first in its `next`;
 *   - a Chinese one gets none, nor one whose English is only a code block, a path or a quote;
 *   - the user's own send (no caller session) is never judged, and a start with the task's own
 *     description (task_create's brief) is not either.
 *
 * Harness as in structured-reply.test.ts: mock daemon + mock CLI, everything else real.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-peer-message-language-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { updateConfig } from '../../src/core/config-manager.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { createSessionRequest } from '../../src/core/session-requests.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')
const RULE = 'Talk to the user in Chinese.'

let server: HttpServer
let port: number
let daemon: MockDaemon

const url = (p: string) => `http://localhost:${port}${p}`

async function req(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url(p), {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

async function until<T>(what: string, probe: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let v = await probe()
  while (!ok(v) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
    v = await probe()
  }
  if (!ok(v)) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)?.slice(0, 400)}`)
  return v
}

interface Worker { sid: string; taskId: string }

async function startWorker(message: string): Promise<Worker> {
  const started = await req('POST', '/api/sessions/quick-start', { cwd: '/tmp', message })
  expect(started.status, JSON.stringify(started.json)).toBe(200)
  const w = { sid: started.json.sessionId, taskId: started.json.taskId }
  await until('first hand-back', async () => (await req('GET', `/api/tasks/${w.taskId}`)).json?.task?.phase, (p) => p === 'NEED_ACTION')
  await until('session idle', async () => {
    const r = await req('GET', `/api/sessions/${w.sid}`)
    return r.json?.session?.process_status ?? r.json?.process_status ?? ''
  }, (s) => s !== 'running')
  return w
}

const asSession = (sid: string) => ({ 'x-walnut-caller-sid': sid })

/** Real lines of the 2026-11-16 overnight record, shortened. */
const ENGLISH = 'tests/web/spec-color-parse-ratchet.test.ts is red on main: the helper parses colours by hand. '
  + 'Please switch it to the shared parser and land the fix before 18:00Z; do not loosen the guard.'
const CHINESE = 'main 上有一个守卫红了：这个辅助函数自己手写了颜色解析。请改用共享的解析函数，在 18:00Z 前修好根因再 land，不要放宽守卫。'
const CHINESE_WITH_CODE = `${CHINESE}\n\n复现命令和报错：\n\`\`\`\nbun run test:focus tests/web/spec-color-parse-ratchet.test.ts\nAssertionError: expected the helper to import the shared colour parser instead of parsing rgb() strings by hand\n\`\`\`\n文件在 tests/e2e/browser/truncation-peek-helpers.ts。`
const CHINESE_QUOTING = '用户原话："please make every message to another task follow my language, and tell the sender when it does not"。'
  + '我的理解：发给其他任务的消息也要用中文，不符合时提醒发送方。'

let lead: Worker
let worker: Worker

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  await updateConfig({ session: { reply_language: RULE } } as never)
  lead = await startWorker('lead the release')
  worker = await startWorker('check the release build')
}, 120_000)

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a message to another task is judged for the reply language', () => {
  it('an English task_send gets the note, with the user\'s rule', async () => {
    const r = await req('POST', '/api/v1/messages', { to: worker.taskId, text: ENGLISH, expect_reply: false }, asSession(lead.sid))
    expect(r.status, JSON.stringify(r.json)).toBe(202)
    expect(r.json.reply_language).toContain('this message to another task is not in the user\'s language')
    expect(r.json.reply_language).toContain(RULE)
  })

  it('a Chinese one, one whose English is a code block and a path, and one quoting the user\'s English get none', async () => {
    for (const text of [CHINESE, CHINESE_WITH_CODE, CHINESE_QUOTING]) {
      const r = await req('POST', '/api/v1/messages', { to: worker.taskId, text, expect_reply: false }, asSession(lead.sid))
      expect(r.status, JSON.stringify(r.json)).toBe(202)
      expect(r.json.reply_language, text.slice(0, 40)).toBeUndefined()
    }
  })

  it('a reply in English gets the note, its structured result judged with it', async () => {
    const rq = await createSessionRequest({ fromSessionId: lead.sid, fromTaskId: lead.taskId, toSessionId: worker.sid, toTaskId: worker.taskId, text: '修好了吗？' })
    const r = await req('POST', '/api/v1/messages', {
      in_reply_to: rq.id, text: 'Done.', result: 'Landed the root-cause fix on main and the guard is green again on both machines.',
    }, asSession(worker.sid))
    expect(r.status, JSON.stringify(r.json)).toBe(202)
    expect(r.json.reply_language).toContain('this message to another task')
  })

  it('the user\'s own send is never judged', async () => {
    const r = await req('POST', '/api/v1/messages', { to: worker.taskId, text: ENGLISH, expect_reply: false })
    expect(r.status, JSON.stringify(r.json)).toBe(202)
    expect(r.json.reply_language).toBeUndefined()
  })

  it('a start message in English gets the note; a start with the task\'s own description does not', async () => {
    const make = async (title: string, description?: string) => {
      const r = await req('POST', '/api/tasks', { title, ...(description ? { description } : {}) })
      expect(r.status, JSON.stringify(r.json)).toBeLessThan(300)
      return String(r.json.task.id)
    }
    const first = await make('first teammate')
    const started = await req('POST', `/api/v1/tasks/${first}/start`, { message: ENGLISH, cwd: '/tmp', expect_reply: false }, asSession(lead.sid))
    expect(started.status, JSON.stringify(started.json)).toBe(202)
    expect(started.json.reply_language).toContain('this message to another task')

    const second = await make('second teammate', ENGLISH)
    const brief = await req('POST', `/api/v1/tasks/${second}/start`, { message: ENGLISH, cwd: '/tmp', expect_reply: false }, asSession(lead.sid))
    expect(brief.status, JSON.stringify(brief.json)).toBe(202)
    expect(brief.json.reply_language).toBeUndefined()
  }, 60_000)

  it('the hint\'s switch in Settings turns it off', async () => {
    // The Settings switch writes through the hints route, as here.
    const off = await req('PUT', '/api/v1/hints/reply-language', { enabled: false })
    expect(off.status, JSON.stringify(off.json)).toBe(200)
    try {
      // The other way round: the lead's sends above used up its peer-send allowance for the minute.
      const r = await req('POST', '/api/v1/messages', { to: lead.taskId, text: ENGLISH, expect_reply: false }, asSession(worker.sid))
      expect(r.status, JSON.stringify(r.json)).toBe(202)
      expect(r.json.reply_language).toBeUndefined()
    } finally {
      await req('DELETE', '/api/v1/hints/reply-language')
    }
  })
})
