/**
 * Stream compaction (src/providers/stream-compact-core.ts): a stopped session's
 * stream file without the token deltas of its finished turns. Pins that every
 * other byte survives in order, that a turn without a result keeps everything,
 * that the kept-line offsets are the new file's, and that the swap only happens
 * over the exact file that was read.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStreamCompact, type StreamCompactPrepared } from '../../src/providers/stream-compact-core.js'
import { foldLine, initialFoldState } from '../../src/providers/daemon-fold.js'

const L = (o: unknown) => JSON.stringify(o) + '\n'
const delta = (t: string) => L({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } })
const thinking = (n: number) => L({ type: 'system', subtype: 'thinking_tokens', tokens: n })
const user = (t: string) => L({ type: 'user', message: { role: 'user', content: t } })
const assistant = (t: string) => L({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } })
// Key order as the CLI writes it: `type` is not the first key of a result line.
const result = (n: number) => L({ duration_api_ms: 10, stop_reason: 'end_turn', session_id: 's', type: 'result', subtype: 'success', is_error: false, num_turns: n })
const cron = [
  L({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-cron', name: 'CronCreate', input: { cron: '7 9 * * *' } }] } }),
  L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-cron', content: 'ok' }] }, tool_use_result: { id: 'job-1' } }),
]

let dir = ''
beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stream-compact-'))) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

function make(opts: { fs?: typeof fs; log?: Parameters<typeof createStreamCompact>[0]['log']; chunkBytes?: number; maxLineBytes?: number; minBytes?: number; reserveBytes?: number } = {}) {
  return createStreamCompact({
    fs: opts.fs ?? fs, log: opts.log, now: () => 1000, pid: process.pid, minBytes: opts.minBytes ?? 0, reserveBytes: opts.reserveBytes ?? 0,
    maxLineBytes: opts.maxLineBytes ?? 1024 * 1024, chunkBytes: opts.chunkBytes,
  })
}

/** Real file operations; only the unavailable statx birth time falls back to a controlled ctime. */
function ctimeFallbackFs(file: string, failPostRenameStat = false) {
  let ctimeMs = 1000.25
  let renamed = false
  let failStat = failPostRenameStat
  let markAtRename: Record<string, unknown> | null = null
  const fallback = (st: fs.Stats) => Object.assign(st, { ctimeMs, birthtimeMs: ctimeMs })
  const injectedFs = {
    ...fs,
    promises: {
      ...fs.promises,
      open: (async (...args: Parameters<typeof fs.promises.open>) => {
        const handle = await fs.promises.open(...args)
        const stat = handle.stat.bind(handle)
        handle.stat = (async () => fallback(await stat())) as typeof handle.stat
        return handle
      }) as typeof fs.promises.open,
    },
    statSync: ((p: fs.PathLike) => {
      const st = fs.statSync(p)
      if (p === file && renamed && failStat) {
        failStat = false
        throw new Error('post-rename stat unavailable')
      }
      return fallback(st)
    }) as typeof fs.statSync,
    renameSync: ((from: fs.PathLike, to: fs.PathLike) => {
      markAtRename = JSON.parse(fs.readFileSync(file + '.compact', 'utf-8'))
      fs.renameSync(from, to)
      renamed = true
      ctimeMs = 1000.75 // Same floored epoch, different full identity after rename.
    }) as typeof fs.renameSync,
    appendFileSync: ((...args: Parameters<typeof fs.appendFileSync>) => {
      fs.appendFileSync(...args)
      ctimeMs = 1001.25
    }) as typeof fs.appendFileSync,
  }
  return { fs: injectedFs, markAtRename: () => markAtRename }
}

