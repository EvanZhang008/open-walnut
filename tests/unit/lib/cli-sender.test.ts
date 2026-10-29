/**
 * Who stands behind a `walnut tools call` made outside every session (src/lib/cli-sender.ts).
 * 2026-10-28: a LaunchAgent's task_send notes read as the user talking to four tasks.
 */
import { describe, expect, it } from 'vitest'
import { cliAutomationSender, senderLabel } from '../../../src/lib/cli-sender.js'

const NO_TTY = [false, false, false]

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
