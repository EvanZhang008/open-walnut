/**
 * The org chart's cards and drops (web/src/components/org/org-chart-model.ts): Main, then one
 * VP card per project; a project the user put under another VP sits on that VP's card, and a
 * drop says what it would do before it happens.
 */
import { describe, it, expect } from 'vitest'
import type { Task } from '../../src/core/types.js'
import { buildOrgTree, type OrgTaskLike } from '../../src/core/org/org-tree.js'
import { buildChannels } from '../../web/src/components/org/org-channels-model.js'
import { ceoLine, dropPlan, vpCards, vpLine } from '../../web/src/components/org/org-chart-model.js'

let n = 0
const t = (project: string, over: Partial<OrgTaskLike> = {}): OrgTaskLike => {
  n++
  return { id: `t${n}`, title: `task ${n}`, project, phase: 'TODO', created_at: `2026-10-01T00:00:${String(n).padStart(2, '0')}Z`, ...over }
}

function cardsOf(tasks: OrgTaskLike[]) {
  // The chart's cards come from one row per project (the page's own rows fold a VP's projects).
  const { projects } = buildChannels(buildOrgTree(tasks), tasks as unknown as Task[], () => null)
  return vpCards(projects)
}

const garden = [t('Garden', { phase: 'IN_PROGRESS' }), t('Garden', { phase: 'WAITING' })]
const seeds = [t('Seeds'), t('Seeds', { phase: 'IN_PROGRESS' })]
const inbox = [t('')]
const gardenLead = t('Garden', { org_role: 'lead', title: 'Garden lead' })
const seedsLead = t('Seeds', { org_role: 'lead', title: 'Seeds lead', session_id: 'sid-seeds-lead' })

