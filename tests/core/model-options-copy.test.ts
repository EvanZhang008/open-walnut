/**
 * The companion's model picker and switches while the Mac is away
 * (src/core/sessions/model-options-copy.ts).
 *
 * Pinned: the picker answers from the copy the Mac last pushed (the host's own
 * catalog, else the static registry), in the Mac's shape plus `offline`; a
 * change goes to the session's host only while the companion leads it, at that
 * lead's epoch; a session on the Mac itself, no lead yet, a stale lead, an old
 * daemon and an effort the model does not take each answer as they should; what
 * the companion applied shows until the Mac pushes again.
 */
import { describe, expect, it } from 'vitest'
import { createModelCopy } from '../../src/core/sessions/model-options-copy.js'
import type { SessionProjection } from '../../src/core/session-projection.js'
import type { SessionModelCatalogEntry } from '../../src/core/types.js'

const NOW = 1_800_000_000_000
const B = 'bbbbbbbb-2222-4222-8222-222222222222'
const M = 'cccccccc-3333-4333-8333-333333333333'

const CATALOG: SessionModelCatalogEntry[] = [
  { value: 'default', displayName: 'Default', resolvedModel: 'claude-opus-4-8[1m]', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'sonnet[1m]', displayName: 'Sonnet (1M)', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
  { value: 'haiku', displayName: 'Haiku', supportsEffort: false, supportedEffortLevels: [] },
  { value: 'retired', displayName: 'Retired', disabled: true },
]

function projection(over: Partial<SessionProjection> = {}, exportedAt = new Date(NOW - 60_000).toISOString()): SessionProjection {
  return {
    version: 1, exportedAt,
    sessions: [
      { id: B, host: 'devbox', process_status: 'idle', started_at: '', last_active_at: '', message_count: 3, cli_model: 'sonnet[1m]', effort: 'medium' },
      { id: M, host: '', process_status: 'idle', started_at: '', last_active_at: '', message_count: 1, model: 'opus' },
    ],
    host_model_catalogs: { devbox: { models: CATALOG, fetchedAt: '2026-10-07T20:00:00Z' } },
    ...over,
  }
}

function harness(opts: { projection?: () => SessionProjection | null; lead?: { walnutId: string; epoch: number } | null; reply?: Record<string, unknown> | Error } = {}) {
  let now = NOW
  const requests: Array<{ host: string; cmd: string; params: Record<string, unknown> }> = []
  const lost: string[] = []
  let current = opts.projection ?? (() => projection())
  const copy = createModelCopy({
    now: () => now,
    projection: async () => current(),
    leadFor: async () => (opts.lead === undefined ? { walnutId: 'wtest', epoch: 4 } : opts.lead),
    request: async (host, cmd, params) => {
      requests.push({ host, cmd, params })
      if (opts.reply instanceof Error) throw opts.reply
      return opts.reply ?? { ok: true, appliedLive: true }
    },
    lostHost: (host, why) => { lost.push(`${host}:${why}`) },
  })
  return { copy, requests, lost, advance: (ms: number) => { now += ms }, setProjection: (p: () => SessionProjection | null) => { current = p } }
}

describe('the picker from the copy', () => {
  it('answers in the Mac\'s shape from the host\'s own catalog, marked offline', async () => {
    const r = await harness().copy.modelOptions(B)
    expect(r).toMatchObject({ current: 'sonnet[1m]', currentEffort: 'medium', offline: true, asOf: new Date(NOW - 60_000).toISOString() })
    expect(r!.models.map((m) => m.id)).toEqual(['default', 'sonnet[1m]', 'haiku'])
    expect(r!.models[1]).toEqual({ id: 'sonnet[1m]', label: 'Sonnet (1M)', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] })
  })

  it('a host the Mac never sent a catalog for gets the static registry', async () => {
    const r = await harness({ projection: () => projection({ host_model_catalogs: undefined }) }).copy.modelOptions(B)
    expect(r!.models.length).toBeGreaterThan(0)
    expect(r!.models.every((m) => typeof m.id === 'string' && typeof m.label === 'string')).toBe(true)
  })

  it('a session the copy does not list: null, the route asks the Mac as before', async () => {
    expect(await harness().copy.modelOptions('dddddddd-4444-4444-8444-444444444444')).toBeNull()
    expect(await harness({ projection: () => null }).copy.modelOptions(B)).toBeNull()
  })
})

