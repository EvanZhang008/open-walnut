/**
 * The delivery ledger misses no step a host or the queue knows of (2026-11-25, the Reflection VP's
 * daily audit):
 *  - after the Mac slept 3.4 hours, 57 delivered messages read `written` and never `read`: the
 *    host's fact log, compacted while its leader was away, folded each CLI read
 *    (`session:user-line`) into a turn summary;
 *  - 12 messages read `parked` for 31 to 39 hours and 3 `queued` for up to 44 hours, long gone from
 *    every queue: the ways that took them out wrote no step.
 *
 * Enumerated from the source, so a new member of either class fails here:
 *  - every event the ledger records a step from is a channel fact the host's log keeps whole: never
 *    folded into a turn summary, never a snapshot, never a flow;
 *  - the queue file is written in one place, which tells every row that left it (session-queue-exits.ts).
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { DELIVERY_LEDGER_EVENTS } from '../../../src/core/sessions/delivery-ledger.js'
import { DELIVERY_STEP_FACTS, SESSION_EVENT_CLASS, SNAPSHOT_FACTS, TURN_END_FACT, TURN_SUMMARY_FACTS } from '../../../src/core/session-channel/event-classes.js'
import { compactRecords, type FactRecord } from '../../../src/core/session-channel/fact-log.js'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf-8')

function sites(pattern: string): Array<{ file: string; text: string }> {
  let out = ''
  try {
    out = execFileSync('git', ['grep', '-nE', pattern, '--', 'src/'], { cwd: ROOT, encoding: 'utf-8' })
  } catch (err) {
    if ((err as { status?: number }).status === 1) return []
    throw err
  }
  return out.split('\n').filter(Boolean).map((l) => {
    const m = /^([^:]+):\d+:(.*)$/.exec(l)!
    return { file: m[1]!, text: m[2]! }
  }).filter((s) => !/^\s*(\/\/|\*|\/\*)/.test(s.text))
}

const rec = (seq: number, name: string, data: unknown = {}): FactRecord =>
  ({ v: 2, seq, opId: `o${seq}`, rev: 1, at: seq, kind: 'session-fact', sid: 's1', sseq: seq, name, data, line: { v: seq * 10 } })

describe('every step the ledger records reaches the leader from a host', () => {
  it('is a fact the host keeps whole: never in a turn summary, never a snapshot', () => {
    expect(DELIVERY_LEDGER_EVENTS.length).toBeGreaterThan(5)
    for (const name of DELIVERY_LEDGER_EVENTS) {
      expect(SESSION_EVENT_CLASS[name], name).toBe('fact')
      expect(TURN_SUMMARY_FACTS.has(name), name).toBe(false)
      expect(SNAPSHOT_FACTS.has(name), name).toBe(false)
    }
    // The CLI's read of a line is the ledger's `read`, and named as a delivery step.
    expect(DELIVERY_STEP_FACTS.has('session:user-line')).toBe(true)
    for (const name of DELIVERY_STEP_FACTS) expect(DELIVERY_LEDGER_EVENTS as readonly string[]).toContain(name)
  })

  it('the ledger subscribes to exactly that list and records a step for each', () => {
    const src = read('src/core/sessions/delivery-ledger.ts')
    expect(src).toContain('interest: [...DELIVERY_LEDGER_EVENTS]')
    const body = src.slice(src.indexOf('export function onDeliveryEvent('), src.indexOf('const SUBSCRIBER ='))
    const cases = [...body.matchAll(/case EventNames\.(\w+):/g)].map((m) => m[1]).sort()
    const listed = [...src.slice(src.indexOf('export const DELIVERY_LEDGER_EVENTS'), src.indexOf('as const;')).matchAll(/EventNames\.(\w+)/g)].map((m) => m[1]).sort()
    expect(cases).toEqual(listed)
  })

  it('a compaction of a finished turn keeps every ledger fact of it', () => {
    const facts = DELIVERY_LEDGER_EVENTS.filter((n) => n !== TURN_END_FACT)
    const records = [
      ...facts.map((name, i) => rec(i + 1, name, { sessionId: 's1' })),
      rec(facts.length + 1, 'session:tool-use', { name: 'Bash' }),
      rec(facts.length + 2, 'session:tool-result', {}),
      rec(facts.length + 3, TURN_END_FACT, { result: 'done' }),
    ]
    const out = compactRecords(records)
    for (const name of facts) expect(out.some((r) => r.name === name), name).toBe(true)
    // Transcript detail still folds.
    expect(out.filter((r) => r.name === 'session:tool-use')).toEqual([])
    expect(out.some((r) => r.name === 'turn-summary')).toBe(true)
  })
})

describe('every row that leaves the queue is told', () => {
  it('the queue file is written in one place, which tells the rows that left it', () => {
    const writes = sites('writeJsonFile\\(SESSION_QUEUE_FILE')
    expect(writes.map((s) => s.file)).toEqual(['src/core/session-queue-store.ts'])
    const store = read('src/core/session-queue-store.ts')
    // The fresh read's places are taken before this process's changes, and the exits told after the write.
    expect(store).toMatch(/const places = placesOf\(s\);[\s\S]*applyPatch\(s, patch\);[\s\S]*await writeJsonFile\(SESSION_QUEUE_FILE, s, \{ durable \}\);\s*recordQueueExits\(exitsBetween\(places, s\)\);/)
    // Nothing else names the queue file but its spool's path (rows stored beside it, merged in by the store).
    const named = sites('SESSION_QUEUE_FILE').map((s) => s.file).filter((f) => f !== 'src/core/session-queue-store.ts' && f !== 'src/constants.ts')
    expect([...new Set(named)]).toEqual(['src/core/session-queue-spool.ts'])
    expect(read('src/core/session-queue-spool.ts')).not.toMatch(/writeJsonFile\(SESSION_QUEUE_FILE|rename\([^)]*SESSION_QUEUE_FILE\)/)
  })
})
