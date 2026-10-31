/**
 * Needs you is only ever an individual task (2026-10-31, the user: "这个都是 individual task is needs
 * you ... We can choose talk to VP"). Main, a VP or a lead never stands as Needs you, whatever fact
 * would make an individual task ask the user (a prompt, an error, a letter, a Board choice, its own
 * ask, a NEED_ACTION phase), and no turn-end report moves it to NEED_ACTION. Every surface that
 * counts Needs you (Org, Board, Brief, task rows, the phone) reads the derived status, so the
 * derivation is the one place to hold it. Guard: the org roles are read from the source, so a new
 * role fails here until it is covered.
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
const flags = (role: OrgRole): Partial<UserStatusInput> => (role === 'main' ? { isMain: true } : { isLead: true })

// Each fact that makes an individual task ask the user.
const ASKING: Record<string, Partial<UserStatusInput>> = {
  prompt: { phase: 'IN_PROGRESS', processStatus: 'idle', pendingPermissionTool: 'Bash' },
  error: { phase: 'NEED_ACTION', processStatus: 'error', errorMessage: 'The CLI exited' },
  letter: { phase: 'NEED_ACTION', processStatus: 'idle', openLetter: 'Approve the send' },
  choice: { phase: 'NEED_ACTION', processStatus: 'idle', openChoice: 'Which design?', openChoiceAt: at },
  session: { phase: 'NEED_ACTION', processStatus: 'idle', report: { at, state: 'needs', ask: 'Pick one' } },
  phase: { phase: 'NEED_ACTION', processStatus: 'stopped' },
}

describe('no org node is ever Needs you', () => {
  it('reads the org roles from the source', () => expect(roles().sort()).toEqual(['lead', 'main']))

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
