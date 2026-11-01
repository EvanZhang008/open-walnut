/**
 * The compact Brief read on a real server (GET /api/v1/tasks/:id/brief?compact=1, brief_read
 * compact:true; src/core/sessions/brief-compact.ts). 2026-11-01: a full read cost 8 to 10k tokens
 * and Walnut asks Main and every lead to refresh every few messages. The compact read:
 *   - with nothing moved is a few lines (well under 1k tokens) for a team of 30;
 *   - carries the rules on a session's first read of the node only;
 *   - lists a moved task with the letter's own line, which a brief_write edit replaces as is, and
 *     the live lists of only the sections that move touched;
 *   - lists a finished task with the line Walnut drops, and an ask the letter leaves out;
 *   - is the full read for a node with no Brief yet.
 * Only the Claude CLI is mocked (no CLI runs here).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-brief-compact'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { ensureProjectLead } from '../../src/core/org/org-store.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'

const SID_A = '11111111-2222-4333-8444-555555555555'
const SID_B = '66666666-7777-4888-9999-aaaaaaaaaaaa'
let base = ''
let leadId = ''
const workers: string[] = []

async function until(what: string, ok: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + 20_000
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

async function read(id: string, opts: { compact?: boolean; sid?: string } = {}): Promise<{ raw: string; body: Record<string, any> }> {
  const res = await fetch(`${base}/api/v1/tasks/${id}/brief${opts.compact ? '?compact=1' : ''}`, {
    headers: opts.sid ? { 'x-walnut-caller-sid': opts.sid } : {},
  })
  expect(res.status).toBe(200)
  const raw = await res.text()
  return { raw, body: JSON.parse(raw) }
}

async function write(id: string, payload: unknown): Promise<Response> {
  return fetch(`${base}/api/v1/tasks/${id}/brief`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
}

/** About four characters a token: the budget the lead set, in characters. */
const UNDER_1K_TOKENS = 3_000

