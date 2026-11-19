/**
 * Needs you lists and counts only what asks the user (2026-11-18, a VP's reflection: its Brief read
 * "53 more things need you" where about 12 asked him, and a decision due at noon was lost among
 * them). A task with only something to read (To read: a finished result, an answer, a turn that
 * asked nothing) sits under Needs you as ONE count line, never a line of its own and never in a
 * count of asks: in the Brief Walnut writes, in the lists brief_read hands the writer, in the
 * refresh that wakes the writer, in the report letter, on the Org page and on the phone.
 *
 * The ratchets at the end fail when a new place reads Needs you from the section (which holds To
 * read too) or counts the Org page's cards with `.length`, until it says which it means.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { Task } from '../../../src/core/types.js'
import type { UserStatus } from '../../../src/core/user-status.js'
import { buildOrgTree } from '../../../src/core/org/org-tree.js'
import {
  ADDED_ASKS_MAX, ADDED_MORE_RE, BRIEF_WALNUT_WORDS, BRIEF_STRUCTURE_RULE, briefAsksUser, briefOwnChars, briefToRead, structureBrief,
} from '../../../src/core/sessions/brief-structure.js'
import { briefNeedsAsks, briefSectionLines } from '../../../src/core/sessions/brief.js'
import { buildMorningReport } from '../../../src/core/org/morning-report.js'
import { askCount, buildChannels, type AlertProbe } from '../../../web/src/components/org/org-channels-model.js'
import { buildStatusBoard, chipCount, statusBrief, toLookLine } from '../../../web/src/components/board/board-status-model.js'

const NOW = '2026-11-18T10:00:00.000Z'
const lead = { id: 'lead-0001', title: 'Garden lead', phase: 'WAITING', status: 'in_progress', org_role: 'lead', project: 'Garden' } as Task

let n = 0
function task(status: Partial<UserStatus> & { state: UserStatus['state'] }): Task {
  n++
  const phase = status.state === 'needs' || status.state === 'read' ? 'NEED_ACTION' : status.state === 'working' ? 'IN_PROGRESS' : 'WAITING'
  return {
    id: `task-${String(n).padStart(4, '0')}-aaaa`, title: `Job ${n}`, phase, status: 'in_progress', project: 'Garden',
    parent_task_id: lead.id, created_at: NOW, updated_at: NOW, phase_changed_at: NOW,
    user_status: { at: NOW, ...status } as UserStatus,
  } as Task
}
const ask = (words: string) => task({ state: 'needs', source: 'session', ask: words })
const look = () => task({ state: 'read', source: 'session', toRead: 'turn', waitingOn: 'Its turn ended, nothing asked' })

/** A lead's team the way the reported Brief had it: a few asks among many tasks only to read. */
function team(asks: number, looks: number): Task[] {
  return [
    ...Array.from({ length: asks }, (_, i) => ask(`Decide release ${i}`)),
    ...Array.from({ length: looks }, look),
    task({ state: 'working', now: 'building' }),
  ]
}
const refs = (text: string) => [...text.matchAll(/<task-ref id="([^"]+)"/g)].map((m) => m[1]!)
const needsPart = (text: string) => text.split('### Working')[0]!

