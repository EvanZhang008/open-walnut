/**
 * task_update adopts and releases (src/ops/tasks.ts): `parent_task_id` rides the
 * PATCH as is, and when the server says the leader link changed (`placement`),
 * the outcome names the new relation instead of listing fields.
 *
 * The handler runs against a recording stub transport: no network, no disk.
 */
import { describe, it, expect } from 'vitest'
import { getOp } from '../../../src/ops/index.js'

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
interface SeenCall { method: Method; path: string; body?: unknown }
interface Spoken { outcome: string; next: string; [key: string]: unknown }

function runner(reply: (method: Method, path: string, body?: unknown) => unknown) {
  const op = getOp('task_update')
  if (!op?.handler) throw new Error('task_update must declare a handler')
  const seen: SeenCall[] = []
  const call = async (method: Method, path: string, body?: unknown) => {
    seen.push({ method, path, body })
    return reply(method, path, body)
  }
  return { seen, speak: async (args: Record<string, unknown>) => await op.handler!(args, call) as Spoken }
}

const WORKER = { id: 't_77c0de', title: 'Import the invoices' }
const LEADER = { id: 't_1ead00', title: 'Close the quarter' }

describe('task_update parent_task_id', () => {
  it('declares the field with its adopt / release description', () => {
    const op = getOp('task_update')
    const field = (op?.input as Record<string, { description?: string }> | undefined)?.parent_task_id
    expect(field?.description).toBe('Adopt or release: set to your own task id to make an existing task a worker of '
      + 'yours (it keeps its project and folder; its stops, completions, errors and waits then reach you), or "" to release it.')
  })

  it('forwards the leader id and says the task is now a worker', async () => {
    const r = runner(() => ({
      task: { id: WORKER.id, title: WORKER.title, phase: 'TODO' },
      placement: { parent_task_id: LEADER.id, parent_title: LEADER.title },
    }))
    const out = await r.speak({ id: WORKER.id, parent_task_id: LEADER.id })
    expect(r.seen).toEqual([{ method: 'PATCH', path: `/tasks/${WORKER.id}`, body: { parent_task_id: LEADER.id } }])
    expect(out.outcome).toContain(`"${WORKER.title}" (${WORKER.id}) is now a worker of "${LEADER.title}" (${LEADER.id}). `
      + 'It keeps its project and folder; its stops, completions, errors and waits now reach that task.')
    expect(out.outcome).not.toContain('Task fields updated')
    expect(out.outcome).toContain('No session was started or stopped by this')
    expect(out.placement).toEqual({ parent_task_id: LEADER.id, parent_title: LEADER.title })
  })

  it('forwards "" and says the task is released from its old leader', async () => {
    const r = runner(() => ({
      task: { id: WORKER.id, title: WORKER.title, phase: 'TODO' },
      placement: { parent_task_id: '', previous_parent_task_id: LEADER.id, previous_parent_title: LEADER.title },
    }))
    const out = await r.speak({ id: WORKER.id, parent_task_id: '' })
    expect(r.seen[0].body).toEqual({ parent_task_id: '' })
    expect(out.outcome).toContain(`"${WORKER.title}" (${WORKER.id}) is no longer a worker of "${LEADER.title}" (${LEADER.id}). `
      + 'It keeps its project and folder; its stops, completions, errors and waits no longer reach that task.')
    expect(out.outcome).not.toContain('is now a worker')
  })

  it('names the other fields changed alongside the link', async () => {
    const r = runner(() => ({
      task: { id: WORKER.id, title: WORKER.title },
      placement: { parent_task_id: LEADER.id, parent_title: LEADER.title },
    }))
    const out = await r.speak({ id: WORKER.id, parent_task_id: LEADER.id, priority: 'important' })
    expect(r.seen[0].body).toEqual({ parent_task_id: LEADER.id, priority: 'important' })
    expect(out.outcome).toContain('is now a worker of')
    expect(out.outcome).toContain('Other fields updated (priority).')
  })

  it('keeps the plain field list when the server reports no link change', async () => {
    // Re-sending the leader a task already has: the server writes nothing and sends no placement.
    const r = runner(() => ({ task: { id: WORKER.id, title: WORKER.title } }))
    const out = await r.speak({ id: WORKER.id, parent_task_id: LEADER.id })
    expect(out.outcome).toContain('Task fields updated (parent_task_id).')
    expect(out.outcome).not.toContain('worker')
  })

  it('a placement without parent_task_id never reads as a leader link', async () => {
    const r = runner(() => ({ task: { id: WORKER.id, title: WORKER.title }, placement: { project: 'acme' } }))
    const out = await r.speak({ id: WORKER.id, title: WORKER.title })
    expect(out.outcome).toContain('Task fields updated (title).')
  })
})
