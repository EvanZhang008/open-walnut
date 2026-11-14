/**
 * Several sends Claude Code drains into ONE user line: every bubble of the run is
 * absorbed, whichever of their uuids the line carries.
 *
 * inc-1794638780357 (2026-11-14): two messages sent while a turn ran ("cr why is it
 * neede", "is the draft cr done") reached the model as one line,
 * "cr why is it neede\nis the draft cr done". Claude Code 2.1.322 writes that line
 * under the LAST send's uuid and lists the others in `mergedSendUuids`. The uuid
 * pass (U22, 2026-11-10) proved the second bubble by the line's uuid and retired
 * the line from the text multisets, so the merged-run passes could no longer see
 * it: the first bubble had no evidence left and stayed "Delivered ✓" at the bottom
 * of the timeline, under five later messages.
 *
 * Guards: the whole run/anchor/separator matrix below, with and without the
 * line's `mergedUuids`, and a source scan that every place in web/src that
 * collects a user row's uuids goes through sendUuidsOfRow, so a new collector
 * cannot miss the merged ones.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { dedupeOptimisticMessages, historyUuidsOf, settleShownByUuid } from '@/components/sessions/optimistic-dedup'
import { sendUuidsOfRow } from '@/utils/send-uuids'

const uuid = (n: number) => `22222222-aaaa-4bbb-8ccc-${String(n).padStart(12, '0')}`
const T0 = Date.UTC(2026, 10, 14, 6, 43, 0)
const at = (s: number) => new Date(T0 + s * 1000).toISOString()
const user = (text: string, extra: Record<string, unknown> = {}) => ({ role: 'user', text, ...extra })
const asst = (text: string, s: number) => ({ role: 'assistant', text, timestamp: at(s) })
const bubble = (text: string, n: number, s: number, extra: Record<string, unknown> = {}) => ({
  text, status: 'delivered', queueId: `qm-${n}`, userUuid: uuid(n), timestamp: at(s), ...extra,
})

describe('the incident: two mid-turn sends merged into one line', () => {
  const A = bubble('cr why is it neede', 1, 27)
  const B = bubble('is the draft cr done', 2, 34)
  const history = [
    user('bor why u add this?', { msgId: uuid(9), timestamp: at(23) }),
    asst('first answer', 42),
    // The CLI wrote the merged line under B's uuid, A's in mergedSendUuids.
    user('cr why is it neede\nis the draft cr done', { msgId: uuid(2), timestamp: at(43) }),
    asst('second answer', 61),
    user('I meanwhy i create it', { msgId: uuid(10), timestamp: at(132) }),
    asst('third answer', 141),
  ]

  it('absorbs both bubbles from the line uuid alone (a parse without mergedUuids)', () => {
    // Watermark past the merged line (later turns started): only uuid and time reach it.
    expect(dedupeOptimisticMessages([A, B], history, 4)).toEqual([])
    // Watermark at the line: the same.
    expect(dedupeOptimisticMessages([A, B], history, 2)).toEqual([])
  })

  it('absorbs both bubbles when the line lists the merged uuids', () => {
    const withMerged = history.map((m, i) => (i === 2 ? { ...m, mergedUuids: [uuid(1)] } : m))
    expect(dedupeOptimisticMessages([A, B], withMerged, 4)).toEqual([])
    // Exact ids: a bubble whose text no longer reconstructs the line (Walnut wrapped
    // it) is still proven by its own uuid.
    const wrapped = { ...A, dedupText: '[Images attached]\ncr why is it neede' }
    expect(dedupeOptimisticMessages([wrapped, B], withMerged, 4)).toEqual([])
  })

  it('a later bubble the history does not hold stays on screen', () => {
    const C = bubble('what is this tim fix why he ask u i am confused', 3, 165)
    expect(dedupeOptimisticMessages([A, B, C], history, 4)).toEqual([C])
  })

  it('settleShownByUuid marks a merged send delivered by its listed uuid', () => {
    const withMerged = [user('a\nb', { msgId: uuid(2), mergedUuids: [uuid(1)] })]
    const out = settleShownByUuid([bubble('a', 1, 0, { status: 'received' }), bubble('b', 2, 1, { status: 'received' })], withMerged)
    expect(out.map((m) => m.status)).toEqual(['delivered', 'delivered'])
    expect([...historyUuidsOf(withMerged).keys()].sort()).toEqual([uuid(1), uuid(2)].sort())
  })
})

describe('every merged-run shape absorbs exactly its own bubbles', () => {
  const words = ['alpha one', 'beta two', 'gamma three', 'delta four']
  // Claude Code writes a merged line under its LAST send's uuid and lists the
  // others in mergedSendUuids. A row that lists them proves every member by uuid,
  // wherever the line's own uuid sits; one that does not (an older parse) proves
  // the members BEFORE the line's uuid by the join, and never a bubble after it.
  for (const len of [2, 3, 4]) {
    for (let anchor = 0; anchor < len; anchor++) {
      for (const sep of ['\n', '\n\n']) {
        for (const listed of [false, true]) {
          it(`run of ${len}, line under bubble ${anchor + 1}'s uuid, sep ${JSON.stringify(sep)}, mergedUuids ${listed}`, () => {
            const run = words.slice(0, len).map((w, i) => bubble(w, i + 1, i))
            const others = run.filter((_, i) => i !== anchor).map((b) => b.userUuid)
            const line = user(run.map((b) => b.text).join(sep), {
              msgId: run[anchor].userUuid, timestamp: at(len + 1), ...(listed ? { mergedUuids: others } : {}),
            })
            const history = [user('before', { msgId: uuid(90), timestamp: at(-60) }), line, asst('answer', len + 5)]
            // Unlisted with the line's uuid not on the last member: the join can only
            // run up to its uuid, so the rest of the run has no evidence and stays
            // shown (the safe direction). The CLI never writes that shape.
            const kept = listed || anchor === len - 1 ? [] : run.filter((_, i) => i !== anchor)
            // A send typed after the run, not in history yet, and an identical
            // second batch whose line has not landed: both must stay.
            const later = bubble('later words', 50, len + 10)
            const twin = words.slice(0, len).map((w, i) => bubble(w, 60 + i, len + 20 + i))
            for (const watermark of [1, history.length]) {
              expect(dedupeOptimisticMessages([...run, later], history, watermark)).toEqual([...kept, later])
              expect(dedupeOptimisticMessages([...run, ...twin], history, watermark)).toEqual([...kept, ...twin])
            }
          })
        }
      }
    }
  }

  it('a uuid-proven single line never absorbs a neighbour whose words it does not hold', () => {
    const run = [bubble('first', 1, 0), bubble('second', 2, 1)]
    const history = [user('second', { msgId: uuid(2), timestamp: at(2) })]
    expect(dedupeOptimisticMessages(run, history, 0)).toEqual([run[0]])
  })

  // Review finding: the same words sent again right after a merged batch ("ok",
  // "ok", then "ok") reconstruct the line too; the third is live and must stay.
  for (const listed of [true, false]) {
    for (const third of ['pending', 'parked'] as const) {
      it(`a ${third} send with the batch's words, after the batch (mergedUuids ${listed}), stays on screen`, () => {
        const b1 = bubble('ok', 1, 0)
        const b2 = bubble('ok', 2, 1)
        const b3 = third === 'pending'
          ? bubble('ok', 3, 20, { status: 'pending' })
          : bubble('ok', 3, 20, { status: 'failed', parked: true, serverUndelivered: true, failedError: 'Not answered' })
        const history = [user('ok\nok', { msgId: uuid(2), timestamp: at(5), ...(listed ? { mergedUuids: [uuid(1)] } : {}) })]
        for (const watermark of [0, 1]) expect(dedupeOptimisticMessages([b1, b2, b3], history, watermark)).toEqual([b3])
      })
    }
  }

  it('a send enqueued after the line was written is never a member of it', () => {
    // An older parse (no mergedUuids) with the line under the uuid of a bubble that
    // sits after a later-enqueued open one: only bubbles enqueued before it count.
    const early = bubble('ok', 1, 0)
    const lateOpen = bubble('ok', 3, 40)
    const anchor = bubble('ok', 2, 41)
    const history = [user('ok\nok', { msgId: uuid(2), timestamp: at(5) })]
    expect(dedupeOptimisticMessages([early, lateOpen, anchor], history, 0)).toEqual([early, lateOpen])
  })
})

const WEB_SRC = path.resolve(import.meta.dirname, '../../web/src')
function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? files(p) : /\.tsx?$/.test(e.name) ? [p] : []
  })
}

describe('sendUuidsOfRow is the one reader of the uuids a user row stands for', () => {
  it('lists the line uuid, the uuid a mid-turn line was sent under, and the merged ones', () => {
    expect(sendUuidsOfRow({ role: 'user', msgId: 'm', sourceUuid: 's', mergedUuids: ['a', 'b'] })).toEqual(['m', 's', 'a', 'b'])
    expect(sendUuidsOfRow({ role: 'assistant', msgId: 'm' })).toEqual([])
  })

  it('no file in web/src collects or looks up a row sourceUuid in a set or map by hand', () => {
    // Collecting `sourceUuid` by hand is how a collector forgets `mergedUuids`: the
    // merged line then proves only one of its sends (inc-1794638780357).
    const helper = path.join(WEB_SRC, 'utils/send-uuids.ts')
    const offenders = files(WEB_SRC).filter((f) => f !== helper).flatMap((f) =>
      fs.readFileSync(f, 'utf8').split('\n').flatMap((l, i) =>
        /\.(?:add|set|has|get)\(\s*\w+\.sourceUuid\b/.test(l) ? [`${path.relative(WEB_SRC, f)}:${i + 1}: ${l.trim()}`] : []))
    expect(offenders).toEqual([])
  })
})
