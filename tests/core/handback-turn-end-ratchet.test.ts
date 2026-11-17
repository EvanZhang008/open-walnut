/**
 * Every caller of handBackTaskOnSessionEnd says whether the end it reports is a clean turn end.
 * A clean turn end (`turnEnd: true`) is routine and logs at info; any other end logs the
 * "out-of-band session end" warn that the health monitor counts.
 *
 * 2026-11-16: a daemon's snapshot of a settled turn usually lands before the server's own result
 * handler, so most ordinary turn ends were logged as out-of-band warns (237 of 280 in a day) and
 * the count grew with the day's turns until the log-spike alarm fired. A new caller fails this
 * test until it passes `turnEnd` or is listed here with why its end is never a clean turn end.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
const SRC = path.join(ROOT, 'src')

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return walk(p)
    return /\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name) ? [p] : []
  })
}

/** Callers whose end is never a clean turn end (so the warn is right), keyed by file and source. */
const NOT_A_TURN_END: Record<string, string> = {
  'src/core/session-reconciler.ts:session-reconciler': 'a session whose process is gone (stopped or errored)',
  'src/core/session-reconcile.ts:session-reconcile': 'a turn whose result the server missed, found in the transcript',
  'src/core/sessions/auto-recover-env.ts:auto-recover': 'restart recovery gave up on a session a restart cut',
  'src/core/session-snapshot-apply.ts:snapshot-apply:${source}#terminal': 'a snapshot that reports the process ended',
  'src/providers/daemon-connection.ts:daemon-reconnect:acp-worker-gone': 'an ACP worker that is gone after a reconnect',
}

describe('handBackTaskOnSessionEnd callers declare a clean turn end', () => {
  it('each call passes turnEnd or is listed as never a turn end', () => {
    const undeclared: string[] = []
    const seen = new Set<string>()
    for (const file of walk(SRC)) {
      const rel = path.relative(ROOT, file)
      const text = fs.readFileSync(file, 'utf8')
      const re = /handBackTaskOnSessionEnd\(([^,]+),\s*([^,]+),\s*(['`])([^'`]+)\3/g
      for (const m of text.matchAll(re)) {
        // The call's own argument list: up to the matching close paren.
        let depth = 0
        let end = m.index!
        for (let i = text.indexOf('(', m.index!); i < text.length; i++) {
          if (text[i] === '(') depth++
          else if (text[i] === ')' && --depth === 0) { end = i; break }
        }
        const call = text.slice(m.index!, end)
        if (/\bturnEnd:/.test(call)) continue
        const terminal = /TERMINAL\.has\(projected\)/.test(text.slice(Math.max(0, m.index! - 200), m.index!))
        const key = `${rel}:${m[4]}${terminal ? '#terminal' : ''}`
        seen.add(key)
        if (!NOT_A_TURN_END[key]) undeclared.push(key)
      }
    }
    expect(undeclared, 'pass turnEnd, or list the caller in NOT_A_TURN_END with why').toEqual([])
    // A listed caller that no longer exists is removed from the list.
    expect(Object.keys(NOT_A_TURN_END).filter((k) => !seen.has(k))).toEqual([])
  })
})
