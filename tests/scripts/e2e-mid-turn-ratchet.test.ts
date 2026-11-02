/**
 * An e2e test that starts a slow peer turn and then acts inside it (a message, a park, a fire)
 * needs the turn to outlast the act on a loaded CI runner. A 2.5 s turn ended before the act there
 * (2026-11-02, run 41368117908, task-wait-resume.test.ts), and the test then read a wait that
 * correctly came back as a product failure. Such a turn runs for MID_TURN_MS (8 s or more).
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = path.resolve(__dirname, '../e2e')
// A fixed short `slow:<ms>` turn, then a wait for it to run (the shape of a test that acts inside it).
// A turn meant to end on its own says so on its line ("nothing acts inside it").
const SHORT_MID_TURN = /'slow:(\d+) [^'\n]*'(?![^\n]*nothing acts inside it)[^\n]*\n[^\n]*until\('turn running'/g

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.test.ts') ? [path.join(dir, e.name)] : [])
}

const offenders = (text: string) => [...text.matchAll(SHORT_MID_TURN)].filter((m) => Number(m[1]) < 8_000)

describe('a slow turn an e2e test acts inside', () => {
  it('is never a fixed short slow: prefix', () => {
    const found = files(DIR).flatMap((f) => {
      const text = fs.readFileSync(f, 'utf8')
      return offenders(text).map((m) => `${path.relative(DIR, f)}:${text.slice(0, m.index).split('\n').length}`)
    })
    expect(found).toEqual([])
  })

  it('catches the shape it was written for', () => {
    expect(offenders("    await peer(a, 'slow:2500 a long answer')\n    await until('turn running', () => s(), (x) => x === 'running')")).toHaveLength(1)
    expect(offenders("    await peer(a, 'slow:1500 a short answer') // ends on its own: nothing acts inside it\n    await until('turn running', () => s(), (x) => x === 'running')")).toHaveLength(0)
    expect(offenders("    await peer(a, `slow:${MID_TURN_MS} a long answer`)\n    await until('turn running', () => s(), (x) => x === 'running')")).toHaveLength(0)
  })
})
