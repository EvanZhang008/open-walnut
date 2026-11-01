/**
 * A task's status never reads Waiting on the user (2026-10-30, the user: waiting on them is Needs
 * you; 2026-11-01 org review: two finished tasks sat parked three days on "You, to read the result
 * and close it", off their list). Only Main and a lead wait on them, in their chat (they are never
 * Needs you), and a team the user stopped waits for their resume, as a snooze does.
 *
 * And the other side of the line: a wait whose next move is its lead's or another task's is
 * Waiting on it, whatever its words say of the user (a worker wrote "lead: ... it waits for your
 * call" and read Needs you while its lead held the same questions).
 *
 * Guard for the class: every input shape below, and every `kind: 'you'` the derive can return is
 * listed in the source scan with why it is allowed; a new one fails here.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DONE_ASK, deriveUserStatus, type StatusReport, type UserStatusInput, type WaitKind } from '../../src/core/user-status.js'
import { phaseForReport } from '../../src/core/sessions/report-phase.js'

const NOW = Date.parse('2026-11-01T03:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()

const reports: (StatusReport | null)[] = [
  null,
  { state: 'done', at: iso(NOW - 60_000), now: 'Shipped.' },
  { state: 'working', at: iso(NOW - 60_000) },
  { state: 'needs', at: iso(NOW - 60_000), ask: 'Pick A or B?' },
  ...(['you', 'outside', 'task', 'lead', 'machine', 'other', undefined] as (WaitKind | undefined)[])
    .map((k) => ({ state: 'waiting' as const, at: iso(NOW - 60_000), waiting_kind: k, waiting_on: 'the review, then your call' })),
]

function* inputs(): Generator<UserStatusInput> {
  for (const phase of ['TODO', 'IN_PROGRESS', 'NEED_ACTION', 'WAITING']) {
    for (const report of reports) {
      for (const hasLeader of [false, true]) {
        for (const processStatus of ['idle', 'stopped']) {
          for (const waitUntil of [null, iso(NOW + 3_600_000)]) {
            for (const triggers of [[], ['CR watch']]) {
              yield { phase, report, hasLeader, processStatus, hasSession: true, waitUntil, triggers, phaseChangedAt: iso(NOW - 120_000) }
            }
          }
        }
      }
    }
  }
}

describe('a task never waits on the user', () => {
  it('in any phase, report, lead, session, clock or trigger', () => {
    let n = 0
    for (const input of inputs()) {
      const s = deriveUserStatus(input, NOW)
      expect(s.state === 'waiting' && s.kind === 'you', JSON.stringify({ input, s })).toBe(false)
      n++
    }
    expect(n).toBeGreaterThan(500)
  })

  it('a finished top-level task is the user\'s to read and close, parked or not; a worker\'s is its lead\'s', () => {
    const done: StatusReport = { state: 'done', at: iso(NOW - 60_000) }
    for (const phase of ['NEED_ACTION', 'WAITING']) {
      expect(deriveUserStatus({ phase, report: done, hasSession: true, processStatus: 'stopped', phaseChangedAt: iso(NOW - 120_000) }, NOW))
        .toMatchObject({ state: 'needs', ask: DONE_ASK })
      expect(deriveUserStatus({ phase, report: done, hasLeader: true, hasSession: true, processStatus: 'stopped', phaseChangedAt: iso(NOW - 120_000) }, NOW))
        .toMatchObject({ state: 'waiting', kind: 'lead' })
    }
  })

  it('Main and a lead still wait on the user, in their chat, never Needs you', () => {
    for (const role of [{ isMain: true }, { isLead: true }]) {
      for (const input of inputs()) {
        expect(deriveUserStatus({ ...input, ...role }, NOW).state, JSON.stringify(input)).not.toBe('needs')
      }
    }
  })
})

describe('a wait on its lead or another task is Waiting on it', () => {
  it('whatever its words say of the user', () => {
    for (const kind of ['lead', 'task'] as const) {
      const r: StatusReport = { state: 'waiting', at: iso(NOW - 60_000), waiting_kind: kind, waiting_on: 'it brings you four questions; it waits for your call' }
      expect(phaseForReport(r, { parent_task_id: 'p' }, true), kind).toBe('WAITING')
      const s = deriveUserStatus({ phase: 'WAITING', report: r, hasLeader: true, hasSession: true, processStatus: 'idle', phaseChangedAt: iso(NOW - 120_000) }, NOW)
      expect(s, kind).toMatchObject({ state: 'waiting', kind })
    }
  })
})

describe('guard: every Waiting on the user the derive can return', () => {
  // Each `kind: 'you'` (or a kind that can be 'you') in user-status.ts, by the words beside it.
  const ALLOWED: Record<string, string> = {
    'Your next message, or news from its teams': 'Main or a lead: its question stays in its chat',
    'Its team was stopped': 'a team the user stopped waits for their resume, as a snooze does',
    "Its teams; its question to you is in its chat": 'orgNodeNeverNeeds: Main or a lead',
    'You, in its chat': 'orgNodeNeverNeeds: Main or a lead',
    'You or Walnut, in its chat': 'orgNodeNeverNeeds: Main or a lead',
  }
  it('no other site', async () => {
    const src = await fs.readFile(path.join(__dirname, '../../src/core/user-status.ts'), 'utf8')
    const lines = src.split('\n')
    const sites: string[] = []
    lines.forEach((l, i) => {
      if (/kind:\s*(?:'you'|[^,]*\?\s*'lead'\s*:\s*'you')/.test(l) || /kind:\s*'you',\s*waitingOn\s*\}/.test(l)) {
        const near = lines.slice(Math.max(0, i - 8), i + 2).join('\n')
        if (!Object.keys(ALLOWED).some((k) => near.includes(k))) sites.push(`${i + 1}: ${l.trim()}`)
      }
    })
    expect(sites, 'A new Waiting on the user: make it Needs you (state needs), or list it here with why').toEqual([])
  })
})
