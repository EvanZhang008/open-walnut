/**
 * The lines Walnut writes into a Brief itself (2026-11-10, the CEO's reflection on Main's Brief):
 *  - they led with English words ("Decide:", "Take a look:", "Can close:") in a Brief kept in the
 *    user's reply language, Chinese;
 *  - once the writer reworded its own line for a task, Walnut's earlier line for that task stayed
 *    beside it, so the task read twice.
 * Walnut's words follow the Brief's language (BRIEF_WALNUT_WORDS), and its earlier lines are written
 * again from the live state on every write and every render, so a task is named once.
 *
 * The phrase table is checked against the source: every needs category and every fixed status phrase
 * Walnut puts on a line (user-status.ts, `*_TO_READ` and MARKED_ASK) needs its words in every Brief
 * language, so a new one fails here until it has them.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import type { Task } from '../../../src/core/types.js'
import { NEEDS_CATEGORY_LABELS, turnToReadLine, type NeedsCategory, type UserStatus } from '../../../src/core/user-status.js'
import {
  ADDED_ASKS_MAX, ADDED_MORE_RE, BRIEF_LANGS, BRIEF_WALNUT_WORDS, addedAskLine, briefLangOf, briefWalnutLines, structureBrief,
} from '../../../src/core/sessions/brief-structure.js'
import { shapeBriefText, applyBriefEdits } from '../../../src/core/sessions/brief-write.js'

const ROOT = path.resolve(__dirname, '../../..')
const lead = { id: 'lead', title: 'Garden lead', phase: 'WAITING', status: 'in_progress', org_role: 'lead', project: 'Garden' } as Task
let n = 0
const task = (s: Partial<UserStatus> & { state: UserStatus['state'] }, over: Partial<Task> = {}): Task => ({
  id: `t${++n}`, title: `Bed ${n}`, phase: 'NEED_ACTION', status: 'in_progress', project: 'Garden', parent_task_id: 'lead',
  user_status: { at: '2026-11-10T12:00:00.000Z', ...s } as UserStatus, ...over,
}) as Task

/** Every shape of a line Walnut writes for a task asking the user. */
function shapes(): Task[] {
  const out: Task[] = []
  for (const c of Object.keys(NEEDS_CATEGORY_LABELS) as NeedsCategory[]) out.push(task({ state: 'needs', source: 'session', category: c, ask: 'Pick the supplier for the east bed' }))
  out.push(task({ state: 'read', source: 'session', toRead: 'result', waitingOn: 'The result is ready' }))
  out.push(task({ state: 'read', source: 'session', toRead: 'answer', waitingOn: 'It answered your question' }))
  out.push(task({ state: 'read', source: 'session', toRead: 'turn', waitingOn: turnToReadLine(null) }))
  out.push(task({ state: 'read', source: 'session', toRead: 'turn', waitingOn: turnToReadLine('the beds are watered') }))
  out.push(task({ state: 'needs', source: 'mark', ask: 'It was set to need you by hand: open it.' } as never))
  out.push(task({ state: 'needs', source: 'session' }))
  return out
}

/** Every English word of Walnut's own in a Brief line (the en table), outside the task's own words. */
const ENGLISH_WALNUT = [
  ...Object.values(NEEDS_CATEGORY_LABELS).map((l) => `: ${l}`),
  'The result is ready', 'It answered your question', 'Its turn ended without asking you anything', 'its last words',
  'It was set to need you by hand', 'Needs you', 'more asks', 'more ask ',
]

