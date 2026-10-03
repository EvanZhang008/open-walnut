/**
 * The commit view's selection rules (web/src/components/sessions/sessionCommitModel.ts):
 * only this session's hunks and files start checked, toggling keeps a file's
 * tri-state honest, and the commit payload / Suggest diff carry exactly the pick.
 */
import { describe, expect, it } from 'vitest'
import {
  buildSelections, defaultSelection, fileCheckState, selectedCount, selectedDiffText, toggleFile, toggleHunk,
} from '@/components/sessions/sessionCommitModel'
import type { CommitHunk, CommitPlanFile, CommitPlanRepo } from '@/api/session-commit'

const hunk = (id: string, owner: CommitHunk['owner'], line: number): CommitHunk => ({
  id, owner, oldStart: line, oldLines: [`line ${line + 1}\n`], newStart: line, newLines: [`line ${line + 1} (${id})\n`], seq: 0, before: [], after: [],
})

function repo(files: CommitPlanFile[]): CommitPlanRepo {
  return { repoRoot: '/r', label: 'r', branch: 'main', headSha: 'h', files, upstream: null, pushTarget: null, ahead: null, behind: null, pr: { available: false } }
}

const mixed: CommitPlanFile = { path: 'shared.txt', status: 'modified', kind: 'text', owner: 'mixed', session: true, hunks: [hunk('a', 'mine', 4), hunk('b', 'other', 24)] }
const mineOnly: CommitPlanFile = { path: 'mine.txt', status: 'modified', kind: 'text', owner: 'mine', session: true, hunks: [hunk('c', 'mine', 1)] }
const deleted: CommitPlanFile = { path: 'gone.txt', status: 'deleted', kind: 'deleted', owner: 'mine', session: true }
const unknownBin: CommitPlanFile = { path: 'img.png', status: 'added', kind: 'binary', owner: 'unknown', session: true }
const others: CommitPlanFile = { path: 'other.txt', status: 'modified', kind: 'unread', owner: 'other', session: false }

describe('defaultSelection', () => {
  it('checks this session\'s hunks and whole files only', () => {
    const r = repo([mixed, mineOnly, deleted, unknownBin, others])
    const sel = defaultSelection(r)
    expect(fileCheckState(mixed, sel)).toBe('some')
    expect(fileCheckState(mineOnly, sel)).toBe('all')
    expect(fileCheckState(deleted, sel)).toBe('all')
    expect(fileCheckState(unknownBin, sel)).toBe('none')
    expect(fileCheckState(others, sel)).toBe('none')
    expect(buildSelections(r, sel)).toEqual([
      { path: 'shared.txt', mode: 'hunks', hunks: [mixed.hunks![0]] },
      { path: 'mine.txt', mode: 'hunks', hunks: [mineOnly.hunks![0]] },
      { path: 'gone.txt', mode: 'whole' },
    ])
    expect(selectedCount(r, sel)).toEqual({ files: 3, hunks: 2 })
  })
})

describe('toggling', () => {
  it('a partly checked file becomes fully checked, then empty; hunks toggle one by one', () => {
    const r = repo([mixed, others])
    let sel = defaultSelection(r)
    sel = toggleFile(mixed, sel)
    expect(fileCheckState(mixed, sel)).toBe('all')
    sel = toggleFile(mixed, sel)
    expect(fileCheckState(mixed, sel)).toBe('none')
    sel = toggleHunk(mixed, 'b', sel)
    expect(buildSelections(r, sel)).toEqual([{ path: 'shared.txt', mode: 'hunks', hunks: [mixed.hunks![1]] }])
    sel = toggleHunk(mixed, 'b', sel)
    expect(buildSelections(r, sel)).toEqual([])
    sel = toggleFile(others, sel)
    expect(buildSelections(r, sel)).toEqual([{ path: 'other.txt', mode: 'whole' }])
  })
})

describe('selectedDiffText', () => {
  it('carries only the chosen hunks, and names whole files', () => {
    const r = repo([mixed, deleted])
    const { diff, files } = selectedDiffText(r, defaultSelection(r))
    expect(files).toEqual(['shared.txt', 'gone.txt'])
    expect(diff).toContain('+line 5 (a)')
    expect(diff).not.toContain('(b)')
    expect(diff).toContain('--- gone.txt (deleted, deleted)')
    expect(selectedDiffText(r, defaultSelection(r), 10).diff).toHaveLength(10)
  })
})
