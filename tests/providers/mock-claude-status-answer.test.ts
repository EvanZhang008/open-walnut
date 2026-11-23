/**
 * The mock CLI answers every question that asks for the status lines (FOR_USER_PROMPT) with lines
 * Walnut reads, as a real model does. 2026-11-23: it echoed "Side title: ..." to Walnut's turn-end
 * status question, so every fixture turn read "Waiting: its report on the turn that just ended" for
 * the summary's four-minute quiet window, and two browser specs' hand-back checks stayed red for
 * weeks. Each prompt Walnut builds with the status lines is asked here of the mock's own answer
 * (mock-claude-side-answer.mjs, which the mock CLI answers every side_question with), and a new
 * source file that builds one must join the list.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { sideQuestionAnswer } from './mock-claude-side-answer.mjs'
import { FOR_USER_PROMPT, buildSelfReportPrompt, readStatusReport } from '../../src/core/session-hooks/builtins.js'
import { buildStatusPrompt } from '../../src/core/sessions/status-question.js'
import { unclearAskRetry } from '../../src/core/sessions/unclear-ask.js'

const ROOT = path.resolve(import.meta.dirname, '../..')

/** Every prompt Walnut asks a session that carries the status lines, by the file that builds it. */
const STATUS_PROMPTS: Record<string, Array<[string, () => string]>> = {
  'src/core/sessions/status-question.ts': [
    ['the turn-end status question', () => buildStatusPrompt(FOR_USER_PROMPT, 'Fixture task')],
  ],
  'src/core/session-hooks/builtins.ts': [
    ['the summary with the status lines', () => buildSelfReportPrompt('', 'Fixture task', { status: true })],
  ],
  'src/core/sessions/unclear-ask.ts': [
    ['the unclear-ask retry', () => unclearAskRetry(buildStatusPrompt(FOR_USER_PROMPT, 'Fixture task'), 'It named no kind.')],
  ],
}
/** Files that name FOR_USER_PROMPT without building a question from it. */
const NOT_A_QUESTION = new Set(['src/lib/internal-lines.ts'])

const ask = (question: string): string => sideQuestionAnswer(question) as string

describe('the mock CLI answers the status lines wherever Walnut asks for them', () => {
  const cases = Object.entries(STATUS_PROMPTS).flatMap(([file, list]) => list.map(([label, build]) => [file, label, build] as const))

  it.each(cases)('%s: %s reads as a status report', (_file, _label, build) => {
    const prompt = build()
    expect(prompt).toContain('FOR_USER_STATE:')
    const answer = ask(prompt)
    expect(readStatusReport(answer), `answer: ${answer.slice(0, 300)}`).toMatchObject({ state: 'done' })
  })

  it('a question without the status lines gets none', () => {
    expect(ask('Reply with a short title for this session.')).not.toContain('FOR_USER_STATE')
  })

  it('the mock CLI answers every side_question with it', () => {
    const src = fs.readFileSync(path.join(ROOT, 'tests/providers/mock-claude.mjs'), 'utf-8')
    expect(src).toMatch(/subtype === 'side_question'\) \{[\s\S]{0,400}sideQuestionAnswer\(/)
  })

  it('every source file that builds a question with the status lines is listed', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name) && /\bFOR_USER_PROMPT\b/.test(fs.readFileSync(p, 'utf-8'))) files.push(path.relative(ROOT, p))
      }
    }
    walk(path.join(ROOT, 'src'))
    // unclear-ask.ts rebuilds a prompt its caller passes in, so it never names the constant.
    const missing = files.filter((f) => !STATUS_PROMPTS[f] && !NOT_A_QUESTION.has(f))
    expect(missing, 'list each new prompt in STATUS_PROMPTS so the mock is checked against it').toEqual([])
  })
})
