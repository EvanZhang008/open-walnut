/**
 * Only the writer's own lines of a Brief are held to BRIEF_MAX_CHARS (briefOwnChars in
 * src/core/sessions/brief-structure.ts, checked by brief-write.ts). 2026-11-06, Main: the lines
 * Walnut adds after a write (asks the letter did not name, can-close lines) kept a stored letter
 * over the limit, so every later edit failed and Main rewrote the whole letter four times a day.
 *
 * The guard: whatever Walnut writes into a letter when it shapes it must never count as the
 * writer's, so shaping never makes the writer's share larger. A new kind of line Walnut adds
 * (a push in structureBrief) fails the source ratchet below until briefOwnChars leaves it out.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { Task } from '../../../src/core/types.js'
import { BRIEF_MAX_CHARS, BRIEF_SECTIONS, NEEDS_CATEGORY_LABELS, type NeedsCategory, type UserStatus } from '../../../src/core/user-status.js'
import { ADDED_ASKS_MAX, addedAskLine, briefOwnChars, briefWalnutLines, emptySectionLine, structureBrief } from '../../../src/core/sessions/brief-structure.js'
import { shapeBriefText } from '../../../src/core/sessions/brief-write.js'
import { completeBriefRefs } from '../../../src/core/sessions/brief-rules.js'

const NOW = '2026-11-07T10:00:00.000Z'
const lead = { id: 'lead-0001', title: 'Garden lead', phase: 'WAITING', status: 'in_progress', org_role: 'lead', project: 'Garden' } as Task
const main = { id: 'main-0001', title: 'Main', phase: 'IN_PROGRESS', status: 'in_progress', org_role: 'main' } as Task

let n = 0
function task(status: Partial<UserStatus> & { state: UserStatus['state'] }, over: Partial<Task> = {}): Task {
  n++
  const phase = status.state === 'done' ? 'COMPLETE' : status.state === 'needs' || status.state === 'read' ? 'NEED_ACTION' : status.state === 'working' ? 'IN_PROGRESS' : 'WAITING'
  return {
    id: `task-${String(n).padStart(4, '0')}-aaaa-bbbb`, title: `Job ${n} "quoted" & <odd> 花园`, phase,
    status: phase === 'COMPLETE' ? 'done' : 'in_progress', project: 'Garden', parent_task_id: lead.id,
    user_status: { at: NOW, ...status } as UserStatus, ...over,
  } as Task
}

/** Every kind of status a task in a team can carry, the ones Walnut adds a line for included. */
function team(): Task[] {
  const out: Task[] = []
  const cats = Object.keys(NEEDS_CATEGORY_LABELS) as NeedsCategory[]
  for (const c of cats) out.push(task({ state: 'needs', source: 'session', category: c, ask: `Pick the supplier for bed ${c}, ${'with the prices in the sheet '.repeat(12)}` }))
  for (const c of cats) out.push(task({ state: 'needs', source: 'session', category: c, ask: '' }))
  out.push(task({ state: 'read', source: 'session', toRead: 'result', waitingOn: 'The result is ready' }))
  out.push(task({ state: 'needs', source: 'session', ask: 'Approve the fence plan' }))
  out.push(task({ state: 'needs', source: 'session' }))
  out.push(task({ state: 'needs', source: 'session', ask: 'Short-lived prompt', transient: true } as Partial<UserStatus> & { state: 'needs' }))
  for (let i = 0; i < ADDED_ASKS_MAX + 3; i++) out.push(task({ state: 'needs', source: 'session', ask: `Decide order ${i}` }))
  out.push(task({ state: 'working', now: 'building' }))
  out.push(task({ state: 'waiting', waitingOn: 'a review' }))
  out.push(task({ state: 'done' }))
  return out
}

const ref = (t: Task) => `<task-ref id="${t.id}" label="L${t.id.slice(5, 9)}"/>`

