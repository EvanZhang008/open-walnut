/**
 * Every executeOp call in src/commands names its caller through cliOpCaller.
 *
 * The executor no longer reads WALNUT_SESSION_ID from its own env (an HTTP plugin call must
 * never inherit the server's session), so a CLI call that names no caller reads as an
 * anonymous automation: a session's `walnut approve` lost its session, and a person typing in
 * a terminal read as a script. This ratchet lists every call site; a new one, or one that
 * builds its caller by hand, fails until it uses cliOpCaller.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const COMMANDS = path.join(ROOT, 'src/commands')

/** file -> number of executeOp calls. Update when a command gains or loses one. */
const EXPECTED: Record<string, number> = {
  'approve.ts': 2,
  'browser.ts': 1,
  'guide.ts': 1,
  'mcp-client.ts': 1,
  'pass.ts': 1,
  'tools.ts': 2,
  'wait.ts': 1,
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return sourceFiles(p)
    return /\.tsx?$/.test(e.name) ? [p] : []
  })
}

/** The argument text of each `executeOp(...)` call, by paren balance. */
function executeOpCalls(src: string): string[] {
  const out: string[] = []
  const re = /\bexecuteOp\s*\(/g
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 1
    let i = m.index + m[0].length
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '(') depth++
      else if (src[i] === ')') depth--
    }
    out.push(src.slice(m.index + m[0].length, i - 1))
  }
  return out
}

const files = sourceFiles(COMMANDS).map((p) => ({ rel: path.relative(COMMANDS, p), src: fs.readFileSync(p, 'utf8') }))

describe('CLI executeOp callers name their caller (cliOpCaller)', () => {
  it('the list of call sites is exactly the known one', () => {
    const found: Record<string, number> = {}
    for (const f of files) {
      const n = executeOpCalls(f.src).length
      if (n) found[f.rel] = n
    }
    expect(found).toEqual(EXPECTED)
  })

  for (const f of files) {
    const calls = executeOpCalls(f.src)
    if (!calls.length) continue
    it(`${f.rel}: every call spreads the cliOpCaller result`, () => {
      const boundCaller = /\bconst caller\s*=\s*cliOpCaller\(\)/.test(f.src)
      for (const args of calls) {
        const inline = /\.\.\.cliOpCaller\(\)/.test(args)
        const spread = boundCaller && /\.\.\.caller\b/.test(args)
        expect(inline || spread, `${f.rel}: executeOp(${args.trim().slice(0, 80)}...) names no cliOpCaller caller`).toBe(true)
        // A hand-built caller beside it would override or duplicate the helper's answer.
        expect(args).not.toMatch(/\b(callerSid|callerMode|sender)\s*:/)
      }
    })
  }

  it('no command builds a caller by hand from cliAutomationSender', () => {
    for (const f of files) expect(f.src, f.rel).not.toMatch(/\bcliAutomationSender\s*\(/)
  })
})
