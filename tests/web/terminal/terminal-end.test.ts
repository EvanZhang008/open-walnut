/**
 * "End terminal" (terminal:kill) answers killed:true only for a dtach master
 * that was stopped or never existed. A master left running (probe without an
 * answer, an owner that is not a dtach master, a stop that threw) answers
 * killed:false + unconfirmed + a reason in plain words, and is logged with the
 * full terminal id and the technical reason:
 * the UI used to say "exited" while the shell kept running.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-terminal-end'))

import { log } from '../../../src/logging/index.js'
import { __setTerminalStopForTesting, endDtachForTerminal, killAnswer, readableReason } from '../../../src/web/terminal/terminal-end.js'

const TERMINAL_ID = 'term-end-0123456789abcdef-0123456789abcdef'
const record = { claudeSessionId: TERMINAL_ID, host: 'devbox' }

afterEach(() => {
  __setTerminalStopForTesting(null)
  vi.restoreAllMocks()
})

describe('terminal:kill answer', () => {
  it('stopped and nothing are confirmed ends, with no warning', () => {
    const warn = vi.spyOn(log.web, 'warn')
    expect(killAnswer(TERMINAL_ID, { outcome: 'stopped' })).toEqual({ killed: true })
    expect(killAnswer(TERMINAL_ID, { outcome: 'nothing', reason: 'nothing holds the socket' })).toEqual({ killed: true })
    expect(warn).not.toHaveBeenCalled()
  })

  it('left is unconfirmed with a readable reason, and logs the full terminal id with the technical one', () => {
    const warn = vi.spyOn(log.web, 'warn')
    expect(killAnswer(TERMINAL_ID, { outcome: 'left', reason: 'the probe did not finish' }))
      .toEqual({ killed: false, unconfirmed: true, reason: 'the host did not answer in time' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![1]).toEqual({ terminalId: TERMINAL_ID, reason: 'the probe did not finish' })
  })

  it('left without a reason still says why; a long technical reason is cut in the log', () => {
    const warn = vi.spyOn(log.web, 'warn')
    expect(killAnswer(TERMINAL_ID, { outcome: 'left' })).toEqual({ killed: false, unconfirmed: true, reason: "the terminal's owner could not be verified" })
    killAnswer(TERMINAL_ID, { outcome: 'left', reason: 'x'.repeat(500) })
    expect((warn.mock.calls[1]![1] as { reason: string }).reason).toHaveLength(200)
  })

  it('every technical reason dtach-master.ts gives reads as plain words', () => {
    expect(readableReason('the probe did not finish')).toBe('the host did not answer in time')
    expect(readableReason('no pid record, and the socket\'s owner is not a dtach master for it')).toBe("the terminal's owner could not be verified")
    expect(readableReason('the recorded pid is gone or is another process now, and no way on the host to read the socket\'s owner (no lsof, no /proc)'))
      .toBe('the host cannot show which process holds the terminal')
    expect(readableReason('the stop failed: ssh: connect timed out')).toBe('the stop command failed on the host')
    expect(readableReason(undefined)).toBe("the terminal's owner could not be verified")
  })

  it('endDtachForTerminal maps each stop outcome through the seam', async () => {
    const warn = vi.spyOn(log.web, 'warn')
    const stop = vi.fn()
    __setTerminalStopForTesting(stop)
    stop.mockResolvedValueOnce({ outcome: 'stopped' })
    expect(await endDtachForTerminal(TERMINAL_ID, record)).toEqual({ killed: true })
    stop.mockResolvedValueOnce({ outcome: 'nothing' })
    expect(await endDtachForTerminal(TERMINAL_ID, record)).toEqual({ killed: true })
    stop.mockResolvedValueOnce({ outcome: 'left', reason: "the socket's owner is not a dtach master for it" })
    expect(await endDtachForTerminal(TERMINAL_ID, record))
      .toEqual({ killed: false, unconfirmed: true, reason: "the terminal's owner could not be verified" })
    expect(stop).toHaveBeenCalledWith(record)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('a stop that throws is unconfirmed, never an RPC error', async () => {
    vi.spyOn(log.web, 'warn')
    __setTerminalStopForTesting(async () => { throw new Error('ssh: connect timed out') })
    expect(await endDtachForTerminal(TERMINAL_ID, record))
      .toEqual({ killed: false, unconfirmed: true, reason: 'the stop command failed on the host' })
  })
})
