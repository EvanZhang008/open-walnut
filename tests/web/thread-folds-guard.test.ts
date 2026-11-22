/**
 * His Threads are folded groups, not a row of chips (2026-11-21, the user: "the default is the view
 * you need: Needs you first, then Done, and the rest auto collapsed"; "why so many tabs"). A filter
 * row whose default was All (commit 9f73d8e161) drew every group's cards at once.
 *
 * Fails when:
 *  - a new group of src/core/org/thread-groups.ts has no place: every group is either open
 *    (FOR_HIM_GROUPS: Needs you, Done) or folded (FOLDED_GROUPS), in the view's order;
 *  - the web view draws its groups in another order, brings back a filter row, or keeps an opened
 *    fold through utils/view-memory.ts (an opened fold is plain state, folded again next time);
 *  - a fold head is not the shared DisclosureButton, or a folded group's head no longer sticks to
 *    the pane's bottom (three reviews on his data: under the Done cards the folds were out of sight);
 *  - the phone keeps its folds in @AppStorage, misses a fold for a folded group, or brings back its
 *    row of jump chips over the list.
 * The browser flow is tests/e2e/browser/thread-groups-folds.spec.ts.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FOLDED_GROUPS, FOR_HIM_GROUPS, THREAD_GROUPS } from '../../src/core/org/thread-groups.js'

const root = path.resolve(import.meta.dirname, '../..')
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8')
const BY_STATE = 'web/src/components/org/OrgThreadsByState.tsx'
const THREADS = 'web/src/components/org/OrgThreads.tsx'
const IOS_VIEW = 'ios-native/Walnut/Views/Org/OrgThreadsView.swift'
const IOS_MODEL = 'ios-native/Walnut/Views/Org/OrgThreadModel.swift'
const IOS_FOCUS = 'ios-native/Walnut/Views/Org/OrgThreadFocus.swift'

describe('every Threads group has its place: open or folded', () => {
  it('each group is open (Needs you, Done) or folded, once, in the view\'s order', () => {
    expect([...FOR_HIM_GROUPS]).toEqual(['needs', 'read'])
    for (const g of THREAD_GROUPS) {
      const places = [FOR_HIM_GROUPS.includes(g), FOLDED_GROUPS.includes(g)].filter(Boolean).length
      expect(places, `${g}: open or folded, exactly one`).toBe(1)
    }
    expect([...FOR_HIM_GROUPS, ...FOLDED_GROUPS]).toEqual([...THREAD_GROUPS])
  })

  it('the web draws the open groups, then the folded ones, with no filter row', () => {
    const view = read(BY_STATE)
    expect(view).toContain('[...FOR_HIM_GROUPS, ...FOLDED_GROUPS].map(')
    // Each fold head is the shared Disclosure, and a folded group's head sticks to the pane's bottom.
    expect(view).toContain('<DisclosureButton block expanded={open}')
    expect(view).toContain("'--org-thread-fold-from-end'")
    expect(read('web/src/styles/org-threads.css')).toMatch(/\.org-thread-group\.is-folded \{[^}]*position: sticky;[^}]*bottom: calc\(var\(--org-thread-fold-from-end/)
    expect(fs.existsSync(path.join(root, 'web/src/components/org/ThreadsFilterBar.tsx'))).toBe(false)
    for (const f of [BY_STATE, THREADS]) {
      const src = read(f)
      for (const gone of ['ThreadsFilterBar', 'org-threads-chip', "'threads.filter'", 'isThreadFilter', 'ThreadFilter']) {
        expect(src, `${f}: ${gone}`).not.toContain(gone)
      }
    }
  })

  it('an opened fold is never kept: no view memory for it', () => {
    expect(read(BY_STATE)).not.toMatch(/usePageView|useView\b/)
    // The Threads' other kept choices are the toggles of the view without groups (byState off).
    const keys = [...read(THREADS).matchAll(/usePageView(?:Of)?(?:<[^>]*>)?\(\s*'org',\s*'([^']+)'/g)].map((m) => m[1])
    expect(keys.length).toBeGreaterThan(0)
    for (const k of keys) expect(k, `kept view choice ${k}`).not.toMatch(/fold|filter|group|open/i)
  })

  it('the phone folds each folded group in view state, never @AppStorage, with no jump bar', () => {
    const ios = read(IOS_VIEW)
    expect(ios).not.toMatch(/@AppStorage\([^)]*[Ff]old/)
    expect(ios).toMatch(/@State private var openFolds: Set<String> = \[\]/)
    // Its open groups, then one fold per folded group, in the server's order (Closed is `closed`
    // there, the group id `done`).
    const model = read(IOS_MODEL)
    expect(model).toMatch(/static let openGroups: \[Group\] = \[\.needs, \.read\]/)
    const foldId: Record<string, string> = { done: 'closed' }
    const folds = /enum Fold: String, CaseIterable, Equatable \{\s*case ([a-z, ]+)\n/.exec(read(IOS_FOCUS))
    expect(folds, 'OrgThreadRevealModel.Fold').not.toBeNull()
    expect(folds![1].split(/,\s*/)).toEqual(FOLDED_GROUPS.map((g) => foldId[g] ?? g))
    expect(ios).toContain('ForEach(OrgThreadModel.openGroups, id: \\.self)')
    expect(ios).toContain('ForEach(Fold.allCases, id: \\.self)')
    // No row of jump chips over the list either (the web's filter row's twin).
    for (const gone of ['org.threads.jumps', 'org.threads.jump.', 'jumpBar']) expect(ios, gone).not.toContain(gone)
  })
})
