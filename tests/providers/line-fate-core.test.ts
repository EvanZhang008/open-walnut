/**
 * lineFate: what became of a user line, from the CLI's lifecycle frames, the
 * daemon's write records, and pid-stamped markers (send-dedupe-v1). Pure, so
 * every rule is pinned here; the twins run the same function text.
 */
import { describe, it, expect } from 'vitest'
import {
  lineAnswerFrame, lineFate, lineFateScan, lineFateVerdict, lineTornEnd, lineWriteBegun, lineWriteCut, lineWrittenPart,
  transcriptLineScan, transcriptLineVerdict,
} from '../../src/providers/line-fate-core.js'

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
    // started alone is taken, not answered (line-answer-v1, pinned below).
    expect(lineFate(lines(lc('u-1', 'started')), '', { ...q, pid: 99, answers: true })).toEqual({ fate: 'unanswered', state: 'started' })
    expect(lineFate(lines(lc('u-1', 'completed')), '', q)).toEqual({ fate: 'ran', state: 'completed' })
    expect(lineFate(lines(lc('u-1', 'cancelled')), '', q)).toEqual({ fate: 'cancelled', state: 'cancelled' })
    expect(lineFate(lines(lc('u-1', 'discarded')), '', q)).toEqual({ fate: 'dropped', state: 'discarded' })
    expect(lineFate(lines(lc('u-1', 'refused')), '', q)).toEqual({ fate: 'dropped', state: 'refused' })
    // completed is the most final word; started outranks a later cancelled (it ran); cancelled outranks discarded.
    expect(lineFate(lines(lc('u-1', 'started'), lc('u-1', 'completed')), '', q)).toEqual({ fate: 'ran', state: 'completed' })
    expect(lineFate(lines(lc('u-1', 'started'), lc('u-1', 'cancelled')), '', q)?.fate).toBe('ran')
    expect(lineFate(lines(lc('u-1', 'discarded'), lc('u-1', 'cancelled')), '', q)?.fate).toBe('cancelled')
    // ...and outranks a record that says it is only waiting (the process running now took it).
    expect(lineFate(lines(lc('u-1', 'started')), lines(rec(41, ['qm-1'])), q)).toEqual({ fate: 'ran', state: 'started', answer: 'pending' })
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
    expect(lineFate(lines(lc('u-1', 'started')), lines(rec(41, ['qm-1'])), lost)).toEqual({ fate: 'ran', state: 'started', answer: 'pending' })
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

