/**
 * The mark before a message's thread line is one round stroke with an arrowhead, the same on the web
 * and the phone (2026-11-20, the user: "not this kind of like bit curved from 90", drawing a round U
 * that ends in an arrow). Fails when the curve gains a corner (a line or a quarter arc) or the two
 * clients draw different paths.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.join(__dirname, '../..')
const web = fs.readFileSync(path.join(ROOT, 'web/src/components/sessions/reply-thread-line.tsx'), 'utf8')
const ios = fs.readFileSync(path.join(ROOT, 'ios-native/Walnut/Timeline/TimelineRowBuilder.swift'), 'utf8')
const nums = (s: string) => [...s.replace(/controlPoint\d/g, '').matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]))

describe('the reply mark', () => {
  const fn = web.slice(web.indexOf('function ReplyArc'), web.indexOf('function TaskPart'))
  const [curve, head] = [...fn.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]!)

  it('is one stroke of cubics, no line and no quarter arc in it, then an arrowhead', () => {
    expect(curve).toMatch(/^M[\d. ]+( C[\d. ]+)+$/)
    expect(head).toMatch(/^M[\d. ]+ L[\d. ]+ L[\d. ]+$/)
  })

  it('stays inside its 12x12 box with the stroke, so neither client clips it', () => {
    const pts = nums(`${curve} ${head}`)
    for (const v of pts) { expect(v - 0.65).toBeGreaterThanOrEqual(0); expect(v + 0.65).toBeLessThanOrEqual(12) }
  })

  it('ends in an arrow pointing right, after a round bottom (variant B)', () => {
    const h = nums(head!)
    expect(h[2]! > h[0]! && h[2]! > h[4]!).toBe(true)
    expect(Math.abs(h[1]! + h[5]! - 2 * h[3]!)).toBeLessThan(0.5)
  })

  it('the phone draws the same path', () => {
    const body = ios.slice(ios.indexOf('static func replyArc'), ios.indexOf('let attachment = NSTextAttachment()'))
    expect(body).not.toMatch(/addArc\(/)
    // Swift lists each cubic as its end point, then its two control points.
    const [start, ...segs] = curve!.split(' C')
    const want = [...nums(start!), ...segs.flatMap((seg) => { const [a, b, c, d, e, f] = nums(seg); return [e, f, a, b, c, d] })]
    const swift = nums(body.slice(body.indexOf('curve.move'), body.indexOf('let head')).replace(/\* u/g, ''))
    expect(swift).toEqual(want)
    const swiftHead = nums(body.slice(body.indexOf('head.move'), body.indexOf('for path in')).replace(/\* u/g, ''))
    expect(swiftHead).toEqual(nums(head!))
  })
})
