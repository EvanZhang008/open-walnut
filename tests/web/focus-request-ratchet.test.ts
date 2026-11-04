/**
 * A component asks for the caret through useFocusRequest (web/src/utils/focus-when-shown.ts),
 * never with focusWhenShown in an effect of its own: React runs an effect again when it
 * reconnects a subtree (StrictMode, a Suspense boundary showing its content again), and a bare
 * one took the caret back to a box the person had left (a click on a task row put the caret
 * back in another column's composer).
 *
 * focusWhenShown is called only by the hook and by code that runs on a key press.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const ALLOWED = new Set([
  'web/src/utils/focus-when-shown.ts',
  // A key press's own jump (focusColumnComposer), not an effect.
  'web/src/pages/useHomeKeyboard.ts',
])

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) return files(file)
    return /\.tsx?$/.test(entry.name) ? [file] : []
  })
}

describe('caret requests', () => {
  it('only the hook (and a key press) calls focusWhenShown', () => {
    const offenders = files(path.join(root, 'web/src'))
      .map((file) => path.relative(root, file))
      .filter((rel) => !ALLOWED.has(rel) && /\bfocusWhenShown\(/.test(fs.readFileSync(path.join(root, rel), 'utf8')))
    expect(offenders).toEqual([])
  })

  it('the hook keeps each request to one focus', () => {
    const text = fs.readFileSync(path.join(root, 'web/src/utils/focus-when-shown.ts'), 'utf8')
    expect(text).toMatch(/export function useFocusRequest/)
    expect(text).toMatch(/Object\.is\(done\.current, request\)/)
  })
})
