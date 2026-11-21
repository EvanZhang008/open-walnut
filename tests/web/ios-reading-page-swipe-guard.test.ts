/**
 * No phone page moves sideways under a drag on its content (2026-11-15: the user asked why the
 * Org page's Threads moved left and right when it should only scroll up and down; 2026-11-20 he
 * asked to find every such page). iOS 26 pops a pushed page on a rightward drag anywhere on its
 * content, so a slightly diagonal drag while reading slid the whole page right with its words cut
 * at the edge. The first fix opted pages in one by one and missed every page nobody named (a note,
 * a notes folder, Settings pages, a session opened from a letter).
 *
 * Now `.noContentSwipeBack()` (ios-native/Walnut/Views/Shared/ReadingPageSwipe.swift) puts one
 * pan on each window that every navigation stack's content pop in it waits for. This keeps the
 * class closed: the app's root and every window the app makes install it, nothing turns a content
 * pop back on, and the hold still makes the content pop wait.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
const APP = path.join(ROOT, 'ios-native/Walnut')

function swiftFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return swiftFiles(p)
    return e.name.endsWith('.swift') ? [p] : []
  })
}

/** Source with its line and block comments blanked, so a comment naming a call counts for nothing. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

const read = (rel: string) => code(fs.readFileSync(path.join(APP, rel), 'utf8'))
const all = swiftFiles(APP).map((f) => path.relative(APP, f)).sort()

describe('iOS: a sideways drag on a page is never Back', () => {
  it('the app root installs the hold on its window', () => {
    expect(read('App/WalnutApp.swift')).toMatch(/WindowGroup\s*\{\s*RootView\(\)\s*\.noContentSwipeBack\(\)/)
  })

  it('every window the app makes installs it too', () => {
    const missing = all.filter((f) => /\bUIWindow\s*\(/.test(read(f)) && !/\.noContentSwipeBack\(\)/.test(read(f)))
    expect(missing, 'a file making its own UIWindow must apply .noContentSwipeBack() to the view it hosts').toEqual([])
  })

  it('nothing turns a content pop back on', () => {
    const offenders = all.filter((f) => /interactiveContentPopGestureRecognizer[\s\S]{0,80}isEnabled\s*=\s*true/.test(read(f)))
    expect(offenders).toEqual([])
  })

  it('the hold makes every content pop wait for its pan', () => {
    const src = read('Views/Shared/ReadingPageSwipe.swift')
    expect(src).toMatch(/func noContentSwipeBack\(\) -> some View/)
    expect(src).toMatch(/window\.addGestureRecognizer\(pan\)/)
    expect(src).toMatch(/shouldBeRequiredToFailBy other/)
    expect(src).toMatch(/interactiveContentPopGestureRecognizer === other/)
    expect(src).toMatch(/pop\.require\(toFail: gestureRecognizer\)/)
  })
})
