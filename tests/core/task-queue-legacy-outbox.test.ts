/**
 * The old-Mac git outbox (tasks/outbox/) stops once the Mac drains the journal's
 * task kinds (stage 4d of docs/plan/walnut-companion-unified-replica.md): a relay
 * that answers needs-upgrade from such a Mac (an older daemon of its own on the
 * way) is not a pre-journal primary, so the op goes into the journal or waits in
 * the non-git queue, and the box writes nothing into the data dir's git tree.
 * A Mac that never drained keeps the legacy file, as before (task-queue.test.ts).
 *
 * Real files, real task store, real journal; only the relay is mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'
import { removeTempTree } from '../helpers/temp-home.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-queue-legacy', { CLOUD_MODE: true }))
vi.mock('../../src/web/routes/v1-control-relay.js', () => ({
  callPrimaryControl: async () => ({ ok: false, failure: { kind: 'needs_upgrade', message: 'Unknown control action' } }),
}))
vi.mock('../../src/web/ws/bridge-registry.js', () => ({
  setPrimaryBridgeConnectedHandler: () => {},
  addPrimaryBridgeConnectedHandler: () => () => {},
  addPrimaryBridgeActivityHandler: () => () => {},
}))

import { TASK_QUEUE_DIR, TASKS_DIR, WALNUT_HOME } from '../../src/constants.js'
import { dispatchTaskOp } from '../../src/core/task-queue.js'
import { _resetCompanionJournalForTesting, companionJournalRecords } from '../../src/core/companion-journal.js'

const OUTBOX_DIR = path.join(TASKS_DIR, 'outbox')
const JOURNAL_DIR = path.join(WALNUT_HOME, 'cache', 'journal')

async function listJson(dir: string): Promise<string[]> {
  try { return (await fsp.readdir(dir)).filter((n) => n.endsWith('.json')).sort() } catch { return [] }
}

function task(over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date().toISOString()
  return { id: 'tq-legacy-1', title: 'Acme launch', status: 'todo', phase: 'TODO', priority: 'none', project: '', source: 'local', session_ids: [], description: '', summary: '', note: '', created_at: now, updated_at: now, ...over }
}

async function drains(kinds: string[]): Promise<void> {
  await fsp.mkdir(JOURNAL_DIR, { recursive: true })
  await fsp.writeFile(path.join(JOURNAL_DIR, 'drains.json'), JSON.stringify({ v: 1, kinds, at: Date.now() }))
  _resetCompanionJournalForTesting()
}

beforeEach(async () => {
  _resetCompanionJournalForTesting()
  await removeTempTree(WALNUT_HOME)
  await fsp.mkdir(TASKS_DIR, { recursive: true })
})

afterEach(async () => {
  _resetCompanionJournalForTesting()
  await removeTempTree(WALNUT_HOME)
})

describe('needs-upgrade from a Mac that drains the journal\'s task kinds', () => {
  it('a field write it merges goes into the journal; no queue file, no legacy file', async () => {
    await drains(['task-fields', 'task-create'])
    await dispatchTaskOp({ type: 'update', task: task({ title: 'Acme launch v2' }) as never, touched: ['title'], fields: { title: { base: 'Acme launch', value: 'Acme launch v2', at: Date.now() } } })
    expect(companionJournalRecords().map((r) => [r.kind, r.taskId])).toEqual([['task-fields', 'tq-legacy-1']])
    expect(await listJson(TASK_QUEUE_DIR)).toEqual([])
    expect(await listJson(OUTBOX_DIR)).toEqual([])
  })

  it('an op the journal cannot take waits in the queue, and still no legacy file', async () => {
    await drains(['task-fields', 'task-create'])
    await dispatchTaskOp({ type: 'delete', id: 'tq-legacy-2' })
    expect((await listJson(TASK_QUEUE_DIR)).length).toBe(1)
    expect(await listJson(OUTBOX_DIR)).toEqual([])
  })
})

describe('needs-upgrade from a Mac that never drained', () => {
  it('keeps the legacy file beside the queue copy, as before', async () => {
    await dispatchTaskOp({ type: 'delete', id: 'tq-legacy-3' })
    expect((await listJson(TASK_QUEUE_DIR)).length).toBe(1)
    expect((await listJson(OUTBOX_DIR)).length).toBe(1)
  })
})
