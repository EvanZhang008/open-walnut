/**
 * The home task panel's sections are the one user status (src/core/user-status.ts), as the
 * Org page, the Board and the phone read it. 2026-10-31, the user: Working held tasks whose
 * sessions had stopped hours to months ago and tasks nobody started ("你怎么计算是 need my
 * action? ... This thing's calculation is not right"), because the panel mapped a not-started
 * task to Working on its own.
 *
 * Checked: every user status the server can write (each state, each wait kind, snoozed or
 * not, on every phase) lands in the section of its state, and a Waiting row names why it
 * waits; the source of the panel decides a section only through stateSectionOf.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { Task } from '@open-walnut/core'
import { USER_STATES, type WaitKind } from '../../src/core/user-status'
import { readReason, stateSectionNoNeeds, stateSectionOf, statusSectionOf, waitingReason, STATUS_SECTION_ORDER } from '@/components/tasks/status-sections'
import { ICON_PHASE_TODO, ICON_PHASE_WAITING, ICON_SNOOZE, ICON_TO_READ, sectionRowIcon } from '@/components/common/Icons'

const ROOT = path.resolve(__dirname, '../..')
const PHASES = ['TODO', 'IN_PROGRESS', 'AGENT_COMPLETE', 'NEED_ACTION', 'WAITING'] as const

/** Every wait kind, read from the type's source, so a new kind is covered here at once. */
function waitKinds(): WaitKind[] {
  const src = fs.readFileSync(path.join(ROOT, 'src/core/user-status.ts'), 'utf8')
  const m = /export type WaitKind = ([^;]+);/.exec(src)
  expect(m, 'WaitKind is declared in src/core/user-status.ts').not.toBeNull()
  return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1] as WaitKind)
}

let n = 0
const fmt = (iso: string) => `at ${iso}`
const task = (patch: Partial<Task>): Task => ({
  id: `t${++n}`, title: `Task ${n}`, status: 'todo', phase: 'TODO', priority: 'none', project: 'Garden',
  created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z', ...patch,
} as Task)