describe('the Brief Walnut writes', () => {
  for (const lang of ['en', 'zh'] as const) {
    it(`${lang}: one line per ask, one line counting the tasks only to look at, none of them named`, () => {
      const tasks = [lead, ...team(3, 20)]
      const out = structureBrief('### Needs you\n- None', lead.id, tasks, { live: lead, lang })
      const needs = needsPart(out.text)
      const reads = tasks.filter(briefToRead).map((t) => t.id)
      expect(reads).toHaveLength(20)
      for (const id of reads) expect(refs(needs)).not.toContain(id)
      expect(refs(needs)).toHaveLength(3)
      expect(needs).toContain(BRIEF_WALNUT_WORDS[lang].toLook(20))
      expect(out.walnutLines).toContain(BRIEF_WALNUT_WORDS[lang].toLook(20))
    })
  }

  it('the count past the cap counts asks only', () => {
    const tasks = [lead, ...team(ADDED_ASKS_MAX + 4, 30)]
    const out = structureBrief('### Needs you\n- None', lead.id, tasks, { live: lead, lang: 'zh' })
    expect(out.text).toContain(BRIEF_WALNUT_WORDS.zh.more(4))
    expect(out.text).toContain(BRIEF_WALNUT_WORDS.zh.toLook(30))
    expect(out.text).not.toMatch(/还有 3[0-9] 件事要你处理/)
  })

  it('a line Walnut wrote before for a task now only to read gives way to the count', () => {
    const tasks = [lead, ...team(1, 2)]
    const [, r1, r2] = tasks.slice(1)
    const old = [r1!, r2!].map((t) => `- <task-ref id="${t.id}" label="${t.title}"/>: 看一下：这一轮结束了，没有问你什么`)
    const out = structureBrief(`### Needs you\n${old.join('\n')}`, lead.id, tasks, { live: lead, lang: 'zh', walnut: old })
    expect(refs(needsPart(out.text))).not.toContain(r1!.id)
    expect(out.text).toContain(BRIEF_WALNUT_WORDS.zh.toLook(2))
  })

  it('the count line is Walnut\'s: made again from the live state, never the writer\'s share', () => {
    for (const lang of ['en', 'zh'] as const) {
      for (const k of [1, 7]) {
        expect(ADDED_MORE_RE.test(BRIEF_WALNUT_WORDS[lang].toLook(k))).toBe(true)
        expect(briefOwnChars(BRIEF_WALNUT_WORDS[lang].toLook(k))).toBe(0)
      }
    }
    // Rewritten: the old count leaves, the live one comes.
    const tasks = [lead, ...team(0, 2)]
    const out = structureBrief(`### Needs you\n${BRIEF_WALNUT_WORDS.en.toLook(9)}`, lead.id, tasks, { live: lead, lang: 'en' })
    expect(out.text).not.toContain(BRIEF_WALNUT_WORDS.en.toLook(9))
    expect(out.text).toContain(BRIEF_WALNUT_WORDS.en.toLook(2))
  })

  it('the rule tells the writer not to list them', () => {
    expect(BRIEF_STRUCTURE_RULE).toMatch(/only something to read .*never give it a line of its own/)
    expect(BRIEF_STRUCTURE_RULE).not.toMatch(/goes under Needs you, its line saying what to look at/)
  })
})

