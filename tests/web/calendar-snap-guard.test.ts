/**
 * Every time picked by pointer on the calendar grid lands on a quarter hour, through one snap
 * (gridSnapMinute in web/src/components/calendar/calendar-grid-settings.ts).
 *
 * 2026-11-21, Evan: "why I can drag start at xx:15 can only start at 00or 30". A chip moved and
 * resized snapped to 15 minutes, but a new block clicked or dragged out, the right-click menu and
 * a task dropped from a list each rounded on their own to the 30-minute rows. A new place that
 * rounds a grid time by itself fails here.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { gridSnapMinute, gridSnappedMinuteAt } from '../../web/src/components/calendar/calendar-grid-settings'
import { SNAP_MINUTES } from '../../web/src/utils/calendar-date'

const WEB = path.resolve(import.meta.dirname, '../../web/src')
const SNAP_HOME = 'components/calendar/calendar-grid-settings.ts'

function sources(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...sources(full))
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(full)
  }
  return out
}

describe('the calendar grid has one snap, a quarter hour', () => {
  it('no file rounds a grid time to the rows or the snap by itself', () => {
    const found: string[] = []
    for (const file of sources(WEB)) {
      const rel = path.relative(WEB, file)
      if (rel === SNAP_HOME) continue
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (/Math\.(round|floor|ceil)\(/.test(line) && /\b(SLOT|SNAP)_MINUTES\b/.test(line)) found.push(`${rel}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(found, `round grid times with gridSnapMinute (${SNAP_HOME})`).toEqual([])
  })

  it('the snap takes no quantum of its own (a call cannot pick the 30-minute rows)', () => {
    expect(gridSnapMinute.length).toBe(2)
  })

  it('lands on :00, :15, :30 and :45, and a pointer maps the same way everywhere', () => {
    expect(SNAP_MINUTES).toBe(15)
    expect([600, 607, 608, 622, 638, 653].map((m) => gridSnapMinute(m, 1440))).toEqual([600, 600, 615, 615, 645, 660])
    // 24 px per 30-minute row, the grid starting at 7:00: 5 px is 7:06, 14 px 7:17, 40 px 7:50.
    expect(gridSnappedMinuteAt(5, 420, 1440, 24)).toBe(420)
    expect(gridSnappedMinuteAt(14, 420, 1440, 24)).toBe(435)
    expect(gridSnappedMinuteAt(40, 420, 1440, 24)).toBe(465)
    // Above the grid's first minute it holds at the first minute.
    expect(gridSnappedMinuteAt(-30, 420, 1440, 24)).toBe(420)
  })
})
