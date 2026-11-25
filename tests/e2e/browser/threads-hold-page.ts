/**
 * The page side of the Threads hold matrix (threads-hold-matrix.spec.ts): which card he reads and
 * where the pointer rests, the card's top as each frame paints it, the list's scroll position, and
 * the page's own socket. Everything here runs in the page or drives it; nothing writes a thread.
 */
import type { Page } from '@playwright/test'

export type Pos = 'top' | 'little' | 'middle' | 'end'
/** The pointer on a card, on a fold's head below every card (`head`), between two cards (`gap`); typing; away. */
export type Presence = 'pointer' | 'head' | 'gap' | 'typing' | 'away'

/**
 * Page side: the card he reads, the card right above it (not a Watching copy), and for the pointer
 * off the cards (`head`, `gap`) the point it rests on.
 */
export function pickReading(page: Page, a: { box: string; presence: Presence; group: string | null; scope: string | null }) {
  return page.evaluate((a) => {
    const box = document.querySelector<HTMLElement>(a.box)!
    const br = box.getBoundingClientRect()
    const cards = [...box.querySelectorAll<HTMLElement>('[data-testid="org-thread"]:not([data-copy])')]
    const groupOf = (el: Element) => el.closest<HTMLElement>('[data-testid="org-thread-group"]')?.dataset.group ?? null
    let pick = -1
    let at: { x: number; y: number } | null = null
    const shown = (el: Element) => el.getClientRects().length > 0
    const inView = (r: DOMRect) => r.top >= br.top + 2 && r.bottom <= br.bottom - 2
    // Every card the list draws (Watching's copies too): the pointer is off them all.
    const anyCard = [...box.querySelectorAll<HTMLElement>('[data-testid="org-thread"]')].filter(shown)
    const root = box.querySelector('.org-threads')
    const onList = (x: number, y: number) => { const hit = document.elementFromPoint(x, y); return hit && root?.contains(hit) && !hit.closest('[data-testid="org-thread"]') ? hit : null }
    if (a.presence === 'head') {
      // A fold's head (a group's, Closed's) under every card, the card right above it in view: it holds that card.
      for (const h of box.querySelectorAll<HTMLElement>('[data-testid="org-thread-group-head"], .org-threads-closed-toggle')) {
        const hr = h.getBoundingClientRect()
        if (!shown(h) || !inView(hr) || anyCard.some((c) => c.getBoundingClientRect().top >= hr.bottom - 0.5)) continue
        const p = { x: hr.left + 20, y: (hr.top + hr.bottom) / 2 }
        if (!onList(p.x, p.y)) continue
        const i = cards.map((c, k) => (shown(c) && c.getBoundingClientRect().bottom <= hr.top + 0.5 ? k : -1)).reduce((m, k) => Math.max(m, k), -1)
        if (i < 1 || !inView(cards[i].getBoundingClientRect())) continue
        pick = i
        at = p
        break
      }
    } else if (a.presence === 'gap') {
      // A point off every card in the upper part of the view (a group's head first, else a gap), the card right below it the one he reads.
      const want = br.top + br.height * 0.4
      const x = (cards.find(shown)?.getBoundingClientRect().left ?? br.left) + 12
      let best = Infinity
      for (const heads of [true, false]) {
        for (let y = Math.ceil(br.top + 30); y < br.bottom - 80; y += 2) {
          const hit = onList(x, y)
          if (!hit || (heads && !hit.closest('[data-testid="org-thread-group-head"]'))) continue
          const below = anyCard.find((c) => c.getBoundingClientRect().bottom > y)
          const i = below ? cards.indexOf(below) : -1
          if (i < 1 || below!.getBoundingClientRect().top > br.bottom - 80) continue
          const d = Math.abs(y - want) + (heads ? 0 : 1000)
          if (d < best) { best = d; pick = i; at = { x, y } }
        }
        if (pick >= 0) break
      }
    } else if (a.presence === 'away') {
      // Away: the card at the top of the view, the one the list holds.
      pick = cards.findIndex((el) => el.getBoundingClientRect().bottom > br.top + 0.5)
    } else {
      // At the list: a card in the upper half of the view with a card above it (its group's when
      // one asked; any other when none of that group is there), the box he types in in view.
      const want = br.top + br.height * 0.4
      const fits = (el: HTMLElement, i: number) => {
        if (i < 1) return false
        const r = el.getBoundingClientRect()
        const input = el.querySelector('[data-testid="org-thread-follow-input"]')?.getBoundingClientRect()
        if (r.top < br.top + 2 || r.top > br.bottom - 80) return false
        return a.presence !== 'typing' || (!!input && input.top >= br.top && input.bottom <= br.bottom)
      }
      for (const only of a.group ? [a.group, null] : [null]) {
        let best = Infinity
        cards.forEach((el, i) => {
          if (only && groupOf(el) !== only) return
          if (!fits(el, i)) return
          const d = Math.abs(el.getBoundingClientRect().top - want)
          if (d < best) { best = d; pick = i }
        })
        if (pick >= 0) break
      }
    }
    if (pick < 0) return null
    const above = pick > 0 ? cards[pick - 1] : null
    // The place he reads should his card go: the card drawn right before it, else right after it (copies too).
    const all = [...box.querySelectorAll<HTMLElement>('[data-testid="org-thread"]')]
    const k = all.indexOf(cards[pick])
    const stand = [all[k - 1], all[k + 1]].find((el) => el && shown(el))
    return {
      id: cards[pick].dataset.threadId!, group: groupOf(cards[pick]), above: above?.dataset.threadId ?? null, aboveGroup: above ? groupOf(above) : null, at,
      stand: stand ? { id: stand.dataset.threadId!, copy: stand.dataset.copy ?? null } : null,
    }
  }, a)
}