// line-answer-v1: Claude Code says `started` when it takes a line for a turn,
// before its first word. A CLI killed in between leaves a message nobody answers,
// so `started` alone is no proof the line was answered.
describe('lineFate: taken is not answered (line-answer-v1)', () => {
  const text = (t: string) => ({ type: 'text', text: t })
  const assistant = (content: unknown[], extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content }, ...extra })
  const result = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' })
  const started = lc('u-1', 'started')
  // The server sending the line tells a taken line from an answered one.
  const qa = { ...q, answers: true }

  it('started by a process that is gone, with no answer after it: unanswered', () => {
    expect(lineFate(lines(marker('qm-1', 40), started), '', qa)).toEqual({ fate: 'unanswered', state: 'started' })
    // No process at all now.
    expect(lineFate(lines(marker('qm-1', 41), started), lines(rec(41, ['qm-1'])), { ...qa, pid: null })).toEqual({ fate: 'unanswered', state: 'started' })
  })

  it('the CLI printed its answer after started: ran, answered, in any process', () => {
    for (const answer of [assistant([text('hi')]), assistant([{ type: 'tool_use', id: 't', name: 'Bash', input: {} }]), result]) {
      expect(lineFate(lines(marker('qm-1', 40), started, answer), '', qa)).toEqual({ fate: 'ran', state: 'started', answer: 'yes' })
    }
    // completed is the end of the turn, answered or not.
    expect(lineFate(lines(started, lc('u-1', 'completed')), '', qa)).toEqual({ fate: 'ran', state: 'completed' })
  })

  it('what Claude Code does not count as an answer is none here either', () => {
    const none = [
      assistant([{ type: 'thinking', thinking: 'hm' }]),
      assistant([{ type: 'redacted_thinking', data: 'x' }]),
      assistant([text('  \n ')]),
      assistant([text('API Error: overloaded')], { error: 'server_error' }),
      // A subagent's message is not the main thread's answer.
      assistant([text('sub')], { parent_tool_use_id: 'toolu_1' }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } } }),
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'x' } }),
    ]
    for (const frame of none) {
      expect(lineFate(lines(marker('qm-1', 40), started, frame), '', qa)).toEqual({ fate: 'unanswered', state: 'started' })
      expect(lineAnswerFrame(JSON.parse(frame))).toBe(false)
    }
  })

  it('an answer before started is an earlier turn\'s, not this line\'s', () => {
    expect(lineFate(lines(assistant([text('old')]), result, started), '', qa)).toEqual({ fate: 'unanswered', state: 'started' })
  })

  it('started by the process running now, no answer yet: ran, answer pending (its answer may still come)', () => {
    expect(lineFate(lines(marker('qm-1', 41), started), '', qa)).toEqual({ fate: 'ran', state: 'started', answer: 'pending' })
    // The marker may be out of view: the whole-write record into this process says it too.
    expect(lineFate(lines(started), lines(rec(41, ['qm-1'])), qa)).toEqual({ fate: 'ran', state: 'started', answer: 'pending' })
    // A marker of this pid AFTER the start is a later write, not the one it took.
    expect(lineFate(lines(started, marker('qm-1', 41)), '', qa)).toEqual({ fate: 'unanswered', state: 'started' })
  })

  it('a line taken mid-turn is answered by the turn going on after it', () => {
    expect(lineFate(lines(assistant([text('turn A')]), marker('qm-1', 40), lc('u-1', 'queued'), started, assistant([text('turn A, seeing the line')])), '', qa))
      .toEqual({ fate: 'ran', state: 'started', answer: 'yes' })
  })

  it('a Stop that cancelled the started line\'s turn: ran, never sent again, nothing waits for more', () => {
    expect(lineFate(lines(marker('qm-1', 40), started, lc('u-1', 'cancelled')), '', qa)).toEqual({ fate: 'ran', state: 'started', answer: 'yes' })
  })

  it('an older server (no answers flag) hears ran, as before: it knows no unanswered fate', () => {
    expect(lineFate(lines(marker('qm-1', 40), started), '', q)).toEqual({ fate: 'ran', state: 'started' })
    expect(lineFate(lines(marker('qm-1', 40), started, assistant([text('hi')])), '', q)).toEqual({ fate: 'ran', state: 'started', answer: 'yes' })
  })

  it('output after the line went to another process is that process\'s, not this line\'s answer', () => {
    // Process 40 took it and died; process 42 (resumed) answered a line of its own first.
    const other = marker('qm-9', 42)
    expect(lineFate(lines(marker('qm-1', 40), started, other, assistant([text('another turn')]), result), '', { ...qa, pid: 42 }))
      .toEqual({ fate: 'unanswered', state: 'started' })
    // A later line into the same process: its turn's output still answers the one taken mid-turn.
    expect(lineFate(lines(marker('qm-1', 40), started, marker('qm-2', 40), assistant([text('both')])), '', qa))
      .toEqual({ fate: 'ran', state: 'started', answer: 'yes' })
    // A process that printed before any line of its own went to it (a cron turn, an
    // init-only restart): the daemon's spawn note marks where its output begins.
    const spawned = JSON.stringify({ type: 'system', subtype: 'walnut_process', walnutPid: 42 })
    expect(lineFate(lines(marker('qm-1', 40), started, spawned, assistant([text('a cron turn')]), result), '', { ...qa, pid: 42 }))
      .toEqual({ fate: 'unanswered', state: 'started' })
    // The note of the process that then took the line comes before its start: its answer counts.
    expect(lineFate(lines(spawned, marker('qm-1', 42), started, assistant([text('hi')])), '', { ...qa, pid: 42 }))
      .toEqual({ fate: 'ran', state: 'started', answer: 'yes' })
    // The marker that names another pid can fall on a piece boundary.
    const whole = lines(marker('qm-1', 40), started, other, assistant([text('x')]))
    const cut = whole.indexOf(other)
    const q42 = { ...qa, pid: 42 }
    expect(lineFateVerdict(lineFateScan(whole.slice(cut), q42, lineFateScan(whole.slice(0, cut), q42, null)), '', q42))
      .toEqual({ fate: 'unanswered', state: 'started' })
  })

  it('a second start counts from itself: the answer after the first does not answer the second', () => {
    expect(lineFate(lines(started, assistant([text('a')]), started), '', qa)).toEqual({ fate: 'unanswered', state: 'started' })
  })

  it('folds piece by piece like one scan', () => {
    const whole = lines(marker('qm-1', 40), started, assistant([text('hi')]))
    const cut = whole.indexOf(started) + started.length + 1
    const scan = lineFateScan(whole.slice(cut), q, lineFateScan(whole.slice(0, cut), qa, null))
    expect(lineFateVerdict(scan, '', qa)).toEqual({ fate: 'ran', state: 'started', answer: 'yes' })
  })

  it('lineAnswerFrame and the inlined rule in lineFateScan agree on every frame', () => {
    const frames = [
      assistant([text('hi')]), assistant([{ type: 'tool_use', id: 't', name: 'x', input: {} }]), assistant([{ type: 'thinking', thinking: 'a' }, text('b')]),
      assistant([{ type: 'thinking', thinking: 'a' }]), assistant([text(' ')]), assistant([text('e')], { error: 'rate_limit' }),
      assistant([text('s')], { parent_tool_use_id: 'p' }), assistant([{ type: 'image', source: {} }]), assistant([]),
      JSON.stringify({ type: 'assistant', message: { content: 'not an array' } }), result,
      JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true }),
      JSON.stringify({ type: 'user', message: { content: [text('u')] } }),
    ]
    for (const frame of frames) {
      const byScan = lineFateVerdict(lineFateScan(lines(started, frame), qa, null), '', qa)?.answer === 'yes'
      expect(byScan, frame).toBe(lineAnswerFrame(JSON.parse(frame)))
    }
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
    expect(wrapped.filter((name) => !['lineFateScan', 'lineFateVerdict', 'lineTornEnd', 'lineWriteBegun', 'lineWriteCut', 'lineWrittenPart', 'lineFate', 'lineAnswerFrame',
      'transcriptLineScan', 'transcriptLineVerdict'].includes(name))).toEqual([])
    for (const fn of [lineFateScan, lineFateVerdict, lineTornEnd, lineWriteBegun, lineWriteCut, lineWrittenPart, transcriptLineScan, transcriptLineVerdict]) {
      expect(fn.toString()).not.toContain('__name(')
    }
  })
})

