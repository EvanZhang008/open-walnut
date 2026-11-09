/**
 * Needs you is only ever an individual task (2026-10-31, the user: "这个都是 individual task is needs
 * you ... We can choose talk to VP"). Main, a VP or a lead never stands as Needs you, whatever fact
 * would make an individual task ask the user (a prompt, an error, a letter, a Board choice, its own
 * ask, a NEED_ACTION phase), and no turn-end report moves it to NEED_ACTION. Every surface that
 * counts Needs you (Org, Board, Brief, task rows, the phone) reads the derived status, so the
 * derivation is the one place to hold it. Guard: the org roles are read from the source, so a new
 * role fails here until it is covered.
 *
 * His own requests to a node are its Threads, and a thread waiting on him is no exception: the node
 * carries the counts and the Org page shows them as threads (2026-11-03, the user, after a thread
 * had made every VP read Needs you on each surface: "All replaced to Need Action which is the same
 * as the task status, is this right?"; before that: "thread is better than need u").
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deriveUserStatus, type UserStatusInput } from '../../src/core/user-status.js'
import { phaseForReport } from '../../src/core/sessions/report-phase.js'
import type { OrgRole } from '../../src/core/types.js'

const NOW = Date.parse('2026-10-31T18:00:00Z')
const at = new Date(NOW - 60_000).toISOString()
const roles = (): OrgRole[] => {
  const src = readFileSync(join(process.cwd(), 'src/core/types.ts'), 'utf8')
  const union = src.match(/export type OrgRole = ([^;]+);/)?.[1] ?? ''
  return [...union.matchAll(/'([a-z]+)'/g)].map((m) => m[1] as OrgRole)
}
// The Router reads as a lead does (user-status-sync.ts statusInput).
const flags = (role: OrgRole): Partial<UserStatusInput> => (role === 'main' ? { isMain: true } : { isLead: true })

// Each fact that makes an individual task ask the user.
const ASKING: Record<string, Partial<UserStatusInput>> = {
  prompt: { phase: 'IN_PROGRESS', processStatus: 'idle', pendingPermissionTool: 'Bash' },
  error: { phase: 'NEED_ACTION', processStatus: 'error', errorMessage: 'The CLI exited' },
  letter: { phase: 'NEED_ACTION', processStatus: 'idle', openLetter: 'Approve the send' },
  choice: { phase: 'NEED_ACTION', processStatus: 'idle', openChoice: 'Which design?', openChoiceAt: at },
  session: { phase: 'NEED_ACTION', processStatus: 'idle', report: { at, state: 'needs', ask: 'Pick one' } },
  // A bare NEED_ACTION asks nothing (2026-11-02: only a real ask reaches Needs you), so it is no case here.
}

describe('no org node is ever Needs you', () => {
  it('reads the org roles from the source', () => expect(roles().sort()).toEqual(['lead', 'main', 'router']))

  it('an individual task asks for each of these facts (the cases are real)', () => {
    for (const [name, facts] of Object.entries(ASKING)) {
      expect(deriveUserStatus({ hasSession: true, phaseChangedAt: at, ...facts }, NOW).state, name).toBe('needs')
    }
  })

  it('no org role stands as Needs you for any of them; its ask stays in its words', () => {
    for (const role of roles()) {
      for (const [name, facts] of Object.entries(ASKING)) {
        const s = deriveUserStatus({ hasSession: true, phaseChangedAt: at, ...facts, ...flags(role) }, NOW)
        expect(s.state, `${role} / ${name}`).not.toBe('needs')
      }
      const own = deriveUserStatus({ hasSession: true, phaseChangedAt: at, ...ASKING.session, ...flags(role) }, NOW)
      expect(own.waitingOn).toContain('Pick one')
    }
  })

  it('no turn-end report moves an org node to NEED_ACTION', () => {
    const reports = [
      { state: 'needs' }, { state: 'waiting', waiting_kind: 'you' }, { state: 'waiting', waiting_kind: 'other', waiting_on: 'something' },
      { state: 'waiting' }, { state: 'working' }, { state: 'done' },
    ] as const
    for (const role of roles()) {
      for (const r of reports) {
        for (const alive of [true, false]) {
          for (const armed of [true, false, 'unknown'] as const) {
            expect(phaseForReport(r, { org_role: role }, alive, armed), `${role} ${JSON.stringify(r)}`).not.toBe('NEED_ACTION')
          }
        }
      }
    }
    // An individual task still does.
    expect(phaseForReport({ state: 'needs' }, {}, true)).toBe('NEED_ACTION')
  })
})

describe('a Thread waiting on him is shown as threads, never as the node\'s Needs you', () => {
  const threads = { shown: 2, needs: 1, title: 'Pick a header design', id: 'th-1' }
  const base: Partial<UserStatusInput> = { hasSession: true, phaseChangedAt: at, phase: 'IN_PROGRESS', processStatus: 'idle' }

  it('every org role, whatever it is doing, carries the counts and is never Needs you', () => {
    for (const role of roles()) {
      for (const facts of [{}, { processStatus: 'running' }, ...Object.values(ASKING)]) {
        const s = deriveUserStatus({ ...base, ...facts, ...flags(role), threads }, NOW)
        expect(s.state, `${role} ${JSON.stringify(facts)}`).not.toBe('needs')
        expect(s.source).not.toBe('thread')
        expect(s.threads).toEqual(threads)
      }
    }
  })

  it('the thread is not its ask or its wait: those stay the node\'s own, so a new thread is no status move', () => {
    const one = deriveUserStatus({ ...base, isLead: true, threads }, NOW)
    const other = deriveUserStatus({ ...base, isLead: true, threads: { ...threads, needs: 3, title: 'Another pick' } }, NOW)
    expect(one.waitingOn).toBe(other.waitingOn)
    // The title rides only in its threads count, never in the node's own words.
    const { threads: _counts, ...own } = one
    expect(JSON.stringify(own)).not.toContain('Pick a header design')
  })

  it('threads that only show an answer carry the counts the same way', () => {
    const shown = { shown: 1, needs: 0, title: 'What changed', id: 'th-2' }
    for (const role of roles()) {
      const s = deriveUserStatus({ ...base, ...ASKING.letter, ...flags(role), threads: shown }, NOW)
      expect(s.state).not.toBe('needs')
      expect(s.threads).toEqual(shown)
    }
  })

  it('an individual task never reads threads, and a done node stays done', () => {
    expect(deriveUserStatus({ ...base, threads }, NOW).threads).toBeUndefined()
    expect(deriveUserStatus({ ...base, isMain: true, phase: 'COMPLETE', threads }, NOW).state).toBe('done')
  })

  it('a snoozed node sleeps under Waiting, its threads still counted', () => {
    const s = deriveUserStatus({ ...base, isLead: true, threads, snoozedUntil: '2026-11-06' }, NOW)
    expect(s.state).toBe('waiting')
    expect(s.threads).toEqual(threads)
  })
})
