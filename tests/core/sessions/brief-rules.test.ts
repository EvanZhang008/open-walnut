/**
 * The Brief's rules, checked by Walnut (src/core/sessions/brief-rules.ts): every line names its
 * task, one thing per line, and Main's lines name the VP too. The VP Brief the user sent back
 * (2026-10-27) is the fixture, in neutral names.
 */
import { describe, it, expect } from 'vitest'
import type { Task } from '../../../src/core/types.js'
import { briefFixPrompt, briefIssues, briefNeedsRewrite, briefVpLines, formatBriefIssues, completeBriefRefs } from '../../../src/core/sessions/brief-rules.js'
import { briefMoveLines, briefPrompt } from '../../../src/core/sessions/brief.js'

const t = (over: Partial<Task>): Task => ({ title: 'x', phase: 'IN_PROGRESS', ...over } as Task)
const main = t({ id: 'main', title: 'Main', org_role: 'main', project: 'Ask Walnut' })
const vp = t({ id: 'vp1', title: 'Lighthouse lead', org_role: 'lead', project: 'Lighthouse', created_at: '2026-10-01T00:00:00Z' })
const vp2 = t({ id: 'vp2', title: 'Garden lead', org_role: 'lead', project: 'Garden', created_at: '2026-10-01T00:00:00Z' })
const docSync = t({ id: 'w1', title: 'Docs sync push', project: 'Lighthouse', parent_task_id: 'vp1' })
const fence = t({ id: 'w2', title: 'Fix the fence', project: 'Garden', parent_task_id: 'vp2' })
const all = [main, vp, vp2, docSync, fence]
const ref = (x: Task) => `<task-ref id="${x.id}" label="${x.title}"/>`

describe('a VP Brief', () => {
  it('flags needs-you lines with no task and a line of four asks', () => {
    const text = [
      '**Needs you:**',
      '- The docs sync can be pushed, one word from you is enough.',
      '- Still waiting on your pick: the table design, what the review doc covers first, whether to post the sandbox change, the two chat threads.',
      `- ${ref(docSync)}: the receiver change is vague.`,
    ].join('\n')
    const issues = briefIssues(text, vp, all)
    expect(issues.map((i) => i.kind)).toEqual(['no_task', 'no_task'])
    // A list of four asks in one line; a line that spells out its steps is one thing.
    const several = briefIssues(`- ${ref(docSync)}: pick: the table design; the review doc; the sandbox change; the chat threads.`, vp, all)
    expect(several.map((i) => i.kind)).toEqual(['several_things'])
    expect(briefIssues(`- ${ref(docSync)}\u3001the table\u3001the doc\u3001the threads`, vp, all).map((i) => i.kind)).toEqual(['several_things'])
    for (const fine of [
      `- ${ref(docSync)}: install build 129, open a letter, tap Reply, and check the sheet.`,
      `- ${ref(docSync)}: iOS\u3001Mac\u3001web all shipped.`,
      `- ${ref(docSync)}: done; shipped; nothing waits.`,
    ]) expect(briefIssues(fine, vp, all), fine).toEqual([])
    // "Needs you: nothing" names no task and needs none.
    // Labels, rules and "nothing" lines are not items.
    expect(briefIssues([
      '**Needs you:** nothing.', '- Needs you: none', '**Needs you:** nothing right now.', 'Nothing needs you right now.',
      '**Needs you**', '**Work**', '---', '## Work', 'Work:',
      '\u9700\u8981\u4f60\uff1a\u6682\u65e0', '\u76ee\u524d\u6ca1\u6709\u9700\u8981\u4f60\u5904\u7406\u7684\u4e8b\u3002',
    ].join('\n'), vp, all)).toEqual([])
    // A VP's line needs only the task: no VP check below Main.
    expect(briefIssues(`- ${ref(docSync)}: approve the push of the docs sync to the shared repo.`, vp, all)).toEqual([])
  })
})