describe('org chart cards', () => {
  it('one card per project, named after it, the Inbox last and no one\'s VP', () => {
    const cards = cardsOf([...garden, ...seeds, ...inbox, gardenLead, seedsLead])
    expect(cards.map((c) => [c.name, c.role, c.projects.length])).toEqual([['Garden', 'VP', 1], ['Seeds', 'VP', 1], ['Inbox', 'Inbox', 1]])
    expect(cards.find((c) => c.name === 'Garden')!.line).toBe('1 working · 1 waiting')
    expect(ceoLine(cards)).toBe('2 VPs · 2 working')
  })

  it('a project under another VP joins that VP\'s card and keeps its own line', () => {
    const vp = { ...gardenLead, org_leads: ['Seeds'] }
    const cards = cardsOf([...garden, ...seeds, ...inbox, vp, { ...seedsLead, phase: 'COMPLETE' as const }])
    const g = cards.find((c) => c.name === 'Garden')!
    // Seeds' task not started yet is Waiting (src/core/user-status.ts), as on the Board.
    expect(g.projects.map((p) => [p.name, p.line])).toEqual([['Garden', '1 working · 1 waiting'], ['Seeds', '1 working · 1 waiting']])
    expect(g.line).toBe('2 projects · 2 working · 2 waiting')
    expect(cards.some((c) => c.name === 'Seeds')).toBe(false)
    expect(ceoLine(cards)).toBe('1 VP · 1 working')
  })

  it('a card says its team\'s news in the tasks\' own words with its time, the counts under it', () => {
    const at = (min: number) => `2026-10-26T12:${String(min).padStart(2, '0')}:00.000Z`
    const signed = t('Garden', { phase: 'NEED_ACTION', title: 'Renew the permit', user_status: { state: 'waiting', kind: 'you', now: 'The check passed; only your signature is left.', at: at(30) } as never })
    const busy = t('Garden', { phase: 'IN_PROGRESS', user_status: { state: 'working', now: 'Reading the update', at: at(10) } as never })
    const one = cardsOf([signed, busy, gardenLead]).find((c) => c.name === 'Garden')!
    expect([one.news, one.newsTask]).toEqual(['The check passed; only your signature is left.', 'Renew the permit'])
    expect(one.newsAt).toBe(Date.parse(at(30)))
    expect(one.line).toBe('1 working · 1 waiting')
    // Several projects on one card: the one that needs the user leads, named.
    const ask = t('Seeds', { phase: 'NEED_ACTION', title: 'Pick a supplier', user_status: { state: 'needs', ask: 'Choose one of two quotes', at: at(5) } as never })
    const vp = { ...gardenLead, org_leads: ['Seeds'] }
    const both = cardsOf([signed, busy, ask, vp]).find((c) => c.name === 'Garden')!
    expect([both.news, both.newsTask]).toEqual(['Seeds · Needs you: Choose one of two quotes', 'Pick a supplier'])
    expect(both.projects.map((p) => p.news)).toEqual(['The check passed; only your signature is left.', 'Needs you: Choose one of two quotes'])
  })

  it('a VP the user named carries that name; a VP made only to put projects under lists none until one is dragged there', () => {
    // 2026-10-26, the user: "Create vp means a VP, don't have a project that is fine, I usually will drag".
    // The name is the user's (Task.org_name), never the title its session's topic grows.
    const named = { ...gardenLead, title: 'Garden lead · weekly watering plan', org_name: 'Green Thumb' }
    expect(cardsOf([...garden, { ...named, org_name: undefined }]).find((c) => c.project === 'Garden')!.name).toBe('Garden')
    const growth = t('Growth', { org_role: 'lead', title: 'Growth lead', org_vp_only: true } as Partial<OrgTaskLike>)
    let cards = cardsOf([...garden, ...seeds, named, seedsLead, growth])
    expect(cards.find((c) => c.project === 'Garden')!.name).toBe('Green Thumb')
    const g = cards.find((c) => c.project === 'Growth')!
    expect([g.name, g.role, g.vpOnly, g.projects.length, g.line, g.news]).toEqual(['Growth', 'VP', true, 0, 'No projects yet: drag one here', ''])
    expect(g.leadId).toBe(growth.id)
    // A project dragged under it is its only one; the VP's own ask of the user still counts.
    cards = cardsOf([...garden, ...seeds, named, { ...seedsLead, phase: 'COMPLETE' as const }, { ...growth, org_leads: ['Seeds'], phase: 'NEED_ACTION' as const }])
    const g2 = cards.find((c) => c.project === 'Growth')!
    expect(g2.projects.map((p) => p.name)).toEqual(['Seeds'])
    expect(g2.line).toBe('1 working · 1 waiting')
    expect(g2.needsYou).toBe(1)
    // Its own project shows once it has open work.
    cards = cardsOf([...garden, ...seeds, named, seedsLead, growth, t('Growth', { phase: 'IN_PROGRESS' })])
    expect(cards.find((c) => c.project === 'Growth')!.projects.map((p) => p.name)).toEqual(['Growth'])
    // Taking its one project back out: it keeps nothing of its own to name, unless its home has work.
    const under = cardsOf([...garden, ...seeds, named, { ...seedsLead, phase: 'COMPLETE' as const }, { ...growth, org_leads: ['Seeds'] }])
    const seedsUnder = under.find((c) => c.project === 'Growth')!.projects[0]!
    expect(dropPlan(under, seedsUnder, null)!.lines[0]).toBe('Seeds gets a dedicated VP again.')
    const busyHome = cardsOf([...garden, ...seeds, named, { ...seedsLead, phase: 'COMPLETE' as const }, { ...growth, org_leads: ['Seeds'] }, t('Growth', { phase: 'IN_PROGRESS' })])
    const seedsBusy = busyHome.find((c) => c.project === 'Growth')!.projects.find((p) => p.name === 'Seeds')!
    expect(dropPlan(busyHome, seedsBusy, null)!.lines[0]).toBe('Seeds gets a dedicated VP again; the Growth VP keeps Growth.')
  })

  it('vpLine says what moves, else what is open, else nothing', () => {
    expect(vpLine({ open: 3, running: 0, needsYou: 0, waiting: 0 })).toBe('3 open')
    expect(vpLine({ open: 0, running: 0, needsYou: 0, waiting: 0 })).toBe('Nothing open')
  })
})

