/**
 * A first visit folds the task panel's regions only when the board holds work
 * (web/src/components/tasks/first-visit-folds.ts). 2026-11-08: on a fresh install,
 * Start Task filed the first task under a folded Pinned and the panel showed nothing.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { firstVisitFoldAll, firstVisitFolds } from '../../web/src/components/tasks/first-visit-folds'

describe('first visit folds', () => {
  it('a board with work folds every region, custom tiers included', () => {
    expect([...firstVisitFolds(3, ['ct_a'])].sort()).toEqual(['ct_a', 'focus', 'pinned', 'recent', 'satellite', 'tasks'])
  })

  it('an empty board folds nothing, so the first task made is on screen', () => {
    // Parked, which an empty board once kept folded, is retired: its tasks draw in Satellite.
    const folds = firstVisitFolds(0, ['ct_a'])
    expect([...folds]).toEqual([])
    for (const region of ['pinned', 'focus', 'satellite', 'tasks', 'recent', 'ct_a']) expect(folds.has(region)).toBe(false)
  })

  it('the fold while the first load is on its way is the full one (no flash open on a board with work)', () => {
    expect(firstVisitFoldAll([])).toEqual(firstVisitFolds(1, []))
  })
})

describe('guard: the task panel decides a first visit through first-visit-folds.ts only', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../web/src/components/tasks/TodoPanel.tsx'), 'utf8')
  it('decides after the first load and stores the choice', () => {
    expect(src).toMatch(/firstVisitFolds\(tasks\.length,/)
    expect(src).toMatch(/if \(loading \|\| !customTiersLoaded \|\| firstVisitDecided\.current\) return;/)
  })
  it('names no first-visit fold list of its own', () => {
    expect(src).not.toMatch(/new Set\(\['pinned', 'focus'/)
  })
})