/** Letters a writer sends: every shape structureBrief reshapes. */
function letters(tasks: Task[]): string[] {
  const [a, b, c] = tasks.filter((t) => t.user_status?.state === 'needs')
  const working = tasks.find((t) => t.user_status?.state === 'working')!
  const waiting = tasks.find((t) => t.user_status?.state === 'waiting')!
  const done = tasks.find((t) => t.user_status?.state === 'done')!
  const long = 'and the layout of the north beds is settled '.repeat(4)
  return [
    '',
    'just one line with no sections',
    `### Needs you\n- ${ref(a!)}: pick one\n### Working\n- None\n### Waiting / snoozed\n- None`,
    // Wrong sections, a finished task, a bare ref, an indented sub-item, a short id.
    `### Waiting / snoozed\n${ref(working)}: building ${long}\n  - a sub-item ${long}\n- ${ref(done)}: was sweeping\n  more about it\n- <task-ref id="${waiting.id.slice(0, 9)}" label="W"/>: waits`,
    // Headings in other words, an inline label, Chinese, an about line, a stale "nothing" line.
    `**需要你：**\n- ${ref(b!)}：选一个\n- 无\n## In progress\n- ${ref(a!)}: ${long}\n<about ids="${c!.id}"/>\n**Waiting:** ${ref(waiting)} waits on a review`,
    // A line about the owner itself, and numbered items.
    `### Working\n1. <task-ref id="${lead.id}" label="me"/>: planning\n2) ${ref(working)}: building`,
  ]
}

const shape = (letter: string, owner: Task, tasks: Task[], prior: string[] = []) =>
  shapeBriefText(letter, owner, tasks, { nowIso: NOW, prior }).brief

describe('the lines Walnut writes are recorded and left out', () => {
  for (const owner of [lead, main]) {
    it(`${owner.org_role}: every ask it adds and the count past the cap, for every category and none`, () => {
      const tasks = [owner, ...team()]
      const b = shape('### Needs you\n- None', owner, tasks)
      const lines = b.text.split('\n').filter((l) => l.startsWith('- ') && l !== '- None')
      expect(lines.length).toBe(ADDED_ASKS_MAX + 1)
      expect([...b.added!].sort()).toEqual([...lines].sort())
      expect(briefOwnChars(b.text, b.added)).toBe(0)
      // A letter stored before the record existed: the same lines, told by their shape.
      expect(briefWalnutLines({ text: b.text }, owner, tasks).sort()).toEqual([...lines].sort())
    })
  }
  it('headings and a section\'s "nothing" line are not the writer\'s share either', () => {
    for (const s of BRIEF_SECTIONS) expect(briefOwnChars(`### ${s.heading}`)).toBe(0)
    expect(briefOwnChars(emptySectionLine('English'))).toBe(0)
    expect(briefOwnChars(emptySectionLine('Chinese'))).toBe(0)
  })
})

describe('only Walnut\'s own lines are excused (review 2026-11-07)', () => {
  const tasks = [lead, ...team()]
  const asker = tasks.find((t) => t.user_status?.state === 'needs')!
  it('a writer\'s line in Walnut\'s shape counts in full', () => {
    const forged = `- <task-ref id="${asker.id}" label="Job"/>: Review: ${'my own long words '.repeat(280)}`
    const b = shape(`### Needs you\n${forged}`, lead, tasks)
    expect(b.added).not.toContain(forged)
    expect(briefOwnChars(b.text, b.added)).toBeGreaterThan(BRIEF_MAX_CHARS)
  })
  it('a line Walnut wrote and its writer then grew is the writer\'s', () => {
    const first = shape('### Needs you\n- None', lead, tasks)
    const walnutLine = first.added![0]!
    const grown = first.text.replace(walnutLine, `${walnutLine} ${'and more of mine '.repeat(20)}`)
    const b = shape(grown, lead, tasks, first.added)
    expect(b.added).not.toContain(walnutLine)
    expect(briefOwnChars(b.text, b.added)).toBeGreaterThan(300)
  })
  it('a letter with no record: a labeled line longer than Walnut ever writes is the writer\'s', () => {
    const long = `- <task-ref id="${asker.id}" label="Job"/>: Decide: ${'x'.repeat(300)}`
    expect(briefWalnutLines({ text: long }, lead, tasks)).toEqual([])
  })
  it('a letter with no record: the ask line Walnut wrote before 2026-11-03 (no category) is Walnut\'s', () => {
    const t = tasks.find((x) => x.user_status?.ask === 'Approve the fence plan')!
    const old = `- <task-ref id="${t.id}" label="${t.title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}"/>: Approve the fence plan`
    const writer = `- <task-ref id="${t.id}" label="Job"/>: approve the fence plan today`
    expect(briefWalnutLines({ text: `### Needs you\n${old}\n${writer}` }, lead, tasks)).toEqual([old])
  })
})

