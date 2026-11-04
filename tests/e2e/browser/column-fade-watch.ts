/**
 * A completed column fades where it stands for a moment (MainPage `fadingColumns`, the
 * `is-closing` class, about 160 ms), too short for a polling assertion to be sure to see.
 * This records it in the page instead: each column that took the class, and how far every
 * other column's width moved while it had it (sampled every frame).
 */
import type { Page } from '@playwright/test'

export interface ColumnFade {
  id: string
  /** Per other column: the largest minus the smallest width seen during the fade. */
  drift: Record<string, number>
}

export async function watchColumnFades(page: Page): Promise<() => Promise<ColumnFade[]>> {
  await page.evaluate(() => {
    const w = window as unknown as { __columnFades?: ColumnFade[]; __columnFadeObserver?: MutationObserver }
    w.__columnFadeObserver?.disconnect()
    const fades: ColumnFade[] = []
    w.__columnFades = fades
    const COLUMN = '.main-page-session-column'
    const watch = (el: HTMLElement) => {
      const fade: ColumnFade = { id: el.getAttribute('data-column-id') ?? '', drift: {} }
      fades.push(fade)
      const seen: Record<string, [number, number]> = {}
      const sample = () => {
        // Only frames where it is still there and fading: the frame it left in is the strip's.
        if (!el.isConnected || !el.classList.contains('is-closing')) return
        for (const other of document.querySelectorAll<HTMLElement>(COLUMN)) {
          const id = other.getAttribute('data-column-id') ?? ''
          if (other === el || !id) continue
          const width = other.getBoundingClientRect().width
          const [lo, hi] = seen[id] ?? [width, width]
          seen[id] = [Math.min(lo, width), Math.max(hi, width)]
          fade.drift[id] = seen[id][1] - seen[id][0]
        }
        requestAnimationFrame(sample)
      }
      sample()
    }
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        const el = r.target as HTMLElement
        if (r.type === 'attributes' && el.matches?.(COLUMN) && el.classList.contains('is-closing')
          && !(r.oldValue ?? '').split(/\s+/).includes('is-closing')) watch(el)
      }
    })
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true })
    w.__columnFadeObserver = observer
  })
  return () => page.evaluate(() => (window as unknown as { __columnFades?: ColumnFade[] }).__columnFades ?? [])
}
