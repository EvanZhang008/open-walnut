/**
 * lineFate: what became of a user line, from the CLI's lifecycle frames, the
 * daemon's write records, and pid-stamped markers (send-dedupe-v1). Pure, so
 * every rule is pinned here; the twins run the same function text.
 */
import { describe, it, expect } from 'vitest'
import { lineFate, lineFateScan, lineFateVerdict, lineTornEnd, lineWriteBegun, lineWriteCut, lineWrittenPart } from '../../src/providers/line-fate-core.js'

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
    expect(lineFate('', lines(rec(41, ['qm-1', 'qm-2'])), q)).toEqual({ fate: 'waiting', writtenAt: 1 })
    expect(lineFate('', lines(rec(40, ['qm-1'])), q)).toBeNull()
    expect(lineFate('', lines(rec(41, ['qm-2'])), q)).toBeNull()
    expect(lineFate('', lines(rec(41, ['qm-1'])), { ...q, messageIds: ['qm-1', 'qm-3'] })).toBeNull()
    // No live process: nothing is "waiting" in it.
    expect(lineFate('', lines(rec(41, ['qm-1'])), { ...q, pid: null })).toBeNull()
  })

  it('a new UUID never inherits an old write or partial begin for the same row id', () => {
    const old = JSON.stringify({ pid: 41, uuid: 'old', ids: ['qm-1'], at: 1 });
    expect(lineFate('', lines(old), q)).toBeNull();
    expect(lineFate('', lines(JSON.stringify({ pid: 41, uuid: 'u-1', ids: ['qm-1'], at: 2 })), q)).toEqual({ fate: 'waiting', writtenAt: 2 });
    const begin = JSON.stringify({ pid: 41, uuid: 'old', begin: ['qm-1'], at: 1 });
    expect(lineWriteBegun(lines(begin), q)).toBeNull();
    expect(lineWriteBegun(lines(JSON.stringify({ pid: 41, uuid: 'u-1', begin: ['qm-1'], at: 2 })), q)).toBe(2);
  });

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
    expect(lineFate(lines(lc('', 'started')), lines(rec(41, ['qm-1'])), { ...q, uuid: '' })).toEqual({ fate: 'waiting', writtenAt: 1 })
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
    expect(lineFate('', lines(rec(41, ['qm-1'])), lost)).toEqual({ fate: 'waiting', writtenAt: 1 })
    expect(lineFate(lines(lc('u-9', 'started')), lines(rec(41, ['qm-1'])), lost)).toEqual({ fate: 'waiting', writtenAt: 1 })
    // A marker another process stamped is not this process's write.
    expect(lineFate(lines(marker('qm-1', 40)), lines(rec(41, ['qm-1'])), lost)).toEqual({ fate: 'waiting', writtenAt: 1 })
  })

  it('the CLI\'s own word still wins: a queued frame means it has the line', () => {
    expect(lineFate(lines(marker('qm-1', 41), lc('u-1', 'queued')), lines(rec(41, ['qm-1'])), lost))
      .toEqual({ fate: 'waiting', state: 'queued' })
    expect(lineFate(lines(lc('u-1', 'started')), lines(rec(41, ['qm-1'])), lost)).toEqual({ fate: 'ran', state: 'started' })
    expect(lineFate(lines(lc('u-1', 'discarded')), '', lost)).toEqual({ fate: 'dropped', state: 'discarded' })
  })

  it('a lostPid for another process changes nothing for the one running now', () => {
    expect(lineFate('', lines(rec(41, ['qm-1'])), { ...q, lostPid: 40 })).toEqual({ fate: 'waiting', writtenAt: 1 })
    expect(lineFate('', lines(rec(41, ['qm-1'])), { ...q, lostPid: null })).toEqual({ fate: 'waiting', writtenAt: 1 })
  })
})

