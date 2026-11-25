/**
 * The app's motion (web/src/styles/motion.css): one set of durations and curves, and one way each
 * kind of thing moves.
 *
 * 2026-11-25, the user: "the transition, I want it very smooth ... learn from Apple". Before, 67
 * overlays each opened their own way (eight enter keyframes, 100 to 160 ms, three curves) or not
 * at all, and none of them closed with any motion. The guards below hold the class:
 *  - every member of the overlay family opens through overlay-family.css; a member that brings an
 *    enter animation of its own is a new member of the old mess and fails here;
 *  - the family's own motion takes its timing from motion.css's tokens;
 *  - the decisions (how much moves, the capsule's way, which removed node is an overlay) are pure.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parseHTML } from 'linkedom'
import { walk, scanCss } from './css-scan'
import { members, WEB_SRC } from './overlay-family-scan'
import { decideMotion, EASE, MOTION_MS } from '../../web/src/utils/motion'
import { slideFrames } from '../../web/src/utils/selection-slide'

const read = (rel: string) => fs.readFileSync(path.join(WEB_SRC, rel), 'utf8')

describe('decideMotion', () => {
  it('is full by default, reduced under Reduce Motion, off under automation', () => {
    expect(decideMotion({ reduceMotion: false, automated: false, override: null })).toBe('full')
    expect(decideMotion({ reduceMotion: true, automated: false, override: null })).toBe('reduced')
    expect(decideMotion({ reduceMotion: false, automated: true, override: null })).toBe('off')
    expect(decideMotion({ reduceMotion: true, automated: true, override: null })).toBe('off')
  })

  it('takes a known override first and ignores any other value', () => {
    expect(decideMotion({ reduceMotion: true, automated: true, override: 'full' })).toBe('full')
    expect(decideMotion({ reduceMotion: false, automated: false, override: 'off' })).toBe('off')
    expect(decideMotion({ reduceMotion: false, automated: false, override: 'reduced' })).toBe('reduced')
    expect(decideMotion({ reduceMotion: false, automated: true, override: 'yes' })).toBe('off')
  })
})

describe('slideFrames', () => {
  const box = (left: number, width: number, top = 0) => ({ left, top, width, height: 26 })

  it('moves by transform from the old item to the new one, sizing to the new one', () => {
    expect(slideFrames(box(10, 60), box(120, 90))).toEqual([
      { transform: 'translate(-110px, 0px)', width: '60px', height: '26px' },
      { transform: 'translate(0px, 0px)', width: '90px', height: '26px' },
    ])
  })

  it('moves down a vertical list too', () => {
    expect(slideFrames(box(0, 200, 0), box(0, 200, 64))?.[0].transform).toBe('translate(0px, -64px)')
  })

  it('does not move when nothing moved or an item has no box', () => {
    expect(slideFrames(box(10, 60), box(10, 60))).toBeNull()
    expect(slideFrames(box(10, 0), box(80, 60))).toBeNull()
    expect(slideFrames(box(10, 60), box(80, 0))).toBeNull()
  })
})

describe('overlay-exit copies', () => {
  it('finds the overlay a removed node is, and copies it inert, hidden and without ids', async () => {
    const { document, window } = parseHTML('<html><body></body></html>')
    const g = globalThis as Record<string, unknown>
    const saved = { HTMLElement: g.HTMLElement }
    g.HTMLElement = window.HTMLElement
    try {
      const { overlayRoot, copyForExit } = await import('../../web/src/utils/overlay-exit')
      const wrap = document.createElement('div')
      wrap.innerHTML = '<div class="wn-scrim"><div class="wn-dialog" id="d"><button id="b">OK</button></div></div>'
      const menu = document.createElement('div')
      menu.className = 'x-menu wn-overlay wn-menu'
      const plain = document.createElement('div')
      plain.innerHTML = '<p>text</p>'
      expect(overlayRoot(menu)).toBe(menu)
      expect(overlayRoot(wrap)).toBe(wrap)
      expect(overlayRoot(plain)).toBeNull()
      expect(overlayRoot(document.createTextNode('t'))).toBeNull()

      const copy = copyForExit(wrap)!
      expect(copy.getAttribute('aria-hidden')).toBe('true')
      expect(copy.hasAttribute('data-overlay-exit')).toBe(true)
      expect(copy.querySelectorAll('[id]').length).toBe(0)
      expect(copy.style.pointerEvents).toBe('none')
      expect((copy.querySelector('.wn-dialog') as HTMLElement).style.transition).toBe('none')

      // Nothing reading the page takes the copy for an open menu or dialog, and a copied radio joins no group.
      const menuish = document.createElement('div')
      menuish.className = 'wn-overlay wn-menu'
      menuish.setAttribute('role', 'menu')
      menuish.innerHTML = '<div role="dialog" aria-modal="true"><input type="radio" name="g" checked></div>'
      const menuCopy = copyForExit(menuish)!
      expect(menuCopy.querySelectorAll('[role], [aria-modal], [name]').length).toBe(0)
      expect(menuCopy.hasAttribute('role')).toBe(false)

      const framed = document.createElement('div')
      framed.className = 'wn-overlay'
      framed.innerHTML = '<iframe src="about:blank"></iframe>'
      expect(copyForExit(framed)).toBeNull()
      const hidden = document.createElement('div')
      hidden.className = 'wn-overlay'
      hidden.style.display = 'none'
      expect(copyForExit(hidden)).toBeNull()
    } finally {
      g.HTMLElement = saved.HTMLElement
    }
  })
})

describe('the overlay family opens one way', () => {
  const css = walk(WEB_SRC, ['.css']).flatMap((file) => scanCss(file, fs.readFileSync(file, 'utf8')))

  it('no member of the family brings an enter animation of its own', () => {
    const own = members()
    const found = css
      .filter((d) => /^animation(?:-name)?$/.test(d.prop) && !/^none\b/.test(d.value))
      .filter((d) => d.selectors.some((sel) => {
        const last = sel.trim().split(/\s*[>+~]\s*|\s+/).filter(Boolean).pop() ?? ''
        if (/::/.test(last)) return false
        const classes = [...last.replace(/:[\w-]+(\((?:[^()]|\([^()]*\))*\))?/g, '').matchAll(/\.([\w-]+)/g)].map((m) => m[1])
        return classes.some((c) => own.has(c))
      }))
      .map((d) => `${path.relative(WEB_SRC, d.file)}:${d.line} ${d.selectors.join(', ')} { ${d.prop}: ${d.value} }`)
    expect(found, 'An overlay opens and closes through the family (overlay-family.css, utils/overlay-exit.ts): drop its own enter animation.').toEqual([])
  })

  it('the family\'s motion takes its timing from motion.css', () => {
    const family = read('styles/overlay-family.css').replace(/\/\*[\s\S]*?\*\//g, '')
    const transitions = [...family.matchAll(/transition:\s*([^;]+);/g)].map((m) => m[1].trim()).filter((v) => v !== 'none')
    expect(transitions.length).toBeGreaterThanOrEqual(4)
    for (const value of transitions) {
      for (const item of value.split(',')) {
        expect(item, `"${item.trim()}" names its own timing: use the --motion-* and --ease-* tokens`).toMatch(/var\(--motion-[a-z]+\)\s+var\(--ease-[a-z-]+\)/)
      }
    }
    const tokens = read('styles/motion.css')
    for (const token of ['--motion-fast', '--motion-base', '--motion-slow', '--ease-out', '--ease-in', '--ease-in-out', '--ease-spring']) {
      expect(tokens, token).toContain(`${token}:`)
    }
  })

  it('script runs on the same timings as motion.css', () => {
    const tokens = read('styles/motion.css')
    const value = (name: string) => tokens.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim()
    expect(value('--motion-fast')).toBe(`${MOTION_MS.fast}ms`)
    expect(value('--motion-base')).toBe(`${MOTION_MS.base}ms`)
    expect(value('--motion-slow')).toBe(`${MOTION_MS.slow}ms`)
    expect(value('--ease-out')).toBe(EASE.out)
    expect(value('--ease-in')).toBe(EASE.in)
    expect(value('--ease-in-out')).toBe(EASE.inOut)
    // The script that moves things takes them from there, never a literal of its own.
    for (const file of ['utils/overlay-exit.ts', 'utils/selection-slide.ts', 'utils/reveal.ts']) {
      const src = read(file)
      expect(src, file).not.toMatch(/cubic-bezier\(/)
      expect(src, file).toMatch(/MOTION_MS\./)
    }
  })
})
