/**
 * One decision shows once across a whole team, whatever the relation of the tasks that ask it
 * (src/core/same-ask.ts, same-ask-tree.ts; 2026-11-04, a VP's reflection after 874bac109: siblings
 * under one lead asked the same design decision, and an ask Main had already answered still waited
 * on the user).
 *
 * Every task of a fixture org that has one task of each relation (a subtask, a grandchild, siblings
 * under one task, top-level siblings in one project, cousins across a VP's two projects, a lead's own
 * subtask, Inbox tasks, a project no lead leads) asks the user the same question. The real statusOf
 * runs pass after pass, as the sync does, until nothing moves. Then no two tasks that are related
 * (one above the other, or teammates) both show it, and every task that does not show it waits on
 * one that does. A new kind of team key in teamKeysOf fails until this fixture covers it.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { statusOf, childrenByParent, completeStatusFacts, type StatusFacts } from '../../src/core/user-status-sync.js'
import { teamKeysOf, teammatesIndex } from '../../src/core/same-ask-tree.js'
import { askKey } from '../../src/core/same-ask.js'
import type { Task } from '../../src/core/types.js'

const ASK = 'Should the deploy handler wait for the plugin rollout?'
const T0 = '2026-11-04T09:00:00.000Z'
const NOW = Date.parse('2026-11-04T10:00:00.000Z')

let n = 0
function task(id: string, extra: Partial<Task> = {}): Task {
  n += 1
  const asks = !extra.org_role
  return {
    id, title: `Task ${id}`, phase: asks ? 'NEED_ACTION' : 'IN_PROGRESS', project: 'Garden', status: 'todo',
    created_at: `2026-11-0${1 + (n % 3)}T00:00:${String(n).padStart(2, '0')}.000Z`, phase_changed_at: T0,
    ...(asks ? { session_id: `sid-${id}`, status_report: { state: 'needs', ask: ASK, ask_own: { kind: 'user_own', why: 'He decides the design' }, at: '2026-11-04T09:30:00.000Z', rule: 2 } } : {}),
    ...extra,
  } as Task
}

const ORG: Task[] = [
  task('main', { org_role: 'main', project: '' }),
  task('vp', { org_role: 'lead', project: 'Garden', org_leads: ['Orchard'], parent_task_id: 'main' }),
  task('meadow-lead', { org_role: 'lead', project: 'Meadow', parent_task_id: 'main' }),
  task('top'), task('kid', { parent_task_id: 'top' }), task('grand', { parent_task_id: 'kid' }),
  task('kid2', { parent_task_id: 'top' }),
  task('side'),
  task('orchard', { project: 'Orchard' }), task('orchard-kid', { project: 'Orchard', parent_task_id: 'orchard' }),
  task('vp-worker', { parent_task_id: 'vp' }),
  task('meadow', { project: 'Meadow' }), task('meadow2', { project: 'Meadow' }),
  task('fallow', { project: 'Fallow' }), task('fallow2', { project: 'Fallow' }),
  task('inbox', { project: '' }), task('inbox2', { project: '' }),
]

function emptyFacts(tasks: readonly Task[]): StatusFacts {
  const facts: StatusFacts = {
    sessions: new Map(), letters: new Map(), choices: new Map(), requestsFrom: new Map(), triggers: new Map(),
    schedules: new Map(), titles: new Map(), sessionsOf: new Map(),
  }
  for (const t of tasks) {
    if (!t.session_id) continue
    facts.sessions.set(t.session_id, { processStatus: 'idle', taskId: t.id, startedAt: T0 })
    facts.sessionsOf.set(t.id, [t.session_id])
  }
  return facts
}

/**
 * The sync, pass after pass: each pass derives the tasks it covers from the statuses the last one
 * stored. `subset` picks the tasks of each pass (a dirty set, as the debounced sync runs); every
 * few passes cover all, as the minute sweep does.
 */
