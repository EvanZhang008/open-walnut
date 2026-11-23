/**
 * Finds the ResizeObserver callbacks that can raise "ResizeObserver loop completed with
 * undelivered notifications". The browser's error names no file and no stack (Walnut Health filed
 * 43 of them in a day as "Other in the unknown chunk", 2026-11-23), and whether it fires depends on
 * how deep the changed box sits in the page, which differs between the fixture and the user's
 * window. So this checks the cause instead of waiting for the error: it wraps every observer the
 * page makes and, around each callback, reads the size of every element any observer watches. A
 * callback after which a watched element OUTSIDE the boxes it was just told about changed size is
 * a culprit (a change inside them is delivered in the same frame, which the spec allows), named by
 * what it was told about and what it changed. Install before the first navigation.
 */
import type { Page } from '@playwright/test'

export interface ResizeLoopCulprit {
  /** Classes (or tag) of the boxes the guilty callback was told about. */
  told: string[]
  /** Classes (or tag) of the watched boxes outside them that its callback resized. */
  changed: string[]
  count: number
}

export async function installResizeLoopProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const Native = window.ResizeObserver
    if (!Native || (window as unknown as { __roProbe?: unknown }).__roProbe) return
    const watched = new Set<Element>()
    const culprits = new Map<string, { told: string[]; changed: string[]; count: number }>()
    const loops: number[] = []
    ;(window as unknown as { __roProbe: unknown }).__roProbe = { culprits, loops }
    const name = (el: Element) => {
      const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.') : ''
      const id = el.getAttribute('data-testid')
      return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}${id ? `[${id}]` : ''}`
    }
    const sizes = () => {
      const out = new Map<Element, string>()
      for (const el of watched) {
        if (!el.isConnected) { watched.delete(el); continue }
        const r = el.getBoundingClientRect()
        out.set(el, `${Math.round(r.width * 10)}x${Math.round(r.height * 10)}`)
      }
      return out
    }
    class Probe extends Native {
      constructor(cb: ResizeObserverCallback) {
        super((entries, ro) => {
          const before = sizes()
          try { cb(entries, ro) } finally {
            const after = sizes()
            const targets = entries.map((e) => e.target)
            const changed: string[] = []
            for (const [el, s] of before) {
              const now = after.get(el)
              if (now === undefined || now === s || targets.some((t) => t.contains(el))) continue
              changed.push(name(el))
            }
            if (changed.length) {
              const told = [...new Set(targets.map(name))].sort()
              const key = `${told.join(',')} -> ${[...new Set(changed)].sort().join(',')}`
              const c = culprits.get(key) ?? { told, changed: [...new Set(changed)].sort(), count: 0 }
              c.count++
              culprits.set(key, c)
            }
          }
        })
      }
      observe(el: Element, opts?: ResizeObserverOptions) { watched.add(el); super.observe(el, opts) }
    }
    window.ResizeObserver = Probe as unknown as typeof ResizeObserver
    window.addEventListener('error', (e) => { if (/ResizeObserver loop/.test(e.message)) loops.push(performance.now()) })
  })
}

/** The culprits seen since the page loaded, most frequent first, and how many loop errors it reported. */
export async function resizeLoopReport(page: Page): Promise<{ loops: number; culprits: ResizeLoopCulprit[] }> {
  return page.evaluate(() => {
    const p = (window as unknown as { __roProbe?: { culprits: Map<string, ResizeLoopCulprit>; loops: number[] } }).__roProbe
    if (!p) return { loops: 0, culprits: [] }
    return { loops: p.loops.length, culprits: [...p.culprits.values()].sort((a, b) => b.count - a.count) }
  })
}