describe('Home sections equal the user status', () => {
  const kinds = waitKinds()

  it('reads every wait kind from the source', () => {
    expect(kinds).toEqual(expect.arrayContaining(['not-started', 'stuck', 'time', 'task', 'you']))
  })

  it('every state, wait kind, snooze and phase lands in the section of its state', () => {
    const wrong: string[] = []
    for (const phase of PHASES) {
      for (const state of USER_STATES.filter((s) => s !== 'done')) {
        for (const kind of state === 'waiting' ? kinds : [undefined]) {
          for (const snoozed of [false, true]) {
            const us = { state, ...(kind ? { kind, waitingOn: 'Something' } : {}), ...(snoozed ? { snoozed: { until: '2099-01-01' } } : {}) } as Task['user_status']
            // The panel's own start-date read never overrides a derived status.
            const t = task({ phase, user_status: us, start_date: '2099-01-01' })
            const got = stateSectionOf(t, () => true)
            if (got !== state) wrong.push(`${phase} ${state}/${kind ?? '-'}${snoozed ? ' snoozed' : ''} -> ${got}`)
            if (statusSectionOf(t) !== state) wrong.push(`${phase} ${state}/${kind ?? '-'} drawn in ${statusSectionOf(t)}`)
          }
        }
      }
    }
    expect(wrong).toEqual([])
  })

  it('By project folds a parked or snoozed task; the rest of the open work is its to-do list', () => {
    const wrong: string[] = []
    for (const phase of PHASES) {
      for (const state of USER_STATES.filter((s) => s !== 'done')) {
        for (const kind of state === 'waiting' ? kinds : [undefined]) {
          for (const snoozed of [false, true]) {
            const us = { state, ...(kind ? { kind } : {}), ...(snoozed ? { snoozed: { until: '2099-01-01' } } : {}) } as Task['user_status']
            const got = stateSectionNoNeeds(task({ phase, user_status: us }))
            // Folded: Waiting by its status, or parked (the list never draws a parked row).
            if (got === 'waiting' && state !== 'waiting' && phase !== 'WAITING') wrong.push(`${phase} ${state}/${kind ?? '-'} folded`)
            // Kept in the list: open work, a to-do, a stopped task; never a parked one, unless its
            // own work goes on (Working, 2026-11-02: its build runs while it is parked on it).
            const stays = state === 'working' || state === 'read'
            if (got === 'working' && phase === 'WAITING' && !stays) wrong.push(`${phase} ${state}/${kind ?? '-'} in the list`)
            if (got !== 'working' && phase === 'WAITING' && stays && !snoozed) wrong.push(`${phase} ${state} parked folded`)
            if (got === 'done') wrong.push(`${phase} ${state} done`)
          }
        }
      }
    }
    expect(wrong).toEqual([])
  })

  it('By project folds a snoozed task only while Date reads Available now', () => {
    const t = task({ user_status: { state: 'waiting', kind: 'not-started', snoozed: { until: '2099-01-01' } } as Task['user_status'], start_date: '2099-01-01' })
    expect(stateSectionNoNeeds(t, () => true)).toBe('waiting')
    // Any other Date shows it in the list, so it is not in the fold too.
    expect(stateSectionNoNeeds(t)).toBe('working')
    // Flat keeps it under Waiting whatever Date reads: that is its user status.
    expect(stateSectionOf(t)).toBe('waiting')
  })

  it('a done task is Completed whatever its stored status', () => {
    for (const state of USER_STATES) {
      expect(stateSectionOf(task({ phase: 'COMPLETE', status: 'done', user_status: { state } as Task['user_status'] }))).toBe('done')
    }
  })

  it('every Waiting row says why it waits', () => {
    const silent: string[] = []
    for (const kind of kinds) {
      for (const snoozed of [false, true]) {
        const t = task({ user_status: { state: 'waiting', kind, ...(snoozed ? { snoozed: { until: '2099-01-01' } } : {}) } as Task['user_status'] })
        if (!waitingReason(t, fmt)) silent.push(`${kind}${snoozed ? ' snoozed' : ''}`)
      }
    }
    expect(silent).toEqual([])
    expect(waitingReason(task({ user_status: { state: 'waiting', kind: 'not-started', waitingOn: 'Not started yet' } as Task['user_status'] }), fmt)).toBe('Not started yet')
    expect(waitingReason(task({ user_status: { state: 'waiting', kind: 'stuck', waitingOn: 'It stopped, and nothing will wake it' } as Task['user_status'] }), fmt)).toBe('It stopped, and nothing will wake it')
    // A snoozed task says so, whatever it would wait on after (its date is on the row).
    expect(waitingReason(task({ user_status: { state: 'waiting', kind: 'not-started', waitingOn: 'Not started yet', snoozed: { until: '2099-01-01' } } as Task['user_status'] }), fmt)).toBe('Snoozed')
    expect(waitingReason(task({ phase: 'IN_PROGRESS', user_status: { state: 'working' } as Task['user_status'] }), fmt)).toBe('')
  })

  // 2026-11-02, the user: under Waiting / snoozed the rows wore the needs ring and "looks kike they
  // are waiting for my input", and finished results sat there too.
  it('To read is its own section right under Needs you, and an older stored status lands in it', () => {
    expect(STATUS_SECTION_ORDER.slice(0, 4)).toEqual(['watching', 'needs', 'read', 'working'])
    const older = task({ phase: 'NEED_ACTION', user_status: { state: 'waiting', kind: 'other', toRead: 'result', waitingOn: 'It finished, and its result is there to read' } as Task['user_status'] })
    expect(stateSectionOf(older)).toBe('read')
    expect(readReason(older)).toBe('It finished, and its result is there to read')
    const now = task({ phase: 'NEED_ACTION', user_status: { state: 'read', toRead: 'answer', waitingOn: 'It answered your message' } as Task['user_status'] })
    expect(stateSectionOf(now)).toBe('read')
    expect(readReason(now)).toBe('It answered your message')
    // Snoozed, it sleeps under Waiting / snoozed.
    expect(stateSectionOf(task({ phase: 'NEED_ACTION', user_status: { state: 'waiting', toRead: 'result', snoozed: { until: '2099-01-01' } } as Task['user_status'] }))).toBe('waiting')
  })

  it('a row wears its section\'s mark, never the phase\'s: no ring under Waiting / snoozed', () => {
    const wrong: string[] = []
    for (const phase of PHASES) {
      for (const snoozed of [false, true]) {
        const w = sectionRowIcon('waiting', false, phase, snoozed)
        if (w !== (snoozed ? ICON_SNOOZE : ICON_PHASE_WAITING)) wrong.push(`waiting ${phase}${snoozed ? ' snoozed' : ''}`)
        if (sectionRowIcon('read', false, phase, snoozed) !== ICON_TO_READ) wrong.push(`read ${phase}`)
        // Working: the open ring even while parked on its own build.
        if (sectionRowIcon('working', false, phase, false) !== ICON_PHASE_TODO) wrong.push(`working ${phase}`)
      }
    }
    expect(wrong).toEqual([])
    // Every section card draws its mark through sectionRowIcon (a new row kind fails here).
    const card = fs.readFileSync(path.join(ROOT, 'web/src/components/tasks/StatusSections.tsx'), 'utf8')
    expect(card).toContain('sectionRowIcon(sectionKey')
    expect(card).not.toMatch(/binaryPhaseIcon\(/)
  })

  it('the panel picks a section only through stateSectionOf (a ratchet of the places that name one)', () => {
    // Every place in the panel's source that hands back a state key by hand. A new one is a
    // second rule beside the user status: read stateSectionOf instead, or list it with why.
    const ALLOWED: Record<string, number> = {
      // stateSectionNoNeeds: a design with no Needs you section keeps a needs row in its list.
      'status-sections.ts': 1,
      // The exit grace keeps a leaving row where it was drawn (lastPlace), Working by default.
      'TodoPanel.tsx': 1,
      // The session pill's own state (a prompt waiting on the user), not a section.
      'SessionPill.tsx': 2,
    }
    const dir = path.join(ROOT, 'web/src/components/tasks')
    const found: Record<string, number> = {}
    for (const name of fs.readdirSync(dir)) {
      if (!/\.(ts|tsx)$/.test(name)) continue
      const text = fs.readFileSync(path.join(dir, name), 'utf8')
      const n = [...text.matchAll(/(?:\?|return|=>)\s*'(?:working|waiting|needs)'/g)].length
      if (n) found[name] = n
    }
    expect(found).toEqual(ALLOWED)
  })
})

