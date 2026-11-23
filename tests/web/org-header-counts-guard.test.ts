/**
 * One status, one source for an Org node's counts (2026-11-20: the CEO's header lost "1 Needs you"
 * the moment the CEO started, because whether it keeps Threads was read off its task existing, while
 * its Tasks panel still showed the ask).
 *
 *   - whether a node keeps Threads (the CEO, a VP) is what it IS: `nodeKeepsThreads`, never whether
 *     its task exists yet (contactId), so nothing flips on start;
 *   - the header's counts (`headerPills`) and the side bar's section counts (`sectionCount`) are made
 *     from the one `orgTaskTabs`, so they never disagree, and Needs you counts asks (askCount);
 *   - the ratchets below enumerate, from the source, every place on the Org page that decides
 *     keeps-Threads, makes the tabs or counts a Needs you, and fail when a new one appears.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { Task } from '../../src/core/types.js'
import { buildOrgTree } from '../../src/core/org/org-tree.js'
import { buildChannels, type AlertProbe } from '../../web/src/components/org/org-channels-model.js'
import { allTasksSections, headerPillWords, headerPills, nodeKeepsThreads, orgTaskTabs, ownAskFirst, sectionCount } from '../../web/src/components/org/org-task-tabs.js'

const NOW = Date.parse('2026-11-20T10:00:00.000Z')
const at = new Date(NOW - 60_000).toISOString()
const t = (id: string, extra: Partial<Task> = {}): Task => ({
  id, title: `${id} title`, project: 'Orchard', phase: 'IN_PROGRESS', status: 'in_progress', priority: 'none', created_at: at, updated_at: at, ...extra,
} as Task)
const noAlerts: AlertProbe = () => null

const lead = t('lead-0001', { org_role: 'lead', title: 'Orchard VP', user_status: { state: 'waiting', at } as never })
const asks = t('ask-0001', { parent_task_id: lead.id, phase: 'NEED_ACTION', session_id: 's-ask', user_status: { state: 'needs', source: 'session', ask: 'North bed or south bed?', at } as never })
const reads = t('read-0001', { parent_task_id: lead.id, phase: 'NEED_ACTION', session_id: 's-read', user_status: { state: 'read', source: 'session', toRead: 'turn', at } as never })
const works = t('work-0001', { parent_task_id: lead.id, session_id: 's-work', user_status: { state: 'working', at } as never })
const idle = t('todo-0001', { parent_task_id: lead.id, phase: 'TODO', user_status: { state: 'waiting', kind: 'not-started', at } as never })
const inboxAsk = t('inbox-0001', { project: '', phase: 'NEED_ACTION', session_id: 's-inbox', user_status: { state: 'needs', source: 'session', ask: 'Renew online?', at } as never })
const main = t('main-0001', { org_role: 'main', project: '', session_id: 's-main', user_status: { state: 'waiting', at } as never })

function viewOf(tasks: Task[], pick: (rows: ReturnType<typeof buildChannels>) => ReturnType<typeof buildChannels>['main']) {
  const ch = buildChannels(buildOrgTree(tasks), tasks, noAlerts)
  const row = pick(ch)
  const tabs = orgTaskTabs(row, ch.rows, tasks, NOW)
  const keeps = nodeKeepsThreads(row, row.contactId ? tasks.find((x) => x.id === row.contactId) : undefined)
  const pills = Object.fromEntries(headerPills(tabs, 0, keeps).map((p) => [p.tab, p.n]))
  const sections = Object.fromEntries(allTasksSections(tabs, ownAskFirst(tabs.needs, row.contactId), 0).map((s) => [s.tab, sectionCount(s, 0)]))
  return { row, keeps, pills, sections }
}

describe('a node keeps Threads by what it is', () => {
  const team = [lead, asks, reads, works, idle, inboxAsk]

  it('the CEO before its task exists reads as the CEO once it runs', () => {
    const before = viewOf(team, (c) => c.main)
    const after = viewOf([...team, main], (c) => c.main)
    expect(before.row.contactId).toBeUndefined()
    expect(after.row.contactId).toBe(main.id)
    expect(before.keeps).toBe(true)
    expect(after.keeps).toBe(true)
    expect(before.pills).toEqual(after.pills)
    expect(before.sections).toEqual(after.sections)
    expect(before.pills.needs, 'no Needs you pill on the CEO').toBeUndefined()
    // The ask (and only the ask: a card to read is no ask) is in its Tasks.
    expect(before.sections.needs).toBe(2)
  })

  it('a VP keeps Threads; a router, the Inbox and a project with no VP do not', () => {
    expect(viewOf(team, (c) => c.rows.find((r) => r.contactId === lead.id)!).keeps).toBe(true)
    expect(nodeKeepsThreads({ kind: 'router', isLead: false }, { org_role: 'router' })).toBe(false)
    expect(nodeKeepsThreads({ kind: 'project', isLead: false })).toBe(false)
    expect(nodeKeepsThreads({ kind: 'main', isLead: false })).toBe(true)
  })

  it('a node that keeps none shows the Needs you its side bar counts, asks only', () => {
    const inbox = viewOf(team, (c) => c.rows.find((r) => r.kind === 'project' && r.project === '')!)
    expect(inbox.keeps).toBe(false)
    expect(inbox.pills.needs).toBe(1)
    expect(inbox.sections.needs).toBe(1)
  })

  it('every header pill is its section\'s count', () => {
    for (const v of [viewOf(team, (c) => c.main), viewOf(team, (c) => c.rows.find((r) => r.contactId === lead.id)!)]) {
      for (const [tab, n] of Object.entries(v.pills)) expect(v.sections[tab], tab).toBe(n)
    }
  })

  it('approvals count under Needs you in both', () => {
    const ch = buildChannels(buildOrgTree(team), team, noAlerts)
    const inbox = ch.rows.find((r) => r.kind === 'project' && r.project === '')!
    const tabs = orgTaskTabs(inbox, ch.rows, team, NOW)
    const needs = allTasksSections(tabs, tabs.needs, 2).find((s) => s.tab === 'needs')!
    expect(headerPills(tabs, 2, false).find((p) => p.tab === 'needs')?.n).toBe(sectionCount(needs, 2))
  })
})

const ORG_DIR = 'web/src/components/org'

function scan(dirs: string[], re: RegExp): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.tsx?$/.test(e.name)) for (const m of fs.readFileSync(p, 'utf8').matchAll(re)) out.push(`${path.relative(process.cwd(), p)}: ${m[0]}`)
    }
  }
  for (const d of dirs) walk(path.join(process.cwd(), d))
  return out.sort()
}

describe('ratchets: every Org node count reads the one derivation', () => {
  it('the tabs are made in one place: the node page, which hands them to its header and its side bar', () => {
    expect(scan(['web/src'], /\borgTaskTabs\(/g)).toEqual([
      'web/src/components/org/OrgNodeDetail.tsx: orgTaskTabs(',
      'web/src/components/org/org-task-tabs.ts: orgTaskTabs(',
    ])
  })

  it('every keeps-Threads decision is listed, and none reads whether the node\'s task exists', () => {
    // Each assignment of a keeps-Threads flag on the Org page, with why it is not nodeKeepsThreads.
    const found = scan([ORG_DIR], /\b(?:const|let)\s+keeps(?:Brief|Threads)\s*=\s*[^;\n]+/g)
    expect(found, 'a new keeps-Threads decision: use nodeKeepsThreads (what the node is)').toEqual([
      'web/src/components/org/OrgNodeDetail.tsx: const keepsBrief = nodeKeepsThreads(row, contact)',
      // A list row's own badge (projectRow): the VP's own project's row, not one it leads beside it.
      'web/src/components/org/org-channels-model.ts: const keepsThreads = !!p.lead && !p.vp',
    ].sort())
    for (const line of found) expect(line, 'keyed on the task existing flips on start').not.toMatch(/contactId/)
    const body = fs.readFileSync(path.join(process.cwd(), ORG_DIR, 'org-task-tabs.ts'), 'utf8')
    const fn = body.slice(body.indexOf('export function nodeKeepsThreads'), body.indexOf('export interface HeaderPill'))
    expect(fn).not.toMatch(/contactId/)
  })

  it('the header and the side bar count only through headerPills and sectionCount', () => {
    for (const file of ['OrgNodeDetail.tsx', 'OrgTaskRail.tsx']) {
      const src = fs.readFileSync(path.join(process.cwd(), ORG_DIR, file), 'utf8')
      expect(src, `${file}: a count of its own`).not.toMatch(/\baskCount\(|tabs\.(?:needs|working|waiting|notstarted)\.length/)
    }
    expect(fs.readFileSync(path.join(process.cwd(), ORG_DIR, 'OrgNodeDetail.tsx'), 'utf8')).toMatch(/headerPills\(tabs, approvals, keepsThreads\)/)
    expect(fs.readFileSync(path.join(process.cwd(), ORG_DIR, 'OrgTaskRail.tsx'), 'utf8')).toMatch(/sectionCount\(sec, approvals\.length\)/)
  })

  it('every Needs you count on the Org page goes through askCount (the cards come from each task\'s user_status)', () => {
    // Each place that counts asks for a number the user reads, with where its cards come from.
    expect(scan([ORG_DIR], /\baskCount\([^)]*\)/g), 'a new Needs you count: list it here, from the row\'s alerts or the tabs').toEqual([
      'web/src/components/org/OrgListRow.tsx: askCount(row.alerts)', // a list row's dot (a row with no Threads of its own: a router, a project with no VP)
      'web/src/components/org/org-channels-model.ts: askCount(mainAlerts)', // the CEO row's `needs`
      'web/src/components/org/org-channels-model.ts: askCount(alerts)', // a project row's `needs`
      'web/src/components/org/org-channels-model.ts: askCount(r.alerts)', // the CEO row: the asks under every VP
      'web/src/components/org/org-task-tabs.ts: askCount(sec.alerts)', // sectionCount
      'web/src/components/org/org-task-tabs.ts: askCount(tabs.needs)', // headerPills
    ].sort())
  })
})

describe('the header counts in the user\'s words (2026-11-23: "xx working, yy waiting")', () => {
  it('reads "N working", "N waiting", "N need you": no tab name, no "tasks"', () => {
    expect(headerPillWords('working', 51)).toBe('51 working')
    expect(headerPillWords('waiting', 22)).toBe('22 waiting')
    expect(headerPillWords('notstarted', 5)).toBe('5 not started')
    // A Needs you count reads in the state's own name (task-state-ratchet: no old "need you" count).
    expect(headerPillWords('needs', 2)).toBe('2 Needs you')
    expect(headerPillWords('needs', 1)).toBe('1 Needs you')
  })

  it('counts working and waiting only: a task nobody started is no header count', () => {
    const v = viewOf([lead, works, idle], (c) => c.rows.find((r) => r.contactId === lead.id) ?? c.main)
    expect(v.pills.notstarted).toBeUndefined()
    expect(v.sections.notstarted).toBe(1)
  })

  it('the header draws every task count through headerPillWords, and no "for you" on its threads', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'web/src/components/org/OrgNodeDetail.tsx'), 'utf8')
    const pills = src.slice(src.indexOf('function CountPills('), src.indexOf('/** The live action of the team'))
    expect(pills).toContain('{headerPillWords(tab, n)}')
    expect(pills).not.toMatch(/stateCountLabel|ORG_TASK_TAB_LABELS\.notstarted\}/)
    expect(pills).toMatch(/\{threadCountLabel\(shown\)\}\n/)
    // Round quiet keys, the button family's (buttons.css .btn-round), never a restyled .btn.
    expect([...pills.matchAll(/className="btn btn-round"/g)].length).toBe(2)
  })
})
