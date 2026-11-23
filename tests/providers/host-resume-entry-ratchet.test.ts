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
import { readFileSync, readdirSync } from 'node:fs'
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

/**
 * Every attach of an ACP session, by file and (in the runner) by method: an attach starts the
 * session's worker where it runs, so each one goes through the resume decision (maybeAttachAcpSession
 * asks unless the caller says `asked: true`), or says here why it keeps the session where it is.
 */
const ATTACHES: Record<string, string> = {
  // The runner's own entries.
  'src/providers/claude-code-session.ts#findOrAttachAcpSession': 'the public attach: asks (attaching), answers the host\'s proxy once handed',
  'src/providers/claude-code-session.ts#init': 'the bus handler, SESSION_SEND\'s ACP branch: asked just before (acpResumesOnHost), so `asked: true`',
  'src/providers/claude-code-session.ts#processNextNow': 'asked just before (resumeAtRestOnHost, attaching), so `asked: true`',
  'src/providers/claude-code-session.ts#requestTurnCompleteSelfReport': 'a self-report asks the session that just ended a turn: it stays where it ran, `asked: true`',
  'src/providers/claude-code-session.ts#performNativeReinitialize': 'a Restart stays legacy, as a native one does: `asked: true`',
  // Through findOrAttachAcpSession (so through the decision).
  'src/web/routes/sessions.ts': 'the model catalog (a read): asks, the host\'s proxy answers once handed',
  'src/core/sessions/session-controls.ts': 'a model switch: asks; once handed, the proxy forwards it to the host',
  'src/core/sessions/session-lifecycle.ts': 'a mode change, a permission answer, restoring pending permissions: each asks',
  'src/core/sessions/session-extras.ts': 'the panel\'s controls, read and set: each asks',
  'src/core/subagents/on-host.ts': 'a subagent\'s session attached on use: asks',
  'src/core/session-hooks/builtins.ts': 'a foreground title prompt: asks (a background sweep never attaches: noColdAttach)',
}

/** Every ACP attach call outside its definitions, keyed by file (and the runner's method). */
function attachSites(): Record<string, number> {
  const root = path.resolve(import.meta.dirname, '../..')
  const out: Record<string, number> = {}
  const sig = /^ {2}(?:(?:private|public|protected|static|async|override)\s+)*([A-Za-z_$][\w$]*)\s*[(<]/
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!/\.tsx?$/.test(e.name)) continue
      const rel = path.relative(root, p)
      let method = ''
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        const m = sig.exec(line)
        if (m && !/^\s*(if|for|while|switch|return)\b/.test(line.trim())) method = m[1]
        if (/^\s*(\/\/|\*)/.test(line)) continue
        // Calls only: a definition (`async findOrAttachAcpSession(sessionId: string)`) or an interface member is none.
        const n = line.match(/(?:\.|\bawait\s+this\.)\s*(?:findOrAttachAcpSession|maybeAttachAcpSession)\(/g)?.length ?? 0
        if (n === 0) continue
        const key = rel === 'src/providers/claude-code-session.ts' ? `${rel}#${method}` : rel
        out[key] = (out[key] ?? 0) + n
      }
    }
  }
  walk(path.join(root, 'src'))
  return out
}

describe('every attach of an ACP session is listed with why', () => {
  it('a new attach entry fails here until it goes through the resume decision or says why it does not', () => {
    const found = attachSites()
    // The host's own runner call route (host-routes.ts) attaches the host's own sessions, which no
    // host resumes: listed apart.
    delete found['src/core/session-channel/host-routes.ts']
    expect(Object.keys(found).sort()).toEqual(Object.keys(ATTACHES).sort())
  })

  it('the runner\'s entries that skip the ask are exactly the ones that asked just before or stay legacy', () => {
    const src = readFileSync(FILE, 'utf8')
    const asked = src.match(/maybeAttachAcpSession\([^)]*\{ asked: true \}\)/g) ?? []
    expect(asked).toHaveLength(4)
    expect(src).toMatch(/return found \?\? await this\.maybeAttachAcpSession\(sessionId\) \?\? this\.hostProxyOf\(sessionId\)\n/)
  })
})
