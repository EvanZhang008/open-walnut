/**
 * One list of the engines that can carry a budget (src/core/usage/budget-engines.ts),
 * read by the server route and the web client; the daemon keeps its own copy because
 * its runtime is bundled on its own. 2026-10-30: the client asked every session for a
 * budget and every Gemini, Goose, Pi and DeepSeek panel logged a 400.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { BUDGET_ENGINES, engineHasBudget } from '../../../src/core/usage/budget-engines.js'
import { SESSION_ENGINE_IDS } from '../../../src/core/types.js'

const REPO = path.resolve(import.meta.dirname, '..', '..', '..')

describe('budget engines', () => {
  it("the daemon's copy names the same engines", () => {
    const runtime = fs.readFileSync(path.join(REPO, 'src/providers/usage-budget-runtime.ts'), 'utf-8')
    const m = /^const BUDGET_ENGINES = \[([^\]]*)\];/m.exec(runtime)
    expect(m, 'BUDGET_ENGINES in usage-budget-runtime.ts').not.toBeNull()
    expect(m![1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean)).toEqual([...BUDGET_ENGINES])
  })

  it('every engine is either budgeted or not, and a session with no engine is Claude Code', () => {
    for (const id of SESSION_ENGINE_IDS) expect(typeof engineHasBudget(id)).toBe('boolean')
    expect(engineHasBudget(undefined)).toBe(true)
    expect(engineHasBudget('gemini')).toBe(false)
    for (const id of BUDGET_ENGINES) expect(SESSION_ENGINE_IDS as readonly string[]).toContain(id)
  })

  it('the web hook asks for a budget only for a budgeted engine', () => {
    const hook = fs.readFileSync(path.join(REPO, 'web/src/hooks/useSessionBudgetUsage.ts'), 'utf-8')
    expect(hook).toContain("from '@open-walnut/budget-engines'")
    expect(hook).toMatch(/noBudget \? Promise\.resolve\(null\) : sessionUsageStore\.refresh/)
  })
})
