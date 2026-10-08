/**
 * The daemon's half of a model or effort change made while the companion leads
 * (src/providers/live-settings-core.ts): the value is checked before the CLI
 * sees it (the CLI ACKs garbage), the line is the CLI's own apply_flag_settings
 * request, and only the CLI's answer to THAT request in THAT session's stream
 * settles it.
 */
import { describe, expect, it } from 'vitest'
import { createLiveSettings } from '../../src/providers/live-settings-core.js'

const SID = 'bbbbbbbb-2222-4222-8222-222222222222'

function harness(write: 'ok' | 'not_found' | 'dead' | 'failed' | 'throw' = 'ok') {
  const lines: Array<{ sid: string; line: string }> = []
  const logs: string[] = []
  const live = createLiveSettings({
    writeLine: async (sid, line) => {
      if (write === 'throw') throw new Error('fifo gone')
      lines.push({ sid, line })
      return write
    },
    randomHex: () => 'abcd',
    now: () => 1_800_000_000_000,
    log: (_level, msg) => { logs.push(msg) },
  })
  const sent = () => lines.map((l) => JSON.parse(l.line) as { type: string; request_id: string; request: { subtype: string; settings: Record<string, string> } })
  return { live, lines, sent, logs }
}

describe('live settings', () => {
  it('writes the CLI\'s own request and settles on the CLI\'s answer', async () => {
    const h = harness()
    const p = h.live.apply(SID, { model: 'sonnet[1m]' })
    await Promise.resolve()
    const [req] = h.sent()
    expect(req).toMatchObject({ type: 'control_request', request: { subtype: 'apply_flag_settings', settings: { model: 'sonnet[1m]' } } })
    expect(h.lines[0].sid).toBe(SID)
    h.live.noteResponse(SID, { type: 'control_response', response: { subtype: 'success', request_id: req.request_id } })
    expect(await p).toEqual({ ok: true, appliedLive: true, cliModel: 'sonnet[1m]' })
    expect(h.live.pending()).toBe(0)
  })

  it('effort rides as effortLevel', async () => {
    const h = harness()
    const p = h.live.apply(SID, { effort: 'xhigh' })
    await Promise.resolve()
    expect(h.sent()[0].request.settings).toEqual({ effortLevel: 'xhigh' })
    h.live.noteResponse(SID, { type: 'control_response', response: { subtype: 'success', request_id: h.sent()[0].request_id } })
    expect(await p).toMatchObject({ ok: true, appliedLive: true, effort: 'xhigh' })
  })

  it('an error answer is not applied', async () => {
    const h = harness()
    const p = h.live.apply(SID, { model: 'opus' })
    await Promise.resolve()
    h.live.noteResponse(SID, { type: 'control_response', response: { subtype: 'error', request_id: h.sent()[0].request_id, error: 'nope' } })
    expect(await p).toMatchObject({ ok: true, appliedLive: false, reason: 'no_answer' })
  })

  it('another session\'s answer, or another request\'s, settles nothing', async () => {
    const h = harness()
    const p = h.live.apply(SID, { model: 'opus' }, 200)
    await Promise.resolve()
    const id = h.sent()[0].request_id
    h.live.noteResponse('aaaaaaaa-1111-4111-8111-111111111111', { type: 'control_response', response: { subtype: 'success', request_id: id } })
    h.live.noteResponse(SID, { type: 'control_response', response: { subtype: 'success', request_id: 'mdl-other' } })
    h.live.noteResponse(SID, { type: 'control_response' })
    expect(h.live.pending()).toBe(1)
    expect(await p).toMatchObject({ ok: true, appliedLive: false, reason: 'no_answer' })
    expect(h.live.pending()).toBe(0)
  })

  it('no live CLI: nothing applied now, the values are kept for the next spawn', async () => {
    for (const w of ['not_found', 'dead', 'failed', 'throw'] as const) {
      const h = harness(w)
      expect(await h.live.apply(SID, { model: 'opus', effort: 'low' })).toEqual({
        ok: true, appliedLive: false, reason: w === 'throw' ? 'failed' : w, cliModel: 'opus', effort: 'low',
      })
      expect(h.live.pending()).toBe(0)
    }
  })

  it.each([
    ['an unknown effort', { effort: 'turbo' }, /effort must be one of/],
    ['a model with a space', { model: 'opus 4' }, /model must be/],
    ['a model with a quote', { model: 'opus"' }, /model must be/],
    ['a model that is too long', { model: 'a'.repeat(257) }, /model must be/],
    ['a model that is not a string', { model: 7 }, /model must be/],
    ['nothing at all', {}, /model or effort is required/],
  ])('refuses %s before the CLI sees it', async (_what, raw, re) => {
    const h = harness()
    const r = await h.live.apply(SID, raw)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(re)
    expect(h.lines).toHaveLength(0)
  })

  it('takes a provider id and a 1M alias', async () => {
    for (const model of ['global.anthropic.claude-opus-4-6-v1[1m]', 'us.anthropic.claude-haiku-4-5:0', 'claude-sonnet-4-6']) {
      const h = harness('dead')
      expect((await h.live.apply(SID, { model })).ok).toBe(true)
    }
  })
})
