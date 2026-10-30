/**
 * Ratchet: every code path that writes WAITING goes through the park gate (2026-10-30, the user:
 * "try to avoid until u are actually wait something like pipeline flowing, slack, or cr approval";
 * src/core/sessions/outside-wait.ts). A task parks only on a wait outside Walnut and the user; a
 * wait on the user's input, review or decision is Needs you.
 *
 * Scans src/ for a literal WAITING write (`phase: 'WAITING'`, `newPhase = 'WAITING'`, a
 * `? 'WAITING'` branch, `return 'WAITING'`, SQL `SET phase = 'WAITING'`) and fails on one no entry
 * below names, or on a listed file whose count moved. Each entry says which gate it goes through,
 * and the file must still carry that gate. A new path that parks a task either asks the gate
 * (outsideWaitEvidence / admitSessionPark / triggers that are not `watchesUser`) and is listed
 * here with it, or is not a park.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { triggersHoldWait, triggersStanding } from '../../src/core/task-wait-resume.js'
import { reportNamesOutsideWait, waitWordsNameUser } from '../../src/core/sessions/outside-wait.js'

const ROOT = path.resolve(__dirname, '../..')
const SRC = path.join(ROOT, 'src')

// Any assignment, object value, branch of a ternary or return of the literal; comparisons are not writes.
const WRITE_RE = /(?<![=!<>])=\s*['"]WAITING['"]|:\s*['"]WAITING['"]|\?\s*['"]WAITING['"]|\breturn\s+['"]WAITING['"]/g

/** The file without its comment lines (a doc line quoting a write is no write). */
function code(text: string): string {
  return text.split('\n').filter((l) => !/^\s*(?:\*|\/\/|\/\*)/.test(l)).join('\n')
}

interface Site { count: number; gate: string; mustContain: RegExp }

const SITES: Record<string, Site> = {
  'src/core/sessions/report-phase.ts': {
    count: 2, gate: 'a waiting report parks only on a named outside wait or outsideWaitEvidence; done parks on its lead',
    mustContain: /outsideWaitEvidence\(/,
  },
  'src/core/routines/trigger-api.ts': {
    count: 1, gate: 'a trigger parks its task only when it does not watch the user (`watches`)',
    mustContain: /const park = !watches &&/,
  },
  'src/core/phase.ts': {
    count: 3, gate: 'an interrupted wait, a standing routine and an idle reap come back only on triggers that are not watchesUser',
    mustContain: /resumableWait\(|triggersStanding\(/,
  },
  'src/core/session-health-monitor.ts': {
    count: 1, gate: 'an idle reap parks only on standingRoutineWaits (triggers that are not watchesUser)',
    mustContain: /standingRoutineWaits\(/,
  },
  'src/core/task-db.ts': {
    count: 1, gate: 'v12 migration: a live pre-0.5.2 `waiting` record becomes the phase once; no new park',
    mustContain: /migrateWaitingRecordsToPhase/,
  },
  'src/web/routes/api-v1.ts': {
    count: 1, gate: 'the phase_ignored answer for Main (no write); a session PATCH to WAITING asks admitSessionPark',
    mustContain: /admitSessionPark\(/,
  },
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out) } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

describe('every literal WAITING write goes through the park gate', () => {
  const found = new Map<string, number>()
  for (const file of walk(SRC)) {
    const n = (code(fs.readFileSync(file, 'utf8')).match(WRITE_RE) ?? []).length
    if (n) found.set(path.relative(ROOT, file), n)
  }

  it('no WAITING write outside the listed sites, and no listed count moved', () => {
    const unlisted = [...found.keys()].filter((f) => !SITES[f])
    expect(unlisted, `New WAITING write(s): route them through src/core/sessions/outside-wait.ts and list them here: ${unlisted.join(', ')}`).toEqual([])
    for (const [file, site] of Object.entries(SITES)) {
      expect(found.get(file) ?? 0, `${file}: ${site.gate}`).toBe(site.count)
    }
  })

  it('each listed site still carries its gate', () => {
    for (const [file, site] of Object.entries(SITES)) {
      expect(fs.readFileSync(path.join(ROOT, file), 'utf8'), `${file}: ${site.gate}`).toMatch(site.mustContain)
    }
  })

  it('the session PATCH asks the gate exactly when it writes WAITING', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/web/routes/api-v1.ts'), 'utf8')
    expect(src).toMatch(/if \(phase === 'WAITING'\) \{[\s\S]{0,400}admitSessionPark\(id, actor,/)
  })
})

// A phase from a request body is a write of whatever the caller names, WAITING included: every
// route that takes one asks the gate for a session caller, and so does the replay of a session's
// queued write (a phase the host journalled while the server was away).
describe('every phase a caller names goes through the park gate', () => {
  const GATED: Record<string, RegExp> = {
    'src/web/routes/api-v1.ts': /admitSessionPark\(/,
    'src/web/routes/tasks.ts': /admitSessionPark\([\s\S]*splitSessionParks\(|splitSessionParks\([\s\S]*admitSessionPark\(/,
    'src/web/routes/task-v1.ts': /splitSessionParks\(/,
    'src/core/offline-merge/apply-v2.ts': /admitSessionPark\(/,
  }
  it('each route that validates a phase from the body is gated', () => {
    const routes = walk(path.join(SRC, 'web')).filter((f) => /VALID_PHASES(?:_ARRAY)?\.(?:has|includes)\(/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f))
    const ungated = routes.filter((f) => !GATED[f])
    expect(ungated, `A route takes a phase from its caller without the park gate: ${ungated.join(', ')}`).toEqual([])
  })
  it('each gated path still carries its gate', () => {
    for (const [file, gate] of Object.entries(GATED)) expect(fs.readFileSync(path.join(ROOT, file), 'utf8'), file).toMatch(gate)
  })
})

describe('the gates', () => {
  it('a trigger on the user\'s ask never holds a wait', () => {
    expect(triggersHoldWait([{ state: 'armed', watchesUser: true }])).toBe(false)
    expect(triggersHoldWait([{ state: 'armed' }])).toBe(true)
    expect(triggersHoldWait([{ state: 'armed', watchesUser: true }, { state: 'armed' }])).toBe(true)
    expect(triggersStanding([{ state: 'armed', fires: 5, watchesUser: true }])).toBe(false)
    expect(triggersStanding([{ state: 'armed', fires: 5 }])).toBe(true)
  })

  it('a named wait is outside only when it is not the user', () => {
    expect(reportNamesOutsideWait({ state: 'waiting', waiting_kind: 'outside', waiting_on: 'the PR review' }, {})).toBe(true)
    expect(reportNamesOutsideWait({ state: 'waiting', waiting_kind: 'other', waiting_on: 'the PR review' }, {})).toBe(false)
    expect(reportNamesOutsideWait({ state: 'waiting', waiting_kind: 'lead' }, {})).toBe(false)
    expect(reportNamesOutsideWait({ state: 'waiting', waiting_kind: 'lead' }, { parent_task_id: 'l' })).toBe(true)
    expect(waitWordsNameUser('you: paste the meeting notes')).toBe(true)
    expect(waitWordsNameUser('User\uff1a a decision')).toBe(true)
    expect(waitWordsNameUser('the user-facing deploy')).toBe(false)
  })
})