async function ask(id: string, words: string): Promise<void> {
  await updateTaskRaw(id, { phase: 'NEED_ACTION', status_report: { state: 'needs', ask: words, at: new Date().toISOString() } }, { emitEvent: true, source: 'status-report' })
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  for (let i = 0; i < 30; i++) {
    const { task } = await addTask({ title: `Garden job ${i} with a long enough title to read like a real one`, project: 'Garden' })
    workers.push(task.id)
  }
  for (let i = 0; i < 5; i++) await ask(workers[i]!, `Decide which of the three suppliers gets the order for bed ${i}, with the prices in the sheet`)
  for (let i = 5; i < 30; i++) await updateTaskRaw(workers[i]!, { phase: 'IN_PROGRESS' }, { emitEvent: true, source: 'status-report' })
  await until('the asks are derived', async () => (await getTask(workers[4]!)).user_status?.state === 'needs')
  leadId = (await ensureProjectLead('Garden')).id
})

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('the compact Brief read', () => {
  it('a node with no Brief yet gets the full read even when it asks for compact', async () => {
    const { body } = await read(leadId, { compact: true, sid: SID_A })
    expect(body.compact).toBeUndefined()
    expect(body.brief).toBeNull()
    expect(typeof body.rules).toBe('string')
    expect(body.sections.needs.length).toBe(5)
  })

  it('with nothing moved: a few lines, the rules on the first read only', async () => {
    // The lead writes its letter from the live lists, one line per task.
    const full = await read(leadId)
    const s = full.body.sections as Record<'needs' | 'working' | 'waiting', string[]>
    const letter = `### Needs you\n${s.needs.join('\n')}\n### Working\n${s.working.join('\n')}\n### Waiting / snoozed\n${s.waiting.length ? s.waiting.join('\n') : '- Nothing waits.'}`
    expect((await write(leadId, { content: letter })).status).toBe(200)

    const fullAgain = await read(leadId, { sid: SID_A })
    const first = await read(leadId, { compact: true, sid: SID_B })
    expect(typeof first.body.rules).toBe('string')
    const again = await read(leadId, { compact: true, sid: SID_B })
    expect(again.body.rules).toBeUndefined()
    expect(again.body).toMatchObject({ compact: true, fresh: { stale: false, moved: [], finished: [], newAsks: [] }, sections: {} })
    expect(again.body.brief.text).toBeUndefined()
    expect(again.raw.length).toBeLessThan(UNDER_1K_TOKENS)
    // SID_A read the rules in its full read: its first compact read leaves them out too.
    expect((await read(leadId, { compact: true, sid: SID_A })).body.rules).toBeUndefined()
    // eslint-disable-next-line no-console
    console.log(`brief read sizes: full ${fullAgain.raw.length} chars, compact first ${first.raw.length}, compact nothing moved ${again.raw.length}`)
    expect(fullAgain.raw.length).toBeGreaterThan(again.raw.length * 10)
  })

  it('a session past a compaction gets the rules again on its next compact read', async () => {
    // SID_B already read them; its record, with no compaction yet, keeps it the same reader.
    await createSessionRecord(SID_B, leadId, 'Garden', WALNUT_HOME)
    expect((await read(leadId, { compact: true, sid: SID_B })).body.rules).toBeUndefined()
    await updateSessionRecord(SID_B, { lastCompactUuid: 'compact-1' })
    expect((await read(leadId, { compact: true, sid: SID_B })).body.rules).toBeDefined()
    expect((await read(leadId, { compact: true, sid: SID_B })).body.rules).toBeUndefined()
  })

  it('a moved task comes with the letter\'s own line, which an edit replaces, and only the sections it touched', async () => {
    const before = (await getTask(leadId)).brief!.text
    // A working task the letter names (the lists stop at a cap, so not every worker is in it).
    const moving = workers.slice(5).find((id) => before.includes(`id="${id}"`))!
    await ask(moving, 'Approve the new fence plan')
    await until('the move is derived', async () => (await getTask(moving)).user_status?.ask === 'Approve the new fence plan')
    const { body, raw } = await read(leadId, { compact: true, sid: SID_B })
    expect(body.fresh.stale).toBe(true)
    expect(body.fresh.moved).toHaveLength(1)
    const move = body.fresh.moved[0]
    expect(move).toMatchObject({ id: moving, state: 'needs', words: 'Approve the new fence plan' })
    expect(before.split('\n')).toContain(move.line)
    // Where its line was (an IN_PROGRESS task with nothing running reads Waiting) and Needs you.
    expect(Object.keys(body.sections).sort()).toEqual(['needs', 'waiting'])
    expect(body.sections.needs.some((l: string) => l.includes(moving))).toBe(true)
    expect(raw.length).toBeLessThan(UNDER_1K_TOKENS * 2)
    const res = await write(leadId, { edits: [{ old: move.line, new: `- <task-ref id="${moving}" label="Fence"/>: approve the new fence plan.` }] })
    expect(res.status).toBe(200)
    const after = await read(leadId, { compact: true, sid: SID_B })
    expect(after.body.fresh).toMatchObject({ stale: false, moved: [] })
  })

  it('a finished task comes with the line Walnut drops, and a new ask with Walnut\'s live line', async () => {
    const text = (await getTask(leadId)).brief!.text
    const done = workers.slice(5).filter((id) => text.includes(`id="${id}"`)).at(-1)!
    const named = text.split('\n').find((l) => l.includes(done))!
    await updateTaskRaw(done, { phase: 'COMPLETE' }, { emitEvent: true, source: 'status-report' })
    // A new task asks the user and the letter does not name it.
    const { task: fresh } = await addTask({ title: 'Order the soil', project: 'Garden' })
    await ask(fresh.id, 'Pick the soil mix')
    await until('the new ask is derived', async () => (await getTask(fresh.id)).user_status?.ask === 'Pick the soil mix')
    const { body } = await read(leadId, { compact: true, sid: SID_B })
    expect(body.fresh.finished).toEqual([{ id: done, line: named }])
    expect(body.fresh.newAsks).toHaveLength(1)
    expect(body.fresh.newAsks[0].id).toBe(fresh.id)
    expect(body.fresh.newAsks[0].line).toContain('Pick the soil mix')
    expect(body.sections.needs).toBeDefined()
  })

  it('an ask past the lists\' cap still comes with its line', async () => {
    const extra: string[] = []
    for (let i = 0; i < 16; i++) {
      const { task } = await addTask({ title: `Late ask ${i}`, project: 'Garden' })
      await ask(task.id, `Answer late question ${i}`)
      extra.push(task.id)
    }
    await until('the late asks are derived', async () => (await getTask(extra.at(-1)!)).user_status?.state === 'needs')
    const { body } = await read(leadId, { compact: true, sid: SID_A })
    const late = (body.fresh.newAsks as Array<{ id: string; line?: string }>).filter((a) => extra.includes(a.id))
    expect(late).toHaveLength(16)
    // Those in the lists carry the lists' line; those past the cap a line in the same form.
    for (const a of late) {
      expect(a.line!.startsWith(`- <task-ref id="${a.id}" label="Late ask `)).toBe(true)
      expect(a.line).toContain('Answer late question')
    }
    expect(late.filter((a) => /: Answer late question \d+$/.test(a.line!)).length).toBeGreaterThan(0)
  })
})
