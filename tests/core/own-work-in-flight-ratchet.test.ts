/**
 * Ratchet: a watch of the task's own work (watches:"own") counts as that work going on only while
 * the work is in flight (task-wait-wake.ts ownWorkInFlight), never because it is armed.
 *
 * 2026-11-23, the user: "I don't even know if they are actually working or stopped". A task read
 * Working with its session idle and its Mac queue empty: the queue arms an own-work watch for every
 * task that ever used it, and it stays armed until the task completes. Its check now prints
 * `"idle": true` when nothing is queued, running or unread, and the server keeps that on the
 * trigger's lastCheck (trigger-apply.ts).
 *
 * Enumerated from source, so a new path fails here until it asks the in-flight rule:
 *  1. every `ownWorkTriggers:` value built in src/ (what reads Working and draws the own lines)
 *     filters with ownWorkInFlight;
 *  2. the facts that feed it carry the job's lastCheck.idle;
 *  3. every other call of triggerWatchesOwnWork (the kind of a watch, whatever its work does now)
 *     is listed below with why it may ignore the idle mark;
 *  4. the daemon puts the idle mark on the quiet trigger.checked event (checkIdleOf, which
 *     also waits for every earlier fire's ack);
 *  5. every ownWorkInFlight / ownWorkWakes call passes when the task's sessions last worked: an idle
 *     mark from a check before that may predate a request the turn queued.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
const SRC = path.join(ROOT, 'src')

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(e.name) ? [p] : []
  })
}

const files = walk(SRC).map((f) => ({ rel: path.relative(ROOT, f), text: fs.readFileSync(f, 'utf8') }))

/** Calls of triggerWatchesOwnWork that ask what kind a watch is, never whether its work goes on. */
const KIND_ONLY_CALLERS: Record<string, string> = {
  'src/core/task-wait-wake.ts': 'its definition, and ownWorkInFlight built on it',
  'src/core/user-status-sync.ts': 'keeps every own-work watch out of `triggers`: an idle one is no wait outside either',
  'src/core/routines/trigger-update-patch.ts': 'reports a change of `watches` in an update, a definition change',
}

describe('an own-work watch is work going on only while that work is in flight', () => {
  it('every ownWorkTriggers value in src/ filters with ownWorkInFlight', () => {
    const producers = files.flatMap((f) => f.text.split('\n')
      .map((line, i) => ({ where: `${f.rel}:${i + 1}`, line }))
      .filter(({ line }) => /\bownWorkTriggers\s*:/.test(line) && !/^\s*(\/\/|\*|\/\*\*)/.test(line) && !/ownWorkTriggers\?\s*:\s*readonly/.test(line)))
    expect(producers.length, 'no producer found: the pattern went stale').toBeGreaterThan(0)
    for (const p of producers) expect(p.line, p.where).toMatch(/ownWorkInFlight\(t, /)
  })

  it('every ownWorkInFlight and ownWorkWakes call passes when the task\'s sessions last worked', () => {
    const calls = files.flatMap((f) => [...f.text.matchAll(/\b(ownWorkInFlight|ownWorkWakes)\(([^)]*)/g)]
      .filter((m) => !/function\s+$/.test(f.text.slice(Math.max(0, m.index! - 20), m.index!)))
      .map((m) => ({ where: f.rel, call: m[0] })))
    expect(calls.length).toBeGreaterThan(3)
    // Two arguments: the watch (or task) and the work-end time; a bare reference drops the time.
    for (const c of calls) expect(c.call, c.where).toMatch(/\(\s*[^,\s][^,]*,\s*\S/)
    for (const f of files) expect(f.text, f.rel).not.toMatch(/filter\(ownWorkInFlight\)/)
  })

  it('the status facts carry the job\'s lastCheck.idle beside ownWork', () => {
    const sync = files.find((f) => f.rel === 'src/core/user-status-sync.ts')!.text
    const push = sync.split('\n').filter((l) => /job\.ownWork \? \{ ownWork: true/.test(l))
    expect(push.length).toBe(1)
    expect(push[0]).toMatch(/lastCheck\?\.idle === true/)
  })

  it('every other triggerWatchesOwnWork call is listed with why it may ignore the idle mark', () => {
    const callers = files.filter((f) => /\btriggerWatchesOwnWork\(/.test(f.text)).map((f) => f.rel).sort()
    expect(callers).toEqual(Object.keys(KIND_ONLY_CALLERS).sort())
  })

  it('the daemon sends the idle mark on a quiet check, from the shared rule', () => {
    // A check's run is the trigger runs' (daemon-trigger-runs.ts, an area module of the daemon runtime).
    const text = files.find((f) => f.rel === 'src/providers/daemon-trigger-runs.ts')!.text
    expect(text).toMatch(/checkIdleOf\(output, decision, entry\.state\)/)
  })
})
