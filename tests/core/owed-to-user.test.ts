/**
 * A task is not closed while it still holds something for the user (src/core/sessions/owed-to-user.ts;
 * 2026-11-02: a task closed with its own Progress still saying the user had to resubmit a form by the
 * next day, and Main told the user it was done).
 *
 * The pure reads, and two ratchets: every kind of Needs you the one status gives is named in
 * OWED_STATUS_SOURCES, and every session-reachable close goes through the gate.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { OWED_STATUS_SOURCES, namesUser, statusAskItem, userNameOf, userProgressItems } from '../../src/core/sessions/owed-to-user.js'
import { extractProgressLines } from '../../src/core/task-progress.js'
import { deriveUserStatus, type UserStatus } from '../../src/core/user-status.js'
import { phaseForReport } from '../../src/core/sessions/report-phase.js'
import { isPartial, partialLine } from '../../src/core/peers/structured-reply.js'

const ROOT = path.resolve(__dirname, '../..')
const code = (text: string) => text.split('\n').filter((l) => !/^\s*(?:\*|\/\/|\/\*)/.test(l)).join('\n')

const NOTE = `## Executive Summary
Release questions answered.

## Progress
- [DONE] Garden plan: raised beds, confirmed by Robin.
- [TODO] Robin: Seed shop > Spring order > "Order max" > resubmit by 2026-11-03.
- [TODO] Robin, next year: call the nursery about stock and price.
- [TODO] You: approve the release
- [WAIT] Waits on: the user's decision on the host
- [TODO] Ship the user-status fix
- [TODO] Tell Robin the result
- [WIP] Rerun the comparison for your sign-in page
- [BLOCKED] Robinson report import

## Work Log
- did: nothing more
`

describe('what of the Progress is the user\'s', () => {
  it('reads the user\'s first name from the Identity section of their profile', () => {
    expect(userNameOf('# USER.md\n\n## Identity\nRobin, software engineer. Personal project: a garden.\n')).toBe('Robin')
    expect(userNameOf('## Identity\nRobin \u2014 designer\n')).toBe('Robin')
    expect(userNameOf('## Identity\nSoftware engineer who likes gardens.\n')).toBeUndefined()
    expect(userNameOf('## Identity\n\nThe user is a designer.\n')).toBeUndefined()
    expect(userNameOf('## Language\nEnglish\n')).toBeUndefined()
  })

  it('an open item for the user or waiting on them is theirs; a done one, or one that only mentions them, is not', () => {
    expect(userProgressItems(NOTE, 'Robin', extractProgressLines)).toEqual([
      '[TODO] Robin: Seed shop > Spring order > "Order max" > resubmit by 2026-11-03.',
      '[TODO] Robin, next year: call the nursery about stock and price.',
      '[TODO] You: approve the release',
      '[WAIT] Waits on: the user\'s decision on the host',
    ])
    // Without a recorded name only the plain words count.
    expect(userProgressItems(NOTE, undefined, extractProgressLines)).toHaveLength(2)
    expect(userProgressItems(null, 'Robin', extractProgressLines)).toEqual([])
  })

  it('a line that only mentions the user, or contains the name, is not theirs', () => {
    expect(namesUser('Robinson report import', 'Robin')).toBe(false)
    expect(namesUser('Ship the user-status fix', 'Robin')).toBe(false)
    expect(namesUser('Tell Robin the result', 'Robin')).toBe(false)
    expect(namesUser('Your sign-in on the phone', undefined)).toBe(false)
    expect(namesUser('Check what you asked for', undefined)).toBe(false)
    expect(namesUser('You, Robin: resubmit it', 'Robin')).toBe(true)
    expect(namesUser('The user: pick a name', undefined)).toBe(true)
    expect(namesUser('Waiting for Robin to sign in', 'Robin')).toBe(true)
    expect(namesUser('Waits on you', undefined)).toBe(true)
    expect(namesUser('Waiting on the user-service deploy', undefined)).toBe(false)
    expect(namesUser('Waits for the user-facing review', undefined)).toBe(false)
  })
})

describe('the ask its status makes', () => {
  const s = (v: Partial<UserStatus>) => v as UserStatus
  it('a Needs you ask is owed, a failure is not, a snoozed ask still is', () => {
    expect(statusAskItem(s({ state: 'needs', source: 'session', ask: 'Pick the name' }))).toBe('Pick the name')
    expect(statusAskItem(s({ state: 'needs', source: 'letter', ask: 'Answer the letter' }))).toBe('Answer the letter')
    expect(statusAskItem(s({ state: 'needs', source: 'error', ask: 'It failed: restart it' }))).toBeUndefined()
    expect(statusAskItem(s({ state: 'waiting', kind: 'time', snoozed: { until: '2026-11-13', ask: 'Sign in on the phone' } }))).toBe('Sign in on the phone')
    expect(statusAskItem(s({ state: 'working' }))).toBeUndefined()
    expect(statusAskItem(s({ state: 'read', toRead: 'result' }))).toBeUndefined()
  })

  it('every kind of Needs you the one status gives is named, with whether a close owes it', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/core/user-status.ts'), 'utf8')
    const union = /^\s*source\?:\s*((?:'[a-z_]+'\s*\|?\s*)+);/m.exec(src)?.[1]
    expect(union, 'UserStatus.source not found in user-status.ts').toBeTruthy()
    const members = [...union!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()
    expect(Object.keys(OWED_STATUS_SOURCES).sort(), 'A new kind of Needs you: say in OWED_STATUS_SOURCES whether a close owes it').toEqual(members)
  })
})

describe('a hold stays until it is settled, whatever a later turn reports', () => {
  const owed = { items: ['You: resubmit the form'], ask: 'Left for you when this task was closed: 1) You: resubmit the form', at: '2026-11-02T10:00:00.000Z', by: 'task:t1' }
  const later = '2026-11-02T10:05:00.000Z'

  it('its status reads Needs you with the hold\'s ask after a done, a waiting or a to-read turn', () => {
    for (const report of [
      { state: 'done', at: later },
      { state: 'waiting', waiting_kind: 'outside', waiting_on: 'CI', at: later },
      { state: 'waiting', waiting_kind: 'lead', waiting_on: 'its lead', at: later },
    ] as const) {
      for (const phase of ['NEED_ACTION', 'WAITING', 'IN_PROGRESS'] as const) {
        const s = deriveUserStatus({ phase, hasSession: true, processStatus: 'idle', hasLeader: true, phaseChangedAt: '2026-11-02T10:00:01.000Z', report: report as never, owedHold: { ask: owed.ask, at: owed.at } })
        expect(s.state, `${phase} ${report.state}`).toBe('needs')
        expect(s.ask).toBe(owed.ask)
      }
    }
  })

  it('a running turn still reads Working; Main and a lead are never held; a settled hold is gone', () => {
    expect(deriveUserStatus({ phase: 'IN_PROGRESS', hasSession: true, processStatus: 'running', owedHold: { ask: owed.ask, at: owed.at } }).state).toBe('working')
    expect(deriveUserStatus({ phase: 'NEED_ACTION', hasSession: true, processStatus: 'idle', isLead: true, owedHold: { ask: owed.ask, at: owed.at } }).state).not.toBe('needs')
    expect(deriveUserStatus({ phase: 'COMPLETE', owedHold: { ask: owed.ask, at: owed.at } }).state).toBe('done')
  })

  it('a later turn\'s report keeps it on NEED_ACTION, except while its own work runs', () => {
    const task = { parent_task_id: 'lead1', result_report: { via: 'complete' as const, at: owed.at, not_done: owed.items, owed } }
    expect(phaseForReport({ state: 'done' }, task, true)).toBe('NEED_ACTION')
    expect(phaseForReport({ state: 'waiting', waiting_kind: 'outside', waiting_on: 'CI' }, task, true, true)).toBe('NEED_ACTION')
    expect(phaseForReport({ state: 'working' }, task, true)).toBe('IN_PROGRESS')
    const settled = { ...task, result_report: { ...task.result_report, owed: { ...owed, settled: { at: later, how: 'dropped' as const } } } }
    expect(phaseForReport({ state: 'done' }, settled, true)).toBe('WAITING')
  })

  it('an open hold is Partial with its items; a settled one with no own items is not', () => {
    expect(isPartial({ owed })).toBe(true)
    expect(partialLine({ owed })).toBe('Partial: You: resubmit the form')
    expect(isPartial({ owed: { ...owed, settled: { at: later, how: 'dropped' } } })).toBe(false)
    expect(isPartial({ not_done: ['iOS not tested'], owed: { ...owed, settled: { at: later, how: 'dropped' } } })).toBe(true)
  })
})

// ── Every session-reachable close goes through the gate ──

/**
 * A close of a task: a core call that writes COMPLETE, a literal COMPLETE phase write, or a route's
 * branch to COMPLETE. Reads of the same words count too, so a file that only reads is listed with why.
 */