describe('what Walnut hands the writer and what wakes it', () => {
  it('brief_read\'s Needs you list names asks only and counts the rest in one line', () => {
    const tasks = [lead, ...team(2, 5)]
    const lines = briefSectionLines(lead, tasks, Date.parse(NOW))
    const reads = tasks.filter(briefToRead).map((t) => t.id)
    for (const id of reads) expect(refs(lines.needs.join('\n'))).not.toContain(id)
    expect(lines.needs.filter((l) => l.includes('<task-ref'))).toHaveLength(2)
    expect(lines.needs.at(-1)).toMatch(/^- \(5 tasks have only something to read/)
  })

  it('a task only to read is no ask the refresh tells the writer about', () => {
    const tasks = [lead, ...team(2, 5)]
    expect(Object.keys(briefNeedsAsks(lead, tasks)).sort()).toEqual(tasks.filter(briefAsksUser).map((t) => t.id).sort())
    expect(Object.keys(briefNeedsAsks(lead, tasks))).toHaveLength(2)
  })
})

describe('the report letter', () => {
  it('lists and counts asks only, with one line for the rest', () => {
    const tasks = [lead, ...team(2, 6)]
    const r = buildMorningReport(lead, tasks, [], Date.parse(NOW) - 3_600_000, Date.parse(NOW), 'zh')
    expect(r.counts.needs).toBe(2)
    expect(r.markdown).toContain('## 需要你（2）')
    expect(r.markdown).toContain('另有 6 件只需要你看一下')
    expect(r.subject).toMatch(/^报告：2 项需要你/)
  })
})

describe('the Org page', () => {
  it('counts asks only: the row, its red mark and Main\'s line', () => {
    const tasks = [lead, ...team(1, 4)]
    const noAlerts: AlertProbe = () => null
    const { main, rows } = buildChannels(buildOrgTree(tasks), tasks, noAlerts)
    const row = rows.find((r) => r.project === 'Garden')!
    // The cards are all there (the list folds the ones only to read), the counts are asks only.
    expect(row.alerts).toHaveLength(5)
    expect(askCount(row.alerts)).toBe(1)
    expect(row.needs).toBe(1)
    expect(main.needs).toBe(1)
    const onlyReads = [lead, ...team(0, 4)]
    const quiet = buildChannels(buildOrgTree(onlyReads), onlyReads, noAlerts).rows.find((r) => r.project === 'Garden')!
    expect(quiet.needs).toBe(0)
    expect(quiet.state).not.toBe('alert')
  })
})

describe('the Board', () => {
  it('its Needs you number, chip and headline count and name asks only; the rest is one line', () => {
    const tasks = [lead, ...team(2, 5)]
    const board = buildStatusBoard({ ownerId: lead.id, tasks, now: Date.parse(NOW), doneWindowDays: 7 })
    // All seven are drawn under Needs you, the asks first; the number (the chip and the view toggle) is 2.
    expect(board.groups.needs).toHaveLength(7)
    expect(board.groups.needs.slice(0, 2).every((r) => r.status.state === 'needs')).toBe(true)
    expect(board.counts.needs).toBe(2)
    expect(chipCount(board, 'needs')).toBe(2)
    expect(board.toLook).toBe(5)
    const brief = statusBrief(board)
    expect(brief.needs.map((x) => x.id).sort()).toEqual(tasks.filter(briefAsksUser).map((t) => t.id).sort())
    expect(brief.toLook).toBe(5)
    expect(toLookLine(brief.toLook)).toBe('And 5 only to look at, nothing to decide.')
    expect(toLookLine(0)).toBe('')
  })
})

/** Every read of a Brief section in the source, each with why the section (not an ask) is meant. */
const KNOWN_SECTION_READS = [
  'src/core/org/morning-report.ts: briefSectionOf(t) !== \'needs\'', // "moved": a task only to read is counted as one line, not moved
  'src/core/sessions/brief-structure.ts: briefSectionOf(t) === \'needs\'', // `rewritten`: Walnut's old lines of every Needs you task are made again (asks) or folded (to read)
  'src/core/sessions/brief-structure.ts: briefSectionOf(task)', // where a writer's line goes
  'src/core/sessions/brief.ts: briefSectionOf(t)', // the section a list line goes in; To read is counted apart
  'src/core/sessions/brief-fresh.ts: briefSectionOf(t)', // whether a named line moved section
  'web/src/components/org/OrgBrief.tsx: briefSectionOf(t)', // a render key
  'web/src/components/org/OrgBrief.tsx: briefSectionOf(t) === \'needs\'', // a render key: the count line follows To read too
]

/** Every count or test of the Org page's cards and every shownState (which puts To read under Needs
 *  you) on the Org page, each with why it is not a count of asks. */
const KNOWN_ALERT_LENGTHS = [
  'web/src/components/org/OrgTaskRail.tsx: sec.alerts.length', // whether the list renders at all (the fold row included), and the other sections' sizes
  'web/src/components/org/OrgTaskRail.tsx: sec.alerts.length', // the same line: a non-Needs section's size
  'web/src/components/org/org-channels-model.ts: alerts.length', // whether any card names the row
  'web/src/components/org/org-task-tabs.ts: s.alerts.length', // whether a section is drawn
  'web/src/components/org/org-channels-model.ts: alerts.some', // channelState: red only for an ask (isAsk)
  'web/src/components/org/org-channels-model.ts: shownState(userStateOf(task)', // which tasks get a card (To read too, folded on the page)
  'web/src/components/org/org-channels-model.ts: shownState(storedUserState(s)', // a team's line for the column it is in
  'web/src/components/org/org-task-tabs.ts: shownState(userStateOf(task)', // the dot and tab a watched row wears
  'web/src/components/org/OrgThreads.tsx: shownState(userStateOf(t)', // a thread's task dot
]

function scan(dirs: string[], re: RegExp): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.tsx?$/.test(e.name)) {
        for (const m of fs.readFileSync(p, 'utf8').matchAll(re)) out.push(`${path.relative(process.cwd(), p)}: ${m[0]}`)
      }
    }
  }
  for (const d of dirs) walk(path.join(process.cwd(), d))
  return out.sort()
}

describe('ratchets', () => {
  it('every read of a Brief section says it means the section, not an ask (asks: briefAsksUser)', () => {
    const found = scan(['src', 'web/src'], /briefSectionOf\((?!task: )[^)]*\)(?: [!=]== 'needs')?/g)
    expect(found, 'a new reading of the Brief section: an ask is briefAsksUser, To read is briefToRead').toEqual([...KNOWN_SECTION_READS].sort())
  })

  it('every count of the Org page\'s cards says it is not a count of asks (asks: askCount)', () => {
    const found = scan(['web/src/components/org'], /[\w.]*(?:alerts|tabs\.needs)\.(?:length|some|every)\b|shownState\([^)]*\)/g)
    expect(found, 'a new count of the cards: count asks with askCount').toEqual([...KNOWN_ALERT_LENGTHS].sort())
  })
})
