/**
 * Dictated words reach the clipboard only through a write asked for INSIDE the
 * click (2026-11-09: the dictate-to-clipboard button). The words arrive seconds
 * after the stop press, when Safari and the Mac app's WKWebView no longer allow
 * a clipboard write, so the click must hand copyTextDeferred the promise of the
 * words before anything is awaited.
 *
 * The class: every web file that runs a dictation (imports useSpeechToText) and
 * touches the clipboard. A new one that writes the clipboard any other way, or
 * awaits before asking, fails here.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const WEB = path.join(__dirname, '../../web/src')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

const dictationFiles = walk(WEB).filter((f) => {
  const src = fs.readFileSync(f, 'utf8')
  return /from '@\/hooks\/useSpeechToText'/.test(src)
})

/** The body of `const <name> = (...) => { ... }`, by brace matching. */
function arrowBody(src: string, name: string): string {
  const start = src.search(new RegExp(`const ${name} = \\([^)]*\\) => \\{`))
  expect(start, `${name} handler`).toBeGreaterThanOrEqual(0)
  let i = src.indexOf('{', start)
  let depth = 0
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1)
  }
  throw new Error(`unbalanced ${name}`)
}

describe('dictated words reach the clipboard through a write asked for in the click', () => {
  it('finds the dictation files, the clipboard mic among them', () => {
    expect(dictationFiles.map((f) => path.basename(f))).toContain('ClipboardMicButton.tsx')
  })

  for (const file of dictationFiles) {
    const src = fs.readFileSync(file, 'utf8')
    const rel = path.relative(WEB, file)
    const copiesWords = /copyTextDeferred|copyTextRobust|clipboard\.write/.test(src)
    if (!copiesWords) continue
    it(`${rel}: only copyTextDeferred, never a direct clipboard write`, () => {
      // MicButton's "Copy audio path" copies a path, not dictated words.
      const writes = src.match(/navigator\.clipboard\.write(Text)?\(([^)]*)\)/g) ?? []
      for (const w of writes) expect(w, `${rel}: ${w}`).toMatch(/lastDebugPath/)
      if (rel.endsWith('ClipboardMicButton.tsx')) expect(src).toMatch(/copyTextDeferred\(/)
    })
  }

  it('the clipboard mic asks for the write in the stop click before anything is awaited', () => {
    const src = fs.readFileSync(path.join(WEB, 'components/common/ClipboardMicButton.tsx'), 'utf8')
    const stop = arrowBody(src, 'stop')
    const ask = stop.indexOf('copyTextDeferred(')
    expect(ask).toBeGreaterThan(0)
    expect(stop.slice(0, ask)).not.toMatch(/\bawait\b/)
    // The handler is a plain function, never async: the click calls stop() directly.
    expect(src).not.toMatch(/const stop = async/)
    expect(arrowBody(src, 'handleClick')).toMatch(/if \(isRecording\) \{ stop\(\); return; \}/)
  })

  it('the clipboard mic never wears the composer mic\'s classes, which pages and tests look for', () => {
    const src = fs.readFileSync(path.join(WEB, 'components/common/ClipboardMicButton.tsx'), 'utf8')
    expect(src).not.toMatch(/className="[^"]*\bmic-btn(-wrapper)?\b/)
    expect(src).not.toMatch(/'btn mic-btn\b/)
    expect(src).not.toMatch(/mic-error-bubble/)
  })
})
