/**
 * Dictating straight to the clipboard lives on the phone (the iOS Action Button),
 * never in the web or Mac composer.
 *
 * 2026-11-10: a "Dictate to clipboard" button shipped beside the composer's mic and
 * the person asked for it on the iPhone's Action Button only, not on the Mac. The
 * composer keeps one mic, whose words go into the box. This fails when a
 * clipboard dictation control or its style comes back into web/src.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(__dirname, '../../web/src')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return files(p)
    return /\.(tsx?|css)$/.test(name) ? [p] : []
  })
}

describe('no dictation to the clipboard in the web composer', () => {
  it('no control or style of one is left', () => {
    const left = files(ROOT)
      .filter((f) => /Dictate to clipboard|ClipboardMic|clipboard-mic|dictate-clipboard/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(ROOT, f))
    expect(left).toEqual([])
  })
})
