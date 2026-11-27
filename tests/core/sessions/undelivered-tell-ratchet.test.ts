/**
 * No way of setting a message aside or voiding it unsent can skip telling its sender, or skip the
 * ledger's step (2026-11-26, the Reflection VP's audit: a host's refusal parked a peer's ask and a
 * trigger's reminder with no `parked` step, the ask was retired unread, and its sender never heard).
 * Enumerated from the source, so a new member fails here:
 *  - every ledger step is named for what it means to a sender (undelivered-tell.ts STEP_MEANING);
 *  - the ledger hands every step it writes to the teller (one observer, in recordDelivery);
 *  - every place that writes a set-aside or voided step is listed here, and the only one that
 *    tells by itself (a note the hold dropped, `via: hold`) does tell;
 *  - a row's park and every way out are recorded where the queue file is written, its one writer
 *    (session-queue-exits.ts, delivery-ledger-facts-ratchet.test.ts), a host's as a channel fact the
 *    leader records;
 *  - a note's fate is set dropped only where its sender is told;
 *  - a host's refusal proves the message never ran, so a parked ask is answered at once.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { STEP_MEANING } from '../../../src/core/sessions/undelivered-tell.js'
import { parkMeansNeverRan } from '../../../src/core/sessions/undelivered-requests.js'
import { HOST_REFUSED_REASON } from '../../../src/providers/host-judged-send.js'
import { HOLD_REASONS } from '../../../src/core/relay-fates.js'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf-8')

/** Every source file under src/, tracked or new. */
function srcFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'src/'], { cwd: ROOT, encoding: 'utf-8' })
  return out.split('\n').filter((f) => /\.tsx?$/.test(f) && fs.existsSync(path.join(ROOT, f)))
}

function sites(pattern: string): Array<{ file: string; text: string }> {
  let out = ''
  try {
    out = execFileSync('git', ['grep', '--untracked', '-nE', pattern, '--', 'src/'], { cwd: ROOT, encoding: 'utf-8' })
  } catch (err) {
    if ((err as { status?: number }).status === 1) return []
    throw err
  }
  return out.split('\n').filter(Boolean).map((l) => {
    const m = /^([^:]+):\d+:(.*)$/.exec(l)!
    return { file: m[1]!, text: m[2]! }
  }).filter((s) => !/^\s*(\/\/|\*|\/\*)/.test(s.text))
}

describe('every ledger step has a meaning for the sender', () => {
  it('STEP_MEANING names each step of DeliveryStep, and set-aside and voided are what the queue and the hold write', () => {
    const src = read('src/core/sessions/delivery-ledger.ts')
    const union = /export type DeliveryStep = ([^;]+);/.exec(src)![1]!
    const steps = [...union.matchAll(/'(\w+)'/g)].map((m) => m[1]).sort()
    expect(Object.keys(STEP_MEANING).sort()).toEqual(steps)
    expect(STEP_MEANING.parked).toBe('set-aside')
    for (const s of ['dropped', 'removed', 'cancelled'] as const) expect(STEP_MEANING[s], s).toBe('voided')
    // Every step a queue exit may carry (a host's included) is one of them or a delivery.
    const exits = [...(/const EXIT_STEPS[^=]*= new Set\(\[([^\]]+)\]/.exec(src)![1]!).matchAll(/'(\w+)'/g)].map((m) => m[1]!)
    expect(exits).toContain('parked')
    for (const s of exits) expect(['set-aside', 'voided', 'delivered', 'on-its-way'], s).toContain(STEP_MEANING[s as keyof typeof STEP_MEANING])
  })
})

