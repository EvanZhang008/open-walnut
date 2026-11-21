/**
 * A read that joins a transfer already in flight (DaemonFileReader.shareRead) is
 * credited with that transfer's bytes.
 *
 * A remote read is judged by the bytes reaching its own commands (hosts/read-progress.ts):
 * a read that sees none for the idle bound is answered as a silent host. The shared
 * transfer's commands are sent inside the reader that started it, so before this a
 * joiner counted nothing: CI 2026-11-20 (host-read-silent-link-e2e), the minute
 * transcript sweep started the whole-file read first, the open session's history
 * joined it, and its request was cut "did not answer in time" after 20 s while the
 * bytes it waited for kept arriving at 64 KB/s.
 *
 * Real: DaemonFileReader, ReadProgress and its async context. Mocked: the daemon's
 * send, which credits each command as DaemonConnection.send does (bytes that reached
 * it so far) and answers fs.readRange only when the test lets a chunk through.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const wire = vi.hoisted(() => ({
  file: Buffer.alloc(0),
  gate: [] as Array<() => void>,
}))

vi.mock('../../src/providers/daemon-connection.js', async () => {
  const { creditCurrentRead } = await import('../../src/core/hosts/read-progress.js')
  const send = async (cmd: string, args: Record<string, unknown>) => {
    if (cmd !== 'fs.readRange') return { ok: false, error: `unexpected ${cmd}` }
    let reached = 0
    creditCurrentRead(() => reached)
    await new Promise<void>((resolve) => wire.gate.push(resolve))
    const start = args.start as number
    const slice = wire.file.subarray(start, Math.min(start + (args.length as number), wire.file.length))
    reached = slice.length
    return { ok: true, data: slice.toString('base64'), bytesRead: slice.length, fileSize: wire.file.length, eof: start + slice.length >= wire.file.length }
  }
  return { getDaemonConnection: async () => ({ send }) }
})

import { DaemonFileReader } from '../../src/core/daemon-file-reader.js'
import { ReadProgress, runWithReadProgress } from '../../src/core/hosts/read-progress.js'

const CHUNK_SIZE = (DaemonFileReader as unknown as { CHUNK_SIZE: number }).CHUNK_SIZE
const PATH = '~/.claude/projects/-p/s.jsonl'

/** Let the next fs.readRange answer, once it has been asked. */
async function releaseChunk(): Promise<void> {
  for (let i = 0; i < 200 && wire.gate.length === 0; i++) await new Promise((r) => setTimeout(r, 1))
  const next = wire.gate.shift()
  expect(next, 'a chunk was asked for').toBeTruthy()
  next!()
  await new Promise((r) => setTimeout(r, 5))
}

describe('DaemonFileReader: a joiner counts the shared transfer', () => {
  beforeEach(() => {
    wire.file = Buffer.alloc(CHUNK_SIZE * 3 + 100, 'a')
    wire.gate = []
  })

  it('every chunk the starter receives counts for the read that joined it, and the starter still counts it', async () => {
    const at = { mtimeMs: 1, size: wire.file.length, epoch: 'e:1:1' }
    const starter = new ReadProgress()
    const joiner = new ReadProgress()
    const a = runWithReadProgress(starter, () => new DaemonFileReader('__local__').readFileRangeBuffer(PATH, 0, at))
    // Let the starter put its transfer in flight before the second reader asks.
    await new Promise((r) => setTimeout(r, 5))
    const b = runWithReadProgress(joiner, () => new DaemonFileReader('__local__').readFileRangeBuffer(PATH, 0, at))

    const seen: number[] = []
    for (let i = 0; i < 4; i++) {
      await releaseChunk()
      seen.push(joiner.bytes())
      expect(joiner.bytes(), `chunk ${i + 1}: the joiner sees what the starter sees`).toBe(starter.bytes())
    }
    const [ra, rb] = await Promise.all([a, b])
    expect(rb).toBe(ra) // one transfer, shared
    expect(ra!.buf.length).toBe(wire.file.length)
    // The joiner's count grew with every chunk (the idle bound sees a delivering link).
    expect(seen).toEqual([CHUNK_SIZE, CHUNK_SIZE * 2, CHUNK_SIZE * 3, wire.file.length])
  })

  it('a joiner keeps the final count once the transfer settled, and a new read after it is its own transfer', async () => {
    const at = { mtimeMs: 2, size: wire.file.length, epoch: 'e:1:2' }
    const starter = new ReadProgress()
    const joiner = new ReadProgress()
    const a = runWithReadProgress(starter, () => new DaemonFileReader('__local__').readFileRangeBuffer(PATH, 0, at))
    await new Promise((r) => setTimeout(r, 5))
    const b = runWithReadProgress(joiner, () => new DaemonFileReader('__local__').readFileRangeBuffer(PATH, 0, at))
    for (let i = 0; i < 4; i++) await releaseChunk()
    await Promise.all([a, b])
    expect(joiner.bytes()).toBe(wire.file.length)

    const later = new ReadProgress()
    const c = runWithReadProgress(later, () => new DaemonFileReader('__local__').readFileRangeBuffer(PATH, 0, at))
    await releaseChunk()
    expect(later.bytes()).toBe(CHUNK_SIZE)
    expect(joiner.bytes(), 'a settled transfer counts nothing more for its joiner').toBe(wire.file.length)
    for (let i = 0; i < 3; i++) await releaseChunk()
    await c
  })
})
