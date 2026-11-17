/**
 * Guard: no send is refused for the formats its text holds (review or ticket numbers, another task's
 * paths). Whether work is a task's own deliverable is the sender's judgment, by meaning (the task
 * routing contract); a check that matched numbers in a message was removed on 2026-11-17 (the user:
 * too specific to one way of numbering work). This fails when such a check comes back: a refusal code
 * for it, its escape hatch, or the host daemon reading those formats out of a send again.
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { getOp } from '../../src/ops/index.js'

const root = path.resolve(__dirname, '../..')
const files = (dir: string): string[] => readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? files(path.join(dir, e.name)) : /\.(ts|tsx|mjs)$/.test(e.name) ? [path.join(dir, e.name)] : [])

describe('no send is refused for the formats its text holds', () => {
  it('src holds no scope_mismatch refusal and no same_deliverable escape hatch (only its retired-input line)', () => {
    const hits = files('src').flatMap((f) => readFileSync(path.join(root, f), 'utf8').split('\n')
      .map((line, i) => ({ f, i: i + 1, line }))
      .filter(({ line }) => /scope_mismatch|same_deliverable|sameDeliverable/.test(line) && !/retiredInput: \['same_deliverable'\]/.test(line)))
    expect(hits.map((h) => `${h.f}:${h.i}`)).toEqual([])
  })

  it('task_send still accepts a call that passes the retired field', () => {
    expect(getOp('task_send')!.retiredInput).toContain('same_deliverable')
  })

  it('the host daemon\'s fast path reads no ticket or review formats out of a send', () => {
    const daemon = readFileSync(path.join(root, 'src/providers/offline-host-core.ts'), 'utf8')
    const at = daemon.indexOf('LOCAL_SEND_OPS.indexOf(name)')
    expect(at).toBeGreaterThan(0)
    const fastPath = daemon.slice(at, daemon.indexOf('payload.args = {', at))
    expect(fastPath).not.toMatch(/CR\|PR|ticket\|incident|\\u5de5\\u5355|\.test\(said\)/)
  })
})
