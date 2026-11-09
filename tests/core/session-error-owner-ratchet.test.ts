/**
 * Every Needs you a failure makes says whether the failure is the user's kind (2026-11-09, the CEO
 * for the user: two sessions failed on ECONNRESET, Walnut's own retries failed too, and both read
 * Needs you with "Retry it or open it": retrying what an agent broke was never his decision).
 *
 * A status with `source: 'error'` is a failure shown as Needs you. Each place in src/ that makes one
 * is listed here with why it may reach the user. The rule for all but the user's own terminal is
 * `failureOf` in user-status.ts: his kind (credentials, a sign-in, a permission, spending) or no
 * node above the task, else the task waits on its lead, its VP or Main. A new place fails here
 * until it is routed through `failureOf` or listed with its reason.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..')
const SRC = join(ROOT, 'src')

/** file -> each line making a failure's Needs you, by a snippet of it, with whether it is his kind. */
const LISTED: Record<string, Array<{ snippet: string; his: string }>> = {
  'src/core/user-status.ts': [
    { snippet: "if (!owner) return strip<UserStatus>({ state: 'needs', source: 'error'", his: 'failureOf: his kind by the error text (usersErrorKind), or no lead, VP or Main above the task' },
    { snippet: 'has its session open in a terminal right now', his: "yes: the user's own terminal holds the session, only closing it frees it" },
  ],
}

/** Every call of failureOf: each failure Walnut could not undo goes through the one rule. */
const FAILURE_OF_CALLS = 5

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

describe('a failure reaches the user only when it is his kind', () => {
  it('every place that makes a failure\'s Needs you is listed with whether it is his', () => {
    const found: Record<string, string[]> = {}
    for (const file of walk(SRC)) {
      const lines = readFileSync(file, 'utf8').split('\n').filter((l) => /source:\s*['"]error['"]/.test(l))
      if (lines.length) found[relative(ROOT, file)] = lines
    }
    const unlisted: string[] = []
    for (const [file, lines] of Object.entries(found)) {
      for (const line of lines) {
        if (!(LISTED[file] ?? []).some((e) => line.includes(e.snippet))) unlisted.push(`${file}: ${line.trim().slice(0, 160)}`)
      }
    }
    expect(unlisted, 'route it through failureOf (user-status.ts), or list it here with why it is the user\'s').toEqual([])
    // A listed place that is gone is dropped from the list too.
    for (const [file, entries] of Object.entries(LISTED)) {
      for (const e of entries) expect((found[file] ?? []).some((l) => l.includes(e.snippet)), `${file}: ${e.snippet}`).toBe(true)
    }
  })

  it('every failure Walnut gave up on goes through failureOf', () => {
    const src = readFileSync(join(SRC, 'core', 'user-status.ts'), 'utf8')
    const calls = src.split('\n').filter((l) => /\bfailureOf\(/.test(l) && !/^\s*(\*|\/\/)/.test(l) && !/function failureOf/.test(l))
    expect(calls.length, calls.join('\n')).toBe(FAILURE_OF_CALLS)
  })
})
