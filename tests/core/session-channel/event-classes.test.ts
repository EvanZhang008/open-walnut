/**
 * Every session and transfer event has a channel class (src/core/session-channel/event-classes.ts):
 * a new event in event-bus.ts fails here until it is classed as a fact, flow, the leader's own,
 * or a command.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { SESSION_EVENT_CLASS, TURN_DETAIL_FACTS, TURN_END_FACT } from '../../../src/core/session-channel/event-classes.js'

const src = fs.readFileSync(path.resolve(__dirname, '../../../src/core/event-bus.ts'), 'utf8')
const names = [...src.matchAll(/^\s+(?:SESSION|TRANSFER)_[A-Z_]+:\s*'([^']+)'/gm)].map((m) => m[1])

describe('session event classes', () => {
  it('names every session and transfer event of event-bus.ts, and nothing else', () => {
    expect(names.length).toBeGreaterThan(30)
    expect(Object.keys(SESSION_EVENT_CLASS).sort()).toEqual([...new Set(names)].sort())
  })

  it('the text deltas are flow; a turn end and a permission request are facts', () => {
    expect(SESSION_EVENT_CLASS['session:text-delta']).toBe('flow')
    expect(SESSION_EVENT_CLASS['session:thinking-delta']).toBe('flow')
    for (const n of ['session:result', 'session:permission-request', 'session:permission-resolved', 'session:tool-use', 'session:tool-result', 'session:usage-update', 'session:user-line']) {
      expect(SESSION_EVENT_CLASS[n], n).toBe('fact')
    }
  })

  it('what a turn summary stands for are facts, and the turn end is a fact it never folds', () => {
    for (const n of TURN_DETAIL_FACTS) expect(SESSION_EVENT_CLASS[n], n).toBe('fact')
    expect(TURN_DETAIL_FACTS.has(TURN_END_FACT)).toBe(false)
    expect(TURN_DETAIL_FACTS.has('session:permission-request')).toBe(false)
  })
})