function settle(start: readonly Task[], subset?: (pass: number, t: Task) => boolean, sessions?: (t: Task) => string): Task[] {
  let tasks = start.map((t) => ({ ...t }))
  let quiet = 0
  for (let pass = 0; pass < 60; pass++) {
    const facts = emptyFacts(tasks)
    if (sessions) for (const t of tasks) if (t.session_id) facts.sessions.get(t.session_id)!.processStatus = sessions(t)
    completeStatusFacts(facts, tasks)
    facts.personInputAt = new Map()
    const childrenOf = childrenByParent(tasks)
    const sweep = !subset || pass % 4 === 3
    const next = tasks.map((t) => (sweep || subset!(pass, t) ? { ...t, user_status: statusOf(t, facts, childrenOf, NOW).status } : t))
    const moved = next.some((t, i) => JSON.stringify(t.user_status) !== JSON.stringify(tasks[i]!.user_status))
    tasks = next
    quiet = moved ? 0 : quiet + 1
    if (quiet >= (subset ? 4 : 1)) return tasks
  }
  throw new Error('the statuses never settled')
}

/** The invariant: no two related tasks show it, and every hidden ask leads to one that shows. */
function checkOnce(settled: readonly Task[]): void {
  const byId = new Map(settled.map((t) => [t.id, t]))
  const mates = teammatesIndex(settled)
  const asking = settled.filter((t) => !t.org_role)
  const shown = asking.filter((t) => t.user_status?.state === 'needs')
  for (const a of shown) for (const b of shown) {
    if (a.id >= b.id) continue
    expect(lineal(a, b, byId) || mates(a).some((m) => m.id === b.id), `${a.id} and ${b.id} both show the same ask`).toBe(false)
  }
  for (const t of asking.filter((x) => x.user_status?.state !== 'needs')) {
    let cur: Task | undefined = t
    for (let hops = 0; cur && cur.user_status?.state !== 'needs' && hops < 8; hops++) {
      expect(cur.user_status?.sameAsk?.id, `${cur.id} hides its ask with nothing to show it`).toBeTruthy()
      cur = byId.get(cur.user_status!.sameAsk!.id)
    }
    expect(cur?.user_status?.state, `${t.id}'s ask is shown nowhere`).toBe('needs')
  }
}

function lineal(a: Task, b: Task, byId: Map<string, Task>): boolean {
  const above = (x: Task, y: Task) => {
    let cur = x.parent_task_id ? byId.get(x.parent_task_id) : undefined
    for (let i = 0; cur && i < 12; i++) { if (cur.id === y.id) return true; cur = cur.parent_task_id ? byId.get(cur.parent_task_id) : undefined }
    return false
  }
  return above(a, b) || above(b, a)
}

