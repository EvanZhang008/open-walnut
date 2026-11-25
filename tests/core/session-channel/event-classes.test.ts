/**
 * Every session and transfer event has a channel class (src/core/session-channel/event-classes.ts):
 * a new event in event-bus.ts fails here until it is classed as a fact, flow, the leader's own,
 * or a command.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { SESSION_EVENT_CLASS, SNAPSHOT_FACTS, TURN_DETAIL_FACTS, TURN_END_FACT } from '../../../src/core/session-channel/event-classes.js'

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

/**
 * The facts each of whose records says something of its own (an event, a step, a change), so
 * compaction keeps every one. A fact whose payload is the whole state of its session instead goes
 * in SNAPSHOT_FACTS (newest wins). A new fact fails here until it is put in one of the two:
 * 2026-11-25, unread snapshots of one running turn grew the host's log to 102 MB.
 */
const KEPT_WHOLE = [
  'session:started', 'session:ended', 'session:result', 'session:error', 'transfer:fork-init', 'session:will-reap',
  'session:tool-use', 'session:tool-result', 'session:unknown-event', 'session:usage-limit', 'session:messages-delivered',
  'session:queued-cancelled', 'session:batch-completed', 'session:batch-failed', 'session:delivery-held',
  'session:message-queued', 'session:system-event', 'session:user-line', 'session:usage-update',
  'session:settings-applied', 'session:controls-changed', 'session:turn-settled', 'session:retry-over',
  'session:permission-request', 'session:permission-resolved', 'session:cron-fired', 'session:side-question-done',
  'session:side-thread-renamed', 'session:side-question-error',
]

describe('every fact is kept whole or is a snapshot (fact-log.ts compaction)', () => {
  it('names each fact once, in one of the two', () => {
    const facts = Object.entries(SESSION_EVENT_CLASS).filter(([, c]) => c === 'fact').map(([n]) => n).sort()
    for (const n of SNAPSHOT_FACTS) expect(SESSION_EVENT_CLASS[n], n).toBe('fact')
    expect(KEPT_WHOLE.filter((n) => SNAPSHOT_FACTS.has(n))).toEqual([])
    expect([...KEPT_WHOLE, ...SNAPSHOT_FACTS].sort()).toEqual(facts)
  })
})
