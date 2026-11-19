/**
 * A credential fetch the network broke is transient, never the user's to fix (2026-11-19: the Mac
 * was offline for about 90 minutes, ten sessions ended on a credential error whose cause was DNS,
 * and each read Needs you with "credentials only you can fix").
 *
 * Guards for the class:
 *  - the real texts (names neutral) and their variants are retried by both daemon twins and are
 *    no kind of the user's, so the task waits on its lead;
 *  - every network failure Walnut knows (each wait and drop text of the endpoint corpus, each
 *    network code in the daemon's retry list) wrapped in a credential fetch reads the same way: a
 *    new network pattern there fails here until the network rule covers it;
 *  - a rejection the service gave stays the user's, whatever network words ride beside it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyTurnError } from '../../../src/providers/daemon-core.js'
import { networkCausedAuthError } from '../../../src/providers/network-cause-core.js'
import { getDaemonSource } from '../../../src/providers/daemon-source.js'
import { usersErrorKind } from '../../../src/core/sessions/session-error-owner.js'
import { ENDPOINT_DROPPED_PATTERNS, ENDPOINT_UNREACHABLE_PATTERNS } from '../../../src/core/sessions/endpoint-unreachable.js'

const fetch = (cause: string) => `API Error: 502 could not fetch AWS credentials for managed-profile: CredentialRetrievalError: ${cause}`

const NETWORK: string[] = [
  // The two texts of 2026-11-19.
  fetch('dispatch failure: io error: error trying to connect: dns error: failed to lookup address information: nodename nor servname provided, or not known'),
  fetch('Get "https://sign-in.example.test/token": dial tcp: lookup sign-in.example.test: no such host'),
  // Other clients' words for the same outage.
  fetch('getaddrinfo ENOTFOUND sign-in.example.test'),
  fetch('getaddrinfo EAI_AGAIN sign-in.example.test'),
  fetch('dns error: Temporary failure in name resolution'),
  fetch('dns error: Name or service not known'),
  fetch('connect ECONNREFUSED 127.0.0.1:443'),
  fetch('read ECONNRESET'),
  fetch('connect ETIMEDOUT 10.0.0.5:443'),
  fetch('dial tcp 10.0.0.5:443: i/o timeout'),
  fetch('connect: network is unreachable'),
  'Failed to refresh credentials: could not resolve host: sign-in.example.test',
  'Authentication failed: connection timed out while reaching the token service',
]

const THE_USERS: Array<[string, string]> = [
  [fetch('token expired, sign in again'), 'sign-in'],
  [fetch('401 Unauthorized'), 'sign-in'],
  ['API Error: 401 Unauthorized (fetch failed)', 'credentials'],
  ['API Error: invalid api key (connection reset after the answer)', 'credentials'],
  [fetch('credentials revoked'), 'credentials'],
  ['API Error: 403 Forbidden: dns error ignored', 'permissions'],
]

describe('a credential fetch the network broke', () => {
  it.each(NETWORK)('%s is retried and the team\'s', (text) => {
    expect(networkCausedAuthError(text)).toBe(true)
    expect(classifyTurnError(text)).toBe('retryable')
    expect(usersErrorKind(text)).toBeNull()
  })

  it.each(THE_USERS)('%s stays the user\'s', (text) => {
    expect(networkCausedAuthError(text)).toBe(false)
    expect(classifyTurnError(text)).toBe('terminal')
    expect(usersErrorKind(text)).not.toBeNull()
  })
})

describe('every network failure Walnut knows, under a credential fetch, is the network\'s', () => {
  const corpusSrc = fs.readFileSync(path.join(__dirname, 'endpoint-unreachable-corpus.test.ts'), 'utf8')
  // The wait and drop texts of the endpoint corpus: each is a connection that never answered or dropped.
  const waitTexts = [...corpusSrc.matchAll(/\['((?:[^'\\]|\\.)*)', '(?:wait|drop)'\]/g)].map((m) => m[1])

  it('reads the endpoint corpus', () => {
    expect(waitTexts.length).toBeGreaterThan(10)
    // Each endpoint pattern has a text here, so a new one arrives with its text.
    for (const re of [...ENDPOINT_UNREACHABLE_PATTERNS, ...ENDPOINT_DROPPED_PATTERNS]) {
      expect(waitTexts.some((t) => re.test(t)), String(re)).toBe(true)
    }
  })

  it('each wait and drop text', () => {
    const missed = waitTexts.map((t) => fetch(t.replace(/^API Error: /, ''))).filter((t) => !networkCausedAuthError(t) || usersErrorKind(t) !== null || classifyTurnError(t) !== 'retryable')
    expect(missed, 'a network failure under a credential fetch reads as the user\'s: add its words to network-cause-core.ts').toEqual([])
  })

  it('each network code of the daemon\'s retry list', () => {
    const core = fs.readFileSync(path.join(__dirname, '../../../src/providers/daemon-core.ts'), 'utf8')
    const list = core.slice(core.indexOf('const RETRYABLE_TURN_ERROR_PATTERNS'), core.indexOf('\n]', core.indexOf('const RETRYABLE_TURN_ERROR_PATTERNS')))
    const codes = [...new Set([...list.matchAll(/\\bE([A-Z_]{3,})\\b/g)].map((m) => `E${m[1]}`))]
    expect(codes).toContain('ENOTFOUND')
    const missed = codes.map((c) => fetch(`connect ${c} 10.0.0.5:443`)).filter((t) => !networkCausedAuthError(t) || usersErrorKind(t) !== null)
    expect(missed, 'a network code the daemon retries reads as the user\'s under a credential fetch').toEqual([])
  })
})

describe('both daemon twins', () => {
  it('the deployed template carries the same rule and checks it before the credential words', () => {
    const src = getDaemonSource()
    expect(src).toContain(networkCausedAuthError.toString())
    const body = src.slice(src.indexOf('function classifyTurnError'), src.indexOf('function parseTurnErrorLine'))
    expect(body.indexOf('networkCausedAuthError')).toBeGreaterThan(-1)
    expect(body.indexOf('networkCausedAuthError')).toBeLessThan(body.indexOf('AUTH_TURN_ERROR_PATTERNS'))
  })
})
