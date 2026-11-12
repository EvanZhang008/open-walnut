/**
 * A server that restarted asks a daemon whether it holds the spawn template before it sends it
 * (push-probe-v1; 2026-11-12: each deploy sent both templates, about 200 KB each, on the new
 * link, and the relay on the SSH path ended it).
 *
 *   - held: only the probe goes, about 100 bytes;
 *   - not held, or the probe fails: the template goes, naming its hash for the next probe;
 *   - an older daemon (no push-probe-v1) is never asked, and still gets the template;
 *   - a launch-mode read that failed or ran slow (degraded) builds from the last real read, so
 *     the hash does not flip with the link's speed (each flip sent the template again).
 */
import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())
vi.mock('../../src/core/config-manager.js', () => ({ getConfig: async () => ({}) }))
const launch = vi.hoisted(() => ({ choice: { mode: 'default', cli: 'default' } as Record<string, unknown> }))
vi.mock('../../src/providers/claude-launch-mode.js', () => ({ resolveClaudeLaunchMode: async () => launch.choice }))

const { pushHostSpawnTemplate, pushRoutineSpawnTemplate, _resetLaunchChoicesForTesting } = await import('../../src/providers/spawn-template.js')

const BASE_CAPS = ['replica-start-v1', 'clock-host-start-v1', 'implicit-mode-v1']

function daemon(caps: string[], answer: (params: Record<string, unknown>) => Record<string, unknown> | Error) {
  const sent: Array<Record<string, unknown>> = []
  return {
    sent,
    host: {
      hasCapability: (c: string) => caps.includes(c),
      send: async (_cmd: string, params: Record<string, unknown> = {}) => {
        sent.push(params)
        const r = answer(params)
        if (r instanceof Error) throw r
        return r
      },
    },
  }
}

const o = { home: '/fixture/marina-home', hostKey: 'devbox' }

describe('the spawn templates are asked about before they are sent', () => {
  it('held: only the probe goes', async () => {
    let hash = ''
    const first = daemon([...BASE_CAPS, 'push-probe-v1'], (p) => (p.probe ? { ok: true, held: false } : { ok: true }))
    hash = String(await pushRoutineSpawnTemplate(first.host, o))
    expect(first.sent.map((p) => (p.probe ? 'probe' : 'push'))).toEqual(['probe', 'push'])
    expect(first.sent[1]).toMatchObject({ use: 'routine', hash })
    expect(first.sent[1].template).toBeTruthy()

    const again = daemon([...BASE_CAPS, 'push-probe-v1'], (p) => (p.probe ? { ok: true, held: p.hash === hash } : { ok: true }))
    expect(await pushRoutineSpawnTemplate(again.host, o)).toBe(hash)
    expect(again.sent).toEqual([{ home: o.home, use: 'routine', probe: true, hash }])
    expect(JSON.stringify(again.sent).length).toBeLessThan(200)

    const ask = daemon([...BASE_CAPS, 'push-probe-v1'], (p) => (p.probe ? { ok: true, held: true } : { ok: true }))
    expect(await pushHostSpawnTemplate(ask.host, { ...o, cwd: '/fixture/marina-replica' })).toMatchObject({ sent: false })
    expect(ask.sent).toHaveLength(1)
    expect(ask.sent[0]).toMatchObject({ use: 'ask', probe: true })
  })

  it('a failed probe still sends the template; an older daemon is never asked', async () => {
    const failing = daemon([...BASE_CAPS, 'push-probe-v1'], (p) => (p.probe ? new Error('daemon command timeout') : { ok: true }))
    expect(await pushHostSpawnTemplate(failing.host, { ...o, cwd: '/fixture/marina-replica' })).toMatchObject({ sent: true })
    expect(failing.sent.map((p) => (p.probe ? 'probe' : 'push'))).toEqual(['probe', 'push'])

    const older = daemon(BASE_CAPS, () => ({ ok: true }))
    expect(await pushHostSpawnTemplate(older.host, { ...o, cwd: '/fixture/marina-replica' })).toMatchObject({ sent: true })
    expect(older.sent).toHaveLength(1)
    expect(older.sent[0].probe).toBeUndefined()
    expect(older.sent[0].template).toBeTruthy()
  })

  it('a degraded launch-mode read builds from the last real read: no flip, nothing sent; another change still goes', async () => {
    _resetLaunchChoicesForTesting()
    const real = daemon([...BASE_CAPS, 'push-probe-v1'], (p) => (p.probe ? { ok: true, held: false } : { ok: true }))
    const held = await pushHostSpawnTemplate(real.host, { ...o, cwd: '/fixture/marina-replica' }) as { hash: string }
    const routineHash = await pushRoutineSpawnTemplate(real.host, o)
    launch.choice = { mode: 'default', source: 'engine', degraded: true }
    try {
      const slow = daemon([...BASE_CAPS, 'push-probe-v1'], () => ({ ok: true }))
      expect(await pushHostSpawnTemplate(slow.host, { ...o, cwd: '/fixture/marina-replica', unlessHash: held.hash })).toEqual({ hash: held.hash, sent: false })
      expect(await pushRoutineSpawnTemplate(slow.host, { ...o, unlessHash: routineHash })).toBe(routineHash)
      expect(slow.sent).toEqual([])
      // askBypass turned on meanwhile: the template changed, so it goes.
      const changed = await pushHostSpawnTemplate(slow.host, { ...o, cwd: '/fixture/marina-replica', bypassAllowed: true, unlessHash: held.hash }) as { hash: string; sent: boolean }
      expect(changed.sent).toBe(true)
      expect(changed.hash).not.toBe(held.hash)
      // No real read yet (a server just started): the safe default goes, better than none.
      _resetLaunchChoicesForTesting()
      expect(await pushHostSpawnTemplate(slow.host, { ...o, cwd: '/fixture/marina-replica' })).toMatchObject({ sent: true })
    } finally {
      launch.choice = { mode: 'default', cli: 'default' }
    }
  })
})
