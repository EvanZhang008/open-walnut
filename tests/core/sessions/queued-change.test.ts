/**
 * Edit and Delete of a queued message answer a state, never throw
 * (src/core/sessions/queued-change.ts, src/web/routes/session-chat.ts).
 *
 * 2026-11-09, the user pressed Delete on a bubble the session had already taken
 * and got `RPC handler error for "session:delete-queued": Message not deletable
 * (already processing or not found).` as a red toast: the WS handler logs every
 * thrown error as an error, and the console shows those as toasts.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { queuedChange } from '../../../src/core/sessions/queued-change.js'

describe('queuedChange', () => {
  it('a change that applied is ok', async () => {
    expect(await queuedChange('qm-1', { change: async () => true, readQueue: async () => [] })).toEqual({ ok: true })
  })

  it('a refused change says whether the row is taken (still queued) or gone', async () => {
    expect(await queuedChange('qm-1', { change: async () => false, readQueue: async () => [{ id: 'qm-1', status: 'processing' }] }))
      .toEqual({ ok: false, outcome: 'taken' })
    expect(await queuedChange('qm-1', { change: async () => false, readQueue: async () => [{ id: 'qm-2', status: 'pending' }] }))
      .toEqual({ ok: false, outcome: 'gone' })
  })

  it('a processing row the runner holds back unwritten is held, not taken (it was never sent)', async () => {
    expect(await queuedChange('qm-1', {
      change: async () => false,
      readQueue: async () => [{ id: 'qm-1', status: 'processing' }],
      isHeld: (id) => id === 'qm-1',
    })).toEqual({ ok: false, outcome: 'held' })
  })

  it('a queue that did not answer is unavailable, with its error, and never throws', async () => {
    expect(await queuedChange('qm-1', { change: async () => { throw new Error('lock timeout') }, readQueue: async () => [] }))
      .toEqual({ ok: false, outcome: 'unavailable', error: 'lock timeout' })
    expect(await queuedChange('qm-1', { change: async () => false, readQueue: async () => { throw new Error('read failed') } }))
      .toEqual({ ok: false, outcome: 'unavailable', error: 'read failed' })
  })
})

describe('guard: the queued-message RPCs answer a refusal, they do not throw it', () => {
  const src = readFileSync(path.resolve(__dirname, '../../../src/web/routes/session-chat.ts'), 'utf8')
  // Every handler of a person's change to a queued row (edit-queued, delete-queued, and any new one).
  const handlers = [...src.matchAll(/registerMethod\('session:([a-z-]+-queued)'[\s\S]*?\n {2}\}\)/g)]
  it('finds the handlers', () => {
    expect(handlers.map((m) => m[1]).sort()).toEqual(expect.arrayContaining(['delete-queued', 'edit-queued']))
  })
  for (const m of handlers) {
    it(`session:${m[1]} goes through queuedChange and throws nothing after its argument checks`, () => {
      const body = m[0]
      expect(body).toContain('queuedChange(')
      // The only throws allowed are the payload checks ("requires ...").
      const throws = [...body.matchAll(/throw new Error\(([^)]*)\)/g)].map((t) => t[1])
      for (const t of throws) expect(t).toMatch(/requires/)
    })
  }
})
