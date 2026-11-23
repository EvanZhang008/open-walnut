/**
 * Ratchet: every place the runner starts a CLI of a session (a `.send(` of a ClaudeCodeSession, which
 * spawns or resumes one) is one of a known few, so a delivery cannot resume a legacy session on its
 * own and skip the hand-over to its host (src/providers/host-resume.ts, asked in processNextNow).
 *
 * The known ones: a new start or fork (handleStart, which goes to the host by startGoesToHost before
 * it gets here), a Restart without a message (restartThrough: a Restart stays legacy), and the two
 * resumes of a delivery in processNextNow, after resumeAtRestOnHost. A new call site fails here
 * until it goes through processNextNow or is listed with why.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const FILE = path.resolve(import.meta.dirname, '../../src/providers/claude-code-session.ts')

const KNOWN: Record<string, number> = {
  handleStart: 1,
  restartThrough: 1,
  processNextNow: 2,
}

/** The method each line of the class body belongs to (its last two-space-indented signature). */
function sendSites(src: string): Record<string, number> {
  const out: Record<string, number> = {}
  let method = ''
  const sig = /^ {2}(?:(?:private|public|protected|static|async|override)\s+)*([A-Za-z_$][\w$]*)\s*[(<]/
  for (const line of src.split('\n')) {
    const m = sig.exec(line)
    if (m && !/^\s*(if|for|while|switch|return)\b/.test(line.trim())) method = m[1]
    if (/^\s*(\/\/|\*)/.test(line)) continue
    // A ClaudeCodeSession's send: a session object, never an ACP contract's prompt.
    if (/\b(session|target|targetSession)\.send\(/.test(line)) out[method] = (out[method] ?? 0) + 1
  }
  return out
}

describe('the runner starts a CLI of a session only where the hand-over to its host is asked', () => {
  it('lists every CLI start of the runner', () => {
    expect(sendSites(readFileSync(FILE, 'utf8'))).toEqual(KNOWN)
  })

  it('processNextNow asks host-resume before its resumes', () => {
    const src = readFileSync(FILE, 'utf8')
    const body = src.slice(src.indexOf('private async processNextNow('))
    const ask = body.indexOf('resumeAtRestOnHost(')
    const firstSend = body.search(/\b(session|targetSession)\.send\(/)
    expect(ask).toBeGreaterThan(0)
    expect(ask).toBeLessThan(firstSend)
  })
})
