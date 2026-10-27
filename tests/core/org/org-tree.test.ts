/**
 * The org above the work is DERIVED from the board (src/core/org/org-tree.ts):
 * who reports to whom, who the main agent talks to per project, and the short
 * update note. Pinned here because the server (GET /api/v1/org, the main
 * agent's note) and the browser (the org chart) read the same function, and
 * each rule has a quiet failure: a conversation counted as work, a lead made
 * for the Inbox, a note that lists every project on every message.
 */
import { describe, it, expect } from 'vitest'
import {
  DIGEST_FOLD_MS, buildOrgTree, findProjectNode, formatAlertLine, formatDigestLine, isOrgMember, leadsAlso, orgDigest, pickLead, pickMain,
  pickOwnLead, planOrgNote, type OrgAlert, type OrgTaskLike,
} from '../../../src/core/org/org-tree.js'
import * as viaAlias from '@open-walnut/org-tree'
import { isAskTask } from '../../../src/core/sessions/caller-placement.js'

let n = 0
function t(over: Partial<OrgTaskLike> & { title?: string }): OrgTaskLike {
  n++
  return {
    id: over.id ?? `t${n}`,
    title: over.title ?? `task ${n}`,
    phase: over.phase ?? 'TODO',
    created_at: over.created_at ?? `2026-10-01T00:00:${String(n % 60).padStart(2, '0')}Z`,
    updated_at: over.updated_at ?? `2026-10-01T00:00:${String(n % 60).padStart(2, '0')}Z`,
    ...over,
  }
}

