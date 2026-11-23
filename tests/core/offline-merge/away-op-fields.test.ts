/**
 * A session's task write while the Mac is away is answered by the away host only when the Mac's
 * drain will take it (src/replica/write-port.ts, src/core/offline-merge/journal-actor.ts).
 *
 * 2026-11-23: a session's task_note_write while the Mac was away was answered "Task note
 * replaced" by the host; when the Mac came back the drain refused it, "task_update does not take
 * note; nothing of this write was applied". The away host journals the fields of several ops as
 * one task_update record (task_note_write's note, task_pin_set's pin), and the drain held a
 * session's record to task_update's own input. The class: every field the away host writes this
 * way, read from its source, is either taken by the drain for a session or refused at once.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TASK_FIELDS_OF_OTHER_OPS, opWriteFields } from '../../../src/core/offline-merge/journal-actor.js'
import { RefusedWrite } from '../../../src/core/offline-merge/patch-check.js'
import { createWritePort, type TaskRow } from '../../../src/replica/write-port.js'
import type { ReplicaWrite } from '../../../src/replica/dispatch.js'
import { getOp } from '../../../src/ops/index.js'

const SESSION = { kind: 'session' as const, sid: '1538f1be-333a-46a0-b72d-d3dfc95b0779' }
const DEVICE = { kind: 'device' as const, deviceId: 'dev-marina-phone' }

// Fields the away host writes as a task_update record that no op writes for a session online:
// they stay refused, and the host refuses them at once (never answered "saved").
const NO_SESSION_OP: Record<string, string> = {
  summary: 'no op of its own writes it: only the raw PUT /tasks/:id/summary route, which the `api` op reaches online',
}

/** The fields src/replica/away-writes.ts hands port.taskUpdate by name: textField('x') and literal `{ x }` / `{ x: ... }` patches. */
function awayTaskUpdateFields(): string[] {
  const src = fs.readFileSync(path.resolve('src/replica/away-writes.ts'), 'utf-8')
  const out = new Set<string>()
  for (const m of src.matchAll(/textField\('([a-z_]+)'\)/g)) out.add(m[1]!)
  for (const m of src.matchAll(/port\.taskUpdate\(w, actor, p\.id!, \{([^}]*)\}\)/g)) {
    for (const part of m[1]!.split(',')) {
      const key = /^\s*\[?([a-z_]+)\]?/.exec(part)?.[1]
      if (key && key !== 'field') out.add(key)
    }
  }
  return [...out].sort()
}

async function drainTakes(fields: Record<string, unknown>, actor: object = SESSION): Promise<boolean> {
  try { await opWriteFields({ kind: 'task-fields', op: 'task_update', actor: actor as never }, fields); return true } catch (err) {
    if (err instanceof RefusedWrite) return false
    throw err
  }
}

describe('a session\'s away task write: the host and the drain agree', () => {
  it('the source has the fields to check', () => {
    const fields = awayTaskUpdateFields()
    expect(fields).toEqual(expect.arrayContaining(['note', 'pinned', 'summary', 'description', 'phase']))
  })

  it('every field the away host writes is taken by the drain for a session, or named as one no op writes', async () => {
    const wrong: string[] = []
    for (const f of awayTaskUpdateFields()) {
      const takes = await drainTakes({ [f]: { base: null, value: 'x' } })
      if (takes === (f in NO_SESSION_OP)) wrong.push(`${f}: drain ${takes ? 'takes' : 'refuses'} it`)
    }
    expect(wrong).toEqual([])
  })

  it('each field of another op names an op that exists, and a device still writes the whole set', async () => {
    for (const [field, op] of Object.entries(TASK_FIELDS_OF_OTHER_OPS)) expect(getOp(op), `${field} -> ${op}`).toBeDefined()
    expect(await drainTakes({ summary: { base: null, value: 'x' } }, DEVICE)).toBe(true)
  })

  it('the host refuses at once what the drain would refuse, and keeps a note write', async () => {
    const row: TaskRow = { id: 'mtaskaaa-0001', title: 'Leader work', phase: 'IN_PROGRESS', project: 'Acme' }
    const submits: string[] = []
    const w = {
      opId: 'op-away-1', away: 'host-write', raw: Buffer.from(''),
      submit: async (op: string, args: Record<string, unknown>) => { submits.push(`${op} ${Object.keys(args).filter((k) => k !== 'id').join(',')}`); return { kind: 'applied', reply: { seq: 1, opId: 'op-away-1' } } },
    } as unknown as ReplicaWrite
    const port = createWritePort({ task: async (id) => (id === row.id ? { ...row } : null), board: async () => null, now: () => Date.parse('2026-11-23T07:00:00Z') })
    const kept = await port.taskUpdate(w, SESSION, row.id, { note: 'Plan, step two' })
    expect(kept.answered === false && kept.status).toBe(200)
    // Not final: the same write through the `api` op works once the Mac answers.
    const refused = await port.taskUpdate(w, SESSION, row.id, { summary: 'Done' })
    expect(refused.answered === false && refused.status).toBe(503)
    expect(JSON.stringify(refused)).toMatch(/needs_leader.*does not take summary/)
    expect(submits).toEqual(['task_update note'])
  })

  it('a close that says more than its phase waits for the Mac; a bare close (the console\'s button) is kept', async () => {
    const row: TaskRow = { id: 'mtaskaaa-0002', title: 'Leader work', phase: 'IN_PROGRESS', project: 'Acme' }
    const submits: string[] = []
    const w = {
      opId: 'op-away-2', away: 'host-write', raw: Buffer.from(''),
      submit: async (op: string) => { submits.push(op); return { kind: 'applied', reply: { seq: 1, opId: 'op-away-2' } } },
    } as unknown as ReplicaWrite
    const port = createWritePort({ task: async (id) => (id === row.id ? { ...row } : null), board: async () => null, now: () => Date.parse('2026-11-23T07:00:00Z') })
    // Every input of task_complete but its id rides the close online, none in the away record.
    const said = Object.keys(getOp('task_complete')!.input).filter((k) => k !== 'id')
    expect(said).toEqual(expect.arrayContaining(['result', 'evidence', 'not_done', 'score']))
    for (const k of said) {
      const held = await port.taskComplete(w, SESSION, row.id, { [k]: k === 'force' ? true : 'Shipped, watch set' })
      expect(held.answered === false && held.status, k).toBe(503)
      expect(JSON.stringify(held), k).toMatch(/needs_leader/)
    }
    expect(submits).toEqual([])
    // An empty text or list and a false flag say nothing: an agent's habit, still a bare close.
    const empty = await port.taskComplete(w, SESSION, row.id, { not_done: [], evidence: [], force: false, result: '' })
    expect(empty.answered === false && empty.status).toBe(200)
    const bare = await port.taskComplete(w, DEVICE, row.id, {})
    expect(bare.answered === false && bare.status).toBe(200)
    expect(submits).toEqual(['task_complete', 'task_complete'])
  })
})
