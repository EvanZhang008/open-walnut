/**
 * Dictating straight to the clipboard is an iPhone feature (the iOS Action Button),
 * never a control on any other surface.
 *
 * 2026-11-10: a "Dictate to clipboard" button shipped beside the composer's mic.
 * The person wants it on the iPhone's Action Button only: not in the web or Mac
 * app composer, not in the browser extension's side panel (which frames the same
 * web page), not in the Mac or Windows desktop shells. Those composers keep one
 * mic, whose words go into the box. This fails when a clipboard dictation control,
 * its style or its intent shows up in any source tree but ios-native/.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const REPO = join(__dirname, '../..')
/** Every non-iPhone surface that renders a composer or a native shell around one. */
const SURFACES = ['web/src', 'src', 'packages', 'desktop', 'desktop-windows/src', 'desktop-windows/ui', 'native', 'plugin-store']
const SKIP = new Set(['node_modules', 'dist', 'build', '.build', 'DerivedData'])
const CONTROL = /Dictate to clipboard|DictateToClipboard|ClipboardMic|clipboard-mic|dictate-clipboard|dictateToClipboard/

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return []
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return files(p)
    return /\.(tsx?|jsx?|mjs|css|html|swift|m|cs)$/.test(name) ? [p] : []
  })
}

describe('clipboard dictation is on the iPhone only', () => {
  it('no other surface carries a control, style or intent for it', () => {
    const left = SURFACES.map((s) => join(REPO, s))
      .filter((d) => existsSync(d))
      .flatMap(files)
      .filter((f) => CONTROL.test(readFileSync(f, 'utf8')))
      .map((f) => relative(REPO, f))
    expect(left).toEqual([])
  })

  it('the scan sees the surfaces it names', () => {
    // A renamed tree must not make the guard pass by scanning nothing.
    for (const s of ['web/src', 'packages/browser-extension/src', 'desktop']) {
      expect(existsSync(join(REPO, s)), s).toBe(true)
    }
  })
})
