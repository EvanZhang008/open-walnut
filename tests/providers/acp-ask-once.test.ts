/**
 * A command to an ACP worker that outlives its daemon (src/providers/acp-ask-once.ts): a link that
 * went while it waited is asked again with the same params (the worker keeps a command id once), a
 * worker on pipes fails as before, and no daemon in time reads `result unknown`, never success.
 */
import { describe, expect, it } from 'vitest'
import { askOnce, untilAdopted, ResultUnknownError, type AskConn } from '../../src/providers/acp-ask-once.js'
import { linkFailureKind, markLinkFailure } from '../../src/providers/link-failure.js'

const lost = () => markLinkFailure(new Error('daemon connection lost'), 'lost')
const noLink = () => markLinkFailure(new Error('not connected'), 'no-link')

function conn(answers: Array<() => Record<string, unknown>>, sent: Array<Record<string, unknown>>): AskConn {
  return { send: async (_cmd, params) => { sent.push(params ?? {}); const next = answers.shift(); if (!next) throw new Error('no more answers'); return next() } }
}

describe('askOnce', () => {
  it('asks the next daemon the same command after the link went, and returns its answer', async () => {
    const sent: Array<Record<string, unknown>> = []
    const first = conn([() => { throw lost() }], sent)
    const second = conn([() => { throw noLink() }, () => ({ ok: true, result: { accepted: true } })], sent)
    let dials = 0
    const r = await askOnce({ conn: first, reconnect: async () => { dials++; if (dials === 1) throw new Error('not back'); return second }, survive: true, cmd: 'acpSend', params: { sid: 's', commandId: 'acp-prompt:qm-1' }, retryMs: 5 })
    expect(r).toEqual({ ok: true, result: { accepted: true } })
    expect(sent.map((p) => p.commandId)).toEqual(['acp-prompt:qm-1', 'acp-prompt:qm-1', 'acp-prompt:qm-1'])
  })

  it('a worker on pipes (no survive): the lost link fails the command as before', async () => {
    const sent: Array<Record<string, unknown>> = []
    const err = await askOnce({ conn: conn([() => { throw lost() }], sent), reconnect: async () => { throw new Error('never asked') }, survive: false, cmd: 'acpSend', params: { commandId: 'c' } }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(ResultUnknownError)
    expect(sent).toHaveLength(1)
  })

  it('the work\'s own failure and a first ask that never reached the host are not asked again', async () => {
    for (const fail of [() => new Error('acpSend failed: boom'), noLink]) {
      const sent: Array<Record<string, unknown>> = []
      const err = await askOnce({ conn: conn([() => { throw fail() }], sent), reconnect: async () => { throw new Error('never asked') }, survive: true, cmd: 'acpSend', params: { commandId: 'c' }, retryMs: 5 }).catch((e) => e)
      expect(err).not.toBeInstanceOf(ResultUnknownError)
      expect(sent).toHaveLength(1)
    }
  })

  it('no daemon back in time: result unknown (errorKind result_unknown, still a lost link), never a success', async () => {
    const sent: Array<Record<string, unknown>> = []
    const err = await askOnce({ conn: conn([() => { throw lost() }], sent), reconnect: async () => { throw new Error('not back') }, survive: true, cmd: 'acpRespond', params: { commandId: 'qp-1' }, waitMs: 40, retryMs: 5 }).catch((e) => e)
    expect(err).toBeInstanceOf(ResultUnknownError)
    expect(err.errorKind).toBe('result_unknown')
    expect(err.message).toContain('result unknown')
    expect(linkFailureKind(err)).toBe('lost')
    expect(sent).toHaveLength(1)
  })

  it('a refusal while the host still checks a worker that outlived its daemon is asked again, then answered (2026-11-21 review R2-2)', async () => {
    const sent: Array<Record<string, unknown>> = []
    const adopting = () => ({ ok: false, errorKind: 'worker_adopting', error: 'still checking' })
    for (const survive of [true, false]) {
      sent.length = 0
      const c2 = conn([adopting, adopting, () => ({ ok: true, accepted: true })], sent)
      const r = await askOnce({ conn: c2, reconnect: async () => c2, survive, cmd: 'acpSend', params: { commandId: 'p1' }, adoptStepMs: 5 })
      expect(r).toEqual({ ok: true, accepted: true })
      expect(sent).toEqual([{ commandId: 'p1' }, { commandId: 'p1' }, { commandId: 'p1' }])
    }
    // Still refused when the wait runs out: that refusal is the answer (nothing was sent to the worker).
    const always = { send: async () => adopting() }
    expect(await untilAdopted(() => always.send(), { waitMs: 30, stepMs: 5 })).toMatchObject({ ok: false, errorKind: 'worker_adopting' })
  })
})
