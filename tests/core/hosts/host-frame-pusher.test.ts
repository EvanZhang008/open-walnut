/**
 * The server pushes a host's live frame when its connection moves (host-frame-pusher.ts),
 * also for a host row written without a config:changed: the host network adds a machine's
 * row when it joins, and discovered SSH hosts come from ~/.ssh/config. 2026-11-02: a machine
 * that had just joined read "Reaching it ... Retrying" for 30 s after it connected, because
 * the map the frames are pushed from did not have its row yet.
 */
import { describe, expect, it } from 'vitest'
import { createHostFramePusher, MISSED_HOST_RECHECK_MS } from '../../../src/core/hosts/host-frame-pusher.js'

function setup(initial: Record<string, { label: string }>) {
  let defs = { ...initial }
  let disk = { ...initial }
  let t = 1_000
  let refreshes = 0
  const pushed: Array<[string, unknown]> = []
  const p = createHostFramePusher({
    defs: () => defs,
    refresh: async () => { refreshes++; defs = { ...disk } },
    push: (host, def) => pushed.push([host, def]),
    now: () => t,
  })
  return {
    p, pushed,
    write: (host: string, def: { label: string }) => { disk = { ...disk, [host]: def } },
    advance: (ms: number) => { t += ms },
    refreshes: () => refreshes,
  }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('a host frame', () => {
  it('is pushed from the map for a known host, with no config read', async () => {
    const s = setup({ box: { label: 'box' } })
    s.p.emit('box')
    expect(s.pushed).toEqual([['box', { label: 'box' }]])
    expect(s.refreshes()).toBe(0)
  })

  it('reaches a host whose row was written without a config change', async () => {
    const s = setup({})
    s.write('joined', { label: 'joined' })
    s.p.emit('joined')
    await settle()
    expect(s.pushed).toEqual([['joined', { label: 'joined' }]])
    // From then on the map has it.
    s.p.emit('joined')
    expect(s.pushed).toHaveLength(2)
    expect(s.refreshes()).toBe(1)
  })

  it('reads the config at most once a while for a key no row names', async () => {
    const s = setup({})
    for (let i = 0; i < 5; i++) s.p.emit('direct:http://x')
    await settle()
    expect(s.refreshes()).toBe(1)
    expect(s.pushed).toEqual([])
    s.advance(MISSED_HOST_RECHECK_MS)
    s.p.emit('direct:http://x')
    await settle()
    expect(s.refreshes()).toBe(2)
    // Another key is looked up at once.
    s.write('late', { label: 'late' })
    s.p.emit('late')
    await settle()
    expect(s.pushed).toEqual([['late', { label: 'late' }]])
  })

  it('a row written right after a miss is found after a config change', async () => {
    const s = setup({})
    s.p.emit('soon')
    await settle()
    s.write('soon', { label: 'soon' })
    s.p.emit('soon')
    await settle()
    expect(s.pushed).toEqual([])
    s.p.configChanged()
    s.p.emit('soon')
    await settle()
    expect(s.pushed).toEqual([['soon', { label: 'soon' }]])
  })

  it('never pushes this Mac itself', async () => {
    const s = setup({})
    s.p.emit('__local__')
    s.p.emit('')
    await settle()
    expect(s.refreshes()).toBe(0)
  })
})