describe('a change while the Mac is away', () => {
  it('goes to the session\'s host at the lead\'s epoch, and shows in the picker until the Mac pushes again', async () => {
    const h = harness()
    const r = await h.copy.changeModel(B, 'haiku')
    expect(r).toEqual({ status: 200, body: { model: 'haiku', cliModel: 'haiku', appliedLive: true, viaCompanion: true } })
    expect(h.requests).toEqual([{ host: 'devbox', cmd: 'leader.settings', params: { walnutId: 'wtest', epoch: 4, sid: B, model: 'haiku' } }])
    expect((await h.copy.modelOptions(B))!.current).toBe('haiku')
    // The Mac's next push is the truth again.
    h.advance(1_000)
    h.setProjection(() => projection({}, new Date(NOW + 500).toISOString()))
    expect((await h.copy.modelOptions(B))!.current).toBe('sonnet[1m]')
  })

  it('an alias is resolved as the Mac resolves it', async () => {
    const h = harness()
    const r = await h.copy.changeModel(B, '  sonnet[1m] ')
    expect(r.status).toBe(200)
    expect(h.requests[0].params.model).toBe('sonnet[1m]')
  })

  it('effort: checked against the session\'s model in the host catalog', async () => {
    const h = harness()
    expect(await h.copy.changeEffort(B, 'high')).toEqual({ status: 200, body: { effort: 'high', appliedLive: true, overridden: false, viaCompanion: true } })
    expect(h.requests[0].params).toMatchObject({ sid: B, effort: 'high' })
    expect((await h.copy.modelOptions(B))!.currentEffort).toBe('high')
    const tooHigh = await h.copy.changeEffort(B, 'max')
    expect(tooHigh.status).toBe(409)
    expect(h.requests).toHaveLength(1)
  })

  it.each([
    ['an empty model', (c: ReturnType<typeof harness>['copy']) => c.changeModel(B, ' '), 400],
    ['a model with a quote', (c: ReturnType<typeof harness>['copy']) => c.changeModel(B, 'opus"'), 400],
    ['an unknown effort', (c: ReturnType<typeof harness>['copy']) => c.changeEffort(B, 'turbo'), 400],
    ['a session the copy does not list', (c: ReturnType<typeof harness>['copy']) => c.changeModel('dddddddd-4444-4444-8444-444444444444', 'haiku'), 404],
  ])('%s is refused here and nothing is sent', async (_what, run, status) => {
    const h = harness()
    expect((await run(h.copy)).status).toBe(status)
    expect(h.requests).toHaveLength(0)
  })

  it('a session on the Mac itself: nothing to reach, said plainly', async () => {
    const h = harness()
    const r = await h.copy.changeModel(M, 'haiku')
    expect(r.status).toBe(503)
    expect((r.body.error as { message: string }).message).toMatch(/runs on your Mac/)
    expect(h.requests).toHaveLength(0)
  })

  it('before the takeover nothing leads the host: try again in a minute', async () => {
    const h = harness({ lead: null })
    const r = await h.copy.changeModel(B, 'haiku')
    expect(r.status).toBe(503)
    expect((r.body.error as { message: string }).message).toMatch(/within about a minute/)
    expect(h.requests).toHaveLength(0)
  })

  it('a stale lead is let go and the change is not claimed', async () => {
    const h = harness({ reply: { ok: false, error: 'the current epoch is 5', errorKind: 'stale_epoch' } })
    const r = await h.copy.changeModel(B, 'haiku')
    expect(r.status).toBe(503)
    expect(h.lost).toEqual(['devbox:stale_epoch'])
    expect((await h.copy.modelOptions(B))!.current).toBe('sonnet[1m]')
  })

  it('an old daemon says it needs an upgrade', async () => {
    const h = harness({ reply: { ok: false, error: 'command not permitted over bridge: leader.settings' } })
    expect(await h.copy.changeModel(B, 'haiku')).toMatchObject({ status: 400, body: { error: { code: 'session_control_needs_upgrade' } } })
  })

  it('the host does not answer: 503, and the picker keeps the old value', async () => {
    const h = harness({ reply: new Error('bridge request timed out') })
    expect((await h.copy.changeModel(B, 'haiku')).status).toBe(503)
    expect((await h.copy.modelOptions(B))!.current).toBe('sonnet[1m]')
  })

  it('no live CLI: accepted for the next spawn, appliedLive false', async () => {
    const h = harness({ reply: { ok: true, appliedLive: false, reason: 'not_found' } })
    expect(await h.copy.changeModel(B, 'haiku')).toMatchObject({ status: 200, body: { appliedLive: false } })
  })
})