/**
 * The card's top as each frame paints it: read in the frame's rAF, then read again in a
 * ResizeObserver made after the page's own (callbacks run in the order they were made, after
 * layout and before paint), so a frame whose size change the page puts right in its observer
 * counts as what it painted.
 */
export const startSampling = (page: Page, box: string, cardSel: string) => page.evaluate(({ box, s }) => {
  const w = window as Window & { holdSampler?: { on: boolean; ys: number[]; ro: ResizeObserver } }
  const read = () => { const el = document.querySelector(s); return el ? el.getBoundingClientRect().top : NaN }
  const ro = new ResizeObserver(() => { if (st.on && st.ys.length) st.ys[st.ys.length - 1] = read() })
  const st = w.holdSampler = { on: true, ys: [] as number[], ro }
  for (const c of Array.from(document.querySelector(box)?.children ?? [])) ro.observe(c)
  const tick = () => requestAnimationFrame(() => { if (!st.on) return; st.ys.push(read()); tick() })
  tick()
}, { box, s: cardSel })
export const stopSampling = (page: Page) => page.evaluate(() => {
  const w = window as Window & { holdSampler?: { on: boolean; ys: number[]; ro: ResizeObserver } }
  w.holdSampler!.on = false
  w.holdSampler!.ro.disconnect()
  return w.holdSampler!.ys
})

/** The list drawn as it stands: the box's height the same over a few frames (the last write has landed). */
export async function settled(page: Page, box: string): Promise<void> {
  const height = () => page.evaluate((b) => document.querySelector<HTMLElement>(b)!.scrollHeight, box)
  let was = await height()
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(250)
    const now = await height()
    if (now === was) return
    was = now
  }
}

export async function setPosition(page: Page, box: string, pos: Pos): Promise<void> {
  await page.evaluate(({ box, pos }) => {
    const el = document.querySelector<HTMLElement>(box)!
    el.scrollTop = pos === 'top' ? 0 : pos === 'little' ? 60 : pos === 'end' ? el.scrollHeight : Math.round((el.scrollHeight - el.clientHeight) / 2)
  }, { box, pos })
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
}

export const typingState = (page: Page, inputSel: string) => page.evaluate((s) => {
  const el = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(s)
  const a = document.activeElement
  return { focus: !!el && (a === el || el.contains(a)), caret: (a as HTMLTextAreaElement | null)?.selectionStart ?? null }
}, inputSel)

/** The page's own socket, so a reconnect can be told to it (file-live-edit.spec.ts does the same). */
export async function keepSocket(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const Native = window.WebSocket
    class Kept extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        if (new URL(String(url), location.href).pathname === '/ws') (window as Window & { holdTestSocket?: WebSocket }).holdTestSocket = this
      }
    }
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'] as const) Object.defineProperty(Kept, k, { value: Native[k] })
    window.WebSocket = Kept
  })
}
