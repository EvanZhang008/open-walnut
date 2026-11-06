/**
 * Every op that takes a review's `score` reads it by the one rule the HTTP routes and the offline
 * host use (src/ops/review-score-input.ts, structured-reply.ts scoreProblem): keys in any case,
 * "n/n/n" text, and a part that cannot be read is refused, never dropped. 2026-11-06: task_send
 * took {"function":9,"UX":8,"UI":7} and kept only the function score.
 */
import { describe, expect, it } from 'vitest'
import { listOps, opInputJsonSchema, parseOpArgs } from '../../../src/ops/index.js'
import { readScore } from '../../../src/core/peers/structured-reply.js'

const scoreOps = listOps({ includeDeprecated: true }).filter((op) => op.input && 'score' in op.input)

describe('ops taking a review score', () => {
  it('are the ones this test knows (a new one is checked by the same rule)', () => {
    expect(scoreOps.map((op) => op.name).sort()).toEqual(['session_send', 'task_complete', 'task_send'])
  })

  for (const op of scoreOps) {
    const base = op.name === 'task_complete' ? { id: 'mtask-0001' } : { in_reply_to: 'rq-0123456789ab', text: 'ok' }
    it(`${op.name}: every score is kept whole or refused`, () => {
      const cases: unknown[] = [
        { function: 9, UX: 8, UI: 7 }, { Function: '9', ux: '8/10', ui: 7 }, '9/8/7', '9 | 8 | 7',
        { function: 9, ux: 8, ui: 7, design: 2 }, { ui: 11 }, '10/9/11', '10//9/9', '9/8', {}, [9, 8, 7], 9,
      ]
      for (const score of cases) {
        const r = parseOpArgs(op, { ...base, score })
        if (!r.ok) continue
        // Taken: what reaches the server reads as the same three parts the caller meant.
        const read = readScore(r.args.score)
        const given = typeof score === 'string' ? 3 : Object.keys(score as object).length
        expect(read && Object.keys(read).length, JSON.stringify(score)).toBe(given)
      }
      expect(parseOpArgs(op, { ...base, score: { function: 9, UX: 8, UI: 7 } }).ok).toBe(true)
      expect(parseOpArgs(op, { ...base, score: '9/8/7' }).ok).toBe(true)
      expect(parseOpArgs(op, { ...base, score: { function: 9, ux: 8, ui: 7, design: 2 } }).ok).toBe(false)
      expect(parseOpArgs(op, { ...base, score: '10/9/11' }).ok).toBe(false)
    })
    it(`${op.name}: its input still has a JSON schema`, () => {
      const schema = opInputJsonSchema(op) as { properties?: Record<string, unknown> }
      expect(schema.properties?.score).toBeTruthy()
    })
  }
})