/** Two finished turns (with a cron), then an unfinished third with its deltas. */
function sample(): { text: string; expected: string } {
  const turn1 = [L({ type: 'system', subtype: 'init', session_id: 's' }), user('one'), delta('a'), thinking(3), delta('b'), assistant('ab'), ...cron, result(1)]
  const turn2 = [user('two'), thinking(5), delta('é中'), assistant('é中'), result(2)]
  const turn3 = [user('three'), delta('c'), thinking(7)]
  const fragment = '{"type":"stream_event","event":{"ty'
  const keep = (lines: string[]) => lines.filter((l) => !l.startsWith('{"type":"stream_event",') && !l.startsWith('{"type":"system","subtype":"thinking_tokens",'))
  return {
    text: [...turn1, ...turn2, ...turn3].join('') + fragment,
    expected: [...keep(turn1), ...keep(turn2), ...turn3].join('') + fragment,
  }
}

function fold(text: string) {
  let state = initialFoldState(0)
  let v = 0
  for (const line of text.split('\n').slice(0, -1)) {
    v += Buffer.byteLength(line) + 1
    if (line.trim()) state = foldLine(state, line, v)
  }
  return state
}

describe('stream compaction', () => {
  it.each([undefined, 7, 64])('drops deltas and thinking counters of finished turns only, every other byte kept in order (chunk %s)', async (chunkBytes) => {
    const file = path.join(dir, 's.jsonl')
    const { text, expected } = sample()
    fs.writeFileSync(file, text)
    const kept: Array<{ line: string; v: number }> = []
    const sc = make({ chunkBytes })
    const prepared = await sc.compact(file, { onKeptLine: (buf, v) => kept.push({ line: buf.toString('utf-8'), v }) }) as StreamCompactPrepared
    expect('skipped' in prepared).toBe(false)
    expect(fs.readFileSync(prepared.tmpPath, 'utf-8')).toBe(expected)
    expect(prepared.after).toBe(Buffer.byteLength(expected))
    expect(prepared.droppedBytes).toBe(Buffer.byteLength(text) - Buffer.byteLength(expected))
    expect(prepared.droppedLines).toBe(5)
    // Each kept line's v is its end offset in the NEW file (the fragment is not a line).
    const lines = expected.split('\n').slice(0, -1)
    let v = 0
    expect(kept.map((k) => k.line)).toEqual(lines)
    expect(kept.map((k) => k.v)).toEqual(lines.map((l) => (v += Buffer.byteLength(l) + 1)))
    // The original is untouched until commit; the copy keeps its mtime (retention reads it).
    expect(fs.readFileSync(file, 'utf-8')).toBe(text)
    expect((fs.statSync(prepared.tmpPath).mode & 0o777).toString(8)).toBe('600')
    expect(prepared.tmpPath).toBe(`${file}.compact-tmp-${process.pid}`)
    expect(Math.floor(fs.statSync(prepared.tmpPath).mtimeMs / 1000)).toBe(Math.floor(fs.statSync(file).mtimeMs / 1000))
  })

  it('folding the kept lines is the fold of the compacted file, with the same turn and cron facts as the original', async () => {
    const file = path.join(dir, 's.jsonl')
    const { text } = sample()
    fs.writeFileSync(file, text)
    let state = initialFoldState(0)
    const sc = make()
    const prepared = await sc.compact(file, { onKeptLine: (buf, v) => { const l = buf.toString('utf-8'); if (l.trim()) state = foldLine(state, l, v) } }) as StreamCompactPrepared
    const compacted = fs.readFileSync(prepared.tmpPath, 'utf-8')
    expect(state).toEqual(fold(compacted))
    const original = fold(text)
    expect(state.cronIds).toEqual({ 'job-1': 1 })
    // Every fact but the offsets is the original's.
    const facts = (f: typeof state) => ({ ...f, v: 0, lastResult: f.lastResult && { ...f.lastResult, endOffset: 0 } })
    expect(facts(state)).toEqual(facts(original))
    expect(state.v).toBe(Buffer.byteLength(compacted.slice(0, compacted.lastIndexOf('\n') + 1)))
  })

  it('a file whose turn never finished, or with little to drop, is left alone, never copied, and not looked at again until it grows', async () => {
    const sc = make({ minBytes: 16 })
    const open = path.join(dir, 'open.jsonl')
    fs.writeFileSync(open, user('x') + delta('a') + delta('b'))
    expect(await sc.compact(open)).toEqual({ skipped: 'no-finished-turn' })
    const openStat = fs.statSync(open)
    expect(JSON.parse(fs.readFileSync(sc.markPathFor(open), 'utf-8'))).toMatchObject({
      dev: openStat.dev, ino: openStat.ino, birthtimeMs: openStat.birthtimeMs, size: openStat.size,
    })
    expect(sc.due(open, openStat)).toBe(false)
    expect(sc.due(open, { ...openStat, birthtimeMs: openStat.birthtimeMs + 0.25 })).toBe(true)
    const lean = path.join(dir, 'lean.jsonl')
    fs.writeFileSync(lean, user('x') + delta('a') + result(1))
    const writes: string[] = []
    const realOpen = fs.promises.open
    fs.promises.open = (async (p: fs.PathLike, flags?: string | number, mode?: fs.Mode) => {
      if (flags !== 'r') writes.push(String(p))
      return realOpen(p, flags, mode)
    }) as typeof fs.promises.open
    try {
      expect(await sc.compact(lean, { minDropBytes: 1000 })).toEqual({ skipped: 'little-to-drop' })
    } finally { fs.promises.open = realOpen }
    expect(writes).toEqual([]) // counted read-only, nothing written
    expect(fs.existsSync(sc.tmpPathFor(lean))).toBe(false)
    expect(sc.due(lean, fs.statSync(lean))).toBe(false)
    expect(sc.rewrittenFrom(lean, fs.statSync(lean))).toBe(null)
    fs.appendFileSync(lean, delta('y'.repeat(200)) + result(2))
    expect(sc.due(lean, fs.statSync(lean))).toBe(true)
    const none = path.join(dir, 'none.jsonl')
    fs.writeFileSync(none, user('x') + assistant('y') + result(1))
    expect(await sc.compact(none)).toEqual({ skipped: 'little-to-drop' })
  })

  it('only a line whose own type is result ends a turn (not one that merely contains the key)', async () => {
    const file = path.join(dir, 's.jsonl')
    const lookalike = L({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'X', input: { type: 'result' } }] } })
    fs.writeFileSync(file, user('one') + delta('a') + result(1) + user('two') + delta('b') + lookalike + delta('c'))
    const prepared = await make().compact(file) as StreamCompactPrepared
    expect(fs.readFileSync(prepared.tmpPath, 'utf-8')).toBe(user('one') + result(1) + user('two') + delta('b') + lookalike + delta('c'))
    expect(prepared.droppedLines).toBe(1)
  })

  it('a delta fragment a killed CLI left, glued to the next spawn\'s first line, is kept whole', async () => {
    const file = path.join(dir, 's.jsonl')
    const glued = '{"type":"stream_event","event":{"ty' + user('resumed')
    fs.writeFileSync(file, user('one') + delta('a') + glued + delta('b') + result(1))
    const prepared = await make().compact(file) as StreamCompactPrepared
    expect(fs.readFileSync(prepared.tmpPath, 'utf-8')).toBe(user('one') + glued + result(1))
    expect(prepared.droppedLines).toBe(2)
    expect(prepared.droppedBytes).toBe(Buffer.byteLength(delta('a') + delta('b')))
  })

  it('a last result still being written does not hide an earlier finished one', async () => {
    const file = path.join(dir, 's.jsonl')
    const head = user('one') + delta('a') + result(1)
    fs.writeFileSync(file, head + user('two') + delta('b') + '{"duration_api_ms":3,"type":"result","subtype":"succ')
    const prepared = await make({ chunkBytes: 8 }).compact(file) as StreamCompactPrepared
    expect(fs.readFileSync(prepared.tmpPath, 'utf-8')).toBe(user('one') + result(1) + user('two') + delta('b') + '{"duration_api_ms":3,"type":"result","subtype":"succ')
  })

  it('refuses to copy when the disk could not hold it', async () => {
    const file = path.join(dir, 's.jsonl')
    fs.writeFileSync(file, sample().text)
    const sc = make({ reserveBytes: Number.MAX_SAFE_INTEGER })
    expect(await sc.compact(file)).toEqual({ skipped: 'low-disk' })
    expect(fs.existsSync(sc.tmpPathFor(file))).toBe(false)
    expect(sc.due(file, fs.statSync(file))).toBe(true) // tried again later
  })

  it('names only session stream files, and sweeps what a dead daemon left', () => {
    const sc = make()
    expect(sc.isStreamFile('s.jsonl')).toBe(true)
    expect(sc.isStreamFile('s.acp.jsonl')).toBe(false)
    expect(sc.isStreamFile('s.jsonl.fold')).toBe(false)
    fs.writeFileSync(path.join(dir, 'a.jsonl'), 'x')
    fs.writeFileSync(path.join(dir, 'a.jsonl.compact-tmp-999999'), 'dead daemon')
    fs.writeFileSync(path.join(dir, 'a.jsonl.compact-tmp-424242'), 'live daemon')
    fs.writeFileSync(path.join(dir, 'a.jsonl.compact'), '{}')
    fs.writeFileSync(path.join(dir, 'gone.jsonl.compact'), '{}')
    sc.sweepStale(dir, (pid) => pid === 424242)
    expect(fs.readdirSync(dir).sort()).toEqual(['a.jsonl', 'a.jsonl.compact', 'a.jsonl.compact-tmp-424242'])
  })

  it('an abort, a line too long to hold, or a missing file leaves the original and no copy', async () => {
    const file = path.join(dir, 's.jsonl')
    const { text } = sample()
    fs.writeFileSync(file, text)
    let reads = 0
    const small = make({ chunkBytes: 16 })
    expect(await small.compact(file, { aborted: () => ++reads > 3 })).toEqual({ skipped: 'aborted' })
    expect(fs.readFileSync(file, 'utf-8')).toBe(text)
    expect(fs.existsSync(small.tmpPathFor(file))).toBe(false)

    const long = path.join(dir, 'long.jsonl')
    fs.writeFileSync(long, assistant('z'.repeat(5000)) + delta('a') + result(1))
    const tight = make({ chunkBytes: 256, maxLineBytes: 1024 })
    expect(await tight.compact(long)).toEqual({ skipped: 'line-too-long' })
    expect(fs.existsSync(tight.tmpPathFor(long))).toBe(false)

    expect(await make().compact(path.join(dir, 'gone.jsonl'))).toEqual({ skipped: 'error' })
  })

  it.each(['due', 'rewrittenFrom'] as const)('%s does not reuse a mark for another file identity, even at the same size', async (method) => {
    const sc = make({ minBytes: 64 })
    const file = path.join(dir, 's.jsonl')
    fs.writeFileSync(file, sample().text)
    const prepared = await sc.compact(file) as StreamCompactPrepared
    expect(sc.commit(file, prepared)).toBe(true)
    const st = fs.statSync(file)
    const same = { dev: st.dev, ino: st.ino, size: st.size, birthtimeMs: 1000.25 }
    const mark = JSON.parse(fs.readFileSync(sc.markPathFor(file), 'utf-8'))
    fs.writeFileSync(sc.markPathFor(file), JSON.stringify({ ...mark, ...same }))
    expect(sc[method](file, same)).toBe(method === 'due' ? false : mark.from)
    for (const changed of [
      { ...same, birthtimeMs: 1000.75 }, // Same official epoch, different precise identity.
      { ...same, dev: same.dev + 1 },
      { ...same, ino: same.ino + 1 },
    ]) {
      expect(sc[method](file, changed)).toBe(method === 'due' ? true : null)
    }
  })

  it.each([
    { skipped: 'little-to-drop' },
    { from: '1:2:1000' },
  ])('a legacy mark without identity is rechecked and never names an old epoch (%j)', (extra) => {
    const sc = make({ minBytes: 64 })
    const file = path.join(dir, 's.jsonl')
    fs.writeFileSync(file, sample().text)
    const st = fs.statSync(file)
    fs.writeFileSync(sc.markPathFor(file), JSON.stringify({ v: 1, ino: st.ino, size: st.size, ...extra }))
    expect(sc.rewrittenFrom(file, st)).toBe(null)
    expect(sc.due(file, st)).toBe(true)
  })

  it.each(['dev', 'birthtimeMs'] as const)('commit rejects a replaced %s at the same inode, size and mtime', async (field) => {
    const file = path.join(dir, 's.jsonl')
    const { text } = sample()
    fs.writeFileSync(file, text)
    let replacement: fs.Stats | null = null
    const injectedFs = {
      ...fs,
      statSync: ((p: fs.PathLike) => p === file && replacement ? replacement : fs.statSync(p)) as typeof fs.statSync,
    }
    const sc = make({ fs: injectedFs })
    const prepared = await sc.compact(file) as StreamCompactPrepared
    const st = fs.statSync(file)
    replacement = { ...st, [field]: st[field] + (field === 'birthtimeMs' ? 0.25 : 1) } as fs.Stats
    expect(sc.commit(file, prepared)).toBe(false)
    expect(fs.readFileSync(file, 'utf-8')).toBe(text)
    expect(fs.existsSync(prepared.tmpPath)).toBe(false)
    expect(fs.existsSync(sc.markPathFor(file))).toBe(false)
  })

  it.each([false, true])('commit records the actual renamed identity with a ctime birth fallback (post-rename stat failure: %s)', async (failPostRenameStat) => {
    const file = path.join(dir, 's.jsonl')
    const { text, expected } = sample()
    fs.writeFileSync(file, text)
    const injected = ctimeFallbackFs(file, failPostRenameStat)
    const logs: Array<{ level: string; msg: string; meta: Record<string, unknown> }> = []
    const sc = make({ fs: injected.fs, log: (level, msg, meta) => logs.push({ level, msg, meta }) })
    const original = injected.fs.statSync(file)
    expect(original.birthtimeMs).toBe(original.ctimeMs)
    const from = `${original.dev}:${original.ino}:${Math.floor(original.birthtimeMs)}`
    const prepared = await sc.compact(file) as StreamCompactPrepared
    const tmp = injected.fs.statSync(prepared.tmpPath)
    expect(fs.readFileSync(file, 'utf-8')).toBe(text)
    expect(fs.readFileSync(prepared.tmpPath, 'utf-8')).toBe(expected)

    // The actual rename has committed, even when reading its metadata then fails.
    expect(sc.commit(file, prepared)).toBe(true)
    const after = injected.fs.statSync(file)
    expect(fs.readFileSync(file, 'utf-8')).toBe(expected)
    expect(fs.existsSync(prepared.tmpPath)).toBe(false)
    expect(after.ino).not.toBe(original.ino)
    expect(after.ino).toBe(tmp.ino)
    expect(after.dev).toBe(tmp.dev)
    expect(after.size).toBe(tmp.size)
    expect(after.birthtimeMs).toBe(after.ctimeMs)
    expect(after.birthtimeMs).not.toBe(tmp.birthtimeMs)
    expect(Math.floor(after.birthtimeMs)).toBe(Math.floor(tmp.birthtimeMs))
    // The pre-rename mark remains crash evidence on platforms with a stable birth time.
    expect(injected.markAtRename()).toMatchObject({
      dev: tmp.dev, ino: tmp.ino, birthtimeMs: tmp.birthtimeMs, size: tmp.size, from,
    })
    const mark = JSON.parse(fs.readFileSync(sc.markPathFor(file), 'utf-8'))
    if (failPostRenameStat) {
      expect(logs).toEqual([{
        level: 'warn', msg: 'stream compaction committed; output metadata could not be read',
        meta: { jsonlPath: file, error: 'post-rename stat unavailable' },
      }])
      expect(mark.birthtimeMs).toBe(tmp.birthtimeMs)
      // A later successful stat must not inherit identity from the pre-rename mark.
      expect(sc.rewrittenFrom(file, after)).toBe(null)
    } else {
      expect(logs).toEqual([])
      expect(mark).toMatchObject({ dev: after.dev, ino: after.ino, birthtimeMs: after.birthtimeMs, size: after.size, from })
      expect(sc.rewrittenFrom(file, after)).toBe(from)
    }
    injected.fs.appendFileSync(file, '\n' + user('next') + delta('new'))
    const appended = injected.fs.statSync(file)
    expect(appended.ino).toBe(after.ino)
    expect(appended.birthtimeMs).not.toBe(after.birthtimeMs)
    expect(sc.rewrittenFrom(file, appended)).toBe(null)
    expect(fs.readFileSync(file, 'utf-8')).toBe(expected + '\n' + user('next') + delta('new'))
  })

  it('commit swaps in a new inode only over the exact file that was read, and marks it so it is not copied again until it grows', async () => {
    const sc = make({ minBytes: 64 })
    const file = path.join(dir, 's.jsonl')
    const { text, expected } = sample()
    fs.writeFileSync(file, text)
    const before = fs.statSync(file)
    expect(sc.due(file, before)).toBe(true)

    // Appended after the read: refused, copy removed, original kept.
    const stale = await sc.compact(file) as StreamCompactPrepared
    fs.appendFileSync(file, '\n')
    expect(sc.commit(file, stale)).toBe(false)
    expect(fs.existsSync(stale.tmpPath)).toBe(false)
    expect(fs.readFileSync(file, 'utf-8')).toBe(text + '\n')

    fs.writeFileSync(file, text)
    const prepared = await sc.compact(file) as StreamCompactPrepared
    const old = fs.statSync(file)
    expect(prepared).toMatchObject({ dev: old.dev, ino: old.ino, birthtimeMs: old.birthtimeMs })
    const ino = old.ino
    expect(sc.rewrittenFrom(file, old)).toBe(null)
    expect(sc.commit(file, prepared)).toBe(true)
    const after = fs.statSync(file)
    expect(fs.readFileSync(file, 'utf-8')).toBe(expected)
    expect(after.ino).not.toBe(ino)
    expect(Math.floor(after.mtimeMs / 1000)).toBe(Math.floor(old.mtimeMs / 1000))
    expect(JSON.parse(fs.readFileSync(sc.markPathFor(file), 'utf-8'))).toMatchObject({
      dev: after.dev, ino: after.ino, birthtimeMs: after.birthtimeMs, size: after.size,
    })
    // The new file names the epoch it replaced (the daemon's streamEpoch format),
    // only while it is still exactly that output.
    const from = `${old.dev}:${old.ino}:${Math.floor(old.birthtimeMs)}`
    expect(sc.rewrittenFrom(file, after)).toBe(from)
    expect(sc.rewrittenFrom(file, { ...after, size: after.size + 1 })).toBe(null)
    expect(sc.due(file, after)).toBe(false)
    // Grown by a quarter (and past the size floor): due again.
    fs.appendFileSync(file, delta('x'.repeat(after.size)) + result(9))
    expect(sc.due(file, fs.statSync(file))).toBe(true)
    // A recreated file (new inode) does not inherit the mark. The old file is moved
    // aside, not unlinked: a freed inode number is often handed straight back to the
    // next create, and a recreated file of the very same size on the very same inode
    // is (rightly) indistinguishable from the compacted one. Keeping the old inode
    // allocated is what makes the new one provably different.
    const marked = fs.statSync(file).ino
    fs.renameSync(file, `${file}.old`)
    fs.writeFileSync(file, expected)
    expect(fs.statSync(file).ino).not.toBe(marked)
    expect(sc.due(file, fs.statSync(file))).toBe(true)
    expect(sc.rewrittenFrom(file, fs.statSync(file))).toBe(null)
  })
})