// line-answer-v1 when the stream lost the line's frames (a rotated file, a window
// passed): Claude Code's transcript, read the harness's way (sessionStorage.ts,
// conversationRecovery.ts detectTurnInterruption).
describe('transcriptLineScan: the CLI\'s transcript says whether it took and answered a line', () => {
  const entry = (e: Record<string, unknown>) => JSON.stringify({ parentUuid: null, isSidechain: false, sessionId: 's', ...e })
  const prompt = (uuid: string, content: unknown = 'the question') => entry({ type: 'user', uuid, message: { role: 'user', content } })
  const reply = (content: unknown[], extra: Record<string, unknown> = {}) => entry({ type: 'assistant', uuid: `a-${Math.random()}`, message: { role: 'assistant', content }, ...extra })
  const text = (t: string) => ({ type: 'text', text: t })
  const verdict = (t: string) => transcriptLineVerdict(transcriptLineScan(t, 'u-1', null))

  it('not in the transcript: null (the CLI never took it; the line is written)', () => {
    expect(verdict(lines(prompt('u-0'), reply([text('hi')])))).toBeNull()
    expect(verdict('')).toBeNull()
  })

  it('its prompt with an answer after it: ran, answered', () => {
    expect(verdict(lines(prompt('u-1'), reply([text('hi')])))).toEqual({ fate: 'ran', state: 'started', answer: 'yes' })
    expect(verdict(lines(prompt('u-1'), reply([{ type: 'tool_use', id: 't', name: 'Bash', input: {} }])))).toEqual({ fate: 'ran', state: 'started', answer: 'yes' })
  })

  it('its prompt last, or only what is no answer after it: unanswered', () => {
    expect(verdict(lines(prompt('u-1')))).toEqual({ fate: 'unanswered', state: 'started' })
    for (const none of [
      reply([{ type: 'thinking', thinking: 'hm' }]), reply([text(' ')]),
      reply([text('API Error')], { isApiErrorMessage: true }),
      reply([text('sub')], { isSidechain: true }),
      entry({ type: 'system', subtype: 'informational', content: 'x' }),
      entry({ type: 'user', isMeta: true, message: { role: 'user', content: 'caveat' } }),
    ]) expect(verdict(lines(prompt('u-1'), none)), none).toEqual({ fate: 'unanswered', state: 'started' })
  })

  it('the next prompt before any answer: its turn ended unanswered, a later answer is that prompt\'s', () => {
    expect(verdict(lines(prompt('u-1'), prompt('u-2'), reply([text('to u-2')])))).toEqual({ fate: 'unanswered', state: 'started' })
    // A tool result is the same turn going on, not a new prompt.
    const result = entry({ type: 'user', uuid: 'r', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } })
    expect(verdict(lines(prompt('u-1'), result, reply([text('done')])))).toEqual({ fate: 'ran', state: 'started', answer: 'yes' })
  })

  it('a line taken mid-turn is its queued_command attachment (source_uuid), answered by the turn after it', () => {
    const attached = entry({ type: 'attachment', uuid: 'att', attachment: { type: 'queued_command', prompt: 'later', source_uuid: 'u-1' } })
    expect(verdict(lines(reply([text('before')]), attached))).toEqual({ fate: 'unanswered', state: 'started' })
    expect(verdict(lines(reply([text('before')]), attached, reply([text('after')])))).toEqual({ fate: 'ran', state: 'started', answer: 'yes' })
  })

  it('text that quotes the uuid is not the line; pieces fold like one scan', () => {
    expect(verdict(lines(reply([text('see u-1')])))).toBeNull()
    const whole = lines(prompt('u-1'), reply([text('hi')]))
    const cut = whole.indexOf('\n') + 1
    expect(transcriptLineVerdict(transcriptLineScan(whole.slice(cut), 'u-1', transcriptLineScan(whole.slice(0, cut), 'u-1', null))))
      .toEqual({ fate: 'ran', state: 'started', answer: 'yes' })
  })
})
