/**
 * Unit test: `task_list` answers a LEAN row, and `status` is not part of it.
 *
 * The bug this pins: `fields=list` was called "slim" but shipped 34 keys and
 * ~1160 bytes per row, so listing one 58-task project came back at 75KB — over
 * the tool-output budget, which forced the caller to pipe the JSON through a
 * hand-written field filter before it could read anything. Worse, most of the
 * payload was internal bookkeeping (has_note / has_summary / has_ext flags,
 * ledger_desc, pin_order on unpinned rows, `_syncedAt` AND `_synced_at`, two
 * nested session_status objects, session_id AND exec_session_id AND session_ids)
 * and the fat row carried BOTH `phase` and the lossy `status` projection of it.
 * A row with two disagreeing state fields gets read wrong: `status` cannot
 * express NEED_ACTION, so "waiting on the human" looked identical to "running".
 *
 * Would these fail on reverted code? YES. Drop the projection in
 * src/ops/tasks.ts and every assertion below about an ABSENT key flips, because
 * the handler passes the route's row through untouched.
 */
import { describe, it, expect } from 'vitest'
import { getOp } from '../../../src/ops/index.js'

/** One row shaped like what GET /api/tasks?fields=list actually returns. */
const FAT_ROW = {
  id: 'mtev5rha-3a0c',
  title: 'Draft Model Picker',
  project: 'Walnut',
  phase: 'NEED_ACTION',
  status: 'in_progress',
  priority: 'none',
  pinned: 1,
  focus_tier: 'backlog',
  pin_order: 118,
  unread: true,
  created_at: '2026-08-20T00:00:00.000Z',
  updated_at: '2026-08-29T18:31:37.148Z',
  due_date: '',
  completed_at: undefined,
  source: 'local',
  cwd: '/workspace/marina',
  ledger_desc: 'Work session for fixing walnut project issues',
  session_id: '7f0aa681',
  exec_session_id: '7f0aa681',
  session_ids: ['7f0aa681'],
  last_session_update: '2026-08-29T18:31:37.148Z',
  session_status: { process_status: 'stopped', mode: 'bypass' },
  exec_session_status: { process_status: 'stopped', mode: 'bypass' },
  has_note: true,
  has_summary: true,
  has_description: false,
  has_ext: false,
  has_synced: false,
  has_conversation_log: false,
  starred: false,
  group_id: null,
  milestones: null,
  external_url: null,
  _syncedAt: null,
  _synced_at: null,
  tags: [],
}

/** Run the task_list op against a stub server that returns `rows`. */
async function listWith(rows: unknown[], args: Record<string, unknown> = {}) {
  const op = getOp('task_list')
  if (!op?.handler) throw new Error('task_list must have a handler')
  const result = await op.handler(
    { fields: 'list', ...args },
    async () => ({ tasks: rows, total: rows.length }),
  ) as { tasks: Record<string, unknown>[] }
  return result.tasks
}

describe('task_list lean row', () => {
  it('drops `status` — phase is the one state field', async () => {
    const [row] = await listWith([FAT_ROW])
    expect(row.phase).toBe('NEED_ACTION')
    expect('status' in row).toBe(false)
  })

  it('drops the internal bookkeeping that made the "slim" row 34 keys', async () => {
    const [row] = await listWith([FAT_ROW])
    for (const dropped of [
      'status', 'priority', 'unread', 'source', 'cwd', 'ledger_desc',
      'session_id', 'exec_session_id', 'session_ids', 'session_status',
      'exec_session_status', 'last_session_update',
      'has_note', 'has_summary', 'has_description', 'has_ext', 'has_synced',
      'has_conversation_log', 'starred', 'milestones', 'external_url',
      '_syncedAt', '_synced_at',
    ]) {
      expect(row, `${dropped} must not reach a lean row`).not.toHaveProperty(dropped)
    }
  })

  it('keeps the keys a sorted or windowed result needs to be explainable', async () => {
    const [row] = await listWith([FAT_ROW])
    expect(row.id).toBe('mtev5rha-3a0c')
    expect(row.title).toBe('Draft Model Picker')
    expect(row.project).toBe('Walnut')
    expect(row.updated_at).toBe('2026-08-29T18:31:37.148Z')
    // pinned is normalized to a real boolean (the row carries SQLite's 1/0).
    expect(row.pinned).toBe(true)
    expect(row.focus_tier).toBe('backlog')
    expect(row.pin_order).toBe(118)
  })

  it('omits empty values instead of answering null', async () => {
    const [row] = await listWith([FAT_ROW])
    // due_date was '', completed_at was undefined, tags was [] — an absent key
    // is cheaper to read than a null and says the same thing.
    expect(row).not.toHaveProperty('due_date')
    expect(row).not.toHaveProperty('completed_at')
    expect(row).not.toHaveProperty('tags')
    expect(row).not.toHaveProperty('group_id')
  })

  it('answers project as "" for an Inbox task rather than dropping the key', async () => {
    // Absent vs "" must not be the difference between "Inbox" and "unknown".
    const [row] = await listWith([{ id: 'x', title: 'Loose', phase: 'TODO', updated_at: 'now' }])
    expect(row.project).toBe('')
    expect(row.pinned).toBe(false)
  })

  it('never puts pin_order on an unpinned row', async () => {
    // Board bookkeeping is meaningless off the board, and a stale order number
    // on an unpinned row reads as "this is pinned at 118".
    const [row] = await listWith([{ ...FAT_ROW, pinned: 0, focus_tier: undefined }])
    expect(row.pinned).toBe(false)
    expect(row).not.toHaveProperty('pin_order')
  })

  it('fields=full keeps task fields and presents execution consistently', async () => {
    const [row] = await listWith([FAT_ROW], { fields: 'full' })
    expect(row).not.toHaveProperty('status')
    expect(row.has_note).toBe(true)
    expect(row).not.toHaveProperty('session_status')
    expect(row.execution).toEqual({ state: 'stopped' })
  })

  it('leaves a non-object row alone instead of projecting garbage', async () => {
    // An unexpected 200 body must reach the caller as-is, not as an empty row
    // that reads like a real task with every field missing.
    expect(await listWith(['not a task', null])).toEqual(['not a task', null])
  })

  it('reports count/total/truncated off the ORIGINAL rows, not the projection', async () => {
    const op = getOp('task_list')!
    const result = await op.handler!(
      { fields: 'list' },
      async () => ({ tasks: [FAT_ROW], total: 58 }),
    ) as { count: number; total: number; truncated: boolean; hint?: string }
    expect(result.count).toBe(1)
    expect(result.total).toBe(58)
    expect(result.truncated).toBe(true)
    expect(result.hint).toContain('CUT')
  })
})

describe('task_list / task_update schemas', () => {
  it('task_list does not advertise a status filter', () => {
    const input = getOp('task_list')!.input as Record<string, unknown>
    expect(input).not.toHaveProperty('status')
    expect(input).toHaveProperty('phases')
    expect(input).toHaveProperty('completion')
  })

  it('task_update does not accept status — phase is the only write path', () => {
    // status:'done' used to jump a task straight to COMPLETE, which is the
    // human's call; and it could not express NEED_ACTION at all.
    const input = getOp('task_update')!.input as Record<string, unknown>
    expect(input).not.toHaveProperty('status')
    expect(input).toHaveProperty('phase')
  })
})
