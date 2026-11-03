/**
 * Every lifecycle wait has an end (src/core/sessions/lifecycle-waits.ts). 2026-11-03: a stop the
 * host never confirmed blocked its session for good, and a task's move stayed pending 1 h 50 min
 * because the turn's background command kept the session `running` and only a status event could
 * start it. This ratchet:
 *  - checks each listed wait against its file: the file exists and defines every limit it names;
 *  - finds the waits in the source and fails on one not listed: every `new TurnEndWait(` (the shared
 *    turn-end wait), and every module that listens for a session's status leaving `running` with a
 *    hand-rolled subscriber (a wait with no poll and no deadline, the shape of both bugs);
 *  - checks the shared wait's verdicts: free runs, background work runs after its grace, anything
 *    else past the limit expires, an unreadable ask time never waits.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { LIFECYCLE_WAITS, TURN_END_OBSERVERS } from '../../../src/core/sessions/lifecycle-waits.js'
import { turnEndVerdict, TURN_END_WAITERS } from '../../../src/core/sessions/turn-end-wait.js'

const ROOT = path.resolve(__dirname, '../../..')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...sourceFiles(rel))
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(rel)
  }
  return out
}

const SRC = sourceFiles('src').map((f) => ({ file: f, text: fs.readFileSync(path.join(ROOT, f), 'utf8') }))
const listedFiles = new Set(LIFECYCLE_WAITS.map((w) => w.file))

describe('lifecycle waits', () => {
  it('each listed wait names its file and the limits that file defines', () => {
    const ids = new Set<string>()
    for (const w of LIFECYCLE_WAITS) {
      expect(ids.has(w.id), `duplicate id ${w.id}`).toBe(false)
      ids.add(w.id)
      const abs = path.join(ROOT, w.file)
      expect(fs.existsSync(abs), `${w.id}: ${w.file} does not exist`).toBe(true)
      const text = fs.readFileSync(abs, 'utf8')
      expect(w.limits.length, `${w.id} names no limit`).toBeGreaterThan(0)
      for (const c of w.limits) {
        expect(new RegExp(`\\b${c}\\b\\s*[:=]`).test(text), `${w.id}: ${c} is not defined in ${w.file}`).toBe(true)
      }
      expect(w.atEnd.length, `${w.id} says nothing about its end`).toBeGreaterThan(10)
    }
  })

  it('every TurnEndWait in the source is listed', () => {
    const users = SRC.filter((s) => /new TurnEndWait\b/.test(s.text)).map((s) => s.file)
    expect(users.length).toBeGreaterThanOrEqual(4)
    for (const f of users) expect(listedFiles.has(f), `${f} makes a TurnEndWait but is not in LIFECYCLE_WAITS`).toBe(true)
  })

  it('no module hand-rolls a wait for a session\'s turn to end', () => {
    // The shape of both bugs: a subscriber on the status event that acts once it leaves `running`.
    const rolled = SRC.filter((s) => /SESSION_STATUS_CHANGED/.test(s.text)
      && /bus\.subscribe\(/.test(s.text)
      && /process_status\s*[!=]==\s*['"]running['"]/.test(s.text)
      && !/new TurnEndWait\b/.test(s.text))
      .map((s) => s.file)
    const unknown = rolled.filter((f) => !(f in TURN_END_OBSERVERS))
    expect(unknown, 'a new turn-end wait: use TurnEndWait (src/core/sessions/turn-end-wait.ts) and list it in LIFECYCLE_WAITS, or list an observer in TURN_END_OBSERVERS with why').toEqual([])
    // An observer that is gone leaves the list.
    for (const f of Object.keys(TURN_END_OBSERVERS)) expect(fs.existsSync(path.join(ROOT, f)), `${f} is gone`).toBe(true)
  })

  it('every turn-end waiter has finite limits', async () => {
    for (const w of LIFECYCLE_WAITS.filter((x) => SRC.find((s) => s.file === x.file && /new TurnEndWait\b/.test(s.text)))) {
      await import(path.join(ROOT, w.file))
    }
    expect([...TURN_END_WAITERS.keys()].sort()).toEqual(['engine-switch-turn-end', 'org-handover-close', 'self-complete-stop', 'team-stop-turn-end'])
    for (const [name, l] of TURN_END_WAITERS) {
      expect(Number.isFinite(l.maxMs) && l.maxMs > 0, `${name} maxMs`).toBe(true)
      expect(Number.isFinite(l.backgroundGraceMs) && l.backgroundGraceMs > 0, `${name} backgroundGraceMs`).toBe(true)
    }
  })

  it('the shared verdicts: free runs, background runs after its grace, the rest expires at the limit', () => {
    const limits = { backgroundGraceMs: 100, maxMs: 1_000 }
    expect(turnEndVerdict({ hold: 'free', askedAt: 0, now: 0, limits })).toBe('run')
    expect(turnEndVerdict({ hold: 'turn', askedAt: 0, now: 999, limits })).toBe('wait')
    expect(turnEndVerdict({ hold: 'turn', askedAt: 0, now: 1_000, limits })).toBe('expire')
    expect(turnEndVerdict({ hold: 'queue', askedAt: 0, now: 1_000, limits })).toBe('expire')
    expect(turnEndVerdict({ hold: 'background', askedAt: 0, backgroundSince: 50, now: 149, limits })).toBe('wait')
    expect(turnEndVerdict({ hold: 'background', askedAt: 0, backgroundSince: 50, now: 150, limits })).toBe('run-over-background')
    expect(turnEndVerdict({ hold: 'turn', askedAt: Number.NaN, now: 0, limits })).toBe('expire')
  })
})