describe('Walnut\'s lines follow the Brief\'s language', () => {
  it('every needs category and every fixed status phrase has words in every Brief language', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/core/user-status.ts'), 'utf8')
    const fixed = [...src.matchAll(/export const (\w+_TO_READ|MARKED_ASK) = '([^']+)'/g)].map((m) => m[2]!)
    expect(fixed.length).toBeGreaterThanOrEqual(4)
    for (const lang of BRIEF_LANGS) {
      if (lang === 'en') continue
      const w = BRIEF_WALNUT_WORDS[lang]
      for (const c of Object.keys(NEEDS_CATEGORY_LABELS) as NeedsCategory[]) expect(w.labels[c], `${lang}: category ${c}`).toBeTruthy()
      for (const phrase of fixed) expect(w.fixed[phrase], `${lang}: "${phrase}" (user-status.ts) has no words`).toBeTruthy()
    }
  })

  it('a Chinese Brief gets every Walnut line in Chinese, and an English one in English', () => {
    const tasks = shapes()
    for (const t of tasks) {
      const zh = addedAskLine(t, false, tasks, 'zh')
      const own = zh.replace(/<task-ref\b[^>]*>/g, '').replace('Pick the supplier for the east bed', '').replace('the beds are watered', '')
      for (const word of ENGLISH_WALNUT) expect(own, `${t.user_status!.toRead ?? t.user_status!.category ?? t.user_status!.source}: ${zh}`).not.toContain(word)
      expect(own).toMatch(/[\u4e00-\u9fff]/)
    }
    expect(addedAskLine(tasks[0]!, false, tasks, 'en')).toContain(`: ${NEEDS_CATEGORY_LABELS.look}: Pick the supplier`)
  })

  it('the count past the cap is in the Brief\'s language and still read as Walnut\'s', () => {
    for (const lang of BRIEF_LANGS) {
      for (const k of [1, 5]) expect(ADDED_MORE_RE.test(BRIEF_WALNUT_WORDS[lang].more(k)), `${lang} ${k}`).toBe(true)
    }
    const many = Array.from({ length: ADDED_ASKS_MAX + 2 }, (_, i) => task({ state: 'needs', source: 'session', ask: `Decide the order of bed ${i}` }))
    const text = structureBrief('### Needs you\n- \u65e0\n### Working\n- \u65e0\n### Waiting / snoozed\n- \u65e0', lead.id, [lead, ...many], { live: lead }).text
    expect(text).toContain(BRIEF_WALNUT_WORDS.zh.more(2))
    expect(text).not.toContain('more asks')
  })

  it('the language is the one given, else the letter\'s own script', () => {
    expect(briefLangOf('Chinese')).toBe('zh')
    expect(briefLangOf('zh')).toBe('zh')
    expect(briefLangOf('English', '\u4e2d\u6587')).toBe('en')
    expect(briefLangOf(undefined, '### Needs you\n- \u7b49\u4f60\u51b3\u5b9a')).toBe('zh')
    expect(briefLangOf(undefined, '### Needs you\n- <task-ref id="x" label="\u4e2d"/>: pick one')).toBe('en')
  })

  it('a letter stored before (no record of its Walnut lines) has its Chinese lines told by their shape', () => {
    const t = task({ state: 'needs', source: 'session', category: 'decide', ask: '\u4e1c\u8fb9\u82b1\u575b\u9009\u54ea\u5bb6\u4f9b\u5e94\u5546\uff1f' })
    const line = addedAskLine(t, false, [lead, t], 'zh')
    const text = `### Needs you\n${line}\n### Working\n- \u65e0\n### Waiting / snoozed\n- \u65e0`
    expect(briefWalnutLines({ text }, lead, [lead, t])).toEqual([line])
  })
})

