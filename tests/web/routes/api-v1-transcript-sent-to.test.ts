/**
 * GET /api/v1/sessions/:id/transcript: a send's tool row says whom it went to
 * (`sentTo`), so the phone names the task instead of "another session"
 * (2026-10-30, the user, of a lead's "Sent 2": which session?).
 *
 * The shapes a lead's real sends take: inline arguments; arguments built in a
 * subshell, where only the answer (cut short to an id prefix) names the target;
 * a loop over two tasks, one call with two targets; and a plain command, which
 * carries nothing.
 *
 * Real: Express server, api-v1 router, task store, session records, the read
 * pipeline over JSONL on disk. Mocked: constants (temp dirs) and the local
 * daemon file reader.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../../helpers/mock-local-daemon-reader.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-transcript-sent-to'))
vi.mock('../../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { WALNUT_HOME, CLAUDE_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { encodeProjectPath } from '../../../src/core/session-history.js'
import { addTask } from '../../../src/core/task-manager.js'

const CWD = '/Users/test/transcript-sent-to'

let server: HttpServer
let port: number

interface Row { role: string; text: string; kind?: string; sentTo?: { ref: string; taskId?: string; title?: string }[] }

let seq = 0
const at = (): string => new Date(Date.UTC(2026, 0, 3, 0, 0, ++seq)).toISOString()
function call(id: string, command: string, result: string): Record<string, unknown>[] {
  return [
    { type: 'assistant', uuid: `a-${++seq}`, timestamp: at(),
      message: { id: `msg_${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } },
    { type: 'user', uuid: `r-${++seq}`, timestamp: at(),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result }] } },
  ]
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
}, 60_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  await fs.rm(CLAUDE_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a send row names its targets', () => {
  it('inline, from the answer alone, and a loop over two tasks', async () => {
    const brief = (await addTask({ title: 'Brief task' })).task
    const status = (await addTask({ title: 'Task status foundation' })).task
    const sid = 'sess-sent-to'
    const lines = [
      { type: 'user', uuid: `u-${++seq}`, timestamp: at(), message: { role: 'user', content: [{ type: 'text', text: 'Tell both teams.' }] } },
      ...call('t1', `walnut tools call task_send '{"to":"${brief.id}","title":"Hi","text":"..."}'`, `Message queued for ${brief.id}. Do NOT resend.`),
      ...call('t2', `walnut tools call task_send "$(python3 -c 'print(1)')" | cut -c1-60`, `Message delivered on this host to ${status.id.slice(0, -2)}`),
      ...call('t3', `for id in ${brief.id} ${status.id}; do walnut tools call task_send "{\\"to\\":\\"$id\\"}"; done`,
        `Message delivered on this host to ${brief.id}\nMessage delivered on this host to ${status.id}`),
      ...call('t4', 'ls -la', 'total 0'),
      // A search for a send is not one, though its output names a task.
      ...call('t5', `grep -n "walnut tools call task_send" notes.log`, `12: Message queued for ${brief.id}`),
      { type: 'assistant', uuid: `a-${++seq}`, timestamp: at(), message: { id: 'msg_end', role: 'assistant', content: [{ type: 'text', text: 'Both told.' }] } },
    ]
    await createSessionRecord(sid, '', '', CWD, { title: 'Sends', initialProcessStatus: 'idle' })
    const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(CWD))
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

    for (const qs of ['?fresh=1&rich=1', '?fresh=1']) {
      const res = await fetch(`http://localhost:${port}/api/v1/sessions/${sid}/transcript${qs}`)
      expect(res.status).toBe(200)
      const rows = ((await res.json()) as { messages: Row[] }).messages.filter((r) => r.kind === 'tool')
      expect(rows.map((r) => (r.sentTo ?? []).map((t) => t.title ?? `?${t.ref}`)), qs).toEqual([
        ['Brief task'],
        ['Task status foundation'],
        ['Brief task', 'Task status foundation'],
        [],
        [],
      ])
      expect(rows[2].sentTo!.map((t) => t.taskId), qs).toEqual([brief.id, status.id])
      expect(rows[3].sentTo, qs).toBeUndefined()
      expect(rows[4].sentTo, qs).toBeUndefined()
    }
  })
})
