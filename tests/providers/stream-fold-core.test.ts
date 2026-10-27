/**
 * stream-fold-core.ts on its own: the async one-pass fold equals a plain
 * line-by-line fold (chunk edges, a torn tail, an oversized line, a checkpoint
 * to resume from), it leaves checkpoints, and a rotation is offered only for a
 * big file whose transcript exists. The daemon twins run it in
 * daemon-big-stream-resume-twins-e2e.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { foldLine, initialFoldState, type FoldState } from '../../src/providers/daemon-fold.js'
import { createFoldCheckpoint } from '../../src/providers/fold-checkpoint-core.js'
import { createStreamFold } from '../../src/providers/stream-fold-core.js'

interface Task { tasks: Record<string, { status: string; t: number }>; updatedAt: number; recentTransitions: Array<{ t: number }>; n: number }
const emptyTask = (): Task => ({ tasks: {}, updatedAt: 0, recentTransitions: [], n: 0 })
// A stand-in task reducer: counts task lines and keeps the last status per id.
function applyTask(ts: Task, parsed: Record<string, unknown>): boolean {
  if (parsed.type !== 'system' || typeof parsed.task_id !== 'string') return false
  ts.tasks[parsed.task_id] = { status: String(parsed.status ?? 'running'), t: 0 }
  ts.n++
  return true
}

let dir = ''
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-stream-fold-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

function make(opts: { chunkBytes?: number; progressBytes?: number; rotateBytes?: number; maxLineBytes?: number; minCheckpoint?: number } = {}) {
  const checkpoint = createFoldCheckpoint({ fs, createHash: crypto.createHash, pid: 1, minBytes: opts.minCheckpoint ?? 1 })
  const logs: Array<{ msg: string; meta: Record<string, unknown> }> = []
  const sf = createStreamFold<FoldState, Task>({
    fs, path, foldLine, initialFoldState, emptyTaskState: emptyTask, applyTaskEvent: applyTask,
    checkpoint, maxLineBytes: opts.maxLineBytes ?? 1024 * 1024, now: Date.now,
    log: (_l, msg, meta) => logs.push({ msg, meta }),
    chunkBytes: opts.chunkBytes, progressBytes: opts.progressBytes, rotateBytes: opts.rotateBytes,
  })
  return { sf, checkpoint, logs }
}

const L = (o: unknown) => JSON.stringify(o) + '\n'
function stream(turns: number): string {
  const out: string[] = [L({ type: 'system', subtype: 'init', session_id: 's' })]
  for (let t = 1; t <= turns; t++) {
    // Multi-byte text, so chunk edges fall inside characters.
    out.push(L({ type: 'user', message: { role: 'user', content: 'turn ' + t + ' \u00e9\u4e2d' } }))
    out.push(L({ type: 'system', subtype: 'task_started', task_id: 'k' + t }))
    out.push(L({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(t * 37 % 900) }] } }))
    out.push(L({ type: 'system', subtype: 'task_notification', task_id: 'k' + t, status: t % 3 ? 'completed' : 'failed' }))
    out.push(L({ duration_api_ms: 1, type: 'result', subtype: 'success', is_error: false, num_turns: t, stop_reason: 'end_turn' }))
    out.push(L({ type: 'system', subtype: 'session_state_changed', state: 'idle' }))
  }
  return out.join('')
}

/** The plain fold: every complete line in order, same `v` coordinate. */
function reference(text: string): { fold: FoldState; tasks: number; boundary: number } {
  let fold = initialFoldState(0)
  const ts = emptyTask()
  let v = 0
  const end = text.lastIndexOf('\n') + 1
  for (const line of text.slice(0, end).split('\n').slice(0, -1)) {
    v += Buffer.byteLength(line) + 1
    if (!line.trim()) continue
    fold = foldLine(fold, line, v)
    if (line.includes('"task_')) applyTask(ts, JSON.parse(line))
  }
  return { fold, tasks: ts.n, boundary: v }
}