// A line that waits in a process which never reads it (2026-10-06: a trigger line
// waited four days in a CLI that read nothing, then reached the next process). The
// record alone cannot tell "behind a running turn" from "nobody reads": the answer
// says when the write went in and whether the CLI printed anything after the line's
// marker, so the server can bound how long it trusts "waiting" (LINE_UNREAD_PARK_MS).
describe('a waiting answer says how long the process has been still', () => {
  const recAt = (at: number) => JSON.stringify({ pid: 41, uuid: 'u-1', ids: ['qm-1'], at })
  const progress = JSON.stringify({ type: 'tool_progress', tool_use_id: 't-1', elapsed_time_seconds: 30 })
  const retryNote = JSON.stringify({ type: 'system', subtype: 'turn_retry', content: 'retrying', uuid: 'x', session_id: 's', timestamp: 't' })
  const cronNote = JSON.stringify({ type: 'system', subtype: 'scheduled_task_fire', content: 'fired', uuid: 'y', session_id: 's', timestamp: 't' })

  it('nothing printed after the line\'s marker: quiet, with the time the write went in', () => {
    expect(lineFate(lines(marker('qm-1', 41)), lines(recAt(5000)), q)).toEqual({ fate: 'waiting', writtenAt: 5000, quiet: true })
  })

  it('a running turn prints after the marker (text, a tool_progress beat): not quiet', () => {
    expect(lineFate(lines(marker('qm-1', 41), progress), lines(recAt(5000)), q)).toEqual({ fate: 'waiting', writtenAt: 5000 })
    const text = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } })
    expect(lineFate(lines(marker('qm-1', 41), text), lines(recAt(5000)), q)).toEqual({ fate: 'waiting', writtenAt: 5000 })
    // Another line's lifecycle frame is the CLI's own output too.
    expect(lineFate(lines(marker('qm-1', 41), lc('u-2', 'completed')), lines(recAt(5000)), q)).toEqual({ fate: 'waiting', writtenAt: 5000 })
  })

  it('Walnut\'s own lines after the marker are not the CLI\'s output', () => {
    expect(lineFate(lines(marker('qm-1', 41), marker('qm-2', 41), retryNote, cronNote, marker('qm-3')), lines(recAt(5000)), q))
      .toEqual({ fate: 'waiting', writtenAt: 5000, quiet: true })
  })

  it('only output after the newest marker of the line counts', () => {
    // An earlier copy of the line, then output, then this copy: still since this copy.
    expect(lineFate(lines(marker('qm-1', 41), progress, marker('qm-1', 41)), lines(recAt(5000)), q))
      .toEqual({ fate: 'waiting', writtenAt: 5000, quiet: true })
  })

  it('a marker out of view says nothing about stillness (megabytes printed since): not quiet', () => {
    expect(lineFate(lines(progress), lines(recAt(5000)), q)).toEqual({ fate: 'waiting', writtenAt: 5000 })
    expect(lineFateVerdict(null, lines(recAt(5000)), q)).toEqual({ fate: 'waiting', writtenAt: 5000 })
    // Another process's marker is not this write.
    expect(lineFate(lines(marker('qm-1', 40)), lines(recAt(5000)), q)).toEqual({ fate: 'waiting', writtenAt: 5000 })
  })

  it('the CLI\'s own word still wins, and a record with no time gives none', () => {
    // The CLI named the line queued: it reads its input, so it is not still.
    expect(lineFate(lines(marker('qm-1', 41), lc('u-1', 'queued')), lines(recAt(5000)), q)).toEqual({ fate: 'waiting', writtenAt: 5000 })
    expect(lineFate(lines(marker('qm-1', 41), lc('u-1', 'queued')), '', q)).toEqual({ fate: 'waiting', state: 'queued' })
    expect(lineFate(lines(marker('qm-1', 41)), lines(JSON.stringify({ pid: 41, uuid: 'u-1', ids: ['qm-1'] })), q))
      .toEqual({ fate: 'waiting', quiet: true })
  })

  it('pieces fold to the whole-text answer', () => {
    const stream = lines(marker('qm-1', 41), retryNote, progress)
    const cuts = stream.split('\n').filter(Boolean)
    for (let at = 0; at <= cuts.length; at++) {
      const head = cuts.slice(0, at).map((l) => l + '\n').join('')
      const tail = cuts.slice(at).map((l) => l + '\n').join('')
      const scan = lineFateScan(tail, q, lineFateScan(head, q, null))
      expect(lineFateVerdict(scan, lines(recAt(5000)), q)).toEqual(lineFate(stream, lines(recAt(5000)), q))
    }
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
    expect(lineFateVerdict(null, lines(rec(41, ['qm-1'])), q)).toEqual({ fate: 'waiting', writtenAt: 1 })
    expect(lineFateVerdict(null, '', q)).toBeNull()
  })
})

