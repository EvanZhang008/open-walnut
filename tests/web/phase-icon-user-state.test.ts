/**
 * A task's toggle icon reads its one user status, never the phase alone (2026-11-02, the user, on a
 * task parked on its own build that wore the hourglass in its session header: "look htis one is
 * runing why it is in wait? ... if it is runnig it shoud be i progress right?").
 *
 * Guards for the class: every call of `binaryPhaseIcon` in web/src passes the task's user state
 * (a new row that draws a wait from the phase alone fails here), and the hourglass is drawn only
 * for a parked task that really waits: never for one whose own work runs (Working) or one with only
 * a result to read (To read).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { binaryPhaseIcon, sectionRowIcon, ICON_PHASE_WAITING, ICON_PHASE_TODO, ICON_SNOOZE } from '../../web/src/components/common/Icons'

const WEB_SRC = path.resolve(__dirname, '../../web/src')

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return sourceFiles(p)
    return /\.(tsx?|jsx?)$/.test(e.name) ? [p] : []
  })
}

/** The argument list of each call `name(...)` in `src`, split at its top-level commas. */
function callArgs(src: string, name: string): string[][] {
  const out: string[][] = []
  const re = new RegExp(`\\b${name}\\(`, 'g')
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const before = src.slice(Math.max(0, m.index - 16), m.index)
    if (/function\s+$/.test(before)) continue
    let depth = 0
    let cur = ''
    const args: string[] = []
    for (let i = m.index + m[0].length; i < src.length; i++) {
      const c = src[i]
      if (depth === 0 && c === ')') { args.push(cur.trim()); break }
      if (depth === 0 && c === ',') { args.push(cur.trim()); cur = ''; continue }
      if ('([{'.includes(c)) depth++
      if (')]}'.includes(c)) depth--
      cur += c
    }
    out.push(args)
  }
  return out
}

describe('the toggle icon reads the user status', () => {
  it('every binaryPhaseIcon call in web/src passes the task\'s user state', () => {
    const calls = sourceFiles(WEB_SRC).flatMap((f) =>
      callArgs(fs.readFileSync(f, 'utf8'), 'binaryPhaseIcon').map((args) => ({ file: path.relative(WEB_SRC, f), args })))
    // The rows that draw it (search results, focus cards, the task table, the Home rows, the
    // leader flyout, the session header, the status sections).
    expect(calls.length).toBeGreaterThanOrEqual(8)
    const missing = calls.filter((c) => c.args.length < 3 || !c.args[2] || c.args[2] === 'undefined')
    expect(missing).toEqual([])
  })

  it('the hourglass is a real wait only', () => {
    expect(binaryPhaseIcon(false, 'WAITING', 'waiting')).toBe(ICON_PHASE_WAITING)
    expect(binaryPhaseIcon(false, 'WAITING', undefined)).toBe(ICON_PHASE_WAITING)
    expect(binaryPhaseIcon(false, 'WAITING', 'working')).toBe(ICON_PHASE_TODO)
    expect(binaryPhaseIcon(false, 'WAITING', 'read')).toBe(ICON_PHASE_TODO)
    expect(binaryPhaseIcon(false, 'IN_PROGRESS', 'working')).toBe(ICON_PHASE_TODO)
  })

  it('a watched task wears its own state\'s mark', () => {
    expect(sectionRowIcon('watching', false, 'WAITING', false, 'working')).toBe(ICON_PHASE_TODO)
    expect(sectionRowIcon('watching', false, 'WAITING', false, 'waiting')).toBe(ICON_PHASE_WAITING)
    expect(sectionRowIcon('waiting', false, 'WAITING', true, 'waiting')).toBe(ICON_SNOOZE)
  })
})
