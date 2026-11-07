/**
 * tests/helpers/fake-child.ts: a fake child ends once the code under test listens, never after
 * a fixed sleep (2026-11-07: inline-subagent-slim's first case timed out on a loaded host,
 * because its runner's first import outlasted the 10 ms sleep and the exit went to nobody).
 */
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { endWhenHeard } from './fake-child.js'

/** A runner that, like a cold first import, attaches its close listener late. */
function lateListener(delayMs: number): { proc: EventEmitter; ended: Promise<number | null> } {
  const proc = new EventEmitter()
  const ended = new Promise<number | null>((resolve) => {
    setTimeout(() => proc.on('close', (code: number | null) => resolve(code)), delayMs)
  })
  return { proc, ended }
}

const settled = (p: Promise<unknown>, ms: number): Promise<boolean> =>
  Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))])

describe('endWhenHeard', () => {
  it('a fixed 10 ms sleep loses the end of a child whose runner listens late', async () => {
    const { proc, ended } = lateListener(50)
    await new Promise((r) => setTimeout(r, 10))
    proc.emit('exit', 0)
    proc.emit('close', 0)
    expect(await settled(ended, 200)).toBe(false)
  })

  it('waits for the listener, so the same late runner hears the end', async () => {
    const { proc, ended } = lateListener(50)
    await endWhenHeard(proc, 3)
    expect(await ended).toBe(3)
  })

  it('no test under tests/ emits a fake child\'s exit or close right after a fixed sleep', () => {
    const root = path.resolve(__dirname, '..')
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) { walk(full); continue }
        if (!/\.test\.tsx?$/.test(entry.name) || full === __filename) continue
        const lines = fs.readFileSync(full, 'utf8').split('\n')
        lines.forEach((line, i) => {
          if (!/await new Promise\(\(?\w*\)? => setTimeout\(\w+, \d+\)\)/.test(line)) return
          const next = lines.slice(i + 1, i + 4).join('\n')
          if (/\.emit\('(exit|close)'/.test(next)) offenders.push(`${path.relative(root, full)}:${i + 1}`)
        })
      }
    }
    walk(root)
    expect(offenders, 'end the fake child with endWhenHeard from tests/helpers/fake-child.ts').toEqual([])
  })
})