describe('lineTornEnd: a resend ends what a dead write may have left (runner gate r3, r3-torn)', () => {
  const q = { uuid: 'u-1', messageIds: ['qm-1'], pid: 7 }
  const seen = lineFateScan(marker('qm-1', 7), q, null)
  it('a uuid line nothing proves in, with this process\'s marker in, gets a newline ahead of it', () => {
    expect(lineTornEnd(null, q, seen)).toBe(true)
  })
  it('no marker of this process (none, an older daemon\'s, another pid\'s): nothing ahead of it', () => {
    expect(lineTornEnd(null, q, null)).toBe(false)
    expect(lineTornEnd(null, q, lineFateScan('', q, null))).toBe(false)
    expect(lineTornEnd(null, q, lineFateScan(marker('qm-1'), q, null))).toBe(false)
    expect(lineTornEnd(null, q, lineFateScan(marker('qm-1', 8), q, null))).toBe(false)
  })
  it('a line proven in is not written at all, so it gets nothing', () => {
    for (const fate of ['ran', 'cancelled', 'dropped', 'waiting'] as const) expect(lineTornEnd({ fate }, q, seen)).toBe(false)
  })
  it('a line without a uuid is written as before: the CLI could not drop a copy of it', () => {
    expect(lineTornEnd(null, { ...q, uuid: '' }, seen)).toBe(false)
  })
})

// A FIFO write that failed after bytes went in must not read as "nothing sent"
// (2026-10-24: EPIPE at any offset answered like a 0-byte failure).
describe('lineWrittenPart: how much of a failed write went into the pipe', () => {
  // '{"a":1}\n' is 8 bytes; with a torn-end newline ahead it is 9, lead 1.
  it('nothing, or only the newlines put ahead of the line: none', () => {
    expect(lineWrittenPart(0, 8, 0)).toBe('none')
    expect(lineWrittenPart(1, 9, 1)).toBe('none')
    expect(lineWrittenPart(2, 10, 2)).toBe('none')
  })
  it('part of the body: prefix; all but the final newline: body; all of it: line', () => {
    expect(lineWrittenPart(1, 8, 0)).toBe('prefix')
    expect(lineWrittenPart(2, 9, 1)).toBe('prefix')
    expect(lineWrittenPart(6, 8, 0)).toBe('prefix')
    expect(lineWrittenPart(7, 8, 0)).toBe('body')
    expect(lineWrittenPart(8, 9, 1)).toBe('body')
    expect(lineWrittenPart(8, 8, 0)).toBe('line')
  })
  it('a write that never started (no buffer yet): none', () => {
    expect(lineWrittenPart(0, 0, 0)).toBe('none')
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
    expect(wrapped.every((name) => ['lineFateScan', 'lineFateVerdict', 'lineTornEnd', 'lineWriteBegun', 'lineWriteCut', 'lineWrittenPart', 'lineFate'].includes(name))).toBe(true)
    for (const fn of [lineFateScan, lineFateVerdict, lineTornEnd, lineWriteBegun, lineWriteCut, lineWrittenPart]) expect(fn.toString()).not.toContain('__name(')
  })
})
