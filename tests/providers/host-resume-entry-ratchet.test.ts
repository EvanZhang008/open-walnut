/**
 * Ratchet: every place the runner starts a CLI of a session (a `.send(` of a ClaudeCodeSession, which
 * spawns or resumes one) is one of a known few, so a delivery cannot resume a legacy session on its
 * own and skip the hand-over to its host (src/providers/host-resume.ts, asked in processNextNow).
 *
 * The known ones: a new start or fork (handleStart, which goes to the host by startGoesToHost before
 * it gets here), a Restart without a message (restartThrough: a Restart stays legacy), and the two
 * resumes of a delivery in processNextNow, after resumeAtRestOnHost; and one ACP prompt, no CLI. An
 * ACP send drains without processNext: its branch asks host-resume before it attaches the session
 * (an attach starts the session's worker), which the last check pins.
 * Matched by call shape (any receiver), so a new call site fails here, whatever its variable is
 * called, until it goes through processNextNow or is listed with why.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const FILE = path.resolve(import.meta.dirname, '../../src/providers/claude-code-session.ts')

const KNOWN: Record<string, number> = {
  handleStart: 1,
  restartThrough: 1,
  processNextNow: 2,
  // Not a CLI: an ACP session's prompt, through its contract (asked before: processNextNow, or the send's ACP branch).
  drainAcpPrompt: 1,
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
    // Every `.send(` by its call shape, whatever the receiver is called (a ClaudeCodeSession's send
    // spawns or resumes a CLI): each is listed by the method it is in.
    const n = line.match(/[\w$)\]]\s*\??\.send\(/g)?.length ?? 0
    if (n > 0) out[method] = (out[method] ?? 0) + n
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
    const firstSend = body.search(/[\w$)\]]\s*\??\.send\(/)
    expect(ask).toBeGreaterThan(0)
    expect(ask).toBeLessThan(firstSend)
  })

  it('an ACP send asks host-resume before it attaches the session (an attach starts its worker)', () => {
    const src = readFileSync(FILE, 'utf8')
    const at = src.indexOf('case EventNames.SESSION_SEND: {')
    const branch = src.slice(at, src.indexOf('case EventNames.SESSION_PERMISSION_RESOLVED', at))
    const ask = branch.indexOf('acpResumesOnHost(')
    expect(branch.indexOf('acpResumeHostOf(')).toBeGreaterThan(0)
    expect(ask).toBeGreaterThan(0)
    expect(ask).toBeLessThan(branch.indexOf('maybeAttachAcpSession('))
    // processNextNow's ask comes before its ACP attach too.
    const body = src.slice(src.indexOf('private async processNextNow('))
    expect(body.indexOf('resumeAtRestOnHost(')).toBeLessThan(body.indexOf('maybeAttachAcpSession('))
  })
})