describe('one decision shows once across a team', () => {
  const settled = settle(ORG)
  const byId = new Map(settled.map((t) => [t.id, t]))
  const asking = settled.filter((t) => !t.org_role)
  const shown = asking.filter((t) => t.user_status?.state === 'needs')
  const mates = teammatesIndex(settled)

  it('no two related tasks both show it', () => {
    for (const a of shown) {
      for (const b of shown) {
        if (a.id >= b.id) continue
        const related = lineal(a, b, byId) || mates(a).some((m) => m.id === b.id)
        expect(related, `${a.id} and ${b.id} both show the same ask`).toBe(false)
      }
    }
  })

  it('every task that does not show it waits on one that does', () => {
    for (const t of asking.filter((x) => x.user_status?.state !== 'needs')) {
      let cur: Task | undefined = t
      for (let hops = 0; cur && cur.user_status?.state !== 'needs' && hops < 6; hops++) {
        expect(cur.user_status?.sameAsk?.id, `${cur.id} hides its ask with nothing to show it`).toBeTruthy()
        cur = byId.get(cur.user_status!.sameAsk!.id)
      }
      expect(cur?.user_status?.state, `${t.id}'s ask is shown nowhere`).toBe('needs')
    }
  })

  it('the fixture covers each relation: one row for the VP\'s team, one per team outside it', () => {
    // The VP's two projects and its worker are one team; a project with no lead and the Inbox are a team per top-level task.
    expect(shown.filter((t) => ['top', 'kid', 'grand', 'kid2', 'side', 'orchard', 'orchard-kid', 'vp-worker'].includes(t.id))).toHaveLength(1)
    expect(shown.filter((t) => ['meadow', 'meadow2'].includes(t.id))).toHaveLength(1)
    expect(shown.filter((t) => ['fallow', 'fallow2', 'inbox', 'inbox2'].includes(t.id))).toHaveLength(4)
  })

  it('every kind of team key teamKeysOf makes is in the fixture', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/core/same-ask-tree.ts'), 'utf8')
    const body = src.slice(src.indexOf('export function teamKeysOf'), src.indexOf('/** A task that is in a team'))
    const kinds = new Set([...body.matchAll(/`([a-z]+):\$\{/g)].map((m) => m[1]))
    const KNOWN: Record<string, string> = {
      root: 'the top-level task it is under: siblings and cousins below one task (top, kid, kid2, grand), Inbox and lead-less projects one per top-level task',
      lead: 'a lead or VP above it or leading its project: siblings across a project (top, side), cousins across a VP\'s projects (orchard), a lead\'s own subtask (vp-worker)',
    }
    expect([...kinds].sort(), 'a new kind of team key: add tasks of it to ORG and say here what it groups').toEqual(Object.keys(KNOWN).sort())
    const leads = settled.filter((t) => t.org_role === 'lead')
    const made = new Set(asking.flatMap((t) => teamKeysOf(t, byId, leads).map((k) => k.split(':')[0])))
    for (const k of kinds) expect(made.has(k!), `no fixture task has a ${k} key`).toBe(true)
  })
})

describe('the order the sync runs in changes nothing', () => {
  it('passes over a few dirty tasks at a time settle on one row per team too', () => {
    for (const seed of [1, 7, 13, 29, 101]) {
      let x = seed
      const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648 }
      checkOnce(settle(ORG, () => rnd() < 0.3))
    }
  })

  it('a holder running a turn keeps its ask: nobody else takes it, and its turn end asking the same keeps it', () => {
    const first = settle(ORG)
    const team = ['top', 'kid', 'grand', 'kid2', 'side', 'orchard', 'orchard-kid', 'vp-worker']
    const holder = first.find((t) => team.includes(t.id) && t.user_status?.state === 'needs')!
    // Its turn starts (a re-check, a trigger, a peer): phase moves, the session runs.
    const running = settle(first.map((t) => (t.id === holder.id ? { ...t, phase: 'IN_PROGRESS', phase_changed_at: '2026-11-04T09:50:00.000Z' } as Task : t)),
      undefined, (t) => (t.id === holder.id ? 'running' : 'idle'))
    expect(running.filter((t) => team.includes(t.id) && t.user_status?.state === 'needs').map((t) => t.id), 'another took the ask while its holder worked').toEqual([])
    // The turn ends asking the same: the same task shows it again.
    const back = settle(running.map((t) => (t.id === holder.id ? { ...t, phase: 'NEED_ACTION', phase_changed_at: '2026-11-04T09:55:00.000Z',
      status_report: { ...t.status_report!, at: '2026-11-04T09:56:00.000Z' } } as Task : t)))
    expect(back.filter((t) => team.includes(t.id) && t.user_status?.state === 'needs').map((t) => t.id)).toEqual([holder.id])
  })

  it('a task bridging two teams never leaves an ask shown twice or nowhere', () => {
    // bridge: under top (root key with the VP team) but filed in Meadow (another lead's team).
    checkOnce(settle([...ORG, task('bridge', { project: 'Meadow', parent_task_id: 'top' })]))
  })
})

describe('an ask a lead, VP or Main answered for the user', () => {
  it('shows nowhere, and a teammate folded under it reads it answered', () => {
    // Answered after the folds were made (they are stamped at NOW).
    const answer = { key: askKey(ASK), ask: ASK, text: 'Yes, wait.', by: 'main', byTitle: 'Main', at: '2026-11-04T10:30:00.000Z' }
    const first = settle(ORG)
    const holder = first.find((t) => ['top', 'kid', 'grand', 'kid2', 'side', 'orchard', 'orchard-kid', 'vp-worker'].includes(t.id) && t.user_status?.state === 'needs')!
    const after = settle(first.map((t) => (t.id === holder.id ? { ...t, ask_answered: answer } : t)))
    const team = after.filter((t) => ['top', 'kid', 'grand', 'kid2', 'side', 'orchard', 'orchard-kid', 'vp-worker'].includes(t.id))
    expect(team.filter((t) => t.user_status?.state === 'needs').map((t) => t.id), 'an answered ask came back elsewhere in its team').toEqual([])
    expect(after.find((t) => t.id === holder.id)!.user_status).toMatchObject({ state: 'waiting', answeredFor: { by: 'main' } })
    // A teammate that asks it only now reads it answered there, never a new Needs you.
    const late = settle([...after, task('late', { project: 'Orchard', created_at: '2026-10-01T00:00:00.000Z' })])
    expect(late.find((t) => t.id === 'late')!.user_status).toMatchObject({ state: 'waiting', sameAsk: { id: holder.id, answered: true } })
  })
})
