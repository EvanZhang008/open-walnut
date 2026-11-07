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
import { ADDED_ASKS_MAX, addedAskLine, briefOwnChars, emptySectionLine, isWalnutBriefLine, structureBrief } from '../../../src/core/sessions/brief-structure.js'
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

describe('isWalnutBriefLine', () => {
  it('knows every line Walnut adds, for Main (with the VP) and a lead, every category and none', () => {
    const tasks = team()
    const vp = { id: 'vp-00001', title: 'Garden "VP"', phase: 'IN_PROGRESS', status: 'in_progress', org_role: 'lead', project: 'Garden' } as Task
    for (const t of tasks.filter((x) => x.user_status?.state === 'needs' || x.user_status?.state === 'read')) {
      for (const owner of [lead, main]) {
        const line = addedAskLine(t, owner === main, [...tasks, vp])
        expect(isWalnutBriefLine(line), line).toBe(true)
        expect(briefOwnChars(line)).toBe(0)
      }
    }
    expect(isWalnutBriefLine('- And 1 more ask the user: the Task view lists it.')).toBe(true)
    expect(isWalnutBriefLine('- And 12 more asks the user: the Task view lists them.')).toBe(true)
  })
  it('never takes a writer\'s line for Walnut\'s', () => {
    for (const line of [
      '- <task-ref id="a" label="A"/>：Can close 了',
      '- <task-ref id="a" label="A"/>: approve the fence plan',
      '- <task-ref id="a" label="A"/>: Can closely watch it',
      '- Can close: the result is ready',
    ]) expect(isWalnutBriefLine(line), line).toBe(false)
  })
  it('headings and a section\'s "nothing" line are not the writer\'s share either', () => {
    for (const s of BRIEF_SECTIONS) expect(briefOwnChars(`### ${s.heading}`)).toBe(0)
    expect(briefOwnChars(emptySectionLine('English'))).toBe(0)
    expect(briefOwnChars(emptySectionLine('Chinese'))).toBe(0)
  })
})

describe('shaping never grows the writer\'s share', () => {
  for (const owner of [lead, main]) {
    it(`${owner.org_role}: every letter shape, against every status`, () => {
      const tasks = [owner, ...team()]
      for (const letter of letters(tasks)) {
        const shaped = shapeBriefText(letter, owner, tasks, { nowIso: NOW }).brief.text
        const before = briefOwnChars(completeBriefRefs({ text: letter }, tasks).text)
        expect(briefOwnChars(shaped), `${letter}\n=>\n${shaped}`).toBeLessThanOrEqual(before)
        // Shaped again (a later write of the stored letter as it is): the same share.
        const again = shapeBriefText(shaped, owner, tasks, { nowIso: NOW }).brief.text
        expect(briefOwnChars(again)).toBe(briefOwnChars(shaped))
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
    const stored = shapeBriefText(letter, main, tasks, { nowIso: NOW }).brief.text
    expect(stored.length).toBeGreaterThan(BRIEF_MAX_CHARS)
    expect(briefOwnChars(stored)).toBeLessThanOrEqual(BRIEF_MAX_CHARS)
    expect(briefOwnChars(stored)).toBe(briefOwnChars(letter))
  })
})

/** Every place structureBrief puts a line into the letter. A new one is a new kind of line Walnut
 *  may write: make briefOwnChars leave it out (isWalnutBriefLine, headingSection or saysNothing),
 *  cover it in team() / letters() above, then list it here. */
const KNOWN_LINE_SOURCES: Record<string, string> = {
  'last.push(line)': 'the writer\'s own line, moved to its section',
  'body.needs.push(addedAskLine(t, main, tasks))': 'an ask the letter did not name: isWalnutBriefLine',
  'body.needs.push(`- And ${more} more': 'the count past the cap: ADDED_MORE_RE',
  'added.push(t.id)': 'ids, not lines',
  "out.push(...head, '')": 'the writer\'s lines before the first heading',
  'out.push(`### ${s.heading}`, ...lines': 'a canonical heading: headingSection',
  'lines = [emptySectionLine(': 'a section\'s "nothing" line: saysNothing',
}

describe('source ratchet: every line structureBrief writes is accounted for', () => {
  it('lists every push and every assigned line', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/core/sessions/brief-structure.ts'), 'utf8')
    const body = src.slice(src.indexOf('export function structureBrief('), src.indexOf('export function briefSectionsBlock('))
    const found = [...body.matchAll(/[\w.]+\.(?:push|unshift|splice)\([^\n;]*|lines = \[[^\n;]*/g)].map((m) => m[0])
    const unknown = found.filter((f) => !Object.keys(KNOWN_LINE_SOURCES).some((k) => f.startsWith(k)))
    expect(unknown, 'a new line source in structureBrief: see KNOWN_LINE_SOURCES').toEqual([])
    for (const k of Object.keys(KNOWN_LINE_SOURCES)) expect(found.some((f) => f.startsWith(k)), `stale entry: ${k}`).toBe(true)
  })
})

describe('structureBrief live keeps Walnut\'s asks recognizable', () => {
  it('every line it adds is Walnut\'s', () => {
    const tasks = [lead, ...team()]
    const out = structureBrief('### Needs you\n- None', lead.id, tasks, { live: lead })
    const asks = out.text.split('\n').filter((l) => l.includes('<task-ref'))
    expect(asks.length).toBe(ADDED_ASKS_MAX)
    for (const l of asks) expect(isWalnutBriefLine(l), l).toBe(true)
  })
})
