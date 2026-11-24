import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { needsSummary } from '../../../src/core/approvals/summary.js'
import { contextFromRows, contextSummary, cutTo, goalOf, ASKER_STEPS, WHY_MAX } from '../../../src/core/approvals/asker-context.js'

const said = (text: string) => ({ role: 'assistant', text })
const tool = (text: string, detail?: string) => ({ role: 'assistant', text, kind: 'tool', ...(detail ? { detail } : {}) })
const user = (text: string) => ({ role: 'user', text })

describe('the context an approval shows', () => {
  it('reads the last three steps before the request, oldest first, and the last words as why', () => {
    const rows = [
      user('ship it'),
      tool('Bash', 'npm test'),
      said('Tests pass. I will publish the prompt now so the site picks it up.'),
      tool('Edit', 'site/prompt.md'),
      tool('Bash', 'git log -1 --oneline'),
      tool('Bash', 'walnut approve "Push the prompt" --detail -'),
    ]
    const ctx = contextFromRows(rows)
    expect(ctx.steps).toEqual([
      { kind: 'said', text: 'Tests pass. I will publish the prompt now so the site picks it up.' },
      { kind: 'edited', text: 'site/prompt.md' },
      { kind: 'ran', text: 'git log -1 --oneline' },
    ])
    expect(ctx.why).toBe('Tests pass. I will publish the prompt now so the site picks it up.')
    expect(ctx.whyFrom).toBe('session')
  })

  it('an MCP approval call is not a step either, and the steps stop at the turn that asked', () => {
    const rows = [said('old turn words'), user('go'), tool('mcp__walnut__task_get', 'abc'), tool('mcp__walnut__approval_request')]
    const ctx = contextFromRows(rows)
    expect(ctx.steps).toEqual([{ kind: 'tool', text: 'task_get abc' }])
    // Why still comes from its words, the last ones before the request.
    expect(ctx.why).toBe('old turn words')
  })

  it("the asker's own why wins and is cut to two lines", () => {
    const long = 'word '.repeat(100)
    const ctx = contextFromRows([said('something else')], long)
    expect(ctx.whyFrom).toBe('asker')
    expect(ctx.why!.length).toBeLessThanOrEqual(WHY_MAX)
    expect(ctx.why!.endsWith('…')).toBe(true)
  })

  it('a long last message gives its end, starting at a sentence', () => {
    const text = `${'Earlier context sentence here. '.repeat(12)}Now I push the build to the store.`
    const ctx = contextFromRows([said(text)])
    expect(ctx.why!.length).toBeLessThanOrEqual(WHY_MAX + 1)
    expect(ctx.why!.endsWith('Now I push the build to the store.')).toBe(true)
  })

  it('no transcript (a script outside a session): nothing is made up', () => {
    expect(contextFromRows(undefined)).toEqual({})
    expect(contextFromRows([], 'release check')).toEqual({ why: 'release check', whyFrom: 'asker' })
  })

  it(`keeps at most ${ASKER_STEPS} steps`, () => {
    const rows = Array.from({ length: 8 }, (_, i) => tool('Bash', `step ${i}`))
    expect(contextFromRows(rows).steps!.map((s) => s.text)).toEqual(['step 5', 'step 6', 'step 7'])
  })

  it('the goal is the first sentence of the description, else of the summary', () => {
    expect(goalOf({ description: '## Rebuild the world in Go. Then publish.', summary: 'x' })).toBe('Rebuild the world in Go.')
    expect(goalOf({ description: '', summary: 'Ships the site. More.' })).toBe('Ships the site.')
    expect(goalOf({})).toBeUndefined()
    expect(cutTo('a '.repeat(200), 20).length).toBeLessThanOrEqual(20)
  })

  it('summarises as plain lines for a signed envelope', () => {
    expect(contextSummary({ why: 'w', whyFrom: 'asker', goal: 'g', project: 'Walnut', steps: [{ kind: 'ran', text: 'ls' }] }))
      .toBe('Why (given): w\nGoal: g\nProject: Walnut\nRan: ls')
  })

  // 2026-11-14: a Git push's approval read "why: <walnut-turn status="agent-ack"/>" on the phone.
  it('a Walnut control line is never the reason: an agent-ack turn gives none, the turn before it does', () => {
    const ack = said('<walnut-turn status="agent-ack"/>')
    const rows = [said('Publishing the two tracking commits so the table is current.'), tool('Bash', 'git status'), ack]
    const ctx = contextFromRows(rows)
    expect(ctx).toMatchObject({ why: 'Publishing the two tracking commits so the table is current.', whyFrom: 'session' })
    expect(JSON.stringify(ctx)).not.toContain('walnut-turn')
    expect(contextSummary({ ...ctx })).not.toMatch(/walnut-/)
    // Only control lines: no reason at all, and no step that says one.
    const only = contextFromRows([ack, said('<walnut-message kind="peer-note" from="x">note</walnut-message>')])
    expect(only.why).toBeUndefined()
    expect(only.steps ?? []).toEqual([])
    // Words beside a control line keep only the words; an asker's own why is cleaned the same way.
    expect(contextFromRows([said('Pushing now. <walnut-turn status="done"/>')]).why).toBe('Pushing now.')
    expect(contextFromRows([], '<walnut-turn status="agent-ack"/> Release check').why).toBe('Release check')
  })

  // 2026-11-24: an agent's `walnut approve --why` in English showed as it was in the dialog.
  it('an asker\'s why in another language than his setting is not shown: Walnut writes the summary in his', () => {
    const en = 'Publishes the new prompt so the site picks it up today.'
    const zh = '把新的提示词发布到网站上，今天就能生效。'
    const other = contextFromRows([], en, 'han')
    expect(other).toEqual({ why: en, whyFrom: 'asker_other' })
    expect(needsSummary({ status: 'pending', context: other })).toBe(true)
    expect(contextSummary(other)).toContain(`Why (given): ${en}`)
    expect(contextFromRows([], zh, 'han').whyFrom).toBe('asker')
    // No setting (or the experiment off): the asker's words are shown as before.
    expect(contextFromRows([], en, null).whyFrom).toBe('asker')
    expect(needsSummary({ status: 'pending', context: contextFromRows([], zh, 'han') })).toBe(false)
  })
})

/**
 * Class guard: a reason marked anything but `asker` is never shown as the asker's own, on every
 * surface (the web dialog, the phone, the push, the summary writer, the store). Each reads `whyFrom`
 * only against 'asker', so a new value (asker_other) reads as "Walnut's summary"; a reading that
 * names another value fails here.
 */
describe('every reader of whyFrom tells only asker apart (guard)', () => {
  const ROOT = path.resolve(__dirname, '../../..')
  const walk = (d: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p, out)
      else if (/\.(ts|tsx|swift)$/.test(e.name)) out.push(p)
    }
    return out
  }
  it('compares whyFrom only with asker', () => {
    const bad: string[] = []
    for (const dir of ['src', 'web/src', 'ios-native/Walnut']) {
      for (const f of walk(path.join(ROOT, dir))) {
        const rel = path.relative(ROOT, f)
        for (const m of fs.readFileSync(f, 'utf8').matchAll(/whyFrom\s*[!=]==?\s*['"]([a-z_]+)['"]/g)) {
          if (m[1] !== 'asker' && !(rel === 'src/core/approvals/asker-context.ts' && m[1] === 'session')) bad.push(`${rel}: ${m[0]}`)
        }
      }
    }
    expect(bad).toEqual([])
  })
})
