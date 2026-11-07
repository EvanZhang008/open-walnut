/**
 * Browser specs share one fixture server, and spec files run in parallel workers. Two
 * classes of cross-spec interference reached CI on 2026-11-07:
 *
 * 1. A fixture task one spec writes (renames, completes, resets) was written by a second
 *    spec too: task-store-detail-popup-instant reused pw-task-store-sync, which
 *    task-store-same-browser-instant renames and completes mid-run, and opened on the other
 *    spec's title with its row Done. A fixture task a spec writes belongs to that spec alone;
 *    another spec makes its own task.
 * 2. A kanban spec read every worker's notices in the window's one corner: another team's
 *    seeded Bash prompts held the corner, the full-screen sheet moved past it, the board pane
 *    fell under 600px and the lane strip (wide mode only) was gone mid-test
 *    (board-kanban-controls C53). Every kanban spec keeps the corner to the board's own toasts
 *    (keepCornerToBoard), as the others already did.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const DIR = path.resolve(import.meta.dirname, '../e2e/browser')
const specs = fs.readdirSync(DIR).filter((f) => f.endsWith('.spec.ts'))
const read = (f: string) => fs.readFileSync(path.join(DIR, f), 'utf-8')

/** Pairs that write different fields of one fixture task and read neither field of the other's. */
const SHARED_WRITERS: Record<string, { files: string[]; why: string }> = {
  'pw-task-vscode': {
    files: ['kebab-menu-viewport-fit.spec.ts', 'session-header-title-row.spec.ts'],
    why: 'kebab-menu-viewport-fit only resets the phase to IN_PROGRESS and finds the row by id; session-header-title-row only sets the title it then reads',
  },
}

describe('browser specs keep out of each other\'s data', () => {
  it('a fixture task a spec writes is written by no other spec', () => {
    const writers = new Map<string, string[]>()
    for (const f of specs) {
      const src = read(f)
      const id = /const TASK_ID = '([^']+)'/.exec(src)?.[1]
      if (!id) continue
      const writes = /\.patch\(\s*`\/api\/(v1\/)?tasks\/\$\{TASK_ID\}`/.test(src) || /\/api\/(v1\/)?tasks\/\$\{TASK_ID\}\/toggle-complete/.test(src)
      if (writes) writers.set(id, [...(writers.get(id) ?? []), f])
    }
    expect(writers.size).toBeGreaterThan(0)
    const shared = [...writers].filter(([id, files]) => files.length > 1
      && !(SHARED_WRITERS[id] && files.every((f) => SHARED_WRITERS[id].files.includes(f))))
    expect(shared, 'give the second spec a task of its own (create it in the test, delete it after)').toEqual([])
  })

  it('every kanban spec keeps the notice corner to the board', () => {
    const kanban = specs.filter((f) => f.startsWith('board-kanban-'))
    expect(kanban.length).toBeGreaterThan(5)
    const missing = kanban.filter((f) => !/await keepCornerToBoard\(/.test(read(f)))
    expect(missing, 'call keepCornerToBoard(context) in the spec\'s beforeEach').toEqual([])
  })
})
