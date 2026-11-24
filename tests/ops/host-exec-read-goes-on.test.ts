/**
 * A reader that follows the `nextOffset` an agent's host_exec_read answer gives reaches the end of
 * the log and has read every byte of it once, whatever its lines look like
 * (src/ops/host-exec-shown.ts fromAskedOffset).
 *
 * 2026-11-24: the host starts a read from the start of the line its offset falls in
 * (host-exec-line.ts readLogLines); the answer showed the first 4 KB of a 256 KB xcodebuild
 * command line and gave an offset inside it, so the next read showed the same 4 KB and gave the
 * same offset: an iOS fleet script read one job 7,700 times, two reads a second, for an hour.
 * The reads here are the host's real ones on a real file, and the answers the op's real shaping.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { readLogLines } from '../../src/providers/host-exec-line.js'
import { OUTPUT_MAX_BYTES } from '../../src/providers/host-exec-core.js'
import { RUN_ANSWER_MAX_CHARS, shownRun } from '../../src/ops/host-exec-shown.js'
import { ANSWER_SURFACE_NAMES, ANSWER_SURFACES } from '../../src/ops/answer.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-goes-on-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const short = (n: number) => Array.from({ length: n }, (_, i) => `short line ${i} of build output\n`).join('')
const END = 'FLEET_RESULT {"ok":true}\n'
/** Whole logs, each ending its windows a different way. */
const LOGS: Record<string, string> = {
  'short lines': `${short(2_000)}${END}`,
  'a line longer than an answer': `${short(400)}    builtin-SwiftDriver ${'x'.repeat(12_000)} ERROR: the real failure\n${short(50)}${END}`,
  'a line longer than the host looks back': `${short(400)}${'y'.repeat(70 * 1024)}\n${short(50)}${END}`,
  'a line longer than the host\'s whole window': `${short(400)}    builtin-SwiftDriver ${'x'.repeat(300_000)}\n${short(50)}${END}`,
  'a long line of wide characters': `${short(100)}${'文'.repeat(9_000)}\n${short(50)}${END}`,
  'a long last line with no newline': `${short(100)}${END}${'z'.repeat(20_000)}`,
}

const CUT = /… \[Walnut cut: \d+ more characters\]$/

/** Read `file` from `from` to its end the way an agent does; what it read, in order. */
function readToEnd(file: string, from: number, surface: (typeof ANSWER_SURFACE_NAMES)[number], max: number, running = false): { reads: number; read: string } {
  const size = fs.statSync(file).size
  let off = from
  let read = ''
  for (let reads = 1; reads <= 2_000; reads++) {
    const r = readLogLines(file, off, OUTPUT_MAX_BYTES, running)
    const result = { host: 'H', jobId: 'hx-test', running, exitCode: running ? null : 0, ms: 1, outputBytes: size, logFile: file, ...r }
    const a = shownRun({ result, args: { offset: off }, surface, max }) as { nextOffset: number; offset: number; output?: string }
    // An answer that fits is the host's own (from the line's start); a cut one starts where it was asked.
    const text = String(a.output ?? '').replace(CUT, '')
    read += a.offset < off ? Buffer.from(text).subarray(off - a.offset).toString() : text
    expect(a.nextOffset, `read ${reads} from ${off} of ${size}`).toBeGreaterThan(off)
    expect(a.nextOffset, 'never past the log').toBeLessThanOrEqual(size)
    off = a.nextOffset
    if (off >= size) return { reads, read }
  }
  return { reads: Infinity, read }
}

function write(log: string | Buffer): string {
  const file = path.join(dir, `log-${Math.random().toString(36).slice(2)}.log`)
  fs.writeFileSync(file, log)
  return file
}

describe('a read from the offset an answer gives always goes on, and leaves nothing out', () => {
  for (const [name, log] of Object.entries(LOGS)) {
    for (const surface of ANSWER_SURFACE_NAMES) {
      for (const max of [RUN_ANSWER_MAX_CHARS, ANSWER_SURFACES[surface].max, 4_000]) {
        it(`${name}, ${surface}, answer of ${max}`, () => {
          const { reads, read } = readToEnd(write(log), 0, surface, max)
          // Each read shows about 1 KB at least: the reads are bounded by the log's size.
          expect(reads).toBeLessThan(Buffer.byteLength(log) / 900 + 20)
          expect(read).toBe(log)
        })
      }
    }
  }

  it('from an offset inside a long line', () => {
    const log = LOGS['a line longer than the host\'s whole window']!
    const from = Buffer.byteLength(short(400)) + 100_003
    expect(readToEnd(write(log), from, 'cli', ANSWER_SURFACES.cli.max).read).toBe(Buffer.from(log).subarray(from).toString())
  })

  it('a job still writing a long last line shows what it wrote since', () => {
    const file = write(short(10))
    let off = fs.statSync(file).size
    for (let i = 0; i < 5; i++) {
      fs.appendFileSync(file, 'p'.repeat(3_000))
      const r = readLogLines(file, off, OUTPUT_MAX_BYTES, true)
      const a = shownRun({ result: { host: 'H', jobId: 'hx-1', running: true, ms: 1, outputBytes: fs.statSync(file).size, logFile: file, ...r }, args: { offset: off }, surface: 'cli', max: ANSWER_SURFACES.cli.max }) as { nextOffset: number }
      expect(a.nextOffset).toBeGreaterThan(off)
      off = a.nextOffset
    }
  })

  it('bytes that are not UTF-8 never send a read past the log', () => {
    const bad = Buffer.concat([Buffer.from(short(5)), Buffer.alloc(7_000, 0xff), Buffer.from('\n'), Buffer.from(short(800)), Buffer.from(END)])
    const { read } = readToEnd(write(bad), 0, 'cli', ANSWER_SURFACES.cli.max)
    expect(read.endsWith(END)).toBe(true)
    expect(read).toContain('short line 0 of build output')
    expect(read).toContain('short line 799 of build output')
  })

  it('every answer that names where a read goes on is one of these', () => {
    // Ratchet: a new answer that gives a reader an offset to go on from must keep the promise this
    // file checks. host-exec-shown.ts is checked above; host-exec.ts passes the host's own offsets.
    const roots = ['src/ops', 'src/core/hosts'].map((r) => path.join(__dirname, '../..', r))
    const givers: string[] = []
    for (const root of roots) {
      for (const f of fs.readdirSync(root, { recursive: true }) as string[]) {
        if (!f.endsWith('.ts')) continue
        const text = fs.readFileSync(path.join(root, f), 'utf8')
        if (/(?<![.\w])nextOffset(?:\s*:\s*(?!number\b)|\s*[,}])/.test(text)) givers.push(path.relative(path.join(__dirname, '../..'), path.join(root, f)))
      }
    }
    expect(givers.sort()).toEqual(['src/core/hosts/host-exec.ts', 'src/ops/host-exec-shown.ts'])
  })
})
