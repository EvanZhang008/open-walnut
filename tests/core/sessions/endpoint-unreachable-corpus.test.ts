/**
 * Every turn error text Walnut knows, with the way it must be handled (2026-11-03: the Mac's model
 * proxy went down, eight sessions ended on "API Error: Connection refused — a firewall or proxy may be
 * blocking it (ECONNREFUSED)", and the daemon's classifier read "refused" as a model refusal, so no
 * layer retried and every task read Needs you).
 *
 *   wait       the endpoint was never reached: the endpoint wait probes it and continues once it
 *              answers (sessions/endpoint-wait.ts); the task waits on its machine
 *   retry      reached and failed in passing (timeouts, 5xx, overload): the daemon's turn retry and
 *              session-auto-continue
 *   terminal   an answer that a retry cannot change (auth, refusal, too long, quota, a cancel)
 *
 * Guards for the class:
 *  - each text is handled as listed, by both daemon twins' classifier;
 *  - every pattern of the three lists is exercised by a text here: a new pattern (a new error text
 *    someone met) fails until its text is added with how it is handled;
 *  - the two twins carry the same patterns;
 *  - every wait pattern is also a retryable one (an older daemon retries what the wait owns).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { classifyTurnError } from '../../../src/providers/daemon-core.js'
import { ENDPOINT_UNREACHABLE_PATTERNS, matchesEndpointUnreachable } from '../../../src/core/sessions/endpoint-unreachable.js'
import { isEndpointUnreachableError, endpointWaitTakes } from '../../../src/core/sessions/endpoint-wait.js'
import { matchesRetryExhaustion } from '../../../src/core/session-auto-continue.js'

type Handling = 'wait' | 'retry' | 'terminal'

/** Real texts first (where seen), then the shapes each pattern exists for. Names and ids neutral. */
const CORPUS: Array<[string, Handling]> = [
  // The endpoint was never reached.
  ['API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)', 'wait'], // 2026-11-03, 8 sessions
  ['API Error: connect ECONNREFUSED 127.0.0.1:8402', 'wait'],
  ['API Error: Connection error.', 'wait'],
  ['API Error: getaddrinfo ENOTFOUND bedrock-runtime.us-west-2.amazonaws.com', 'wait'],
  ['API Error: getaddrinfo EAI_AGAIN api.anthropic.com', 'wait'],
  ['API Error: fetch failed', 'wait'],
  ['API Error: fetch failed (EAI_AGAIN)', 'wait'],
  ['API Error: socket hang up', 'wait'],
  ['API Error: connect EHOSTUNREACH 10.0.0.5:443', 'wait'],
  ['API Error: connect ENETUNREACH 10.0.0.5:443', 'wait'],
  ['API Error: connect EHOSTDOWN 10.0.0.5:443', 'wait'],
  ['API Error: ENETDOWN', 'wait'],
  ['API Error: Unable to connect to API (ConnectionRefused)', 'wait'],
  // Reached, failed in passing.
  ['API Error: The operation timed out.', 'retry'],
  ['API Error: Request timed out', 'retry'],
  ['API Error: api_timeout', 'retry'],
  ['API Error: Server error mid-response. The response above may be incomplete.', 'retry'],
  ['API Error: Stream idle timeout - no chunks received', 'retry'],
  ['API Error: No chunks received from the stream', 'retry'],
  ['API Error: Response stalled mid-stream. The response above may be incomplete.', 'retry'],
  ['API Error: The system encountered an unexpected error during processing. Try your request again.', 'retry'],
  ['API Error: 429 Too Many Requests', 'retry'],
  ['API Error: 500 {"type":"error"}', 'retry'],
  ['API Error: Rate limit reached for requests', 'retry'],
  ['API Error: 529 overloaded_error', 'retry'],
  ['API Error: Service Unavailable', 'retry'],
  ['API Error: Bad Gateway', 'retry'],
  ['API Error: Gateway Timeout', 'retry'],
  ['API Error: Internal Server Error', 'retry'],
  ['API Error: Connection reset by peer', 'retry'],
  ['API Error: Connection closed unexpectedly', 'retry'],
  ['API Error: read ECONNRESET', 'retry'],
  ['API Error: connect ETIMEDOUT 10.0.0.5:443', 'retry'],
  ['API Error: write EPIPE', 'retry'],
  ['API Error: Network error while streaming', 'retry'],
  ['API Error: Premature close', 'retry'],
  ['API Error: terminated', 'retry'],
  // An answer a retry cannot change.
  ["API Error: Fable 5 can't help with this. Start a new session to continue.", 'terminal'], // real
  // The subscription's usage limit: the usage-limit wait continues it at the reset (sessions/usage-limit-wait.ts).
  ["You've hit your session limit \u00b7 resets 3pm (America/Los_Angeles)", 'terminal'], // Claude Code
  ["You've hit your usage limit. Upgrade to Pro or try again at 3:05 PM.", 'terminal'], // Codex
  ['Claude AI usage limit reached|1762282800', 'terminal'], // older Claude Code
  ["You're out of extra usage \u00b7 resets 3pm (UTC)", 'terminal'],
  ['usageLimitExceeded', 'terminal'], // codex error info
  // A provider's per-minute rate limit is no usage limit: retried as before.
  ["API Error: You've hit your rate limit, retry in 20s", 'retry'],
  ['API Error: the model refused to answer', 'terminal'],
  ['API Error: stop_reason: "refusal"', 'terminal'],
  ['Prompt too long', 'terminal'],
  ['API Error: context window exceeded', 'terminal'],
  ['API Error: input length 250000 exceeds the maximum', 'terminal'],
  ['API Error: too many tokens in the request', 'terminal'],
  ['API Error: 400 invalid_request_error', 'terminal'],
  ['API Error: 401 Unauthorized', 'terminal'],
  ['API Error: 403 Forbidden', 'terminal'],
  ['API Error: authentication failed: expired token', 'terminal'],
  ['API Error: quota exceeded for this account', 'terminal'],
  ['API Error: permission denied', 'terminal'],
  ['API Error: not found: model claude-x', 'terminal'],
  ['Request cancelled by user', 'terminal'],
  ['API Error: ECANCELED', 'terminal'],
  // An auth failure that also mentions a dead connection is still an auth failure: never waited on.
  ['API Error: 401 Unauthorized (fetch failed)', 'terminal'],
  ['API Error: something nobody has ever seen before', 'terminal'],
]

