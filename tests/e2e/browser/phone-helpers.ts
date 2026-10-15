/**
 * Shared checks for the phone specs (spec section 7).
 *
 * - findSmallTargets: every visible control a finger can hit must offer a
 *   44 x 44 hit area. The element's own box counts, and so does a `::before`
 *   that extends it: four probes 22 px from the center must land on the
 *   element (elementFromPoint). Inline links in message and note text are
 *   exempt, as is anything aria-hidden.
 * - findSmallText: every visible text node renders at 12 px or more.
 * - injectSafeArea / setKeyboardInset: Playwright draws no notch and no
 *   keyboard, so the specs write the CSS variables the phone rules read.
 */
import { devices, expect, type Page } from '@playwright/test'

export const PHONE = devices['iPhone 15']
export const PHONE_LANDSCAPE = devices['iPhone 15 landscape']

export interface SmallTarget { tag: string; label: string; width: number; height: number; x: number; y: number }

export const TARGET_SELECTOR = 'button, a[href], [role=button], input, select, textarea, [role=menuitem], [role=tab]'
// Message text renders under .markdown-body: its inline links are exempt too.
const EXEMPT_SELECTOR = '.markdown a, .markdown-body a, .note-body a'

export async function findSmallTargets(page: Page, root = 'body'): Promise<SmallTarget[]> {
  return page.evaluate(({ sel, exempt, rootSel }) => {
    const out: SmallTarget[] = []
    const scope = document.querySelector(rootSel) ?? document.body
    const vw = window.innerWidth
    const vh = window.innerHeight
    for (const el of Array.from(scope.querySelectorAll<HTMLElement>(sel))) {
      if (el.closest('[aria-hidden="true"], [inert]') || el.closest(exempt)) continue
      if (el instanceof HTMLInputElement && el.type === 'hidden') continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0 || cs.pointerEvents === 'none') continue
      if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      // Covered by another layer at its center: not reachable, so not a target now.
      const atCenter = document.elementFromPoint(Math.min(vw - 1, Math.max(0, cx)), Math.min(vh - 1, Math.max(0, cy)))
      const wrapAt = el instanceof HTMLInputElement ? el.closest('label') : null
      if (!atCenter || !(el === atCenter || el.contains(atCenter) || atCenter.contains(el) || (!!wrapAt && wrapAt.contains(atCenter)))) continue
      if (r.width >= 43.5 && r.height >= 43.5) continue
      const hits = (x: number, y: number) => {
        if (x < 0 || y < 0 || x >= vw || y >= vh) return true // off screen: not a defect of the box
        const t = document.elementFromPoint(x, y)
        // A tap anywhere in the label that wraps an input activates it.
        const wrap = el instanceof HTMLInputElement ? el.closest('label') : null
        return !!t && (t === el || el.contains(t) || (!!wrap && wrap.contains(t)))
      }
      const w = Math.max(r.width, 44) / 2 - 0.5
      const h = Math.max(r.height, 44) / 2 - 0.5
      if (hits(cx - w, cy) && hits(cx + w, cy) && hits(cx, cy - h) && hits(cx, cy + h)) continue
      const label = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').trim().slice(0, 40)
      out.push({ tag: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? `.${el.className.split(' ')[0]}` : ''), label, width: Math.round(r.width), height: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) })
    }
    return out
  }, { sel: TARGET_SELECTOR, exempt: EXEMPT_SELECTOR, rootSel: root })
}

export interface SmallText { text: string; size: number; tag: string }

export async function findSmallText(page: Page, min = 12, root = 'body'): Promise<SmallText[]> {
  return page.evaluate(({ minPx, rootSel }) => {
    const out: SmallText[] = []
    const walker = document.createTreeWalker(document.querySelector(rootSel) ?? document.body, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = (n.textContent ?? '').trim()
      if (!text) continue
      const el = n.parentElement
      if (!el || el.closest('[aria-hidden="true"], script, style, noscript, svg')) continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0 || r.bottom <= 0 || r.top >= window.innerHeight) continue
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue
      const size = parseFloat(cs.fontSize)
      if (size < minPx - 0.01) out.push({ text: text.slice(0, 40), size, tag: el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? `.${el.className.split(' ')[0]}` : '') })
    }
    return out
  }, { minPx: min, rootSel: root })
}

export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const m = await page.evaluate(() => ({
    scroll: document.scrollingElement?.scrollWidth ?? document.documentElement.scrollWidth,
    inner: window.innerWidth,
  }))
  expect(m.scroll, `page scrollWidth ${m.scroll} > innerWidth ${m.inner}`).toBeLessThanOrEqual(m.inner)
}

export async function injectSafeArea(page: Page, inset: { top?: number; right?: number; bottom?: number; left?: number }): Promise<void> {
  await page.evaluate((s) => {
    const root = document.documentElement.style
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      if (typeof s[side] === 'number') root.setProperty(`--wn-safe-${side}`, `${s[side]}px`)
    }
  }, inset)
}

export async function setKeyboardInset(page: Page, px: number): Promise<void> {
  await page.evaluate((v) => {
    document.documentElement.style.setProperty('--wn-keyboard-inset', `${v}px`)
    document.documentElement.dataset.wnKeyboard = v > 0 ? 'open' : 'closed'
  }, px)
}

export const menuButton = (page: Page) => page.locator('.phone-topbar').getByRole('button', { name: 'Menu' })
export const backButton = (page: Page) => page.locator('.phone-topbar').getByRole('button', { name: 'Back' })

export async function openDrawer(page: Page): Promise<void> {
  await menuButton(page).click()
  await expect(page.locator('.sidebar.open')).toBeVisible()
  await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'true')
}

/**
 * Open a home row's task by tapping its title, the way a thumb does: unfold its
 * project (a fresh profile folds every project, and on a phone the whole header
 * row is the fold target), page in more rows until it shows, then tap. The home
 * search is no shortcut here: on a phone it opens a search layer of its own.
 */
export async function openHomeRow(page: Page, project: string, title: string): Promise<void> {
  const header = page.locator('.todo-panel .todo-group-project-header', {
    has: page.locator('.todo-group-project-name', { hasText: new RegExp(`^${project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }),
  }).first()
  await expect(header).toBeVisible({ timeout: 30_000 })
  await header.scrollIntoViewIfNeeded()
  if (/to expand/.test((await header.getAttribute('title')) ?? '')) await header.click({ position: { x: 48, y: 22 } })
  await expect(header).not.toHaveAttribute('title', /to expand/)
  const row = page.locator('.todo-panel .todo-item-title', { hasText: title }).first()
  for (let i = 0; i < 8 && await row.count() === 0; i++) {
    const more = page.locator('.todo-panel').getByRole('button', { name: 'Show more' }).first()
    if (await more.count() === 0) break
    await more.scrollIntoViewIfNeeded()
    await more.click()
  }
  await row.scrollIntoViewIfNeeded()
  await row.click()
}
