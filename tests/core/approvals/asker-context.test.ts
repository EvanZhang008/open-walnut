import { describe, expect, it } from 'vitest'
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
})
