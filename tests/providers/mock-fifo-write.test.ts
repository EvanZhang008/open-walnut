/**
 * The mock daemons' FIFO writer answers as daemon-core's writeFifo: a reader that closed
 * between the open and the write (EPIPE) is the CLI's death, the same as no reader at the
 * open (ENXIO).
 *
 * 2026-11-26 (GitHub CI, slow tier): the standalone mock daemon took the EPIPE of a mock CLI
 * that exited right after its answer as a protocol error. It answered the write before it
 * drained the answer and never reported the death, so
 * mock-daemon-death-order.test.ts found no answer before the refusal.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { writeFifoLine } from '../helpers/mock-fifo-write.mjs'

let dir: string
let pipe: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-fifo-write-'))
  pipe = path.join(dir, 'cli.pipe')
  execFileSync('mkfifo', [pipe])
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const openReader = (): number => fs.openSync(pipe, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)

describe('writeFifoLine', () => {
  it('writes the whole line into a live reader', () => {
    const reader = openReader()
    try {
      expect(writeFifoLine(pipe, Buffer.from('{"type":"user"}\n'))).toBe('ok')
      const buf = Buffer.alloc(64)
      expect(buf.toString('utf8', 0, fs.readSync(reader, buf))).toBe('{"type":"user"}\n')
    } finally { fs.closeSync(reader) }
  })

  it('a FIFO with no reader is the CLI gone (ENXIO)', () => {
    expect(writeFifoLine(pipe, Buffer.from('x\n'))).toBe('ENXIO')
  })

  it('a reader that closes after the open is the CLI gone too (EPIPE)', () => {
    const reader = openReader()
    expect(writeFifoLine(pipe, Buffer.from('x\n'), { afterOpen: () => fs.closeSync(reader) })).toBe('ENXIO')
  })

  it('a live reader that does not read leaves the line retriable (EAGAIN)', () => {
    const reader = openReader()
    try {
      // Bigger than any pipe buffer: the write fills it and waits out waitMs.
      expect(writeFifoLine(pipe, Buffer.alloc(4 * 1024 * 1024, 'a'), { waitMs: 20 })).toBe('EAGAIN')
    } finally { fs.closeSync(reader) }
  })
})

/**
 * Every mock that writes a CLI's FIFO writes it through writeFifoLine, so a new mock daemon (or a
 * new write path in one) cannot handle ENXIO and forget EPIPE again. A FIFO write is an
 * `O_WRONLY` open; only test files and the files named here may hold one.
 */
const OWN_FIFO_WRITERS: Record<string, string> = {
  'tests/helpers/mock-fifo-write.mjs': 'the one writer',
  'tests/helpers/fifo-epipe-proc.ts': 'a probe of acp-survive.ts, the product code, which owns that write',
}

describe('mock FIFO writes go through writeFifoLine', () => {
  it('no helper or mock under tests/ opens a FIFO for writing on its own', () => {
    const root = path.resolve(import.meta.dirname, '../..')
    const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', 'tests'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter((f) => /\.(ts|mts|js|mjs)$/.test(f) && !/\.(test|spec)\.ts$/.test(f))
    expect(files.length).toBeGreaterThan(100)
    const writers = files.filter((f) => {
      try { return fs.readFileSync(path.join(root, f), 'utf8').includes('O_WRONLY') } catch { return false }
    })
    expect(writers.filter((f) => !(f in OWN_FIFO_WRITERS))).toEqual([])
    // Both mock daemons are among the writers it covers.
    for (const mock of ['tests/helpers/mock-daemon.ts', 'tests/helpers/mock-daemon-process.mjs']) {
      expect(fs.readFileSync(path.join(root, mock), 'utf8')).toContain("from './mock-fifo-write.mjs'")
    }
  })
})
