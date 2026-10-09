/**
 * The host-local delivery-marker search behind `markers.find` (both twins; the
 * JS twin carries a hand-inlined copy, pinned in daemon-relay-reroute.test.ts).
 * Small chunks here so every boundary case is cheap.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findDeliveryMarkers, validMarkerIds, MARKER_FIND_MAX_IDS } from '../../src/providers/marker-find-core.js'

const markerLine = (id: string) => JSON.stringify({ type: 'user', subtype: 'walnut-injected', walnutMessageId: id })
let dir: string
let file: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-find-'))
  file = path.join(dir, 's.jsonl')
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('findDeliveryMarkers', () => {
  it('finds a marker cut by a chunk boundary (each read overlaps the newer chunk)', async () => {
    const line = markerLine('qm-mobile-cut')
    const head = 'a'.repeat(100)
    fs.writeFileSync(file, head + line + 'b'.repeat(100))
    // 64-byte chunks: the marker spans several of them.
    for (const chunk of [16, 64, 77, 128]) {
      const r = await findDeliveryMarkers(file, ['qm-mobile-cut'], 1 << 20, chunk)
      expect(r.found, `chunk ${chunk}`).toEqual(['qm-mobile-cut'])
    }
  })

  it('searches the whole file when nothing is found, and says so', async () => {
    fs.writeFileSync(file, markerLine('qm-mobile-other') + '\n' + 'x'.repeat(5_000))
    const r = await findDeliveryMarkers(file, ['qm-mobile-missing'], 1 << 20, 256)
    expect(r).toMatchObject({ found: [], complete: true, scanned: r.size })
  })

  it('stops at the byte bound: not complete, so "not found" proves nothing', async () => {
    fs.writeFileSync(file, markerLine('qm-mobile-deep') + '\n' + 'x'.repeat(10_000))
    const r = await findDeliveryMarkers(file, ['qm-mobile-deep'], 2_000, 500)
    expect(r.found).toEqual([])
    expect(r.complete).toBe(false)
    expect(r.scanned).toBeLessThanOrEqual(2_000)
  })

  it('stops early once every id is found, newest bytes first', async () => {
    fs.writeFileSync(file, 'x'.repeat(10_000) + markerLine('qm-mobile-new'))
    const r = await findDeliveryMarkers(file, ['qm-mobile-new'], 1 << 20, 500)
    expect(r.found).toEqual(['qm-mobile-new'])
    expect(r.scanned).toBeLessThan(r.size)
  })

  it('an id is matched whole, never as the prefix of a longer one', async () => {
    fs.writeFileSync(file, markerLine('qm-mobile-12345'))
    const r = await findDeliveryMarkers(file, ['qm-mobile-1234'], 1 << 20, 64)
    expect(r.found).toEqual([])
  })

  it('a missing file has no markers, searched whole', async () => {
    expect(await findDeliveryMarkers(path.join(dir, 'none.jsonl'), ['qm-mobile-x'])).toEqual({ found: [], complete: true, size: 0, scanned: 0 })
  })
})

describe('validMarkerIds', () => {
  it('bounds the ids', () => {
    expect(validMarkerIds(['qm-mobile-a'])).toEqual(['qm-mobile-a'])
    expect(typeof validMarkerIds('qm-mobile-a')).toBe('string')
    expect(typeof validMarkerIds([''])).toBe('string')
    expect(typeof validMarkerIds(['x'.repeat(201)])).toBe('string')
    expect(typeof validMarkerIds([7])).toBe('string')
    expect(typeof validMarkerIds(Array.from({ length: MARKER_FIND_MAX_IDS + 1 }, (_, i) => `id-${i}`))).toBe('string')
  })
})