describe('shaping never grows the writer\'s share', () => {
  for (const owner of [lead, main]) {
    it(`${owner.org_role}: every letter shape, against every status`, () => {
      const tasks = [owner, ...team()]
      for (const letter of letters(tasks)) {
        const b = shape(letter, owner, tasks)
        const before = briefOwnChars(completeBriefRefs({ text: letter }, tasks).text)
        expect(briefOwnChars(b.text, b.added), `${letter}\n=>\n${b.text}`).toBeLessThanOrEqual(before)
        // Written again as it is stored (an edit that changes nothing, or the whole letter back).
        const again = shape(b.text, owner, tasks, briefWalnutLines(b, owner, tasks))
        expect(briefOwnChars(again.text, again.added)).toBe(briefOwnChars(b.text, b.added))
      }
    })
  }

  it('a letter just under the limit stays under it once Walnut adds its asks, though the text is past it', () => {
    const tasks = [main, ...team()]
    const working = tasks.find((t) => t.user_status?.state === 'working')!
    const lines: string[] = []
    let letter = ''
    for (let i = 0; ; i++) {
      lines.push(`- ${ref(working)}: step ${i} of the garden plan is going on as written in the sheet`)
      const next = `### Needs you\n- None\n### Working\n${lines.join('\n')}\n### Waiting / snoozed\n- None`
      if (briefOwnChars(next) > BRIEF_MAX_CHARS - 100) break
      letter = next
    }
    const stored = shape(letter, main, tasks)
    expect(stored.text.length).toBeGreaterThan(BRIEF_MAX_CHARS)
    expect(briefOwnChars(stored.text, stored.added)).toBe(briefOwnChars(letter))
  })
})

/** Every place structureBrief puts a line into the letter, word for word. A new one is a new kind
 *  of line: a writer's line goes in as `line`; one Walnut writes goes through `walnut(...)`, which
 *  records it (TaskBrief.added) so the limit leaves it out. Cover it in team() / letters() above,
 *  then list it here. */
const KNOWN_LINE_SOURCES = [
  'last.push(line)', // the writer's line under the item before it
  'last.push(line)', // the writer's line, moved to its section
  'body.needs.push(ln)', // inside walnut(): recorded as Walnut's
  'walnutLines.push(ln.text)', // the record itself
  'added.push(t.id)', // ids, not lines
  "out.push(...head, layout(''))", // the writer's lines before the first heading
  'out.push(layout(`### ${s.heading}`), ...lines, layout(\'\'))', // a canonical heading: headingSection
  'lines = [layout(emptySectionLine(opts.language, text))]', // a section's "nothing" line: saysNothing
  'pieces.push(...l.pieces)', // who wrote each part of a line (brief-source.ts), not a line
  "pieces.push({ text: '\\n', layout: true })", // the line break between two lines, Walnut's layout
  'walnut({ text: words, pieces: [{ text: words, writer: askLineWriter(t) }] })', // an ask the letter did not name
  'walnut(layout(BRIEF_WALNUT_WORDS[lang].more(more)))', // the count past the cap, in the Brief's language: ADDED_MORE_RE
]

describe('source ratchet: every line structureBrief writes is accounted for', () => {
  it('lists every push, every assigned line and every walnut() call', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/core/sessions/brief-structure.ts'), 'utf8')
    const body = src.slice(src.indexOf('export function structureBrief('), src.indexOf('export function briefSectionsBlock('))
    const found = [...body.matchAll(/[\w.]+\.(?:push|unshift|splice)\([^\n;]*?\)(?=[;\s]|$)|lines = \[[^\n;]*\]|\bwalnut\((?!line: string)[^\n;]*\)(?=;)/g)].map((m) => m[0])
    expect(found.sort(), 'a new line source in structureBrief: see KNOWN_LINE_SOURCES').toEqual([...KNOWN_LINE_SOURCES].sort())
  })
})

describe('structureBrief live records Walnut\'s asks', () => {
  it('every line it adds is in walnutLines', () => {
    const tasks = [lead, ...team()]
    const out = structureBrief('### Needs you\n- None', lead.id, tasks, { live: lead })
    const asks = out.text.split('\n').filter((l) => l.startsWith('- ') && l !== '- None')
    expect(asks.length).toBe(ADDED_ASKS_MAX + 1)
    expect([...out.walnutLines!].sort()).toEqual([...asks].sort())
  })
})
