import { describe, expect, it, vi, afterEach } from 'vitest'
import { createElement } from '../../web/node_modules/react/index.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'
import { awaitEndAnswer, endOutcomeOf, END_UNCONFIRMED_TEXT } from '../../web/src/hooks/terminal-end-model'
import { TerminalEndUnconfirmedNotice, TerminalPlainNotice } from '../../web/src/components/sessions/TerminalModeNotices'
import type { TerminalOpenPlain } from '../../web/src/api/terminal'

/**
 * The UI half of an honest "End terminal": only killed:true ends the terminal.
 * An unconfirmed answer, a failed RPC or no answer in time keep it, with the
 * notice and a way to try again (useSessionTerminal + SessionTerminal).
 */
afterEach(() => { vi.useRealTimers() })

describe('end outcome from the terminal:kill answer', () => {
  it('killed:true ends it', () => {
    expect(endOutcomeOf({ killed: true })).toEqual({ ended: true })
  })

  it('unconfirmed keeps it, with the server reason', () => {
    expect(endOutcomeOf({ killed: false, unconfirmed: true, reason: 'the probe did not finish' }))
      .toEqual({ ended: false, reason: 'the probe did not finish' })
  })

  it('an answer without killed:true is never an end', () => {
    expect(endOutcomeOf({ killed: false })).toEqual({ ended: false, reason: 'Walnut did not confirm it' })
    expect(endOutcomeOf(undefined)).toEqual({ ended: false, reason: 'Walnut did not confirm it' })
  })

  it('a failed RPC is unconfirmed, not thrown', async () => {
    expect(await awaitEndAnswer(Promise.reject(new Error('WebSocket closed'))))
      .toEqual({ ended: false, reason: 'the connection to Walnut failed', detail: 'WebSocket closed' })
  })

  it('no answer in time is unconfirmed after the deadline', async () => {
    vi.useFakeTimers()
    const pending = awaitEndAnswer(new Promise(() => {}), 30_000)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await pending).toEqual({ ended: false, reason: 'Walnut did not answer within 30s' })
  })

  it('an answer before the deadline wins', async () => {
    expect(await awaitEndAnswer(Promise.resolve({ killed: true }), 50)).toEqual({ ended: true })
  })
})

describe('end unconfirmed notice', () => {
  const html = (ending: boolean) => renderToStaticMarkup(createElement(TerminalEndUnconfirmedNotice, { reason: 'the probe did not finish', ending, onRetry: () => {} }))

  it('says it may still be running, gives the reason and Try again', () => {
    const out = html(false)
    expect(out).toContain(END_UNCONFIRMED_TEXT)
    expect(END_UNCONFIRMED_TEXT).toBe('Walnut could not confirm the terminal ended. It may still be running.')
    expect(out).toContain('Reason: the probe did not finish. Close and reopen the terminal to reattach to it.')
    expect(out).toContain('>Try again</button>')
    expect(out).toContain('role="alert"')
  })

  it('shows Ending… and disables the button while an End runs', () => {
    const out = html(true)
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Ending…<\/button>/)
  })
})

describe('plain notice while an End runs', () => {
  const plain: TerminalOpenPlain = {
    ok: true, terminalId: 'sess-1', cols: 80, rows: 24, persistent: false, reason: 'no_compiler',
    installHint: 'No C compiler here.', installCommand: 'xcode-select --install',
  }
  it('Retry is disabled, still labelled Retry', () => {
    const out = renderToStaticMarkup(createElement(TerminalPlainNotice, { plain, retrying: false, disabled: true, onRetry: () => {} }))
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Retry<\/button>/)
  })
  it('Retry is enabled otherwise', () => {
    const out = renderToStaticMarkup(createElement(TerminalPlainNotice, { plain, retrying: false, onRetry: () => {} }))
    expect(out).not.toMatch(/<button[^>]*disabled=""[^>]*>Retry<\/button>/)
  })
})
