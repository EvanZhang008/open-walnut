/**
 * The pure rules of src/core/task-wait-resume.ts: which turn only interrupts a
 * wait, and which trigger states let it come back. The end-to-end paths are in
 * tests/e2e/task-wait-resume.test.ts.
 */
import { describe, it, expect, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

// noteInterruptedWait reads the task's triggers in the background: keep that off the real data home.
vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-wait-resume-unit'))

import {
  classifyInjectedLine, dropFireTurn, interruptedWaits, noteInjectedLine, noteInterruptedWait, noteTurnSend,
  resetInterruptedWaitsForTest, strongerLine, takeFireTurn, triggersHoldWait, triggersStanding, waitExitCause,
} from '../../src/core/task-wait-resume.js'
import { createEnvelopeKit } from '../../src/core/peers/envelope-kit.js'
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

  it('a turn opened by a line its host delivered is the line\'s: a peer\'s or a notice\'s only interrupts', () => {
    expect(waitExitCause('session:turn-start', undefined, false, 'peer')).toBe('message')
    expect(waitExitCause('session:turn-start', undefined, false, 'walnut-notify')).toBe('message')
  })

  it('what the wait waited for, or a person\'s words, opening the turn end it for good', () => {
    expect(waitExitCause('session:turn-start', undefined, false, 'ends')).toBeNull()
    expect(waitExitCause('session:turn-start', undefined, false, null)).toBeNull()
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

describe('classifyInjectedLine: the stream\'s copy of a delivered line says whose turn it is', () => {
  const kit = createEnvelopeKit()
  const sender = { title: 'Lead', shortId: '0b253ffe', sessionId: '0b253ffe-1d5f-445d-aada-a7b5b5fb5a14', taskId: 'lead-1', host: 'local' }
  const notice = (attrs: Record<string, string>) => kit.buildWalnutMessage({ kind: 'notification', attrs: { from: 'Walnut', ...attrs }, body: 'a notice' })
  const hint = '<system-reminder>\nWalnut (reply-language): answer in English.\n</system-reminder>'

  it('a peer\'s note is a peer\'s, with a reply trailer, a hint or the instruction notice around it', () => {
    const note = kit.buildPeerWrapper('Hold your build.', sender, { title: 'Hold the build' })
    expect(classifyInjectedLine(note)).toBe('peer')
    expect(classifyInjectedLine(`${note}\n${kit.buildReplyTrailer({ id: 'rq-abc123' })}`)).toBe('peer')
    expect(classifyInjectedLine(`${hint}\n\n${notice({ outcome: 'task-routing-policy' })}\n\n${note}`)).toBe('peer')
    expect(classifyInjectedLine(kit.buildPeerWrapper('from a script', { ...sender, anonymous: true }))).toBe('peer')
  })

  it('a Walnut status notice that ends nothing is a notice', () => {
    for (const outcome of ['status', 'moved', 'waiting', 'stopped', 'blocked', 'task-routing-policy']) {
      expect(classifyInjectedLine(notice({ outcome })), outcome).toBe('walnut-notify')
    }
  })

  it('what a wait waits for ends it: a reply, a fire, a settled request, a finished or failed subtask', () => {
    expect(classifyInjectedLine(kit.buildReplyDeliveryText({ id: 'rq-abc123', preview: 'ok?' } as never, sender, 'yes'))).toBe('ends')
    expect(classifyInjectedLine(kit.buildWalnutMessage({ kind: 'trigger', attrs: { from: 'Trigger: build' }, body: 'fired' }))).toBe('ends')
    expect(classifyInjectedLine(notice({ outcome: 'status', request: 'rq-abc123' }))).toBe('ends')
    for (const outcome of ['completed', 'error', 'timeout', 'awaiting_human']) expect(classifyInjectedLine(notice({ outcome })), outcome).toBe('ends')
    // One ending envelope among interrupting ones ends it.
    expect(classifyInjectedLine(`${notice({ outcome: 'waiting' })}\n\n${notice({ outcome: 'completed' })}`)).toBe('ends')
  })

  it('a person\'s words, or anything not led by an envelope, is neither', () => {
    expect(classifyInjectedLine('how is the build going?')).toBeNull()
    expect(classifyInjectedLine(`${hint}\n\nhow is it going?`)).toBeNull()
    // The place or instruction notice rides in front of any line, a person's too.
    expect(classifyInjectedLine(`${notice({ outcome: 'moved' })}\n\nhow is it going?`)).toBeNull()
    expect(classifyInjectedLine(`${notice({ outcome: 'task-routing-policy' })}\n\n${hint}\n\nhow is it going?`)).toBeNull()
    expect(classifyInjectedLine(`look at this: ${kit.buildPeerWrapper('quoted', sender)}`)).toBeNull()
    expect(classifyInjectedLine('<walnut-message kind="peer-note" from="x">\nno close tag')).toBeNull()
    expect(classifyInjectedLine('')).toBeNull()
  })
})

describe('noteInjectedLine: a line inside the turn of a remembered wait', () => {
  const at = '2026-10-29T05:27:00.721Z'
  const remember = (cause: 'self' | 'message', byLine = false) => {
    resetInterruptedWaitsForTest()
    noteInterruptedWait('t1', { waitUntil: null, leftAt: at, sessionId: 's1', cause, source: 'test', ...(byLine ? { byLine } : {}) })
  }

  it('an interruption makes a turn that seemed the CLI\'s own the message\'s', () => {
    remember('self')
    noteInjectedLine('t1', 'peer')
    expect(interruptedWaits().get('t1')).toMatchObject({ cause: 'message', source: 'stream:peer', byLine: true })
  })

  it('what the wait waited for ends it, whoever made the turn', () => {
    for (const cause of ['self', 'message'] as const) {
      remember(cause)
      noteInjectedLine('t1', 'ends')
      expect(interruptedWaits().has('t1'), cause).toBe(false)
    }
  })

  it('a person\'s line ends a turn the stream named; a server send\'s own copy of a plain line leaves the server\'s cause alone', () => {
    remember('message', true)
    noteInjectedLine('t1', null)
    expect(interruptedWaits().has('t1')).toBe(false)
    // An auto-continue nudge is plain text: its session:input already said it interrupts.
    remember('message')
    noteInjectedLine('t1', null)
    expect(interruptedWaits().get('t1')).toMatchObject({ cause: 'message', source: 'test' })
    resetInterruptedWaitsForTest()
  })
})

describe('strongerLine: lines delivered between turns run as one turn', () => {
  it('what the wait waited for, or a person\'s words, stay whatever comes after', () => {
    for (const first of ['ends', null] as const) {
      for (const next of ['peer', 'walnut-notify', 'ends', null] as const) expect(strongerLine(first, next), `${first} ${next}`).toBe(first)
    }
  })
  it('an interruption gives way to the next line; nothing before takes the line as it is', () => {
    expect(strongerLine('peer', 'ends')).toBe('ends')
    expect(strongerLine('walnut-notify', null)).toBeNull()
    expect(strongerLine('peer', 'walnut-notify')).toBe('walnut-notify')
    expect(strongerLine(undefined, 'peer')).toBe('peer')
    expect(strongerLine(undefined, null)).toBeNull()
  })
})

describe('a line that ends the wait before the turn\'s wait is noted', () => {
  const entry = { waitUntil: null, leftAt: 'x', sessionId: 's1', cause: 'message' as const, source: 'stream:peer', byLine: true }
  it('leaves a mark that keeps that turn\'s wait from being remembered, once', () => {
    resetInterruptedWaitsForTest()
    noteInjectedLine('t2', 'ends', { sessionId: 's1', turn: 7 })
    noteInterruptedWait('t2', entry, 7)
    expect(interruptedWaits().has('t2')).toBe(false)
    noteInterruptedWait('t2', entry, 7)
    expect(interruptedWaits().has('t2')).toBe(true)
  })
  it('names one session\'s turn: another turn, or another session, keeps its wait', () => {
    for (const [sessionId, turn] of [['s1', 8], ['s2', 7]] as const) {
      resetInterruptedWaitsForTest()
      noteInjectedLine('t3', 'ends', { sessionId: 's1', turn: 7 })
      noteInterruptedWait('t3', { ...entry, sessionId }, turn)
      expect(interruptedWaits().has('t3'), `${sessionId} ${turn}`).toBe(true)
    }
  })
  it('a person\'s words mark it only in a turn a line opened; an interruption never', () => {
    resetInterruptedWaitsForTest()
    noteInjectedLine('t4', null, { sessionId: 's1', turn: 3 })
    noteInjectedLine('t4', 'peer', { sessionId: 's1', turn: 3, openedByLine: true })
    noteInterruptedWait('t4', entry, 3)
    expect(interruptedWaits().has('t4')).toBe(true)
    resetInterruptedWaitsForTest()
    noteInjectedLine('t4', null, { sessionId: 's1', turn: 4, openedByLine: true })
    noteInterruptedWait('t4', entry, 4)
    expect(interruptedWaits().has('t4')).toBe(false)
    resetInterruptedWaitsForTest()
  })
})