describe('stream-fold-core', () => {
  it('equals a plain fold at any chunk size, multi-byte text across chunk edges included', async () => {
    const text = stream(120)
    const file = path.join(dir, 'a.jsonl')
    fs.writeFileSync(file, text)
    const ref = reference(text)
    for (const chunkBytes of [7, 64, 1000, 4096, 1 << 20]) {
      const { sf, checkpoint } = make({ chunkBytes })
      checkpoint.discard(file)
      const r = await sf.foldFile(file, 1)
      expect(r.boundary, `chunk ${chunkBytes}`).toBe(ref.boundary)
      expect(r.fold).toEqual(ref.fold)
      expect(r.task.n).toBe(ref.tasks)
      expect(r.from).toBe(0)
    }
  })

  it('leaves a torn tail unfolded and outside the boundary', async () => {
    const text = stream(10) + '{"type":"assistant","message":{"content":[{"type":"te'
    const file = path.join(dir, 'b.jsonl')
    fs.writeFileSync(file, text)
    const r = await make({ chunkBytes: 100 }).sf.foldFile(file, 1)
    expect(r.boundary).toBe(reference(text).boundary)
    expect(r.boundary).toBe(Buffer.byteLength(text) - Buffer.byteLength(text.slice(text.lastIndexOf('\n') + 1)))
  })

  it('drops a line longer than the cap and realigns on the next newline', async () => {
    const head = stream(3)
    const tail = stream(2).split('\n').slice(1).join('\n')
    const text = head + L({ type: 'user', message: { content: 'z'.repeat(5000) } }) + tail
    const file = path.join(dir, 'c.jsonl')
    fs.writeFileSync(file, text)
    const { sf, logs } = make({ chunkBytes: 512, maxLineBytes: 2048 })
    const r = await sf.foldFile(file, 1)
    expect(r.boundary).toBe(Buffer.byteLength(text))
    expect(logs.some((l) => l.msg.includes('carry overflow'))).toBe(true)
    // The lines after the dropped one still folded.
    expect(r.task.n).toBe(reference(head).tasks + reference(tail).tasks)
  })

  it('resumes from its own checkpoint: the second fold reads only what was appended', async () => {
    const first = stream(40)
    const file = path.join(dir, 'd.jsonl')
    fs.writeFileSync(file, first)
    const { sf } = make({ chunkBytes: 256 })
    const r1 = await sf.foldFile(file, 1)
    expect(r1.checkpointV).toBe(r1.boundary)
    const more = stream(5).split('\n').slice(1).join('\n')
    fs.appendFileSync(file, more)
    const r2 = await sf.foldFile(file, 1)
    expect(r2.from).toBe(r1.boundary)
    const ref = reference(first + more)
    expect(r2.boundary).toBe(ref.boundary)
    expect(r2.fold).toEqual(ref.fold)
    expect(r2.task.n).toBe(ref.tasks)
  })

  it('saves progress while it folds, so a cut fold is not lost', async () => {
    const text = stream(200)
    const file = path.join(dir, 'e.jsonl')
    fs.writeFileSync(file, text)
    const { sf, checkpoint } = make({ chunkBytes: 1024, progressBytes: 4096 })
    const writes: number[] = []
    const write = checkpoint.write
    checkpoint.write = (...args: Parameters<typeof write>) => { writes.push(args[1].v); return write(...args) }
    const r = await sf.foldFile(file, 1)
    expect(writes.length).toBeGreaterThan(5)
    expect(writes[writes.length - 1]).toBe(r.boundary)
  })

  it('gives the loop back while it folds', async () => {
    const file = path.join(dir, 'f.jsonl')
    fs.writeFileSync(file, stream(400))
    let ticks = 0
    const timer = setInterval(() => { ticks++ }, 0)
    try {
      await make({ chunkBytes: 2048 }).sf.foldFile(file, 1)
    } finally {
      clearInterval(timer)
    }
    expect(ticks).toBeGreaterThan(3)
  })

  it('stops where `aborted` says, and that point is a checkpoint the next fold continues', async () => {
    const text = stream(200)
    const file = path.join(dir, 'g.jsonl')
    fs.writeFileSync(file, text)
    const { sf } = make({ chunkBytes: 1024 })
    let reads = 0
    const cut = await sf.foldFile(file, 1, { aborted: () => ++reads >= 5 })
    expect(cut.aborted).toBe(true)
    expect(cut.boundary).toBeGreaterThan(0)
    expect(cut.boundary).toBeLessThan(Buffer.byteLength(text))
    expect(cut.checkpointV).toBe(cut.boundary)
    const rest = await sf.foldFile(file, 1)
    expect(rest.aborted).toBe(false)
    expect(rest.from).toBe(cut.boundary)
    const ref = reference(text)
    expect(rest.fold).toEqual(ref.fold)
    expect(rest.task.n).toBe(ref.tasks)
  })

  it('assembles a line spanning many chunks whole', async () => {
    const text = stream(2) + L({ type: 'system', subtype: 'task_started', task_id: 'long', description: 'w'.repeat(300_000) }) + stream(1).split('\n').slice(1).join('\n')
    const file = path.join(dir, 'h.jsonl')
    fs.writeFileSync(file, text)
    const r = await make({ chunkBytes: 4096 }).sf.foldFile(file, 1)
    expect(r.boundary).toBe(Buffer.byteLength(text))
    expect(r.task.tasks.long).toBeDefined()
    expect(r.fold).toEqual(reference(text).fold)
  })

  it('a missing file folds to nothing', async () => {
    const r = await make().sf.foldFile(path.join(dir, 'none.jsonl'), 1)
    expect(r).toMatchObject({ boundary: 0, from: 0, checkpointV: 0 })
    expect(r.fold).toEqual(initialFoldState(0))
  })

  describe('rotation', () => {
    const projects = () => path.join(dir, 'projects')
    function transcript(id: string, body = 'x\n') {
      fs.mkdirSync(path.join(projects(), '-some-repo'), { recursive: true })
      fs.writeFileSync(path.join(projects(), '-some-repo', id + '.jsonl'), body)
    }

    it('is offered only at the cap, with a transcript, for a named transcript', async () => {
      const file = path.join(dir, 's1.jsonl')
      fs.writeFileSync(file, 'y'.repeat(2000))
      const { sf } = make({ rotateBytes: 1000 })
      expect(await sf.rotateReason(file, 's1', [projects()], initialFoldState(0))).toBeNull() // no transcript
      transcript('s1', '')
      expect(await sf.rotateReason(file, 's1', [projects()], initialFoldState(0))).toBeNull() // an empty one is no copy
      transcript('s1')
      expect(await sf.rotateReason(file, 's1', [path.join(dir, 'nope'), projects()], initialFoldState(0))).toEqual({ size: 2000 })
      expect(await sf.rotateReason(file, null, [projects()], initialFoldState(0))).toBeNull() // a fork names none
      expect(await make({ rotateBytes: 5000 }).sf.rotateReason(file, 's1', [projects()], initialFoldState(0))).toBeNull()
      expect(await make({ rotateBytes: 0 }).sf.rotateReason(file, 's1', [projects()], initialFoldState(0))).toBeNull()
      expect(make().sf.rotateBytes).toBe(256 * 1024 * 1024)
    })

    it('starts an empty file under a new inode and removes its sidecars', () => {
      const file = path.join(dir, 's2.jsonl')
      fs.writeFileSync(file, 'old\n')
      fs.writeFileSync(file + '.fold', '{}')
      fs.writeFileSync(file + '.compact', '{}')
      const ino = fs.statSync(file).ino
      // Hold the old inode open so the filesystem cannot reuse its number.
      const fd = fs.openSync(file, 'r')
      try {
        expect(make().sf.rotate(file, [file + '.fold', file + '.compact', file + '.fold.next'])).toBe(true)
        expect(fs.readFileSync(file, 'utf8')).toBe('')
        expect(fs.statSync(file).ino).not.toBe(ino)
        expect(fs.existsSync(file + '.fold')).toBe(false)
        expect(fs.existsSync(file + '.compact')).toBe(false)
      } finally {
        fs.closeSync(fd)
      }
    })

    it('is not offered while the fold holds an armed cron or a pending wakeup', async () => {
      const file = path.join(dir, 's3.jsonl')
      fs.writeFileSync(file, 'y'.repeat(2000))
      transcript('s3')
      const { sf, logs } = make({ rotateBytes: 1000 })
      const plain = initialFoldState(0)
      expect(await sf.rotateReason(file, 's3', [projects()], plain)).toEqual({ size: 2000 })
      expect(await sf.rotateReason(file, 's3', [projects()], { ...plain, cronIds: { 'job-1': 1 } })).toBeNull()
      expect(logs.some((l) => l.msg === 'stream rotation skipped' && l.meta.reason === 'cron-armed')).toBe(true)
      expect(await sf.rotateReason(file, 's3', [projects()], { ...plain, wakeupAt: Date.now() + 60_000 })).toBeNull()
      // A wakeup in the past is disarmed.
      expect(await sf.rotateReason(file, 's3', [projects()], { ...plain, wakeupAt: Date.now() - 60_000 })).toEqual({ size: 2000 })
    })
  })
})
