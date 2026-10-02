/**
 * Fold checkpoints (fold-checkpoint-core.ts): a checkpoint is only ever used
 * while it provably describes the stream file, so resuming from it equals a
 * fold from byte 0. Every way the file can stop matching must read as "no
 * checkpoint".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createFoldCheckpoint, FOLD_CHECKPOINT_FORMAT } from '../../src/providers/fold-checkpoint-core.js'
import { foldLine, initialFoldState, type FoldState } from '../../src/providers/daemon-fold.js'

let dir = ''
let jsonl = ''
const MIN = 1024

function line(obj: unknown): string { return JSON.stringify(obj) + '\n' }

/** Stream content well past MIN bytes: a turn with a CronCreate and a result. */
function content(turns: number): string {
  let out = ''
  for (let i = 0; i < turns; i++) {
    out += line({ type: 'user', message: { role: 'user', content: `question ${i}` } })
    for (let t = 0; t < 20; t++) out += line({ type: 'stream_event', event: { delta: { type: 'text_delta', text: `token ${t}` } } })
    out += line({ type: 'result', subtype: 'success', is_error: false, num_turns: i + 1 })
  }
  return out
}

function foldText(text: string, from = initialFoldState(0), base = 0): FoldState {
  let state = from
  let v = base
  for (const l of text.split('\n')) {
    if (!l) continue
    v += Buffer.byteLength(l) + 1
    state = foldLine(state, l, v)
  }
  return state
}

const task = (t: number) => ({
  tasks: { a: { status: 'running', v: 10, t } },
  resourceVersion: 10, updatedAt: t, derivedRunning: 1,
  recentTransitions: [{ taskId: 'a', status: 'completed', v: 9, t }],
})

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-fold-ck-'))
  jsonl = path.join(dir, 'sid.jsonl')
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const make = (minBytes = MIN) => createFoldCheckpoint({ fs, createHash, pid: process.pid, minBytes })

