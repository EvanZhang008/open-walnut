/**
 * Settings > General, "Went ahead without asking": the same step from the same task, several times,
 * is one entry with its count at the place of its newest (2026-11-22 audit: five near-identical
 * lines read as a wall).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { groupSame, splitPaths } from '../../web/src/components/settings/sections/ApprovalsAskRow.js'
import type { Approval } from '../../web/src/api/approvals.js'

const step = (id: string, what: string, taskId: string | undefined, at: string): Approval =>
  ({ id, what, createdAt: at, requester: { host: 'local', taskId, taskTitle: taskId ? `Task ${taskId}` : undefined } }) as unknown as Approval

describe('groupSame', () => {
  it('folds the same step of the same task, keeping newest-first order and the newest as lead', () => {
    const items = [
      step('a3', 'Gave the password to the sign-in', 't1', '2026-11-20T10:03:00Z'),
      step('b1', 'Upload a file', 't2', '2026-11-20T10:02:00Z'),
      step('a2', 'Gave the password to the sign-in', 't1', '2026-11-20T10:01:00Z'),
      step('a1', 'Gave the password to the sign-in', 't1', '2026-11-20T10:00:00Z'),
    ]
    const groups = groupSame(items)
    expect(groups.map((g) => [g.lead.id, g.all.length])).toEqual([['a3', 3], ['b1', 1]])
  })

  it('keeps the same words from another task, or from no task, apart', () => {
    const items = [
      step('x', 'Post the changelog', 't1', '2026-11-20T10:02:00Z'),
      step('y', 'Post the changelog', 't2', '2026-11-20T10:01:00Z'),
      step('z', 'Post the changelog', undefined, '2026-11-20T10:00:00Z'),
    ]
    expect(groupSame(items).map((g) => g.all.length)).toEqual([1, 1, 1])
  })
})

// One scannable row (2026-11-22 audit: long paths filled the row's words): a path's folders move to
// the meta line and the file's name stays in the words; a URL's slashes are not folders.
describe('splitPaths', () => {
  it('moves each path\'s folders out and keeps the file name in place', () => {
    expect(splitPaths('Upload ~/.local/state/walnut/tasks/t1/promo/demo.mp4 from this computer into example.org')).toEqual({
      text: 'Upload demo.mp4 from this computer into example.org',
      dirs: ['~/.local/state/walnut/tasks/t1/promo/'],
    })
    expect(splitPaths('Upload ~/Desktop/Screen Recording at 12.32.01 PM.mov from this computer into 127.0.0.1')).toEqual({
      text: 'Upload Screen Recording at 12.32.01 PM.mov from this computer into 127.0.0.1',
      dirs: ['~/Desktop/'],
    })
    expect(splitPaths('Upload /tmp/a/x.gif and /tmp/a/y.gif into example.org').dirs).toEqual(['/tmp/a/'])
  })

  it('leaves words with no path, and a URL, as they are', () => {
    for (const what of ['Gave the password "garden.example" to "Bakery": sign in', 'Open https://example.org/a/b in the browser', 'Post the and/or note']) {
      expect(splitPaths(what)).toEqual({ text: what, dirs: [] })
    }
  })
})

// The folders are shown whole under the row, wrapping after a "/" (2026-11-22, the audit's third
// look: on one cut line with a hover peek, an upload's source path could not be read).
describe('the meta line under a step', () => {
  const src = readFileSync(join(__dirname, '../../web/src/components/settings/sections/ApprovalsAskRow.tsx'), 'utf8')
  const css = readFileSync(join(__dirname, '../../web/src/styles/approvals-ask-row.css'), 'utf8')
  it('is never cut: no one-line meta class, the folders breakable, no ellipsis in its rule', () => {
    const meta = src.match(/<span className="approvals-unasked-meta[^"]*"/)?.[0] ?? ''
    expect(meta).toBe('<span className="approvals-unasked-meta"')
    expect(src).toMatch(/dirs\.includes\(m\) \? <Breakable text=\{m\} \/>/)
    const rule = css.match(/\.approvals-unasked-meta \{[^}]*\}/)?.[0] ?? ''
    expect(rule).not.toMatch(/ellipsis|nowrap|line-clamp/)
  })
})
