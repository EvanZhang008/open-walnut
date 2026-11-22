/**
 * Ratchet: every leader that sends a copy its moves (`renamed`, for a target whose build takes
 * 'host-replica-moves-v1') also moves a copy that cannot take them, in the two steps of
 * bridgeEntries (core/replication/manifest-moves.ts). Without that, a copy on an older build
 * refuses the move under its half rule on every round until it updates: on 2026-11-20 the one
 * tree moved every note and the companion, held on an older build, kept its notes and pictures
 * at the old paths for days. A new leader of a copy with moves fails here until it bridges too.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(__dirname, '../../../src')

function sources(dir: string): string[] {
  const out: string[] = []
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name)
    if (d.isDirectory()) out.push(...sources(p))
    else if (/\.tsx?$/.test(d.name)) out.push(p)
  }
  return out
}

describe('moves reach every copy, whatever its build', () => {
  const senders = sources(SRC).filter((f) => /\btarget\.moves\b/.test(fs.readFileSync(f, 'utf8')))

  it('finds the leaders that send moves', () => {
    expect(senders.map((f) => path.relative(SRC, f)).sort()).toEqual(expect.arrayContaining(['core/attachment-replica.ts', 'core/host-replica.ts']))
  })

  it('each of them bridges a move for a copy without moves', () => {
    const missing = senders.filter((f) => !/\b(?:bridgeEntries|moveInTwoSteps)\(/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(SRC, f))
    expect(missing).toEqual([])
  })
})
