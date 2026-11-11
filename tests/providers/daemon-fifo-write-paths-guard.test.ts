/**
 * Class guard: every write into a CLI's stdin that can reap the CLI goes through
 * chainFifoWrite, the one place that gives a CLI still booting the boot deadline
 * (write-boot-wait-v1).
 *
 * 2026-11-05: a 7KB status question (sendRaw) written 5s after a spawn under load
 * 300 filled the pipe of a CLI still booting. sendRaw kept only the plain 20s
 * deadline, so the daemon reaped the healthy CLI ('sendRaw-partial-write', exit -1,
 * no transcript), four times that day. A new write path that bypasses
 * chainFifoWrite would bring that back: this test fails when one appears.
 *
 * Source scan of both daemon twins (daemon-core.ts for the bun daemon,
 * daemon-source.ts for the embedded JS one).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../../src/providers')
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8')

/** Span of the function `name`: from its declaration to the next function declared after it. */
function bodyOf(src: string, name: string): { start: number; end: number } {
  const start = src.search(new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(`))
  expect(start, `${name} is declared`).toBeGreaterThan(-1)
  const next = /\n\s*(async\s+)?function\s+\w+\s*\(/g
  next.lastIndex = start + 20
  const m = next.exec(src)
  return { start, end: m ? m.index : src.length }
}

/** Offsets of each call `name(` that is not the declaration itself. */
function callsOf(src: string, name: string): number[] {
  const out: number[] = []
  const re = new RegExp(`(?<!function\\s)\\b${name}\\(`, 'g')
  for (let m = re.exec(src); m; m = re.exec(src)) out.push(m.index)
  return out
}

describe.each([
  ['daemon-core.ts (bun daemon)', 'daemon-core.ts'],
  ['daemon-source.ts (embedded twin)', 'daemon-source.ts'],
])('%s: stdin writes that can reap a CLI', (_label, file) => {
  const src = read(file)

  it('the deadline-bound writer is called only from chainFifoWrite', () => {
    const chain = bodyOf(src, 'chainFifoWrite')
    const calls = callsOf(src, 'writeFifoFullyAsync')
    expect(calls.length).toBeGreaterThan(0)
    for (const at of calls) expect(at > chain.start && at < chain.end, `writeFifoFullyAsync call at offset ${at} is inside chainFifoWrite`).toBe(true)
  })

  it('chainFifoWrite gives a booting CLI the boot deadline for every line', () => {
    const chain = src.slice(bodyOf(src, 'chainFifoWrite').start, bodyOf(src, 'chainFifoWrite').end)
    expect(chain).toMatch(/bootWriteDeadline\(session\)/)
  })

  it('a part-written line into a CLI still booting is held, never reaped, until the boot hold (2026-11-11)', () => {
    // Every write goes through chainFifoWrite (above), which hands the writer the hold.
    const chain = src.slice(bodyOf(src, 'chainFifoWrite').start, bodyOf(src, 'chainFifoWrite').end)
    expect(chain).toMatch(/if \(!stillBooting\(session\)\) return false/)
    // A write queued behind the hold counts as behind a boot.
    expect(chain).toMatch(/session\.fifoBootWaitUntil = Math\.max\(session\.fifoBootWaitUntil (\?\?|\|\|) 0, holdUntil\)/)
    const writer = src.slice(bodyOf(src, 'writeFifoFullyAsync').start, bodyOf(src, 'writeFifoFullyAsync').end)
    // Past the deadline, only a write with nothing in or no hold gives up.
    expect(writer).toMatch(/if \(offset === 0 \|\| !\(?holdPartial/)
    expect(src).toMatch(/FIFO_BOOT_HOLD_MAX_MS = 15 \* 60_?000/)
  })

  it('a partial write reaps only after chainFifoWrite gave up', () => {
    // Each reap for a partial write follows a chainFifoWrite result in the same handler.
    const reaps = [...src.matchAll(/reapSession\([^)]*'(send|sendRaw)-partial-write'/g)]
    expect(reaps.length).toBeGreaterThan(0)
    for (const m of reaps) {
      // The same handler: the 100 lines before the reap.
      const before = src.slice(0, m.index).split('\n').slice(-100).join('\n')
      expect(before, `reap '${m[1]}-partial-write' follows a chainFifoWrite`).toMatch(/chainFifoWrite\(/)
    }
  })
})

describe('quick writes (no reap, a CLI that is reading)', () => {
  it('stay limited to the control responses they answer', () => {
    // writeFifoRaw/writeFifoQuick answer a control_request the CLI just sent, so it
    // reads stdin; they never reap. A new caller must be one of those, or use
    // chainFifoWrite: add it here only after checking which.
    const count = (f: string, name: string) => callsOf(read(f), name).length
    expect({
      sourceRaw: count('daemon-source.ts', 'writeFifoRaw'),
      sourceQuick: count('daemon-source.ts', 'writeFifoQuick'),
      standaloneRaw: count('daemon-standalone.ts', 'writeFifoRaw'),
    }).toEqual({ sourceRaw: 1, sourceQuick: 1, standaloneRaw: 1 })
  })
})
