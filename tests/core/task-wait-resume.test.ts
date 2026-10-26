/**
 * The pure rules of src/core/task-wait-resume.ts: which turn only interrupts a
 * wait, and which trigger states let it come back. The end-to-end paths are in
 * tests/e2e/task-wait-resume.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { dropFireTurn, noteTurnSend, takeFireTurn, triggersHoldWait, triggersStanding, waitExitCause } from '../../src/core/task-wait-resume.js'
import { isPersonSendSource, REOPENING_SEND_SOURCES } from '../../src/core/phase.js'

describe('waitExitCause', () => {
  it('a peer, a status notice or a nudge only interrupts', () => {
    for (const source of ['peer', 'walnut-notify', 'auto-continue', 'auto-recover']) {
      expect(waitExitCause('session:input', source), source).toBe('message')
    }
  })

  it('the same sources carrying what the task waited for (a reply, a finished subtask) end it', () => {
    for (const source of ['peer', 'walnut-notify']) expect(waitExitCause('session:input', source, true), source).toBeNull()
  })

  it('a turn the CLI starts itself only interrupts', () => {
    expect(waitExitCause('session:turn-start', undefined)).toBe('self')
  })

  it('a person, the wait\'s own exits and unknown sources end it for good', () => {
    for (const source of ['ui', 'mobile', 'cli', 'web-api', 'api-v1', 'chat', 'human-inbox',
      'wait-until', 'routine-trigger', 'routine-watcher', 'routine', 'trigger-host-delivery', 'session-start',
      'restart', 'retry', 'hook:digest', 'unknown', undefined]) {
      expect(waitExitCause('session:input', source), String(source)).toBeNull()
    }
  })

  it('no other trigger records an exit', () => {
    for (const trigger of ['session:result', 'session:error', 'session:awaiting-human', 'session:human-answered', 'reconciler']) {
      expect(waitExitCause(trigger, 'peer'), trigger).toBeNull()
    }
  })
})

describe('isPersonSendSource', () => {
  it('is every reopening source but a peer task\'s', () => {
    for (const source of REOPENING_SEND_SOURCES) expect(isPersonSendSource(source), source).toBe(source !== 'peer')
    expect(isPersonSendSource(undefined)).toBe(false)
    expect(isPersonSendSource('walnut-notify')).toBe(false)
  })
})

describe('triggersHoldWait', () => {
  it('needs an armed trigger and no stopped one', () => {
    expect(triggersHoldWait([])).toBe(false)
    expect(triggersHoldWait([{ state: 'armed' }])).toBe(true)
    expect(triggersHoldWait([{ state: 'paused' }])).toBe(false)
    expect(triggersHoldWait([{ state: 'armed' }, { state: 'paused' }])).toBe(true)
    expect(triggersHoldWait([{ state: 'armed' }, { state: 'stopped' }])).toBe(false)
    expect(triggersHoldWait([{ state: 'stopped' }])).toBe(false)
  })

  it('a trigger that fired since the wait was left ends it; one born since, or unknown counts, do not', () => {
    const at = { t1: 3 }
    expect(triggersHoldWait([{ id: 't1', state: 'armed', fires: 3 }], at)).toBe(true)
    expect(triggersHoldWait([{ id: 't1', state: 'armed', fires: 4 }], at)).toBe(false)
    expect(triggersHoldWait([{ id: 't1', state: 'armed', fires: 3 }, { id: 't2', state: 'armed', fires: 1 }], at)).toBe(true)
    expect(triggersHoldWait([{ id: 't1', state: 'armed', fires: 9 }], undefined)).toBe(true)
  })
})

describe('a standing routine\'s fire turn', () => {
  const HOUR = 3600_000
  it('remembers the clock the fire found, once, and only a future one', () => {
    const later = new Date(Date.now() + HOUR).toISOString()
    noteTurnSend('r1', true, false, later)
    expect(takeFireTurn('r1')).toEqual({ waitUntil: later })
    expect(takeFireTurn('r1')).toBeNull()
    noteTurnSend('r2', true, false, new Date(Date.now() - 1000).toISOString())
    expect(takeFireTurn('r2')).toEqual({ waitUntil: null })
  })
  it('a person\'s message, an error or a prompt makes the turn no routine\'s', () => {
    noteTurnSend('r3', true, false, null)
    noteTurnSend('r3', false, false)
    expect(takeFireTurn('r3')).not.toBeNull()
    noteTurnSend('r4', true, false, null)
    noteTurnSend('r4', false, true)
    expect(takeFireTurn('r4')).toBeNull()
    noteTurnSend('r5', true, false, null)
    dropFireTurn('r5')
    expect(takeFireTurn('r5')).toBeNull()
  })
  it('a marker older than a fire turn can last is not trusted', () => {
    noteTurnSend('r6', true, false, null)
    expect(takeFireTurn('r6', Date.now() + 7 * HOUR)).toBeNull()
  })
  it('only a trigger that fired before stands', () => {
    expect(triggersStanding([{ state: 'armed', fires: 1 }])).toBe(false)
    expect(triggersStanding([{ state: 'armed', fires: 2 }])).toBe(true)
    expect(triggersStanding([{ state: 'armed', fires: 5 }, { state: 'stopped', fires: 1 }])).toBe(false)
  })
})