describe('org chart drops', () => {
  const plain = () => cardsOf([...garden, ...seeds, ...inbox, gardenLead, seedsLead])
  const grouped = () => cardsOf([...garden, ...seeds, ...inbox, { ...gardenLead, org_leads: ['Seeds'] }])

  it('a project onto another VP: that VP takes over, both stay projects, its VP hands over and steps down', () => {
    const cards = plain()
    const seedsCard = cards.find((c) => c.name === 'Seeds')!
    const gardenCard = cards.find((c) => c.name === 'Garden')!
    const plan = dropPlan(cards, seedsCard.projects[0]!, gardenCard)!
    expect(plan).toMatchObject({ project: 'Seeds', vp: 'Garden', hint: 'Drop: the Garden VP takes over Seeds', confirm: 'Put under the Garden VP' })
    expect(plan.lines.join(' ')).toContain('Seeds stays its own project; no task changes project.')
    expect(plan.lines.join(' ')).toContain('The Seeds VP sums up its work for the Garden VP, then steps down.')
    // A lead that never talked has nothing to hand over; a project with no lead says nothing of one.
    const quiet = cardsOf([...garden, ...seeds, gardenLead, { ...seedsLead, session_id: undefined }])
    expect(dropPlan(quiet, quiet.find((c) => c.name === 'Seeds')!.projects[0]!, quiet.find((c) => c.name === 'Garden')!)!.lines)
      .toContain('The Seeds VP steps down; it never started, so there is nothing to hand over.')
    const noLead = cardsOf([...garden, ...seeds])
    expect(dropPlan(noLead, noLead.find((c) => c.name === 'Seeds')!.projects[0]!, noLead.find((c) => c.name === 'Garden')!)!.lines)
      .toHaveLength(2)
  })

  it('nothing happens onto its own card, onto the Inbox, or for the Inbox itself', () => {
    const cards = plain()
    const g = cards.find((c) => c.name === 'Garden')!
    const i = cards.find((c) => c.role === 'Inbox')!
    expect(dropPlan(cards, g.projects[0]!, g)).toBeNull()
    expect(dropPlan(cards, g.projects[0]!, i)).toBeNull()
    expect(dropPlan(cards, i.projects[0]!, g)).toBeNull()
    // Its own VP already.
    expect(dropPlan(cards, g.projects[0]!, null)).toBeNull()
  })

  it('a project under a VP can go back to its own, or on to a third VP', () => {
    const third = t('Kitchen')
    const cards = cardsOf([...garden, ...seeds, third, { ...gardenLead, org_leads: ['Seeds'] }])
    const g = cards.find((c) => c.name === 'Garden')!
    const seedsOnG = g.projects.find((p) => p.name === 'Seeds')!
    const own = dropPlan(cards, seedsOnG, null)!
    expect(own).toMatchObject({ project: 'Seeds', vp: '', title: 'Create a dedicated VP for Seeds?' })
    expect(own.lines).toContain('The Garden VP sums up its work on Seeds for it.')
    const k = cards.find((c) => c.name === 'Kitchen')!
    const on = dropPlan(cards, seedsOnG, k)!
    expect(on.vp).toBe('Kitchen')
    // The VP it leaves keeps its own project, so it does not step down.
    expect(on.lines.join(' ')).toContain('The Garden VP sums up its work on Seeds for the Kitchen VP.')
  })

  it('a VP\'s own project moved onto another VP takes the projects it led along', () => {
    const third = t('Kitchen')
    const cards = cardsOf([...garden, ...seeds, third, { ...gardenLead, org_leads: ['Seeds'] }])
    const g = cards.find((c) => c.name === 'Garden')!
    const k = cards.find((c) => c.name === 'Kitchen')!
    const plan = dropPlan(cards, g.projects[0]!, k)!
    expect(plan.lines[0]).toBe('The Kitchen VP leads Garden and Seeds from now on. Each stays its own project; no task changes project.')
    expect(grouped().find((c) => c.name === 'Garden')!.projects).toHaveLength(2)
  })
})
