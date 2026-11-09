/**
 * Who stands behind a `walnut tools call` made outside every session (src/lib/cli-sender.ts).
 * 2026-10-28: a LaunchAgent's task_send notes read as the user talking to four tasks.
 */
import { describe, expect, it } from 'vitest'
import { cliAutomationSender, cliOpCaller, senderLabel } from '../../../src/lib/cli-sender.js'

const NO_TTY = [false, false, false]
const TTY = [true, true, true]

describe('cliAutomationSender', () => {
  it('a session says who it is itself: no label', () => {
    expect(cliAutomationSender({ WALNUT_SESSION_ID: 'sid-1' }, NO_TTY)).toBeUndefined()
    expect(cliAutomationSender({ WALNUT_SESSION_ID: 'sid-1', WALNUT_SENDER: 'watchdog' }, NO_TTY)).toBeUndefined()
  })

  it('a person in a terminal is the person', () => {
    expect(cliAutomationSender({}, [true, true, true])).toBeUndefined()
    // Output piped to a file, the terminal still on stdin (`walnut tools call ... > out.json`).
    expect(cliAutomationSender({}, [true, false, false])).toBeUndefined()
  })

  it('no session and no terminal is a script, named by WALNUT_SENDER', () => {
    expect(cliAutomationSender({}, NO_TTY)).toBe('script')
    expect(cliAutomationSender({ WALNUT_SENDER: 'load-watchdog' }, NO_TTY)).toBe('load-watchdog')
    // Named even with a terminal: the caller said what it is.
    expect(cliAutomationSender({ WALNUT_SENDER: 'nightly backup' }, [true, true, true])).toBe('nightly backup')
  })

  it('WALNUT_SENDER=person keeps a person\'s own pipeline theirs', () => {
    expect(cliAutomationSender({ WALNUT_SENDER: 'person' }, NO_TTY)).toBeUndefined()
    expect(cliAutomationSender({ WALNUT_SENDER: 'Me' }, NO_TTY)).toBeUndefined()
  })

  it('labels are short and plain', () => {
    expect(senderLabel('watch"dog<x>\n')).toBe('watch dog x')
    expect(senderLabel('')).toBe('script')
    expect(senderLabel('a'.repeat(80))).toHaveLength(40)
  })
})

/**
 * The executor reads no WALNUT_SESSION_ID of its own, so every CLI executeOp names its caller
 * through cliOpCaller (the ratchet beside this file holds every call site to it).
 */
describe('cliOpCaller', () => {
  it('a session is the session, with or without a terminal', () => {
    expect(cliOpCaller({ WALNUT_SESSION_ID: 'sid-1' }, TTY)).toEqual({ callerSid: 'sid-1' })
    expect(cliOpCaller({ WALNUT_SESSION_ID: 'sid-1' }, NO_TTY)).toEqual({ callerSid: 'sid-1' })
    // A session id wins over a sender label.
    expect(cliOpCaller({ WALNUT_SESSION_ID: 'sid-1', WALNUT_SENDER: 'watchdog' }, NO_TTY)).toEqual({ callerSid: 'sid-1' })
  })

  it('a session id is trimmed, and a blank one is no session', () => {
    expect(cliOpCaller({ WALNUT_SESSION_ID: '  sid-2 \n' }, NO_TTY)).toEqual({ callerSid: 'sid-2' })
    expect(cliOpCaller({ WALNUT_SESSION_ID: '   ' }, TTY)).toEqual({ callerMode: 'human' })
    expect(cliOpCaller({ WALNUT_SESSION_ID: '' }, NO_TTY)).toEqual({ sender: 'script' })
  })

  it('a person at a terminal is the person', () => {
    expect(cliOpCaller({}, TTY)).toEqual({ callerMode: 'human' })
    expect(cliOpCaller({}, [false, false, true])).toEqual({ callerMode: 'human' })
  })

  it('no session and no terminal is a script by default', () => {
    expect(cliOpCaller({}, NO_TTY)).toEqual({ sender: 'script' })
  })

  it('WALNUT_SENDER names the automation, and person keeps it the person', () => {
    expect(cliOpCaller({ WALNUT_SENDER: 'script' }, NO_TTY)).toEqual({ sender: 'script' })
    expect(cliOpCaller({ WALNUT_SENDER: 'load-watchdog' }, TTY)).toEqual({ sender: 'load-watchdog' })
    expect(cliOpCaller({ WALNUT_SENDER: 'person' }, NO_TTY)).toEqual({ callerMode: 'human' })
    expect(cliOpCaller({ WALNUT_SENDER: 'person' }, TTY)).toEqual({ callerMode: 'human' })
  })

  it('always names exactly one caller', () => {
    const envs = [{}, { WALNUT_SESSION_ID: 's' }, { WALNUT_SENDER: 'x' }, { WALNUT_SENDER: 'me' }, { WALNUT_SESSION_ID: ' ' }]
    for (const env of envs) for (const ttys of [TTY, NO_TTY]) {
      expect(Object.keys(cliOpCaller(env, ttys))).toHaveLength(1)
    }
  })
})
