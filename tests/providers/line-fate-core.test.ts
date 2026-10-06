/**
 * lineFate: what became of a user line, from the CLI's lifecycle frames, the
 * daemon's write records, and pid-stamped markers (send-dedupe-v1). Pure, so
 * every rule is pinned here; the twins run the same function text.
 */
import { describe, it, expect } from 'vitest'
import { lineFate, lineFateScan, lineFateVerdict } from '../../src/providers/line-fate-core.js'

const marker = (id: string, pid?: number) => JSON.stringify({
  type: 'user', subtype: 'walnut-injected', message: { role: 'user', content: 'x' },
  walnutMessageId: id, walnutDelivery: 'ordered', ...(pid ? { walnutPid: pid } : {}),
})
const lc = (uuid: string, state: string) => JSON.stringify({ type: 'command_lifecycle', command_uuid: uuid, state })
const rec = (pid: number, ids: string[]) => JSON.stringify({ pid, ids, at: 1 })
const q = { uuid: 'u-1', messageIds: ['qm-1'], pid: 41 }
const lines = (...l: string[]) => l.join('\n') + '\n'

describe('lineFate', () => {
  it('nothing known: null (the caller writes the line)', () => {
    expect(lineFate('', '', q)).toBeNull()
    expect(lineFate('', '', { uuid: '', messageIds: [], pid: 41 })).toBeNull()
  })

  it('a bare marker is no proof, even for this pid (the write may have been cut before the newline)', () => {
    expect(lineFate(lines(marker('qm-1', 41)), '', q)).toBeNull()
  })

  it('a marker from an older daemon (no pid) never counts, even with a queued frame after it', () => {
    expect(lineFate(lines(marker('qm-1'), lc('u-1', 'queued')), '', q)).toBeNull()
  })

  it('a marker for another process never counts', () => {
    expect(lineFate(lines(marker('qm-1', 40), lc('u-1', 'queued')), '', q)).toBeNull()
  })

  it('a marker for this pid plus a later queued frame: waiting', () => {
    expect(lineFate(lines(marker('qm-1', 41), lc('u-1', 'queued')), '', q)).toEqual({ fate: 'waiting', state: 'queued' })
    // A queued frame BEFORE the marker is about an earlier send.
    expect(lineFate(lines(lc('u-1', 'queued'), marker('qm-1', 41)), '', q)).toBeNull()
  })

  it('the write record for this pid and every id: waiting', () => {
    expect(lineFate('', lines(rec(41, ['qm-1', 'qm-2'])), q)).toEqual({ fate: 'waiting' })
    expect(lineFate('', lines(rec(40, ['qm-1'])), q)).toBeNull()
    expect(lineFate('', lines(rec(41, ['qm-2'])), q)).toBeNull()
    expect(lineFate('', lines(rec(41, ['qm-1'])), { ...q, messageIds: ['qm-1', 'qm-3'] })).toBeNull()
    // No live process: nothing is "waiting" in it.
    expect(lineFate('', lines(rec(41, ['qm-1'])), { ...q, pid: null })).toBeNull()
  })

  it('the CLI\'s own word wins in any process, strongest state first', () => {
    expect(lineFate(lines(lc('u-1', 'started')), '', { ...q, pid: 99 })).toEqual({ fate: 'ran', state: 'started' })
    expect(lineFate(lines(lc('u-1', 'completed')), '', q)).toEqual({ fate: 'ran', state: 'completed' })
    expect(lineFate(lines(lc('u-1', 'cancelled')), '', q)).toEqual({ fate: 'cancelled', state: 'cancelled' })
    expect(lineFate(lines(lc('u-1', 'discarded')), '', q)).toEqual({ fate: 'dropped', state: 'discarded' })
    expect(lineFate(lines(lc('u-1', 'refused')), '', q)).toEqual({ fate: 'dropped', state: 'refused' })
    // completed is the most final word; started outranks a later cancelled (it ran); cancelled outranks discarded.
    expect(lineFate(lines(lc('u-1', 'started'), lc('u-1', 'completed')), '', q)).toEqual({ fate: 'ran', state: 'completed' })
    expect(lineFate(lines(lc('u-1', 'started'), lc('u-1', 'cancelled')), '', q)?.fate).toBe('ran')
    expect(lineFate(lines(lc('u-1', 'discarded'), lc('u-1', 'cancelled')), '', q)?.fate).toBe('cancelled')
    // ...and outranks a record that says it is only waiting.
    expect(lineFate(lines(lc('u-1', 'started')), lines(rec(41, ['qm-1'])), q)?.fate).toBe('ran')
  })

  it('frames for another uuid, quoted text and torn lines are ignored', () => {
    expect(lineFate(lines(lc('u-2', 'started')), '', q)).toBeNull()
    const quoted = JSON.stringify({ type: 'assistant', text: '{"type":"command_lifecycle","command_uuid":"u-1","state":"started"}' })
    expect(lineFate(lines(quoted), '', q)).toBeNull()
    expect(lineFate(`le","command_uuid":"u-1","state":"started"}\n`, `{"pid":41,"ids":["qm-1"\n`, q)).toBeNull()
  })

  it('without a uuid only the record can answer', () => {
    expect(lineFate(lines(lc('', 'started')), lines(rec(41, ['qm-1'])), { ...q, uuid: '' })).toEqual({ fate: 'waiting' })
  })
})