describe('one line per task: Walnut\'s earlier line goes once the writer names the task', () => {
  // Main's 2026-11-10 Brief: Walnut had added a line for a task the letter left out; the writer then
  // wrote its own line for it in other words, and both stayed.
  const asker = () => task({ state: 'read', source: 'session', toRead: 'turn', waitingOn: turnToReadLine('the new day plan is set') }, { title: 'Daily planning' })

  it('on the write: the writer\'s line stays, Walnut\'s goes', () => {
    const t = asker()
    const tasks = [lead, t]
    const first = shapeBriefText('### Needs you\n- \u65e0\n### Working\n- \u65e0\n### Waiting / snoozed\n- \u65e0', lead, tasks, { lang: 'zh' }).brief
    const walnutLine = first.added![0]!
    expect(first.text).toContain(walnutLine)
    expect(walnutLine).toContain(BRIEF_WALNUT_WORDS.zh.labels.look)
    // The writer adds its own line for the task by an edit, leaving Walnut's line as it was.
    const edited = applyBriefEdits(first.text, [{ old: '### Working', new: `- <task-ref id="${t.id}" label="Daily planning"/> \u65b0\u7684\u4e00\u5929\u5b89\u6392\u5df2\u6392\u597d\uff0c\u53bb\u5b83\u90a3\u91cc\u770b\u4e00\u4e0b\u3002\n### Working` }])
    const stored = { ...lead, brief: first } as Task
    const next = shapeBriefText(edited, stored, tasks, { lang: 'zh', prior: briefWalnutLines(first, stored, tasks), walnut: first.added }).brief
    const lines = next.text.split('\n').filter((l) => l.includes(`id="${t.id}"`))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('\u65b0\u7684\u4e00\u5929\u5b89\u6392')
    expect(next.added ?? []).toEqual([])
  })

  it('on the page: a stored letter holding both reads one line, the writer\'s', () => {
    const t = asker()
    const tasks = [lead, t]
    const walnutLine = addedAskLine(t, false, tasks, 'en')
    const own = `- <task-ref id="${t.id}" label="Daily planning"/> the new day plan is set, look there.`
    const brief = { text: `### Needs you\n${walnutLine}\n${own}\n### Working\n- None\n### Waiting / snoozed\n- None`, at: '2026-11-10T12:00:00.000Z', added: [walnutLine] }
    const shown = structureBrief(brief.text, lead.id, tasks, { live: lead, walnut: brief.added }).text
    expect(shown.split('\n').filter((l) => l.includes(`id="${t.id}"`))).toEqual([own])
  })

  it('a Walnut line in English in a Chinese letter is written again in Chinese; one its writer edited is the writer\'s', () => {
    const t = task({ state: 'needs', source: 'session', category: 'decide', ask: '\u4e1c\u8fb9\u82b1\u575b\u9009\u54ea\u5bb6\u4f9b\u5e94\u5546\uff1f' })
    const tasks = [lead, t]
    const english = addedAskLine(t, false, tasks, 'en')
    const brief = { text: `### Needs you\n${english}\n### Working\n- \u65e0\n### Waiting / snoozed\n- \u65e0`, at: '2026-11-10T12:00:00.000Z', added: [english] }
    const shown = structureBrief(brief.text, lead.id, tasks, { live: lead, lang: 'zh', walnut: brief.added }).text
    expect(shown).not.toContain(english)
    expect(shown).toContain(addedAskLine(t, false, tasks, 'zh'))
    // The writer changed Walnut's line: it is the writer's now, kept as written.
    const mine = `${english} (\u6211\u4eca\u5929\u95ee)`
    const kept = structureBrief(brief.text.replace(english, mine), lead.id, tasks, { live: lead, lang: 'zh', walnut: [english] }).text
    expect(kept).toContain(mine)
    expect(kept.split('\n').filter((l) => l.includes(`id="${t.id}"`))).toHaveLength(1)
  })

  // Review 2026-11-11: a line Walnut added whose task moved on stays, under its task's section.
  it('a task Walnut added that now works or waits keeps its line, moved to its section', () => {
    for (const state of ['working', 'waiting'] as const) {
      const t = task({ state: 'needs', source: 'session', category: 'decide', ask: 'Pick the supplier for the east bed' })
      const first = shapeBriefText('### Needs you\n- None\n### Working\n- None\n### Waiting / snoozed\n- None', lead, [lead, t], { lang: 'en' }).brief
      const line = first.added![0]!
      const moved = { ...t, phase: state === 'working' ? 'IN_PROGRESS' : 'WAITING', user_status: { state, at: '2026-11-10T13:00:00.000Z', ...(state === 'waiting' ? { kind: 'outside', waitingOn: 'a reply' } : { now: 'checking' }) } } as Task
      const shown = structureBrief(first.text, lead.id, [lead, moved], { live: lead, walnut: first.added }).text
      const heading = state === 'working' ? '### Working' : '### Waiting / snoozed'
      expect(shown, state).toContain(`${heading}\n${line}`)
    }
  })

  // Review 2026-11-11: a letter stored before Walnut recorded its lines keeps every line as written,
  // even one in Walnut's shape (it may be the writer's, with words that matter).
  it('a letter with no record of Walnut\'s lines loses none of them', () => {
    const t = task({ state: 'needs', source: 'session', category: 'decide', ask: 'Approve staging?' })
    const own = `- <task-ref id="${t.id}" label="${t.title}"/>: Decide: Approve staging only; the production cluster is explicitly excluded.`
    const brief = { text: `### Needs you\n${own}\n### Working\n- None\n### Waiting / snoozed\n- None`, at: '2026-11-10T12:00:00.000Z' }
    expect(structureBrief(brief.text, lead.id, [lead, t], { live: lead, ...(brief as { added?: string[] }).added ? { walnut: (brief as { added?: string[] }).added } : {} }).text).toContain(own)
    expect(shapeBriefText(brief.text, { ...lead, brief } as Task, [lead, t], { prior: briefWalnutLines(brief, lead, [lead, t]) }).brief.text).toContain(own)
  })
})
