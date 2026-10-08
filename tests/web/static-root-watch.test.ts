/**
 * When a missing web root becomes the 'web-assets' error card.
 *
 * 2026-10-04 to 10-08: the cloud companion's deploy rebuilds dist in place under
 * the running server and restarts it a minute or two later. Each deploy raised
 * "Web assets VANISHED from under the running server" although the mirror kept
 * serving the build every open window ran. A gap the mirror covers is now a
 * warning until it outlasts the grace; a gap it does not cover is the card at
 * once (the 2026-09-02 outage).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStaticRootWatch, STATIC_ROOT_GRACE_MS, type StaticRootEvent } from '../../src/web/static-root-watch.js'
import { mirrorHoldsBuild } from '../../src/web/static-mirror.js'

function harness(opts: { initialOk?: boolean; graceMs?: number } = {}) {
  const state = { servable: opts.initialOk ?? true, covered: true, now: 1_000_000 }
  const events: StaticRootEvent[] = []
  const watch = createStaticRootWatch({
    initialOk: opts.initialOk ?? true,
    check: () => state.servable,
    mirrorCovers: () => state.covered,
    report: (e) => events.push(e),
    graceMs: opts.graceMs,
    now: () => state.now,
  })
  const minute = () => { state.now += 60_000; watch.tick() }
  return { state, events, watch, minute }
}

describe('static root watch', () => {
  it('a deploy-length gap the mirror covers is a warning, never the card', () => {
    const h = harness()
    h.minute()
    h.state.servable = false
    h.minute()
    h.minute()
    h.state.servable = true
    h.minute()
    expect(h.events.map(e => e.kind)).toEqual(['covered', 'servable'])
    expect(h.watch.ok()).toBe(true)
  })

  it('a covered gap that outlasts the grace becomes the card, once', () => {
    const h = harness()
    h.state.servable = false
    h.minute()
    for (let i = 0; i < 10; i++) h.minute()
    const broken = h.events.filter(e => e.kind === 'broken')
    expect(broken).toHaveLength(1)
    expect(broken[0]).toMatchObject({ kind: 'broken', mirrorCovers: true })
    expect((broken[0] as { missingForMs: number }).missingForMs).toBeGreaterThanOrEqual(STATIC_ROOT_GRACE_MS)
    h.state.servable = true
    h.minute()
    expect(h.events.at(-1)?.kind).toBe('servable')
  })

  it('a gap with no mirror copy of the running build is the card at once', () => {
    const h = harness()
    h.state.covered = false
    h.state.servable = false
    h.minute()
    expect(h.events).toEqual([{ kind: 'broken', missingForMs: 0, mirrorCovers: false }])
    h.minute()
    expect(h.events).toHaveLength(1)
  })

  it('the mirror losing the build mid-gap raises the card on that tick', () => {
    const h = harness()
    h.state.servable = false
    h.minute()
    h.state.covered = false
    h.minute()
    expect(h.events.map(e => e.kind)).toEqual(['covered', 'broken'])
    expect(h.events[1]).toMatchObject({ mirrorCovers: false, missingForMs: 60_000 })
  })

  it('a boot without assets (already logged by the server) only reports the way back', () => {
    const h = harness({ initialOk: false })
    expect(h.watch.ok()).toBe(false)
    for (let i = 0; i < 10; i++) h.minute()
    expect(h.events).toEqual([])
    h.state.servable = true
    h.minute()
    expect(h.events.map(e => e.kind)).toEqual(['servable'])
  })

  it('each gap is judged on its own: a second deploy after a carded one starts fresh', () => {
    const h = harness({ graceMs: 120_000 })
    h.state.servable = false
    for (let i = 0; i < 4; i++) h.minute()
    h.state.servable = true
    h.minute()
    h.state.servable = false
    h.minute()
    h.state.servable = true
    h.minute()
    expect(h.events.map(e => e.kind)).toEqual(['covered', 'broken', 'servable', 'covered', 'servable'])
  })
})

describe('mirrorHoldsBuild', () => {
  it('is true only for a generation with its index and entry chunk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-mirror-holds-'))
    try {
      const gen = path.join(dir, 'gens', 'ABC123')
      fs.mkdirSync(path.join(gen, 'assets'), { recursive: true })
      fs.writeFileSync(path.join(gen, 'index.html'), '<script type="module" src="/assets/index-ABC123.js"></script>')
      expect(mirrorHoldsBuild(dir, 'ABC123')).toBe(false)
      fs.writeFileSync(path.join(gen, 'assets', 'index-ABC123.js'), 'entry\n')
      expect(mirrorHoldsBuild(dir, 'ABC123')).toBe(true)
      expect(mirrorHoldsBuild(dir, 'OTHER9')).toBe(false)
      expect(mirrorHoldsBuild(dir, null)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
