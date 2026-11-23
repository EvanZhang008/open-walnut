/**
 * Every write of the sessions table in the session store reaches the row hook
 * (src/core/session-channel/row-hook.ts), so a host that runs its sessions turns each write of an
 * own row into a `row` fact and its leader never misses one.
 *
 * The hook is fed by the write lock (session-tracker.ts withWriteLock -> announceWrittenRows) from
 * the rows a section noted (noteSessionRowTouched). So: every INSERT / UPDATE / DELETE of `sessions`
 * in session-tracker.ts must note its row right after, and every one in session-db.ts must be one of
 * the writes listed below with the reason it needs no row fact. A new raw write fails here until it
 * does one or the other.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const WRITE = /\b(INSERT(?:\s+OR\s+REPLACE)?\s+INTO\s+sessions\b|UPDATE\s+sessions\b|DELETE\s+FROM\s+sessions\b)/g
/** How far after the statement its note may come (the row's id is bound a few lines on). */
const NOTE_WITHIN_LINES = 40

/** Writes that need no row fact, by the function they are in, with why. */
const NO_ROW_FACT: Record<string, Record<string, string>> = {
  'src/core/session-db.ts': {
    applySessionCopy: "the leader's sessions copy on a host: an own row takes only its leader fields, which the leader already holds",
    writeCopyRow: "a start's claim of a copied row (claimStartingRow), or an own row given back to the leader (handOwnRowBack): the leader's copy, marked this host's or as the leader has it; the runner's first own write after a claim is the session's born record (a resume's claim announces its row at once, host-boot.ts taken), and a row given back is the leader's own",
    applyCompanionSessionCopy: "the companion's file of the Mac's sessions, never a host's own rows",
    ensureSessionStatusColumns: 'the schema migration at open, before any listener is installed',
  },
  'src/core/session-tracker.ts': {},
}

function enclosingFunction(lines: string[], at: number): string {
  for (let i = at; i >= 0; i--) {
    const m = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/.exec(lines[i])
    if (m) return m[1]
  }
  return '(top level)'
}

function writesOf(file: string): Array<{ line: number; fn: string; noted: boolean; sql: string }> {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
  const lines = text.split('\n')
  const out: Array<{ line: number; fn: string; noted: boolean; sql: string }> = []
  lines.forEach((l, i) => {
    // Comments name these statements too; only code counts.
    if (/^\s*(\/\/|\*)/.test(l)) return
    for (const m of l.matchAll(WRITE)) {
      const after = lines.slice(i, i + NOTE_WITHIN_LINES).join('\n')
      out.push({ line: i + 1, fn: enclosingFunction(lines, i), noted: /noteSessionRowTouched\(/.test(after), sql: m[1] })
    }
  })
  return out
}

describe('every write of the sessions table reaches the row hook', () => {
  for (const file of Object.keys(NO_ROW_FACT)) {
    it(`${file}: each write notes its row or is listed with a reason`, () => {
      const writes = writesOf(file)
      expect(writes.length).toBeGreaterThan(0)
      const missing = writes.filter((w) => !w.noted && !NO_ROW_FACT[file][w.fn])
        .map((w) => `${file}:${w.line} ${w.sql} in ${w.fn}()`)
      expect(missing, 'note the row (noteSessionRowTouched) right after the write, or list the function in NO_ROW_FACT with why').toEqual([])
    })
  }

  it('lists no exemption that no longer writes', () => {
    for (const [file, fns] of Object.entries(NO_ROW_FACT)) {
      const present = new Set(writesOf(file).map((w) => w.fn))
      for (const fn of Object.keys(fns)) expect(present.has(fn), `${file} ${fn}`).toBe(true)
    }
  })

  it('the write lock announces the rows it noted', () => {
    const tracker = fs.readFileSync(path.join(ROOT, 'src/core/session-tracker.ts'), 'utf8')
    const lock = tracker.slice(tracker.indexOf('function withWriteLock'), tracker.indexOf('function withWriteLock') + 3000)
    expect(lock).toMatch(/announceWrittenRows\(touched\)/)
    expect(tracker).toMatch(/noteSessionRowWritten\(rowToSession\(row\)\)/)
  })
})
