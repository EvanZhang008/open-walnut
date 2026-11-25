/**
 * A host's update gap state (the build someone asked for, with what the asker said; since when a
 * build has been held; a capability needed) has ONE place per host: hostUpdateGap
 * (src/providers/daemon-update-gap.ts), read by every connection to the host on either path.
 *
 * 2026-11-25: the state lived on each DaemonConnection (`new UpdateGapHold()` as a field, handed to
 * its NetDaemonUpdater). An asked update was refused as busy, the link came back on a new connection
 * object, and that one's automatic decision held the asked build for the gap again: the ask was lost.
 * This fails when anything in src/ builds its own gap state again.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { hostUpdateGap, UpdateGapHold } from '../../src/providers/daemon-update-gap.js'

const SRC = path.resolve(import.meta.dirname, '../../src')
const PLACE = path.join(SRC, 'providers', 'daemon-update-gap.ts')

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return sources(p)
    return /\.(ts|tsx|mts)$/.test(e.name) ? [p] : []
  })
}

describe('the update gap state has one place per host', () => {
  it('nothing but hostUpdateGap builds an UpdateGapHold', () => {
    const builders = sources(SRC).filter((f) => /new\s+UpdateGapHold\b/.test(fs.readFileSync(f, 'utf8')))
    expect(builders.map((f) => path.relative(SRC, f))).toEqual([path.relative(SRC, PLACE)])
    const text = fs.readFileSync(PLACE, 'utf8')
    expect(text.match(/new\s+UpdateGapHold\b/g)).toHaveLength(1)
    const body = /export function hostUpdateGap\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(text)?.[1] ?? ''
    expect(body).toMatch(/new\s+UpdateGapHold\(\)/)
  })

  it('no update path takes a gap state handed in, and the connection reads the host\'s', () => {
    for (const file of ['providers/daemon-connection.ts', 'providers/daemon-net-update.ts']) {
      const text = fs.readFileSync(path.join(SRC, file), 'utf8')
      expect(text, file).toMatch(/hostUpdateGap\(/)
      expect(text, `${file} keeps no gap state of its own`).not.toMatch(/\bgap\??:\s*UpdateGapHold\b|_gap\s*=\s*/)
    }
  })

  it('every read of one host gets the same state, another host its own', () => {
    expect(hostUpdateGap('devbox')).toBe(hostUpdateGap('devbox'))
    expect(hostUpdateGap('devbox')).not.toBe(hostUpdateGap('studio-mac'))
    expect(hostUpdateGap('devbox')).toBeInstanceOf(UpdateGapHold)
    hostUpdateGap('devbox').ask('walnut-daemon-b', { overBusy: true })
    expect(hostUpdateGap('devbox').overBusy('walnut-daemon-b')).toBe(true)
    expect(hostUpdateGap('devbox').overBusy('walnut-daemon-c')).toBe(false)
    hostUpdateGap('devbox').ask('walnut-daemon-b')
    expect(hostUpdateGap('devbox').overBusy('walnut-daemon-b')).toBe(false)
    expect(hostUpdateGap('devbox').asked('walnut-daemon-b')).toBe(true)
  })
})
