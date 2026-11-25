/**
 * Every 503 the companion's send route answers, each with why it is not held instead.
 *
 * The class (2026-11-25, the Action Button's note to the CEO with the Mac asleep): a phone send
 * the companion answered 503 was kept nowhere. The rule now: a send whose words the companion CAN
 * keep is held (202 queued) and delivered later; a 503 is only for a send it could not keep, or
 * one a quick retry settles, and the phone keeps its words and retries it (ios-sends-kept-guard).
 * A new 503 in these files fails here until it says which of those it is; a held answer it should
 * have been goes to `holdIt` instead.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../../..')
const FILES = ['src/web/routes/cloud-session-send.ts', 'src/web/routes/cloud-send-direct.ts']

/** Why each 503 is not a held answer: the call's text → how many there are and the reason. */
const KNOWN: Record<string, { count: number; why: string }> = {
  "sendError(res, 503, 'bridge_offline', err.message)": {
    count: 1, why: 'the session is not in this copy and the Mac that knows its host is away: there is no host to hold it for',
  },
  "sendError(res, 503, 'bridge_offline', stillHandingOverSentence(await sessionHostName(sessionId) ?? \"the session's host\"))": {
    count: 1, why: 'an earlier try of the same id is still out: it settles in seconds and the retry reads its outcome',
  },
  "sendError(res, 503, 'send_state_unavailable', NOT_SAVED_SENTENCE)": {
    count: 4, why: 'the companion could not write its own record of the send (a disk error): it holds nothing',
  },
  "sendError(ctx.res, 503, 'send_state_unavailable', NOT_SAVED_SENTENCE)": {
    count: 1, why: 'the hold itself could not be stored',
  },
  "sendError(res, 503, 'bridge_offline', relayFailureSentence(relayErr, host, hostName, projected.hostLabel))": {
    count: 2, why: 'the hold could not be stored, or the relay may already sit in the Mac\'s queue (only the same id again, which the Mac dedupes, may go)',
  },
  "sendError(res, 503, 'bridge_offline', notConnectedSentence(host, hostName))": {
    count: 1, why: 'no bridge, and the hold could not be stored',
  },
  "sendError(res, 503, 'bridge_offline', relayFailureSentence(reason, host, hostName, projected.hostLabel))": {
    count: 1, why: 'an error the route did not expect: nothing is known about the send, so nothing is claimed',
  },
  "if (order.behind) { sendError(res, 503, 'bridge_offline', 'An earlier message to this session is still on its way; retrying automatically'); return true }": {
    count: 1, why: 'order: an earlier message of the session is still out, and this one may not pass it',
  },
  "sendError(res, 503, outcome.offline ? 'bridge_offline' : 'send_state_unavailable', outcome.offline ? notConnectedSentence(host, ctx.hostName) : NOT_SAVED_SENTENCE)": {
    count: 1, why: 'the host took nothing, and the hold could not be stored',
  },
  "sendError(res, 503, 'bridge_offline', relayFailureSentence(outcome.message, host, ctx.hostName, ctx.hostLabel))": {
    count: 1, why: 'a transport failure the direct path cannot place (already running, or neither offline nor proven unsent)',
  },
}

function sites(): Map<string, number> {
  const found = new Map<string, number>()
  for (const file of FILES) {
    for (const line of fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n')) {
      if (!/\b503\b/.test(line) || line.trim().startsWith('//') || line.trim().startsWith('*')) continue
      const text = line.trim()
      found.set(text, (found.get(text) ?? 0) + 1)
    }
  }
  return found
}

describe('the companion send route answers 503 only where it cannot hold the send', () => {
  it('every 503 is listed with its reason, and none was added', () => {
    const found = sites()
    const unlisted = [...found].filter(([text, n]) => n > (KNOWN[text]?.count ?? 0))
    expect(unlisted, 'a new 503 in the send route: hold the send (holdIt) or list why it cannot be held').toEqual([])
  })

  it('the list holds no site that is gone (it only shrinks)', () => {
    const found = sites()
    const stale = Object.entries(KNOWN).filter(([text, { count }]) => (found.get(text) ?? 0) < count)
    expect(stale.map(([text]) => text), 'a 503 left the send route: lower or remove its entry').toEqual([])
  })
})
