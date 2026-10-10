/**
 * line-consumption: queue rows written into a CLI that reports its command
 * queue stay queued until the CLI says what it did with their line, and go back
 * to the queue when the process that held them dies first. Nothing but the
 * CLI's own word (or an observed death) settles a line: no turn count, no timer.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  announceReclaimed, awaitLine, dropLine, hasUntakenLines, heldRows, markUnconfirmed, noteHeld, noteLineState,
  onLinesReclaimed, releaseHeld, resetLineConsumption, takeLine, takeUntold, untakenLines,
} from '../../src/providers/line-consumption.js'
import type { QueuedMessage } from '../../src/core/session-message-queue.js'

const row = (id: string): QueuedMessage => ({
  id, sessionId: 's1', message: id, enqueuedAt: new Date(0).toISOString(), status: 'processing',
} as QueuedMessage)

describe('line-consumption', () => {
  beforeEach(() => resetLineConsumption())

  it('a line the CLI names hands back its rows once', () => {
    expect(awaitLine('s1', 'u1', [row('a'), row('b')], 10)).toBeUndefined()
    expect(takeLine('s1', 'u1').map((r) => r.id)).toEqual(['a', 'b'])
    expect(takeLine('s1', 'u1')).toEqual([])
  })

  it('a failed write forgets the line', () => {
    awaitLine('s1', 'u1', [row('a')], 10)
    dropLine('s1', 'u1')
    expect(hasUntakenLines('s1')).toBe(false)
    expect(untakenLines('s1')).toEqual([])
  })

  it('no turn end settles a line: it waits for the CLI or a death', () => {
    awaitLine('s1', 'u1', [row('a')], 10)
    // (r1 counted a line taken at the next turn end; that silently dropped a
    // line the CLI still had queued when its process died later.)
    expect(hasUntakenLines('s1')).toBe(true)
    expect(untakenLines('s1', 10).map((l) => l.uuid)).toEqual(['u1'])
  })

  it('a report that beats the registration is not lost', () => {
    noteLineState('s1', 'u1', 'started')
    expect(awaitLine('s1', 'u1', [row('a')], 10)).toBe('started')
    // Nothing is registered: the caller settled the rows at once.
    expect(hasUntakenLines('s1')).toBe(false)
  })

  it('a queued report does not settle a line', () => {
    noteLineState('s1', 'u1', 'queued')
    expect(awaitLine('s1', 'u1', [row('a')], 10)).toBeUndefined()
    expect(hasUntakenLines('s1')).toBe(true)
  })

  it('discarded and refused are reported as such (never as taken)', () => {
    noteLineState('s1', 'd', 'discarded')
    noteLineState('s1', 'r', 'refused')
    expect(awaitLine('s1', 'd', [row('a')], 10)).toBe('discarded')
    expect(awaitLine('s1', 'r', [row('b')], 10)).toBe('refused')
  })

  it('a death reclaims only the lines written into that process, oldest first', () => {
    awaitLine('s1', 'old', [row('a')], 10)
    awaitLine('s1', 'unknown-pid', [row('b')], null)
    awaitLine('s1', 'new', [row('c')], 11)
    expect(untakenLines('s1', 10)).toEqual([
      { uuid: 'old', rows: [row('a')] },
      { uuid: 'unknown-pid', rows: [row('b')] },
    ])
    expect(untakenLines('s1').map((l) => l.uuid)).toEqual(['new'])
  })

  it('a pid-less death reclaims every line', () => {
    awaitLine('s1', 'x', [row('a')], 10)
    awaitLine('s1', 'y', [row('b')], 11)
    expect(untakenLines('s1', null).map((l) => l.uuid)).toEqual(['x', 'y'])
  })

  it('a row is reported delivered once, and again only after the user was told it is unconfirmed', () => {
    expect(takeUntold('s1', ['a', 'b'])).toEqual(['a', 'b'])
    expect(takeUntold('s1', ['a', 'c'])).toEqual(['c'])
    expect(takeUntold('s1', ['a', 'b', 'c'])).toEqual([])
    markUnconfirmed('s1', ['b'])
    expect(takeUntold('s1', ['a', 'b'])).toEqual(['b'])
    expect(takeUntold('s2', ['a'])).toEqual(['a'])
    expect(takeUntold('s1', ['d', 'd'])).toEqual(['d'])
    resetLineConsumption()
    expect(takeUntold('s1', ['a'])).toEqual(['a'])
  })

  it('P4: past the bound the oldest line is handed to the caller, never left behind', () => {
    const evicted: string[][] = []
    for (let i = 0; i < 65; i++) {
      awaitLine('s1', `u${i}`, [row(`r${i}`)], 10, (rows) => evicted.push(rows.map((r) => r.id)))
    }
    expect(evicted).toEqual([['r0']])
    expect(takeLine('s1', 'u0')).toEqual([])
    expect(untakenLines('s1')).toHaveLength(64)
  })

  it('held rows: noted with their reason, released by id, cleared by a reset', () => {
    noteHeld('s1', ['a', 'b'], 'Waiting to confirm the previous message')
    expect([...(heldRows('s1') ?? new Map()).keys()]).toEqual(['a', 'b'])
    releaseHeld('s1', ['a'])
    expect(heldRows('s1')?.get('b')).toBe('Waiting to confirm the previous message')
    expect(heldRows('s1')?.has('a')).toBe(false)
    releaseHeld('s1', ['b'])
    expect(heldRows('s1')).toBeUndefined()
    noteHeld('s1', ['c'], 'x')
    resetLineConsumption()
    expect(heldRows('s1')).toBeUndefined()
  })

  it('announces reclaimed lines to the one registered listener', () => {
    const heard: string[] = []
    const stop = onLinesReclaimed((sid) => heard.push(sid))
    announceReclaimed('s1')
    stop()
    announceReclaimed('s2')
    expect(heard).toEqual(['s1'])
  })
})