describe('org-tree', () => {
  it('is the same module through the web alias', () => {
    expect(viaAlias.buildOrgTree).toBe(buildOrgTree)
  })

  it('counts open work only: no conversations, no org nodes, no sentinels, nothing complete', () => {
    const cases: [OrgTaskLike, boolean][] = [
      [t({ project: 'Walnut' }), true],
      [t({ project: 'Walnut', phase: 'COMPLETE' }), false],
      [t({ project: 'Ask Walnut' }), false],
      [t({ project: 'Walnut', walnut_agent: true }), false],
      [t({ project: 'ask mentor' }), false],
      [t({ project: 'Walnut', org_role: 'lead' }), false],
      [t({ project: 'Ask Walnut', org_role: 'main', walnut_agent: true }), false],
      [t({ project: 'Walnut', title: '.metadata walnut' }), false],
      [t({ project: 'Walnut', plugin_only: 'practice' }), false],
    ]
    for (const [task, member] of cases) {
      expect(isOrgMember(task), JSON.stringify(task)).toBe(member)
      // The conversation rule is caller-placement's own.
      if (!task.org_role && !task.plugin_only && task.phase !== 'COMPLETE' && !task.title.startsWith('.')) {
        expect(isOrgMember(task)).toBe(!isAskTask(task))
      }
    }
  })

  it('a plugin\'s own tasks make no team: no counts, no lead, no digest line', () => {
    const work = t({ project: 'Practice', phase: 'IN_PROGRESS' })
    const kept = [1, 2, 3].map(() => t({ project: 'Practice', phase: 'NEED_ACTION', plugin_only: 'practice', user_status: { state: 'needs' } }))
    const tree = buildOrgTree([work, ...kept])
    expect(tree.projects).toHaveLength(1)
    expect(tree.projects[0]).toMatchObject({ project: 'Practice', needsLead: false, contactId: work.id })
    expect(tree.counts.needsYou).toBe(0)
    expect(buildOrgTree(kept).projects).toEqual([])
    expect(viaAlias.isHiddenFromTaskLists(kept[0]!)).toBe(true)
    expect(viaAlias.isHiddenFromTaskLists(work)).toBe(false)
    expect(viaAlias.isHiddenFromTaskLists(t({ project: 'Practice', org_role: 'lead' }))).toBe(true)
    const prev = { at: '2026-09-01T00:00:00Z', needsYou: {} }
    const fresh = t({ project: 'Practice', plugin_only: 'practice', created_at: '2026-10-02T00:00:00Z' })
    expect(orgDigest([fresh], prev, '2026-10-03T00:00:00Z').lines).toEqual([])
  })

  it('a project with one team: Main talks to that team, no lead needed', () => {
    const only = t({ project: 'Fertility', phase: 'IN_PROGRESS' })
    const tree = buildOrgTree([only])
    expect(tree.projects).toHaveLength(1)
    const p = tree.projects[0]!
    expect(p).toMatchObject({ project: 'Fertility', needsLead: false, contactId: only.id })
    expect(p.lead).toBeUndefined()
  })

  it('a project with two or more teams needs a lead; once one exists it is the contact', () => {
    const a = t({ project: 'Walnut' })
    const b = t({ project: 'Walnut' })
    const before = buildOrgTree([a, b]).projects[0]!
    expect(before.needsLead).toBe(true)
    expect(before.contactId).toBeUndefined()
    const lead = t({ project: 'walnut', org_role: 'lead', title: 'Walnut lead' })
    const after = buildOrgTree([a, b, lead]).projects[0]!
    expect(after.lead?.id).toBe(lead.id)
    expect(after.contactId).toBe(lead.id)
    // The lead itself is never one of the teams.
    expect(after.teams.map((x) => x.id).sort()).toEqual([a.id, b.id].sort())
  })

  it('a lead stays the contact when its project drops back to one team', () => {
    const a = t({ project: 'Walnut' })
    const lead = t({ project: 'Walnut', org_role: 'lead' })
    expect(buildOrgTree([a, lead]).projects[0]!.contactId).toBe(lead.id)
  })

  it('the Inbox never gets a lead: Main talks to its tasks one by one', () => {
    const tree = buildOrgTree([t({ project: '' }), t({})])
    const inbox = findProjectNode(tree, 'Inbox')!
    expect(inbox.project).toBe('')
    expect(inbox.needsLead).toBe(false)
    expect(inbox.contactId).toBeUndefined()
  })

  it('nests workers by parent link, across projects too, and counts the whole subtree', () => {
    const leader = t({ project: 'Tickets', title: 'Ticket investigation' })
    const w1 = t({ project: 'Tickets', parent_task_id: leader.id, phase: 'NEED_ACTION' })
    const w2 = t({ project: 'Other', parent_task_id: leader.id, phase: 'IN_PROGRESS' })
    const deep = t({ project: 'Tickets', parent_task_id: w1.id, phase: 'WAITING' })
    const tree = buildOrgTree([leader, w1, w2, deep])
    expect(tree.projects.map((p) => p.project)).toEqual(['Tickets'])
    const team = tree.projects[0]!.teams[0]!
    expect(team.id).toBe(leader.id)
    expect(team.workers.map((w) => w.id)).toEqual([w1.id, w2.id]) // NEED_ACTION before IN_PROGRESS
    expect(team.workers[0]!.workers[0]!.id).toBe(deep.id)
    // By the user's status: the leader not started and the parked one both wait.
    expect(team.counts).toEqual({ open: 4, running: 1, needsYou: 1, waiting: 2 })
    expect(tree.counts.open).toBe(4)
  })

  it('work filed by Main, an ask or a lead is top-level work of its project', () => {
    const main = t({ project: 'Ask Walnut', org_role: 'main', walnut_agent: true })
    const ask = t({ project: 'Ask Walnut', walnut_agent: true })
    const lead = t({ project: 'Walnut', org_role: 'lead' })
    const byMain = t({ project: 'Walnut', parent_task_id: main.id })
    const byAsk = t({ project: 'Walnut', parent_task_id: ask.id })
    const byLead = t({ project: 'Walnut', parent_task_id: lead.id })
    const tree = buildOrgTree([main, ask, lead, byMain, byAsk, byLead])
    expect(tree.main?.id).toBe(main.id)
    expect(tree.projects).toHaveLength(1)
    expect(tree.projects[0]!.teams.map((x) => x.id).sort()).toEqual([byMain.id, byAsk.id, byLead.id].sort())
  })

  it('a child of a COMPLETE parent is a team, and a corrupted parent loop still shows every task once', () => {
    const done = t({ project: 'P', phase: 'COMPLETE' })
    const orphan = t({ project: 'P', parent_task_id: done.id })
    const x = t({ id: 'loop-x', project: 'P', parent_task_id: 'loop-y' })
    const y = t({ id: 'loop-y', project: 'P', parent_task_id: 'loop-x' })
    const tree = buildOrgTree([done, orphan, x, y])
    const ids: string[] = []
    const walk = (nodes: { id: string; workers: unknown[] }[]) => {
      for (const node of nodes) { ids.push(node.id); walk(node.workers as never) }
    }
    walk(tree.projects[0]!.teams)
    expect(ids.sort()).toEqual([orphan.id, 'loop-x', 'loop-y'].sort())
  })

  it('orders projects by what waits on the user, the Inbox last', () => {
    const tree = buildOrgTree([
      t({ project: '' , phase: 'NEED_ACTION' }),
      t({ project: 'Quiet' }),
      t({ project: 'Busy', phase: 'IN_PROGRESS' }),
      t({ project: 'Urgent', phase: 'NEED_ACTION' }),
    ])
    expect(tree.projects.map((p) => p.project)).toEqual(['Urgent', 'Busy', 'Quiet', ''])
  })

  it('picks one main (open first, then newest) and one lead per project (open first, then oldest)', () => {
    const oldMain = t({ org_role: 'main', created_at: '2026-01-01T00:00:00Z' })
    const newMain = t({ org_role: 'main', created_at: '2026-02-01T00:00:00Z' })
    const doneMain = t({ org_role: 'main', created_at: '2026-03-01T00:00:00Z', phase: 'COMPLETE' })
    expect(pickMain([oldMain, doneMain, newMain])?.id).toBe(newMain.id)
    expect(pickMain([doneMain])?.id).toBe(doneMain.id)
    const l1 = t({ org_role: 'lead', project: 'W', created_at: '2026-01-01T00:00:00Z', phase: 'COMPLETE' })
    const l2 = t({ org_role: 'lead', project: 'w', created_at: '2026-02-01T00:00:00Z' })
    const l3 = t({ org_role: 'lead', project: 'W', created_at: '2026-03-01T00:00:00Z' })
    expect(pickLead([l3, l1, l2], 'W')?.id).toBe(l2.id)
    expect(pickLead([l1], 'Other')).toBeUndefined()
  })

  it('a closed lead leads no one; an open lead leads a project with no open work', () => {
    const closed = t({ org_role: 'lead', project: 'W', phase: 'COMPLETE' })
    const tree = buildOrgTree([closed, t({ project: 'W' }), t({ project: 'W' })])
    expect(findProjectNode(tree, 'W')).toMatchObject({ needsLead: true })
    expect(findProjectNode(tree, 'W')?.lead).toBeUndefined()
    expect(findProjectNode(tree, 'W')?.contactId).toBeUndefined()

    const idle = t({ org_role: 'lead', project: 'Quiet' })
    const quiet = findProjectNode(buildOrgTree([idle, t({ project: 'Quiet', phase: 'COMPLETE' })]), 'quiet')
    expect(quiet).toMatchObject({ project: 'Quiet', teams: [], contactId: idle.id, lead: { id: idle.id } })
  })

  it('handles a real-size board (5,000 tasks) quickly', () => {
    const tasks: OrgTaskLike[] = []
    for (let i = 0; i < 5000; i++) {
      tasks.push(t({ project: `P${i % 12}`, phase: i % 5 === 0 ? 'COMPLETE' : 'TODO', ...(i % 7 === 3 && i > 10 ? { parent_task_id: `t${n - 3}` } : {}) }))
    }
    const started = performance.now()
    const tree = buildOrgTree(tasks)
    // Generous for a loaded machine; a quadratic walk would take seconds here.
    expect(performance.now() - started).toBeLessThan(1000)
    expect(tree.projects).toHaveLength(12)
  })
})

