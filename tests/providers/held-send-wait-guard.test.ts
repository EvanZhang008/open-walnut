/**
 * Every way the companion's hop says "no way through to the session's host" is read as the
 * host's link being down, so the message waits under "Walnut cannot reach <host>" and goes
 * out by itself, never "Send failed" with a hop's raw words.
 *
 * 2026-11-06: a host's daemon restarted for an update, the Mac's link to it dropped, and the
 * send fell back to the cloud companion, which had no link to that host either and answered
 * 503. The message read "Send failed: The companion refused the session stream" with Retry,
 * while the row stayed pending and went into the session a moment later by itself.
 *
 * This guard reads every reason src/providers/cloud-session-link.ts fails with, and each must
 * be a host link failure (isHostLinkFailure) unless it is listed below with why it is not: a
 * new reason is classified the day it is written.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { isHostLinkFailure, SendHeldError } from '../../src/providers/delivery-failure.js'

const FILE = path.resolve(__dirname, '../../src/providers/cloud-session-link.ts')

/** Reasons that are not "no way through": the line is not waiting on the host's link. */
const NOT_LINK: Record<string, string> = {
  'The session page no longer owns the cloud connection': 'the link was closed on purpose by its owner',
  'The cloud session connection was cancelled': 'a newer connect replaced this one',
  'The companion sent an invalid session event': 'a protocol fault, not a missing link',
  'The session host refused the cloud attachment': 'a refusal the host gave, its words are kept',
}

function reasons(): string[] {
  const text = fs.readFileSync(FILE, 'utf8')
  const out = new Set<string>()
  for (const m of text.matchAll(/(?:new SendHeldError|\bfail)\(\s*(?:'([^']*)'|`([^`]*)`)/g)) {
    out.add((m[1] ?? m[2]).replace(/\$\{[^}]*\}/g, '503'))
  }
  // The ternary in the stream refusal: both of its words.
  for (const m of text.matchAll(/\?\s*'([^']*)'\s*:\s*`([^`]*)`/g)) {
    out.add(m[1]); out.add(m[2].replace(/\$\{[^}]*\}/g, '500'))
  }
  return [...out]
}

describe('the companion hop\'s reasons', () => {
  const found = reasons()

  it('reads the file', () => {
    expect(found).toContain('The companion has no connection to the session host either')
    expect(found.some((r) => r.startsWith('The companion refused the session stream'))).toBe(true)
  })

  it.each(found.filter((r) => !(r in NOT_LINK)).map((r) => [r]))('"%s" is a host link failure', (reason) => {
    expect(isHostLinkFailure(new SendHeldError(reason))).toBe(true)
  })

  it.each(Object.keys(NOT_LINK).map((r) => [r]))('"%s" is not, and is still thrown', (reason) => {
    expect(found).toContain(reason)
    expect(isHostLinkFailure(new SendHeldError(reason))).toBe(false)
    expect(NOT_LINK[reason].length).toBeGreaterThan(10)
  })

  it('a refusal the session host gave is not a link failure (its words and Send failed stay)', () => {
    expect(isHostLinkFailure(new SendHeldError('Not sent yet: the session host refused delivery (publickey denied)'))).toBe(false)
  })
})
