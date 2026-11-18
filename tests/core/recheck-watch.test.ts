/**
 * The record of a trigger that stands in for a re-check (src/core/sessions/recheck-watch.ts):
 * what `watches` may name, how a new watch replaces the old one for the same trigger, and that only
 * a live trigger counts.
 */
import { describe, it, expect } from 'vitest'
import { watchedBy, withWatch } from '../../src/core/sessions/recheck-watch.js'
import { parseTriggerWatch } from '../../src/core/routines/trigger-watches.js'

describe('recheck watch', () => {
  it('accepts "ask", a letter id or "own", nothing else', () => {
    expect(parseTriggerWatch('ask')).toEqual({ kind: 'user', what: 'ask' })
    expect(parseTriggerWatch(' lt-mvszyub6-c1ec46 ')).toEqual({ kind: 'user', what: 'lt-mvszyub6-c1ec46' })
    expect(parseTriggerWatch(' own ')).toEqual({ kind: 'own' })
    for (const none of ['', null, undefined]) expect(parseTriggerWatch(none)).toBeNull()
    for (const bad of ['the ask', 'rq-1234', 'lt-', 42, 'owned']) expect(parseTriggerWatch(bad)).toBe('invalid')
  })

  it('counts a watch only while its trigger is live', () => {
    const task = { recheck_watch: [{ trigger: 'tr-1', watches: 'ask', at: '2026-10-29T00:00:00Z' }] }
    expect(watchedBy(task, 'ask', new Set(['tr-1']))?.trigger).toBe('tr-1')
    expect(watchedBy(task, 'ask', new Set())).toBeUndefined()
    expect(watchedBy(task, 'lt-abcd', new Set(['tr-1']))).toBeUndefined()
    expect(watchedBy({}, 'ask', new Set(['tr-1']))).toBeUndefined()
  })

  it('a new watch of the same trigger replaces the old one, and gone triggers are dropped', () => {
    const at = '2026-10-29T00:00:00Z'
    const cur = [{ trigger: 'tr-1', watches: 'ask', at }, { trigger: 'tr-gone', watches: 'lt-abcd', at }]
    expect(withWatch(cur, { trigger: 'tr-1', watches: 'lt-efgh', at }, new Set(['tr-1']))).toEqual([{ trigger: 'tr-1', watches: 'lt-efgh', at }])
    expect(withWatch(null, { trigger: 'tr-2', watches: 'ask', at })).toEqual([{ trigger: 'tr-2', watches: 'ask', at }])
  })
})