describe('the ledger hands every step to the teller', () => {
  it('one observer, called for each step once it is written, installed by the ledger\'s start', () => {
    const src = read('src/core/sessions/delivery-ledger.ts')
    expect(src).toMatch(/await fsp\.appendFile\(fileOf\(row\.at\)[^\n]*\n\s*try \{ stepObserver\?\.\(row\); \}/)
    expect(src).toContain('stepObserver = m.observeDeliveryStep;')
    // The only step not written (so not told) is the second report of one park.
    const body = src.slice(src.indexOf('export function recordDelivery('), src.indexOf('export function recordQueuedRow('))
    expect([...body.matchAll(/\breturn chain;/g)]).toHaveLength(2)
    expect(body).toMatch(/row\.step === 'parked' && was\?\.step === 'parked'[^\n]*return chain;/)
  })

  it('every place that writes a set-aside or voided step is known; the one that tells by itself does tell', () => {
    // Read whole files: a call spread over several lines counts too.
    const files = srcFiles().filter((f) => /recordDelivery\(\{[^}]*?step: '(parked|dropped|removed|cancelled)'|step: d\.parked \? 'parked'/.test(read(f))).sort()
    expect(files, 'a new way to set a message aside or void it: its step reaches the teller by itself (recordDelivery), so name it here once you checked its `why` says what happened and `via` is right').toEqual([
      'src/core/session-message-queue.ts',
      'src/core/sessions/delivery-ledger.ts',
      'src/core/sessions/held-notices.ts',
    ])
    // `via: hold` (the teller leaves it alone) only where the hold drops a note and tells its sender.
    const held = read('src/core/sessions/held-notices.ts')
    const drop = held.slice(held.indexOf('export function dropParts('), held.indexOf('/** The rider outcome'))
    expect(drop).toContain('via: HOLD_DROP_VIA')
    expect(drop).toMatch(/queueTell\(\{\s*kind: 'dropped'/)
    expect([...new Set(sites('HOLD_DROP_VIA').map((s) => s.file))].sort()).toEqual(['src/core/sessions/held-notices.ts', 'src/core/sessions/undelivered-tell.ts'])
    // A park marked `wait` (told only if it lasts) is a hold that goes by itself, nothing else.
    const queue = read('src/core/session-message-queue.ts')
    expect(queue).toMatch(/if \(holdsCold \|\| holdsRow\) \{[\s\S]{0,400}via: 'wait'/)
    const exits = read('src/core/session-queue-exits.ts')
    expect(exits).toMatch(/HOLD_REASONS\.has\(at\.parkedReason \?\? ''\) \? \{ via: PARK_WAIT_VIA \}/)
  })

  it('every tell to a sender is written in the ledger as `told`, by one writer', () => {
    // 2026-11-27, the Reflection VP's audit: a held note's sender was told it still waited, and the
    // ledger had no `told`: the hold's tells (still waiting, dropped) wrote none, only a queue row's did.
    const store = read('src/core/sessions/held-notices-store.ts')
    const queue = store.slice(store.indexOf('export function queueTell('), store.indexOf('/**\n * Take back queued tells'))
    expect(queue).toMatch(/queueTell\(t: DropTell & \{ mid: string \}, told: ToldStep\)/)
    expect(queue).toMatch(/tells\.push\(t\);[\s\S]*recordSenderTold\(\{/)
    // A tell is queued only by queueTell, and held for its sender only by flushDropTells.
    expect(sites('\\btells\\.push\\(').map((s) => s.file)).toEqual(['src/core/sessions/held-notices-store.ts', 'src/core/sessions/held-notices-store.ts'])
    expect(store).toMatch(/export function settleTells[\s\S]{0,400}tells\.push\(\.\.\.untold\)/)
    expect([...new Set(sites('DROP_TELL_KEY,').filter((s) => /holdFoldedNotice/.test(s.text)).map((s) => s.file))]).toEqual(['src/core/sessions/held-notices-sweep.ts'])
    // Nobody writes `told` but recordSenderTold; it is called by the queue and by a peer's ask answered
    // through its request (no tell is queued there: its asker's notice).
    expect(srcFiles().filter((f) => /step: 'told'/.test(read(f)))).toEqual(['src/core/sessions/delivery-ledger.ts'])
    expect([...new Set(sites('recordSenderTold\\(').map((s) => s.file))].sort()).toEqual([
      'src/core/sessions/delivery-ledger.ts', 'src/core/sessions/held-notices-store.ts', 'src/core/sessions/undelivered-requests.ts', 'src/core/sessions/undelivered-tell.ts',
    ])
    // The hold's own tells never count as a row's park or void told (a note that rides a row later is told of it).
    const teller = read('src/core/sessions/undelivered-tell.ts')
    expect(teller).toMatch(/if \(l\.via === 'note-wait' \|\| l\.via === 'note-void'\) continue;/)
    const held = read('src/core/sessions/held-notices.ts')
    expect([...held.matchAll(/\}, \{ via: '(note-wait|note-void)', sessionId: sid \}\);/g)].map((m) => m[1]).sort()).toEqual(['note-void', 'note-wait'])
  })

  it('a note\'s fate reads dropped only where its sender is told', () => {
    const files = [...new Set(sites(`state: 'dropped'`).map((s) => s.file))].sort()
    expect(files.filter((f) => f.startsWith('src/core/sessions/'))).toEqual(['src/core/sessions/held-notices.ts', 'src/core/sessions/undelivered-tell.ts'])
  })
})

describe('a way out of the queue that says nothing of a row is known', () => {
  it('only a host giving back a line its leader delivers itself is `silent`', () => {
    const found = sites(`noteQueueExit\\([^)]*'silent'`)
    expect(found.map((s) => s.file), 'a new silent exit tells no sender and writes no step: say why its row is not undelivered').toEqual(['src/core/session-message-queue.ts'])
    const queue = read('src/core/session-message-queue.ts')
    expect(queue.slice(queue.indexOf('export async function withdrawQueuedLines('), queue.indexOf('export async function withdrawQueuedLines(') + 2500)).toContain("noteQueueExit(m.id, 'silent')")
  })

  it('a row that leaves while in its delivery\'s hands is recorded by that delivery, not here', () => {
    const exits = read('src/core/session-queue-exits.ts')
    // The one unnamed exit that writes nothing: a processing row (written/read come from its delivery) or a host's hand.
    expect(exits).toMatch(/if \(!step && \(before\.status === 'processing' \|\| before\.transit === 'host'\)\) continue;/)
  })
})

describe('the queue file\'s one writer records every park', () => {
  it('a row that goes into `parked` (or parks again for another reason) and one put back in line are steps', () => {
    const exits = read('src/core/session-queue-exits.ts')
    expect(exits).toContain('function parkStep(')
    expect(exits).toMatch(/const step = parkStep\(before, at\);/)
  })
})

describe('which parks prove a message never ran', () => {
  it('a host\'s refusal does: its asker is answered at once; a hold on its own clock does not', () => {
    expect(parkMeansNeverRan(`${HOST_REFUSED_REASON}: host_runs_sessions_off`)).toBe(true)
    for (const r of HOLD_REASONS) expect(parkMeansNeverRan(r), r).toBe(false)
  })
})