describe('org digest (the main agent\'s update note)', () => {
  const at = '2026-10-21T10:00:00Z'
  const later = '2026-10-21T12:00:00Z'

  it('says nothing the first time, and records where things stand', () => {
    const { lines, next } = orgDigest([t({ project: 'W', phase: 'NEED_ACTION' })], undefined, at)
    expect(lines).toEqual([])
    expect(next).toEqual({ at, needsYou: { w: 1 } })
  })

  it('lists only projects that moved: done, new, or a change in what waits on the user', () => {
    const prev = { at, needsYou: { w: 1, quiet: 0 } }
    const tasks = [
      t({ project: 'W', phase: 'COMPLETE', completed_at: '2026-10-21T11:00:00Z' }),
      t({ project: 'W', phase: 'COMPLETE', completed_at: '2026-10-21T09:00:00Z' }), // before the last note
      t({ project: 'W', phase: 'NEED_ACTION', created_at: '2026-10-01T00:00:00Z' }),
      t({ project: 'Quiet', phase: 'TODO', created_at: '2026-10-01T00:00:00Z' }),
      t({ project: 'New', phase: 'TODO', created_at: '2026-10-21T11:30:00Z' }),
      t({ project: 'Ask Walnut', walnut_agent: true, created_at: '2026-10-21T11:30:00Z' }), // a conversation
    ]
    const { lines } = orgDigest(tasks, prev, later)
    expect(lines.map(formatDigestLine)).toEqual([
      'W: 1 done, 1 waiting on the user',
      'New: 1 new',
    ])
  })

  it('a project whose waits on the user drop to zero is said once, then quiet', () => {
    const prev = { at, needsYou: { w: 2 } }
    const tasks = [t({ project: 'W', phase: 'TODO', created_at: '2026-10-01T00:00:00Z' })]
    const first = orgDigest(tasks, prev, later)
    expect(first.lines.map(formatDigestLine)).toEqual(['W: nothing waiting on the user now'])
    expect(orgDigest(tasks, first.next, '2026-10-21T13:00:00Z').lines).toEqual([])
  })
})