describe('fold checkpoint', () => {
  it('round-trips, and resuming from it equals the fold from byte 0', () => {
    const first = content(20)
    fs.writeFileSync(jsonl, first)
    const ck = make()
    const fold = foldText(first)
    expect(fold.v).toBe(Buffer.byteLength(first))
    expect(ck.write(jsonl, fold, task(5))).toBe(true)

    const more = content(3)
    fs.appendFileSync(jsonl, more)
    const loaded = ck.load<FoldState, ReturnType<typeof task>>(jsonl)!
    expect(loaded.boundary).toBe(fold.v)
    expect(loaded.fold).toEqual(fold)
    expect(loaded.task).toEqual(task(5))
    const resumed = foldText(more, loaded.fold, loaded.boundary)
    expect(resumed).toEqual(foldText(first + more))
    // Written atomically: no temp file left beside it.
    expect(fs.readdirSync(dir).sort()).toEqual(['sid.jsonl', 'sid.jsonl.fold'])
  })

  it('skips small streams and an epoch that is not this file', () => {
    fs.writeFileSync(jsonl, content(20))
    const fold = foldText(fs.readFileSync(jsonl, 'utf8'))
    expect(make(fold.v + 1).write(jsonl, fold, null)).toBe(false)
    expect(make().write(jsonl, fold, null, 'not:this:file')).toBe(false)
    expect(fs.existsSync(jsonl + '.fold')).toBe(false)
  })

  it('refuses a fold that claims more bytes than the file holds', () => {
    fs.writeFileSync(jsonl, content(20))
    const fold = { ...foldText(fs.readFileSync(jsonl, 'utf8')) }
    fold.v += 100
    expect(make().write(jsonl, fold, null)).toBe(false)
  })

  describe('a checkpoint that no longer describes the file reads as none', () => {
    let ck: ReturnType<typeof make>
    let fold: FoldState
    beforeEach(() => {
      fs.writeFileSync(jsonl, content(20))
      ck = make()
      fold = foldText(fs.readFileSync(jsonl, 'utf8'))
      expect(ck.write(jsonl, fold, task(1))).toBe(true)
      expect(ck.load(jsonl)).not.toBeNull()
    })

    it('the file was recreated (new inode, same bytes)', () => {
      const bytes = fs.readFileSync(jsonl)
      // Keep the old inode allocated while the new file is made: ext4 hands a
      // freed inode number straight back, and a recreate inside the same
      // millisecond keeps the birth time too, so unlink + write was the SAME
      // epoch on a Linux runner now and then (CI 2026-10-02).
      fs.renameSync(jsonl, `${jsonl}.old`)
      fs.writeFileSync(jsonl, bytes)
      expect(fs.statSync(jsonl).ino).not.toBe(fs.statSync(`${jsonl}.old`).ino)
      expect(ck.load(jsonl)).toBeNull()
    })

    it('the file was truncated below the boundary', () => {
      fs.truncateSync(jsonl, fold.v - 10)
      expect(ck.load(jsonl)).toBeNull()
    })

    it('the bytes before the boundary changed in place', () => {
      const fd = fs.openSync(jsonl, 'r+')
      fs.writeSync(fd, 'X', fold.v - 5)
      fs.closeSync(fd)
      expect(ck.load(jsonl)).toBeNull()
    })

    it('the checkpoint is torn, foreign, or a different format', () => {
      const good = JSON.parse(fs.readFileSync(jsonl + '.fold', 'utf8'))
      fs.writeFileSync(jsonl + '.fold', '{"v":1,"epo')
      expect(ck.load(jsonl)).toBeNull()
      fs.writeFileSync(jsonl + '.fold', JSON.stringify({ ...good, v: 2 }))
      expect(ck.load(jsonl)).toBeNull()
      fs.writeFileSync(jsonl + '.fold', JSON.stringify({ ...good, fold: { ...good.fold, v: good.boundary - 1 } }))
      expect(ck.load(jsonl)).toBeNull()
      fs.writeFileSync(jsonl + '.fold', JSON.stringify({ ...good, boundary: -1 }))
      expect(ck.load(jsonl)).toBeNull()
    })

    it('the stream file is gone', () => {
      fs.unlinkSync(jsonl)
      expect(ck.load(jsonl)).toBeNull()
    })

    it('discard removes it', () => {
      ck.discard(jsonl)
      expect(fs.existsSync(jsonl + '.fold')).toBe(false)
      expect(ck.load(jsonl)).toBeNull()
      ck.discard(jsonl) // absent: still fine
    })
  })

  it('a checkpoint within the first 4KB still hashes exactly the bytes before it', () => {
    const text = content(2)
    fs.writeFileSync(jsonl, text)
    const small = createFoldCheckpoint({ fs, createHash, pid: process.pid, minBytes: 1 })
    const fold = foldText(text)
    expect(fold.v).toBeLessThan(4096)
    expect(small.write(jsonl, fold, null)).toBe(true)
    expect(small.load(jsonl)?.boundary).toBe(fold.v)
  })

  it('restamps task state the way a rebuild at `now` would', () => {
    const ck = make()
    expect(ck.restampTaskState(task(5), 99)).toEqual({
      tasks: { a: { status: 'running', v: 10, t: 99 } },
      resourceVersion: 10, updatedAt: 99, derivedRunning: 1,
      recentTransitions: [{ taskId: 'a', status: 'completed', v: 9, t: 99 }],
    })
    const empty = { tasks: {}, resourceVersion: 0, updatedAt: 7, derivedRunning: 0, recentTransitions: [] }
    expect(ck.restampTaskState(empty, 99).updatedAt).toBe(0)
  })

  it('never throws on a write it cannot make', () => {
    fs.writeFileSync(jsonl, content(20))
    const fold = foldText(fs.readFileSync(jsonl, 'utf8'))
    const warnings: string[] = []
    const ck = createFoldCheckpoint({
      fs: { ...fs, renameSync: () => { throw new Error('EROFS') } } as typeof fs,
      createHash, pid: process.pid, minBytes: MIN, log: (_l, msg) => { warnings.push(msg) },
    })
    expect(ck.write(jsonl, fold, null)).toBe(false)
    expect(warnings).toEqual(['fold checkpoint write failed'])
    expect(fs.readdirSync(dir)).toEqual(['sid.jsonl'])

    // A stream retention already removed is quietly not checkpointed: every
    // shutdown forces a write for each session the daemon still remembers.
    fs.unlinkSync(jsonl)
    expect(ck.write(jsonl, fold, null)).toBe(false)
    expect(warnings).toEqual(['fold checkpoint write failed'])
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('the format names the fold logic that wrote the checkpoint (ratchet)', () => {
    // A checkpoint carries what the fold logic of ITS day computed for the
    // prefix. When foldLine / initialFoldState / applyTaskEvent change, a
    // resumed fold would keep the old logic's answer for every byte before the
    // boundary. So the logic's text is pinned to the format: when this fails,
    // decide whether the change alters any state a stream can produce. If it
    // does, bump FOLD_CHECKPOINT_FORMAT and the FORMAT inside the factory (old
    // checkpoints then stop loading); either way, update the pin.
    const root = path.resolve(__dirname, '../..')
    const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8')
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim()
    const body = (src: string, header: string) => {
      const start = src.indexOf(header)
      expect(start, header).toBeGreaterThan(-1)
      return strip(src.slice(start, src.indexOf('\n}', start) + 2))
    }
    const fold = read('src/providers/daemon-fold.ts')
    const daemon = read('src/providers/daemon-standalone.ts')
    const logic = [
      body(fold, 'export function initialFoldState'),
      body(fold, 'export function foldLine'),
      body(daemon, 'function applyTaskEvent'),
      body(daemon, 'function emptyTaskState'),
      body(daemon, 'function runningTaskCount'),
      strip(daemon.match(/const BG_TERMINAL_STATUSES = .*/)![0]),
      strip(daemon.match(/const BG_TRANSITION_CAP = .*/)![0]),
    ].join('\n')
    const logicHash = createHash('sha256').update(logic).digest('hex').slice(0, 16)
    expect({ format: FOLD_CHECKPOINT_FORMAT, logicHash }).toEqual({ format: 1, logicHash: 'a8d549d1a5573961' })

    // The factory's own FORMAT is the one written.
    fs.writeFileSync(jsonl, content(20))
    expect(make().write(jsonl, foldText(fs.readFileSync(jsonl, 'utf8')), null)).toBe(true)
    expect(JSON.parse(fs.readFileSync(jsonl + '.fold', 'utf8')).v).toBe(FOLD_CHECKPOINT_FORMAT)
  })

  it('survives the source twin injection (self-contained factory)', () => {
    // daemon-source.ts inlines createFoldCheckpoint.toString(); rebuild it the
    // same way and use it.
    const rebuilt = new Function('return (' + createFoldCheckpoint.toString() + ')')() as typeof createFoldCheckpoint
    fs.writeFileSync(jsonl, content(20))
    const fold = foldText(fs.readFileSync(jsonl, 'utf8'))
    const ck = rebuilt({ fs, createHash, pid: process.pid, minBytes: MIN })
    expect(ck.write(jsonl, fold, null)).toBe(true)
    expect(make().load(jsonl)?.fold).toEqual(fold)
  })
})