// send-lost-line-v1. The write record says the whole line went into the stdin
// pipe of process `pid`. It cannot say the CLI read it: any other reader of the
// pipe (an agent's grep that named the FIFO) takes the bytes, and the record
// then answers "waiting" forever. When the server proves the CLI read past the
// line without a word on it, it asks again with `lostPid`.
describe('lineFate with lostPid: the server proved the process read past the line', () => {
  const lost = { ...q, lostPid: 41 }

  it('the record for that process no longer says the line waits in it, once its marker is in view', () => {
    // The marker that went with the write is in the scanned tail and no frame follows it.
    expect(lineFate(lines(marker('qm-1', 41)), lines(rec(41, ['qm-1'])), lost)).toBeNull()
  })

  it('a marker out of the scanned window leaves the record standing: no frame was looked for', () => {
    // The CLI printed more than the window since the line, so its `queued` may just be out of view.
    expect(lineFate('', lines(rec(41, ['qm-1'])), lost)).toEqual({ fate: 'waiting' })
    expect(lineFate(lines(lc('u-9', 'started')), lines(rec(41, ['qm-1'])), lost)).toEqual({ fate: 'waiting' })
    // A marker another process stamped is not this process's write.
    expect(lineFate(lines(marker('qm-1', 40)), lines(rec(41, ['qm-1'])), lost)).toEqual({ fate: 'waiting' })
  })

  it('the CLI\'s own word still wins: a queued frame means it has the line', () => {
    expect(lineFate(lines(marker('qm-1', 41), lc('u-1', 'queued')), lines(rec(41, ['qm-1'])), lost))
      .toEqual({ fate: 'waiting', state: 'queued' })
    expect(lineFate(lines(lc('u-1', 'started')), lines(rec(41, ['qm-1'])), lost)).toEqual({ fate: 'ran', state: 'started' })
    expect(lineFate(lines(lc('u-1', 'discarded')), '', lost)).toEqual({ fate: 'dropped', state: 'discarded' })
  })

  it('a lostPid for another process changes nothing for the one running now', () => {
    expect(lineFate('', lines(rec(41, ['qm-1'])), { ...q, lostPid: 40 })).toEqual({ fate: 'waiting' })
    expect(lineFate('', lines(rec(41, ['qm-1'])), { ...q, lostPid: null })).toEqual({ fate: 'waiting' })
  })
})

describe('lineFateScan / lineFateVerdict: the daemons scan a long tail piece by piece', () => {
  const stream = lines(
    marker('qm-1', 41), lc('u-2', 'started'), lc('u-1', 'queued'), lc('u-1', 'started'), lc('u-1', 'cancelled'), lc('u-1', 'completed'),
  )
  it('any split at line boundaries gives the whole-text answer', () => {
    const cuts = stream.split('\n').filter(Boolean)
    for (let at = 0; at <= cuts.length; at++) {
      const head = cuts.slice(0, at).map((l) => l + '\n').join('')
      const tail = cuts.slice(at).map((l) => l + '\n').join('')
      const scan = lineFateScan(tail, q, lineFateScan(head, q, null))
      expect(lineFateVerdict(scan, '', q)).toEqual(lineFate(stream, '', q))
    }
  })

  it('a marker in one piece and its queued frame in the next still prove the line is in', () => {
    const scan = lineFateScan(lines(lc('u-1', 'queued')), q, lineFateScan(lines(marker('qm-1', 41)), q, null))
    expect(lineFateVerdict(scan, '', q)).toEqual({ fate: 'waiting', state: 'queued' })
    // The other order is an earlier send's frame.
    const before = lineFateScan(lines(marker('qm-1', 41)), q, lineFateScan(lines(lc('u-1', 'queued')), q, null))
    expect(lineFateVerdict(before, '', q)).toBeNull()
  })

  it('no scan at all: only the record answers', () => {
    expect(lineFateVerdict(null, lines(rec(41, ['qm-1'])), q)).toEqual({ fate: 'waiting' })
    expect(lineFateVerdict(null, '', q)).toBeNull()
  })
})

describe('the inlined text survives a bundler that keeps names', () => {
  it('scan and verdict hold no named inner function, so no name helper lands inside them', async () => {
    // esbuild with keepNames (as tsx runs the server) wraps every NAMED function
    // in __name(); inside an inlined body that call would not exist in the daemon.
    const { transformSync } = await import('esbuild')
    const src = (await import('node:fs')).readFileSync(new URL('../../src/providers/line-fate-core.ts', import.meta.url), 'utf8')
    const out = transformSync(src, { loader: 'ts', keepNames: true, format: 'esm' }).code
    const wrapped = [...out.matchAll(/__name\(([^,]+),/g)].map((m) => m[1].trim())
    expect(wrapped.every((name) => ['lineFateScan', 'lineFateVerdict', 'lineFate'].includes(name))).toBe(true)
    for (const fn of [lineFateScan, lineFateVerdict]) expect(fn.toString()).not.toContain('__name(')
  })
})