const CLOSE_RE = /\b(?:completeTask|toggleComplete|setPhaseBulk)\(|phase: 'COMPLETE'|\bif \((?:req\.body\.)?phase === 'COMPLETE' \|\||\?\.value === 'COMPLETE'/g
const GATE_RE = /\b(?:admitSessionClose|splitSessionCloses|owedToUser)\(/g

/**
 * Every file of src that closes tasks (or reads like it), with its counts. A file whose gates are
 * fewer than its closes says why none is needed: no session can reach that close.
 */
const SITES: Record<string, { closes: number; gates: number; why?: string }> = {
  'src/web/routes/task-v1.ts': { closes: 2, gates: 2 },
  'src/web/routes/tasks.ts': { closes: 4, gates: 4 },
  'src/web/routes/api-v1.ts': { closes: 1, gates: 1 },
  'src/core/offline-merge/apply-v2.ts': { closes: 1, gates: 1 },
  'src/core/transfer/transfer.ts': { closes: 1, gates: 1 },
  'src/core/pull-requests/pr-watch.ts': { closes: 1, gates: 1 },
  'src/core/task-manager.ts': { closes: 3, gates: 0, why: 'the definitions every route above calls; the gate sits in the route, where the caller is known' },
  'src/core/user-status.ts': { closes: 2, gates: 0, why: 'reads a phase, writes none' },
  'src/core/sessions/session-send-core.ts': { closes: 1, gates: 0, why: 'an error detail naming a COMPLETE target, no write' },
  'src/providers/offline-host-core.ts': { closes: 5, gates: 0, why: 'the offline host reads whether a task is COMPLETE; a queued close replays through apply-v2.ts, which is gated' },
  'src/replica/write-port.ts': { closes: 1, gates: 0, why: 'queues the close for the leader, which replays it through apply-v2.ts (gated)' },
  'src/commands/direct-commands.ts': { closes: 1, gates: 0, why: 'the CLI\'s own `done`, typed by a person at a terminal' },
  'src/web/routes/sessions.ts': { closes: 1, gates: 0, why: 'executing a plan, a person\'s click: the plan task\'s work moves to the task carrying it out' },
  'src/core/sessions/session-rewind.ts': { closes: 1, gates: 0, why: 'a person\'s rewind: the work continues in the rewound task' },
  'src/core/sessions/external-session-import.ts': { closes: 1, gates: 0, why: 'an imported terminal session idle for days, closed by the importer, never by a session' },
  'src/core/org/handover-close.ts': { closes: 1, gates: 0, why: 'an org handover closing the old lead, never an individual task\'s work' },
  'src/core/org/org-store.ts': { closes: 1, gates: 0, why: 'retiring an org lead that never talked: an org node, never held' },
  'src/core/routines/run-close.ts': { closes: 1, gates: 0, why: 'a routine run closing itself after its result; its asks are its letters, sent before' },
  'src/core/triage/runs.ts': { closes: 2, gates: 0, why: 'an inbox triage run closing itself; its asks are its own letters' },
  'src/core/plugins/server-api.ts': { closes: 1, gates: 0, why: 'a plugin\'s own task close through its API, no session caller' },
  'src/integrations/microsoft-todo.ts': { closes: 1, gates: 0, why: 'a sync pull: the list was deleted on the remote service' },
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out); else if (/\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

describe('every session-reachable close asks what the user still has', () => {
  const found = new Map<string, { closes: number; gates: number }>()
  for (const f of walk(path.join(ROOT, 'src'))) {
    const text = code(fs.readFileSync(f, 'utf8'))
    const closes = (text.match(CLOSE_RE) ?? []).length
    if (closes) found.set(path.relative(ROOT, f), { closes, gates: (text.match(GATE_RE) ?? []).length })
  }

  it('no file closes a task outside the listed ones', () => {
    const extra = [...found.keys()].filter((f) => !SITES[f])
    expect(extra, 'A new path closes a task: send a session caller through admitSessionClose (core/sessions/owed-to-user.ts), or say why no session reaches it, and list it here').toEqual([])
  })

  it('each listed file holds a gate for every close it makes, or says why it needs none, and its counts are current', () => {
    for (const [f, want] of Object.entries(SITES)) {
      const got = found.get(f) ?? { closes: 0, gates: 0 }
      expect(got, f).toEqual({ closes: want.closes, gates: want.gates })
      if (got.gates < got.closes) expect(want.why, `${f}: a close without the gate and no reason`).toBeTruthy()
    }
  })
})
