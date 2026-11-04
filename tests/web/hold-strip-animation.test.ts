/**
 * Holding the session strip's animation removes what auto-animate was fading out
 * (web/src/pages/hold-strip-animation.ts): a disable() cancels the fade, and the element it
 * re-inserted for the fade would otherwise stay over the strip for good.
 */
import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { FADING_OUT_MARK, holdStripAnimation } from '../../web/src/pages/hold-strip-animation'

const root = path.resolve(import.meta.dirname, '../..')

describe('holdStripAnimation', () => {
  it('turns the animation off, removes the columns still fading out, and turns it back on', () => {
    const removed: string[] = []
    const child = (name: string, fading: boolean) => {
      const el = { remove: () => { removed.push(name) } }
      if (fading) Object.defineProperty(el, FADING_OUT_MARK, { value: true })
      return el
    }
    const strip = { children: [child('kept', false), child('fading', true)] } as unknown as HTMLElement
    const frames: (() => void)[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { frames.push(cb); return frames.length })
    try {
      const calls: boolean[] = []
      holdStripAnimation((on) => calls.push(on), strip)
      expect(calls).toEqual([false])
      expect(removed).toEqual(['fading'])
      frames.shift()!()
      expect(calls).toEqual([false])
      frames.shift()!()
      expect(calls).toEqual([false, true])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reads the mark the installed auto-animate puts on an element it fades out', () => {
    const lib = fs.readFileSync(path.join(root, 'web/node_modules/@formkit/auto-animate/index.mjs'), 'utf8')
    expect(lib).toContain(`const DEL = "${FADING_OUT_MARK}"`)
  })

  it('nothing else in web/src turns an auto-animate parent off', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) { walk(file); continue }
        if (!/\.tsx?$/.test(entry.name) || file.endsWith('hold-strip-animation.ts')) continue
        const text = fs.readFileSync(file, 'utf8')
        // useAutoAnimate's setter, or a controller's disable(), called with "off".
        if (/(Animate|setEnabled)\(false\)|\.disable\(\)/.test(text) && /auto-animate/.test(text)) offenders.push(path.relative(root, file))
      }
    }
    walk(path.join(root, 'web/src'))
    expect(offenders).toEqual([])
  })
})
