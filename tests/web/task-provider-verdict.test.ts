/**
 * Settings › Task providers: the test line's words and tone for every state of a typed title
 * (web/src/components/settings/sections/task-provider-parts.tsx), and the stored rule list.
 */
import { describe, expect, it } from 'vitest'
import { verdictOf, wordsFromText } from '../../web/src/components/settings/sections/task-provider-parts'

describe('task provider test line', () => {
  const base = { sample: 'Fix the login retry', hardMatch: null, ai: true, answer: null } as const

  it('says what to do before anything is typed', () => {
    expect(verdictOf({ ...base, sample: '  ' })).toEqual({ tone: 'idle', text: 'Type a task title to see whether it may sync' })
  })

  it('a hard rule decides before the AI is asked', () => {
    expect(verdictOf({ ...base, hardMatch: 'salary', answer: { pass: true, reason: 'x' } })).toEqual({ tone: 'fail', text: 'Fails the hard rule "salary"' })
  })

  it('with the AI rule off, passing the hard rules passes', () => {
    expect(verdictOf({ ...base, ai: false })).toEqual({ tone: 'pass', text: 'Passes the hard rules' })
  })

  it('walks the AI states: not asked, asking, no answer, pass, fail', () => {
    expect(verdictOf(base).tone).toBe('pending')
    expect(verdictOf({ ...base, answer: 'asking' }).text).toBe('Passes the hard rules, asking the AI')
    expect(verdictOf({ ...base, answer: { error: 'timed out' } })).toEqual({ tone: 'pending', text: 'Passes the hard rules. The AI did not answer: timed out' })
    expect(verdictOf({ ...base, answer: { pass: true, reason: 'team work' } })).toEqual({ tone: 'pass', text: 'Passes both rules. AI: team work' })
    expect(verdictOf({ ...base, answer: { pass: false, reason: 'about pay' } })).toEqual({ tone: 'fail', text: 'Fails the AI rule: about pay' })
  })

  it('a pasted list becomes one rule per line, trimmed, no repeats', () => {
    expect(wordsFromText('salary\n  side project \n\nsalary\n/\\bcodename-\\w+/')).toEqual(['salary', 'side project', '/\\bcodename-\\w+/'])
  })
})