describe('when the main agent\'s note goes (planOrgNote)', () => {
  const at = '2026-10-21T10:00:00Z'
  const atMs = Date.parse(at)
  const moved = { lines: [{ project: 'W', done: 0, added: 0, needsYou: 3, needsYouChanged: true }], next: { at: '2026-10-21T10:10:00Z', needsYou: { w: 3 } } }
  const still = { lines: [], next: { at: '2026-10-21T10:10:00Z', needsYou: { w: 2 } } }
  const ask: OrgAlert = { key: 'ask:t1:rq-1', project: 'W', title: 'Fix it', kind: 'question' }
  const fail: OrgAlert = { key: 'error:t2:s2', project: 'W', title: 'Ship it', kind: 'error' }

  it('a count move inside the half hour says nothing and keeps the baseline; after it, one folded note', () => {
    const prev = { at, needsYou: { w: 2 }, alerts: [] }
    const early = planOrgNote(prev, moved, [], atMs + DIGEST_FOLD_MS - 1)
    expect(early.kind).toBe('none')
    expect(early.next).toEqual({ at, needsYou: { w: 2 }, alerts: [] })
    const due = planOrgNote(prev, moved, [], atMs + DIGEST_FOLD_MS)
    expect(due.kind).toBe('full')
    expect(due.next).toEqual({ ...moved.next, alerts: [] })
    expect(DIGEST_FOLD_MS).toBe(30 * 60_000)
  })

  it('a new alert goes at once, alone; the counts keep waiting from the same baseline', () => {
    const prev = { at, needsYou: { w: 2 }, alerts: [] }
    const plan = planOrgNote(prev, moved, [ask], atMs + 60_000)
    expect(plan.kind).toBe('alerts')
    expect(plan.alerts).toEqual([ask])
    expect(plan.next).toEqual({ at, needsYou: { w: 2 }, alerts: [ask.key] })
    // Told: the same prompt is no news; a second one is.
    expect(planOrgNote(plan.next, moved, [ask], atMs + 120_000).kind).toBe('none')
    const second = planOrgNote(plan.next, still, [ask, fail], atMs + 180_000)
    expect(second.kind).toBe('alerts')
    expect(second.alerts).toEqual([fail])
  })

  it('the folded note carries only alerts not told yet, and a resolved alert leaves the record', () => {
    const prev = { at, needsYou: { w: 2 }, alerts: [ask.key, 'ask:t9:gone'] }
    const plan = planOrgNote(prev, moved, [ask, fail], atMs + DIGEST_FOLD_MS)
    expect(plan.kind).toBe('full')
    expect(plan.alerts).toEqual([fail])
    expect(plan.next.alerts).toEqual([ask.key, fail.key])
  })

  it('alerts past the cap are counted, stay untold, and are named on the next message', () => {
    const many: OrgAlert[] = Array.from({ length: 8 }, (_, i) => ({ key: `ask:t${i}:rq`, project: 'W', title: `T${i}`, kind: 'question' as const }))
    const prev = { at, needsYou: { w: 2 }, alerts: [] }
    const first = planOrgNote(prev, still, many, atMs + 60_000, DIGEST_FOLD_MS, 6)
    expect(first.alerts.map((a) => a.title)).toEqual(['T0', 'T1', 'T2', 'T3', 'T4', 'T5'])
    expect(first.more).toBe(2)
    expect(first.next.alerts).toEqual(many.slice(0, 6).map((a) => a.key))
    const second = planOrgNote(first.next, still, many, atMs + 120_000, DIGEST_FOLD_MS, 6)
    expect(second.alerts.map((a) => a.title)).toEqual(['T6', 'T7'])
    expect(second.more).toBe(0)
  })

  it('a state from before alerts takes what needs the user now as known (no burst after an upgrade)', () => {
    const prev = { at, needsYou: { w: 2 } }
    const plan = planOrgNote(prev, still, [ask, fail], atMs + 60_000)
    expect(plan.kind).toBe('none')
    expect(plan.next.alerts).toEqual([ask.key, fail.key])
  })

  it('an alert line names the project, the task and what it waits on', () => {
    expect(formatAlertLine(ask)).toBe('W: "Fix it" asks the user a question')
    expect(formatAlertLine({ ...ask, kind: 'permission', tool: 'Bash' })).toBe('W: "Fix it" waits for the user to approve Bash')
    expect(formatAlertLine({ ...fail, project: '' })).toBe('Inbox: "Ship it" stopped on an error')
  })

  describe('one VP for several projects (org_leads)', () => {
    it('a project put under another lead is talked to through that lead, and still stands as its own project', () => {
      const a1 = t({ project: 'Garden' })
      const a2 = t({ project: 'Garden' })
      const b1 = t({ project: 'Seeds', phase: 'IN_PROGRESS' })
      const vp = t({ project: 'Garden', org_role: 'lead', title: 'Garden lead', org_leads: ['seeds'] })
      const own = t({ project: 'Seeds', org_role: 'lead', title: 'Seeds lead', phase: 'COMPLETE' })
      const tree = buildOrgTree([a1, a2, b1, vp, own])
      const garden = tree.projects.find((p) => p.project === 'Garden')!
      const seeds = tree.projects.find((p) => p.project === 'Seeds')!
      expect(garden).toMatchObject({ contactId: vp.id, lead: { id: vp.id } })
      expect(garden.vp).toBeUndefined()
      expect(seeds).toMatchObject({ contactId: vp.id, lead: { id: vp.id }, vp: 'Garden' })
      expect(seeds.teams.map((x) => x.id)).toEqual([b1.id])
      // The project's own lead is still found, for giving it back.
      expect(pickLead([vp, own], 'Seeds')?.id).toBe(vp.id)
      expect(pickOwnLead([vp, own], 'Seeds')?.id).toBe(own.id)
      expect(leadsAlso(vp, 'SEEDS')).toBe(true)
      // A lead never "also" leads its own project.
      expect(leadsAlso(t({ project: 'Seeds', org_role: 'lead', org_leads: ['Seeds'] }), 'Seeds')).toBe(false)
    })

    it('a project with no open work under a VP still shows, under that VP', () => {
      const a = t({ project: 'Garden' })
      const vp = t({ project: 'Garden', org_role: 'lead', org_leads: ['Seeds'] })
      const seeds = buildOrgTree([a, vp]).projects.find((p) => p.project === 'Seeds')
      expect(seeds).toMatchObject({ vp: 'Garden', contactId: vp.id, teams: [] })
    })

    it('a lead someone closed keeps the projects under it: the next contact reopens it', () => {
      const b1 = t({ project: 'Seeds' })
      const b2 = t({ project: 'Seeds' })
      const vp = t({ project: 'Garden', org_role: 'lead', org_leads: ['Seeds'], phase: 'COMPLETE' })
      const seeds = buildOrgTree([b1, b2, vp]).projects.find((p) => p.project === 'Seeds')!
      expect(seeds.lead).toBeUndefined()
      expect(seeds.needsLead).toBe(true)
      expect(pickLead([b1, b2, vp], 'Seeds')?.id).toBe(vp.id)
    })
  })
})