describe("Main's Brief", () => {
  it('needs the VP beside a worker, not beside a VP or its own work', () => {
    const issues = briefIssues([
      `- ${ref(docSync)}: approve the docs sync push.`,
      `- ${ref(fence)} ${ref(vp2)}: the fence waits on a supplier pick.`,
      `- ${ref(vp)}: the Lighthouse team is on track.`,
      `- ${ref(main)}: I keep the weekly digest.`,
    ].join('\n'), main, all)
    expect(issues).toEqual([{ kind: 'no_vp', line: `- ${ref(docSync)}: approve the docs sync push.`, vp: { id: 'vp1', title: 'Lighthouse lead' } }])
    expect(formatBriefIssues(issues)[0]).toContain('add <task-ref id="vp1" label="Lighthouse lead"/> after the task')
  })

  it('is told its VPs and the VP of every move', () => {
    expect(briefVpLines(main, all)).toEqual([`- ${ref(vp)} leads Lighthouse`, `- ${ref(vp2)} leads Garden`])
    expect(briefVpLines(vp, all)).toEqual([])
    const owner = { ...main, brief: { text: 'x', at: '2026-10-27T09:00:00Z' } } as Task
    // Main's own worker in a VP's project, and a VP that moved.
    const moved = { ...fence, parent_task_id: 'main', phase_changed_at: '2026-10-27T10:00:00Z' } as Task
    const vpMoved = { ...vp, phase_changed_at: '2026-10-27T09:30:00Z' } as Task
    expect(briefMoveLines(owner, [owner, vpMoved, vp2, docSync, moved])).toEqual([
      `- ${ref(fence)} (VP ${ref(vp2)}): now Working`,
      `- ${ref(vp)}: now Working`,
    ])
    const prompt = briefPrompt({ hadBrief: true, moves: [], main: true, vps: briefVpLines(main, all), issues: ['- names no task: x'] })
    expect(prompt).toContain('names two tasks: first the <task-ref id="..." label="..."/> of the task doing the work, then the <task-ref/> of the VP who leads it')
    expect(prompt).toContain(`Your VPs:\n- ${ref(vp)} leads Lighthouse`)
    expect(prompt).toContain('Walnut found these lines of your last Brief breaking the rules')
    expect(prompt).toContain('One thing per line')
    expect(prompt).toContain('which document, repo or release')
  })

  it('the rewrite ask carries the Brief, the VPs, the moves and the language, and ends on the field', () => {
    const ask = briefFixPrompt({
      text: '- The docs sync can be pushed.', issues: [{ kind: 'no_task', line: '- The docs sync can be pushed.' }], main: true,
      vps: briefVpLines(main, all), moves: [`- ${ref(fence)}: now Working`], language: 'Chinese', ownId: 'main',
    })
    expect(ask).toContain('- names no task (start it with the <task-ref/> of the task it is about): - The docs sync can be pushed.')
    expect(ask).toContain('<brief>\n- The docs sync can be pushed.\n</brief>')
    expect(ask).toContain('keeping every line that is right as it is, in Chinese')
    expect(ask).toContain('then the <task-ref/> of the VP who leads it')
    expect(ask).toContain(`Your VPs:\n- ${ref(vp)} leads Lighthouse`)
    expect(ask).toContain(`What moved in your team since your last Brief:\n- ${ref(fence)}: now Working`)
    expect(ask).toMatch(/FOR_USER_BRIEF:\n<the letter>$/)
  })

  it('re-asks only for a new line with no task or no VP', () => {
    const noTask = { kind: 'no_task' as const, line: '- a' }
    expect(briefNeedsRewrite([noTask], undefined)).toBe(true)
    expect(briefNeedsRewrite([noTask], [noTask])).toBe(false)
    expect(briefNeedsRewrite([{ kind: 'several_things', line: '- b' }], undefined)).toBe(false)
    expect(briefNeedsRewrite([], undefined)).toBe(false)
  })

  it('never asks for a VP whose lead is complete', () => {
    const doneVp = { ...vp, phase: 'COMPLETE' } as Task
    expect(briefIssues(`- ${ref(docSync)}: approve the docs sync push.`, main, [main, doneVp, docSync])).toEqual([])
    expect(briefVpLines(main, [main, doneVp])).toEqual([])
  })
})

describe('completeBriefRefs', () => {
  const tasks = [{ id: '65c5766d-1d2d-5bc5-ad1c-6ca835bab8b0' }, { id: 'mvm0n3bu-6910' }, { id: 'abc123-1111' }, { id: 'abc123-2222' }]
  // 2026-10-27: Main named a task by the head of its id, and its pill showed no live status.
  it('writes out a ref named by the head of one task id, and leaves the rest as written', () => {
    const brief = { text: '- <task-ref id="65c5766d" label="Phones & Cloud"/> <task-ref id="mvm0n3bu-6910" label="Walnut lead"/>: pick a layout.\n- <task-ref id="abc123" label="Two share this head"/>: x\n- <task-ref id="nope99" label="None"/>: y\n- <task-ref id="65c5" label="Too short"/>: z', at: '2026-10-27T16:00:00Z' }
    const out = completeBriefRefs(brief, tasks)
    expect(out.text).toContain('id="65c5766d-1d2d-5bc5-ad1c-6ca835bab8b0" label="Phones & Cloud"')
    expect(out.text).toContain('id="mvm0n3bu-6910"')
    expect(out.text).toContain('id="abc123" label="Two share this head"')
    expect(out.text).toContain('id="nope99"')
    expect(out.text).toContain('id="65c5" label="Too short"')
    expect(out.at).toBe(brief.at)
    // Nothing to complete: the same object.
    const whole = { text: '- <task-ref id="mvm0n3bu-6910" label="Walnut lead"/>: ok', at: 'x' }
    expect(completeBriefRefs(whole, tasks)).toBe(whole)
  })
})
