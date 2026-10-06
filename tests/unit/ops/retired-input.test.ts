/**
 * Retired op fields (WalnutOp.retiredInput, src/ops/executor.ts parseOpArgs).
 *
 * wait_report left task_update, task_update_bulk and trigger_create on
 * 2026-10-05, and the HTTP route ignored a stray one, but the op executor
 * refused the whole call for it. A session started before the change kept
 * sending it, and a park its host queued offline was refused at replay and lost
 * (the handover's "record failed" card). A retired field is now dropped on every
 * surface; any other unknown key is still refused, and the catalog never offers
 * the retired one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeOp, getOp, opInputJsonSchema, parseOpArgs } from '../../../src/ops/index.js'
import { LOCAL_ORIGIN } from '../../../src/lib/caller-origin.js'

const op = (name: string) => getOp(name)!

afterEach(() => { vi.unstubAllGlobals() })

describe('parseOpArgs drops a retired field and nothing else', () => {
  it('task_update keeps the park and drops wait_report', () => {
    const raw = { id: 't1', phase: 'WAITING', wait_until: '2d', wait_report: 'PR 123 is pushed.' }
    const r = parseOpArgs(op('task_update'), raw)
    expect(r).toEqual({ ok: true, args: { id: 't1', phase: 'WAITING', wait_until: '2d' } })
    // The caller's object is never edited in place.
    expect(raw.wait_report).toBe('PR 123 is pushed.')
  })

  it('still refuses an unknown key that was never a field (a typo is not dropped)', () => {
    const r = parseOpArgs(op('task_update'), { id: 't1', phse: 'WAITING', wait_report: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.message).toMatch(/^Invalid arguments for task_update: /)
      expect(r.message).toContain('phse')
      expect(r.message).not.toContain('wait_report')
    }
  })

  it('task_update_bulk drops it from every patch, and refuses any other unknown key in one', () => {
    const r = parseOpArgs(op('task_update_bulk'), {
      updates: [
        { id: 't1', phase: 'WAITING', wait_report: 'a' },
        { id: 't2', title: 'Rename' },
        { id: 't3', phase: 'WAITING', wait_report: 'c' },
      ],
    })
    expect(r).toEqual({ ok: true, args: { updates: [
      { id: 't1', phase: 'WAITING' }, { id: 't2', title: 'Rename' }, { id: 't3', phase: 'WAITING' },
    ] } })
    const typo = parseOpArgs(op('task_update_bulk'), { updates: [{ id: 't1', wait_report: 'a', titel: 'x' }] })
    expect(typo.ok).toBe(false)
    if (!typo.ok) expect(typo.message).toContain('titel')
    // A malformed list is the schema's to report, not the drop's to crash on.
    expect(parseOpArgs(op('task_update_bulk'), { updates: ['t1', null] }).ok).toBe(false)
    expect(parseOpArgs(op('task_update_bulk'), { updates: 't1' }).ok).toBe(false)
  })

  it('trigger_create drops it', () => {
    const base = { run: 'bash check.sh', every: '5m', prompt: 'Reply.', description: 'Checks PR 123.' }
    expect(parseOpArgs(op('trigger_create'), { ...base, wait_report: 'PR 123 is pushed.' })).toEqual({ ok: true, args: base })
  })

  it('an op with no retired fields, and a call with none, behave exactly as before', () => {
    expect(parseOpArgs(op('task_get'), { id: 't1' })).toEqual({ ok: true, args: { id: 't1' } })
    expect(parseOpArgs(op('task_get'), { id: 't1', wait_report: 'x' }).ok).toBe(false)
    expect(parseOpArgs(op('task_update'), undefined).ok).toBe(false)
  })

  it('the catalog never offers a retired field', () => {
    for (const name of ['task_update', 'task_update_bulk', 'trigger_create']) {
      expect(JSON.stringify(opInputJsonSchema(op(name))), name).not.toContain('wait_report')
    }
  })
})

describe('executeOp', () => {
  it('sends the park without the retired field, as the HTTP route would have taken it', async () => {
    const bodies: unknown[] = []
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      bodies.push(init.body ? JSON.parse(String(init.body)) : undefined)
      return new Response(JSON.stringify({ task: { id: 't1', phase: 'WAITING' } }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const r = await executeOp('task_update', { id: 't1', phase: 'WAITING', wait_report: 'PR 123 is pushed.' }, {
      apiBase: 'http://127.0.0.1:1', origin: LOCAL_ORIGIN,
    })
    expect(r.ok).toBe(true)
    expect(bodies).toEqual([{ phase: 'WAITING' }])
  })

  it('a call that carried only the retired field says it changes nothing', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('must not be called') })
    const r = await executeOp('task_update', { id: 't1', wait_report: 'x' }, { apiBase: 'http://127.0.0.1:1', origin: LOCAL_ORIGIN })
    expect(r).toMatchObject({ ok: false, message: 'task_update needs at least one field to change besides `id`.' })
  })
})