function handlingOf(text: string): Handling {
  if (isEndpointUnreachableError(text)) return 'wait'
  return classifyTurnError(text) === 'retryable' ? 'retry' : 'terminal'
}

const ROOT = path.resolve(__dirname, '../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** The regex literals of `const|var NAME = [ ... ]` in a source file, as the regex reads them. */
function patternList(src: string, name: string, template: boolean): RegExp[] {
  const at = src.search(new RegExp(`(?:const|var) ${name}(?::[^=]+)? = \\[`))
  expect(at, name).toBeGreaterThan(-1)
  const body = src.slice(src.indexOf('[', at) + 1, src.indexOf('\n]', at))
  return body.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/') && !l.startsWith('//'))
    .map((l) => {
      const lit = l.replace(/,$/, '')
      const m = /^\/(.*)\/([a-z]*)$/.exec(template ? lit.replace(/\\\\/g, '\\') : lit)
      expect(m, `not one regex literal per line: ${l}`).toBeTruthy()
      return new RegExp(m![1], m![2])
    })
}

const core = read('src/providers/daemon-core.ts')
const twin = read('src/providers/daemon-source.ts')
const LISTS = ['RETRYABLE_TURN_ERROR_PATTERNS', 'TERMINAL_TURN_ERROR_PATTERNS'] as const

describe('every known turn error text is handled as listed', () => {
  it.each(CORPUS)('%s → %s', (text, handling) => {
    expect(handlingOf(text)).toBe(handling)
    // The endpoint wait takes exactly the wait texts at a real turn end, and nothing else.
    expect(endpointWaitTakes({ isError: true, result: text })).toBe(handling === 'wait')
    // Auto-continue keeps the retries and leaves the wait texts to the endpoint wait.
    expect(matchesRetryExhaustion(text)).toBe(handling === 'retry')
  })

  it('the wait never takes a clean turn, or one whose own work runs on', () => {
    const text = CORPUS[0][0]
    expect(endpointWaitTakes({ isError: false, result: text })).toBe(false)
    for (const k of ['teamActive', 'backgroundActive', 'detachedBgActive', 'wakeupPending'] as const) {
      expect(endpointWaitTakes({ isError: true, result: text, [k]: true })).toBe(false)
    }
  })
})

describe('every pattern is exercised by a known text', () => {
  it.each(LISTS)('%s (daemon-core.ts)', (name) => {
    const unused = patternList(core, name, false).filter((re) => !CORPUS.some(([t]) => re.test(t)))
    expect(unused.map(String), 'add the error text this pattern exists for to CORPUS, with how it is handled').toEqual([])
  })

  it('ENDPOINT_UNREACHABLE_PATTERNS', () => {
    const unused = ENDPOINT_UNREACHABLE_PATTERNS.filter((re) => !CORPUS.some(([t, h]) => h === 'wait' && re.test(t)))
    expect(unused.map(String), 'add the error text this pattern exists for to CORPUS as wait').toEqual([])
  })

  it('every wait text is retryable to the daemon (an older server or daemon still retries it)', () => {
    for (const [text, h] of CORPUS) if (h === 'wait') expect(classifyTurnError(text), text).toBe('retryable')
    for (const [text, h] of CORPUS) if (h !== 'wait' && matchesEndpointUnreachable(text)) expect(classifyTurnError(text), text).toBe('terminal')
  })
})

describe('the two daemon twins carry the same patterns', () => {
  it.each(LISTS)('%s', (name) => {
    expect(patternList(twin, name, true).map(String)).toEqual(patternList(core, name, false).map(String))
  })
})
