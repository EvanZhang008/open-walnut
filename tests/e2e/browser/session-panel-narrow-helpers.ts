/**
 * Layout rules every session panel keeps in a narrow column, checked over everything it
 * shows, so a notice kind added later is held to them without being listed here
 * (session-panel-narrow.spec.ts).
 *
 *  R1 readable lines: text that wraps to 2+ lines carries at least 12 characters a line on
 *     average, a one-token text node (a host name, a path) stays on one line, and no word
 *     is broken letter by letter across lines.
 *  R2 nothing runs past the panel's left or right edge (descendants of a box that clips or
 *     scrolls horizontally are judged by that box, and invisible elements are skipped).
 *  R3 a notice (`[data-panel-notice]`) gives its words the box's width: the
 *     `.panel-notice-body` takes at least 90% of the content width, nothing sits in a
 *     column beside it, the icon starts the first line of words (never a line of its
 *     own), and every action sits under the words or on their last line;
 *     anywhere in the panel, a button in the flow is never drawn over another box's words.
 *  R4 the header's title row: the title and every pill or chip shows at least 8
 *     characters of its text, or all of it (a title squeezed to nothing included), nothing
 *     on the row is drawn over anything else, and the kebab stays visible inside the panel.
 *
 * No tests in this file (Playwright refuses a test() call from an imported module).
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { expectPeeksInPlace } from './truncation-peek-helpers'

export interface Offender {
  rule: 'R1' | 'R2' | 'R3' | 'R4'
  /** The element, as `tag[data-testid].class1.class2`. */
  where: string
  /** Its text, cut to a snippet. */
  text: string
  detail: string
}

/** Every rule over every visible element of `panel`, read in one frame. */
export async function auditPanel(panel: Locator): Promise<Offender[]> {
  return panel.evaluate((root: HTMLElement) => {
    const out: Array<{ rule: 'R1' | 'R2' | 'R3' | 'R4'; where: string; text: string; detail: string }> = []
    const pr = root.getBoundingClientRect()
    const round = (n: number) => Math.round(n)

    const where = (el: Element): string => {
      let s = el.tagName.toLowerCase()
      const id = el.getAttribute('data-testid')
      if (id) s += `[data-testid=${id}]`
      const cls = (el.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 2)
      if (cls.length) s += `.${cls.join('.')}`
      return s
    }
    const snip = (s: string | null | undefined, n = 70): string => {
      const t = (s ?? '').replace(/\s+/g, ' ').trim()
      return t.length > n ? `${t.slice(0, n - 3)}...` : t
    }
    const textOf = (el: Element) => snip((el as HTMLElement).innerText ?? el.textContent)

    // Visibility, cached per element: display none (no box), visibility hidden, opacity 0
    // anywhere up the chain, a clip (screen-reader-only text), or a box under 3px.
    const seen = new Map<Element, boolean>()
    const isVisible = (el: Element): boolean => {
      if (el === root) return true
      const cached = seen.get(el)
      if (cached !== undefined) return cached
      const cs = getComputedStyle(el)
      let ok = cs.display !== 'none' && cs.visibility !== 'hidden' && cs.visibility !== 'collapse' && cs.opacity !== '0'
      if (ok && cs.display !== 'contents') {
        if (cs.clip && cs.clip !== 'auto' && /rect\(\s*0/.test(cs.clip)) ok = false
        if (ok && cs.clipPath && cs.clipPath !== 'none' && /inset\(\s*50%/.test(cs.clipPath)) ok = false
        if (ok) {
          const r = el.getBoundingClientRect()
          if (el.getClientRects().length === 0 || r.width < 3 || r.height < 3) ok = false
        }
      }
      if (ok && el.parentElement) ok = isVisible(el.parentElement)
      seen.set(el, ok)
      return ok
    }

    /** Line boxes of a set of rects: one per distinct row (a rect joins the row its middle falls in). */
    const lineBoxes = (rects: DOMRect[]): Array<{ top: number; bottom: number }> => {
      const lines: Array<{ top: number; bottom: number }> = []
      for (const r of [...rects].filter((x) => x.width > 0.5 && x.height > 0).sort((a, b) => a.top - b.top)) {
        const mid = (r.top + r.bottom) / 2
        const line = lines.find((l) => mid >= l.top - 1 && mid <= l.bottom + 1)
        if (line) { line.top = Math.min(line.top, r.top); line.bottom = Math.max(line.bottom, r.bottom) }
        else lines.push({ top: r.top, bottom: r.bottom })
      }
      return lines
    }
    const rangeRects = (node: Node, start?: number, end?: number): DOMRect[] => {
      const range = document.createRange()
      if (start === undefined) range.selectNodeContents(node)
      else { range.setStart(node, start); range.setEnd(node, end!) }
      return Array.from(range.getClientRects())
    }
    const inPre = (el: Element) => !!el.closest('pre, textarea, [contenteditable="true"]')

    const all = Array.from(root.querySelectorAll('*')).filter((el) => isVisible(el))

    // ---------- R1: readable lines ----------
    const brokenWordReported = new Set<Element>()
    for (const el of all) {
      if (inPre(el)) continue
      const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim())
      if (own.length === 0) continue
      // The element's own flow: text nodes reached through inline descendants only (a
      // block or inline-block child is measured on its own).
      const nodes: Text[] = []
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!(n.textContent ?? '').trim()) continue
        let p = n.parentElement
        let inline = true
        while (p && p !== el) {
          const d = getComputedStyle(p).display
          if (d !== 'inline' && d !== 'contents') { inline = false; break }
          p = p.parentElement
        }
        if (inline && n.parentElement && isVisible(n.parentElement)) nodes.push(n as Text)
      }
      const rects = nodes.flatMap((n) => rangeRects(n))
      const lines = lineBoxes(rects)
      const chars = nodes.map((n) => n.textContent ?? '').join('').replace(/\s+/g, ' ').trim().length
      if (lines.length >= 2 && chars / lines.length < 12) {
        out.push({
          rule: 'R1', where: where(el), text: textOf(el),
          detail: `wraps to ${lines.length} lines with ${(chars / lines.length).toFixed(1)} chars a line (box ${round(el.getBoundingClientRect().width)}px wide)`,
        })
      }
    }
    // One-token text nodes and words broken across lines.
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      const parent = n.parentElement
      const raw = n.textContent ?? ''
      if (!parent || !raw.trim() || !isVisible(parent) || inPre(parent)) continue
      if (brokenWordReported.has(parent)) continue
      const trimmed = raw.trim()
      if (!/\s/.test(trimmed) && trimmed.length >= 2) {
        const lines = lineBoxes(rangeRects(n))
        if (lines.length > 1) {
          out.push({ rule: 'R1', where: where(parent), text: snip(trimmed), detail: `one token spans ${lines.length} lines` })
          brokenWordReported.add(parent)
          continue
        }
      }
      // A word (split at spaces, hyphens and slashes, where a break is fine) on two lines.
      const re = /[^\s\-\u2010-\u2014/]{3,}/g
      for (let m = re.exec(raw); m; m = re.exec(raw)) {
        const lines = lineBoxes(rangeRects(n, m.index, m.index + m[0].length))
        if (lines.length > 1) {
          out.push({
            rule: 'R1', where: where(parent), text: snip(trimmed),
            detail: `the word "${snip(m[0], 30)}" is broken across ${lines.length} lines`,
          })
          brokenWordReported.add(parent)
          break
        }
      }
    }

    // ---------- R2: nothing past the panel's edges ----------
    // An element inside a box that clips or scrolls horizontally is that box's business:
    // the box itself is checked.
    const clipped = new Map<Element, boolean>()
    const insideClip = (el: Element): boolean => {
      const p = el.parentElement
      if (!p || p === root) return false
      const c = clipped.get(p)
      if (c !== undefined) return c
      const ox = getComputedStyle(p).overflowX
      const v = ox !== 'visible' || insideClip(p)
      clipped.set(p, v)
      return v
    }
    const overflowing = new Set<Element>()
    for (const el of all) {
      const cs = getComputedStyle(el)
      if (cs.display === 'contents' || cs.position === 'fixed') continue
      if (insideClip(el)) continue
      if (el.parentElement && overflowing.has(el.parentElement)) { overflowing.add(el); continue }
      const r = el.getBoundingClientRect()
      const right = r.right - pr.right
      const left = pr.left - r.left
      if (right > 1 || left > 1) {
        overflowing.add(el)
        out.push({
          rule: 'R2', where: where(el), text: textOf(el),
          detail: right > 1 ? `runs ${round(right)}px past the panel's right edge` : `starts ${round(left)}px left of the panel`,
        })
      }
    }

    // ---------- R3: a notice's words use the box ----------
    for (const notice of Array.from(root.querySelectorAll('[data-panel-notice]'))) {
      if (!isVisible(notice)) continue
      const body = notice.querySelector('.panel-notice-body')
      if (!body || !isVisible(body)) {
        out.push({ rule: 'R3', where: where(notice), text: textOf(notice), detail: 'has no visible .panel-notice-body' })
        continue
      }
      const ncs = getComputedStyle(notice)
      const content = (notice as HTMLElement).clientWidth - parseFloat(ncs.paddingLeft) - parseFloat(ncs.paddingRight)
      const br = body.getBoundingClientRect()
      if (br.width < 0.9 * content - 0.5) {
        out.push({
          rule: 'R3', where: where(notice), text: textOf(body),
          detail: `its body is ${round(br.width)}px of a ${round(content)}px box (${Math.round((br.width / content) * 100)}%, needs 90%)`,
        })
      }
      // Nothing beside the body: a direct child level with it, left or right of it.
      const actionsBox = notice.querySelector('.panel-notice-actions')
      for (const child of Array.from(notice.children)) {
        if (child === body || child === actionsBox || !isVisible(child)) continue
        const cr = child.getBoundingClientRect()
        const level = cr.top < br.bottom - 1 && cr.bottom > br.top + 1
        if (level && (cr.right <= br.left + 1 || cr.left >= br.right - 1)) {
          out.push({ rule: 'R3', where: where(child), text: textOf(child) || '(icon)', detail: 'sits in a column beside the notice body' })
        }
      }
      // The actions: under the words, or inline on their last line.
      const bodyText: DOMRect[] = []
      const bw = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
      for (let n = bw.nextNode(); n; n = bw.nextNode()) {
        if ((n.textContent ?? '').trim() && n.parentElement && isVisible(n.parentElement)) bodyText.push(...rangeRects(n))
      }
      const lines = lineBoxes(bodyText)
      // The icon starts the first line of words, never a line of its own.
      const icon = body.querySelector('.panel-notice-icon')
      if (icon && isVisible(icon)) {
        const ir = icon.getBoundingClientRect()
        const words: DOMRect[] = []
        const iw = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
        for (let n = iw.nextNode(); n; n = iw.nextNode()) {
          if ((n.textContent ?? '').trim() && n.parentElement && isVisible(n.parentElement) && !icon.contains(n)) words.push(...rangeRects(n))
        }
        const first = lineBoxes(words).reduce<{ top: number; bottom: number } | null>((a, l) => (!a || l.top < a.top ? l : a), null)
        if (first && !(first.top < ir.bottom - 1 && first.bottom > ir.top + 1)) {
          out.push({ rule: 'R3', where: where(icon), text: '(icon)', detail: `stands alone on a line, ${round(first.top - ir.bottom)}px above the first words` })
        }
      }
      const last = lines.reduce<{ top: number; bottom: number } | null>((a, l) => (!a || l.bottom > a.bottom ? l : a), null)
      for (const action of Array.from(notice.querySelectorAll('.panel-notice-actions > *'))) {
        if (!isVisible(action)) continue
        const ar = action.getBoundingClientRect()
        const under = ar.top >= br.bottom - 1
        const onLastLine = !!last && ar.top >= last.top - 2 && ar.top <= last.bottom
        if (!under && !onLastLine) {
          out.push({
            rule: 'R3', where: where(action), text: textOf(action),
            detail: `sits beside the words (top ${round(ar.top - br.top)}px into a ${round(br.height)}px body), not under them`,
          })
        }
      }
    }

    // ---------- R3 (any box): a button in the flow is never drawn over words ----------
    // A floating control (absolute, fixed, sticky, or inside one) is meant to sit over
    // content and is left out; a button in the flow on top of text is a squeezed layout.
    const floats = (el: Element): boolean => {
      for (let p: Element | null = el; p && p !== root; p = p.parentElement) {
        if (['absolute', 'fixed', 'sticky'].includes(getComputedStyle(p).position)) return true
      }
      return false
    }
    /** The part of `r` left after every clipping ancestor of `el` (scrolled-away text is not seen). */
    const seenRect = (el: Element, r: DOMRect) => {
      let { left, right, top, bottom } = r
      for (let p = el.parentElement; p && p !== root.parentElement; p = p.parentElement) {
        const cs = getComputedStyle(p)
        if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue
        const q = p.getBoundingClientRect()
        left = Math.max(left, q.left); right = Math.min(right, q.right)
        top = Math.max(top, q.top); bottom = Math.min(bottom, q.bottom)
      }
      return { left, right, top, bottom }
    }
    const buttons = all.filter((el) => el.matches('button, [role="button"]') && !floats(el))
    if (buttons.length) {
      const words: Array<{ node: Text; parent: Element; r: { left: number; right: number; top: number; bottom: number } }> = []
      const ww = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let n = ww.nextNode(); n; n = ww.nextNode()) {
        const parent = n.parentElement
        if (!parent || !(n.textContent ?? '').trim() || !isVisible(parent) || floats(parent)) continue
        for (const r of rangeRects(n)) if (r.width > 0.5) words.push({ node: n as Text, parent, r: seenRect(parent, r) })
      }
      for (const b of buttons) {
        const br = b.getBoundingClientRect()
        const hit = words.find((w) => !b.contains(w.node) && !w.parent.contains(b)
          && Math.min(br.right, w.r.right) - Math.max(br.left, w.r.left) > 2
          && Math.min(br.bottom, w.r.bottom) - Math.max(br.top, w.r.top) > 2)
        if (hit) {
          out.push({
            rule: 'R3', where: where(b), text: textOf(b),
            detail: `is drawn over the words of ${where(hit.parent)} "${snip(hit.parent.textContent, 40)}"`,
          })
        }
      }
    }

    // ---------- R4: the header's title row ----------
    const row = root.querySelector('.session-panel-header-top')
    if (row && isVisible(row)) {
      const kebab = row.querySelector('.task-kebab-btn')
      if (!kebab || !isVisible(kebab)) {
        out.push({ rule: 'R4', where: where(row), text: textOf(row), detail: 'the kebab is not visible' })
      } else {
        const kr = kebab.getBoundingClientRect()
        if (kr.right > pr.right + 1) out.push({ rule: 'R4', where: where(kebab), text: '(kebab)', detail: `the kebab runs ${round(kr.right - pr.right)}px past the panel` })
      }
      const parts: Element[] = []
      const title = row.querySelector('.session-panel-title')
      if (title) parts.push(title)
      const meta = row.querySelector('.session-panel-title-meta')
      if (meta) parts.push(...Array.from(meta.children).filter((c) => !c.querySelector('.task-kebab-btn') && !c.matches('.task-kebab-btn')))
      /** The width of `el` left after every clipping ancestor up to the row. */
      const shownWidth = (el: Element): number => {
        const r = el.getBoundingClientRect()
        let left = r.left
        let right = r.left + Math.min(r.width, (el as HTMLElement).clientWidth || r.width)
        for (let p = el.parentElement; p && p !== root.parentElement; p = p.parentElement) {
          if (getComputedStyle(p).overflowX === 'visible') continue
          const q = p.getBoundingClientRect()
          left = Math.max(left, q.left)
          right = Math.min(right, q.right)
          if (p === root) break
        }
        return Math.max(0, right - left)
      }
      // Shown at all: a title squeezed to nothing is the worst cut (isVisible skips a box
      // under 3px, so this asks display and visibility only).
      const drawn = (el: Element) => {
        for (let p: Element | null = el; p && p !== root; p = p.parentElement) {
          const cs = getComputedStyle(p)
          if (cs.display === 'none' || cs.visibility === 'hidden') return false
        }
        return el.getClientRects().length > 0
      }
      if (title && drawn(title)) {
        const tr = title.getBoundingClientRect()
        const text = ((title as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim()
        if (text && tr.width < 3) {
          out.push({ rule: 'R4', where: where(title), text: snip(text), detail: `the title is squeezed to ${round(tr.width)}px` })
        }
      }
      // Nothing on the row is drawn over anything else (the phase icon over a pill, a pill over the title).
      const items: Element[] = []
      const area = row.querySelector('.session-panel-title-area')
      if (area) items.push(...Array.from(area.children))
      if (meta) items.push(...Array.from(meta.children))
      const boxes = items.filter((el) => drawn(el)).map((el) => ({ el, r: el.getBoundingClientRect() })).filter((b) => b.r.width >= 3)
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i].r
          const b = boxes[j].r
          const dx = Math.min(a.right, b.right) - Math.max(a.left, b.left)
          const dy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
          if (dx > 1 && dy > 1) {
            out.push({
              rule: 'R4', where: `${where(boxes[i].el)} + ${where(boxes[j].el)}`,
              text: snip(`${textOf(boxes[i].el) || '(icon)'} | ${textOf(boxes[j].el) || '(icon)'}`),
              detail: `drawn over each other by ${round(dx)}px`,
            })
          }
        }
      }
      for (const part of parts) {
        if (!isVisible(part)) continue
        for (const el of [part, ...Array.from(part.querySelectorAll('*'))]) {
          if (!isVisible(el)) continue
          const d = getComputedStyle(el).display
          if (d === 'inline' || d === 'contents') continue
          const text = ((el as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim()
          if (!text) continue
          const full = (el as HTMLElement).scrollWidth
          const shown = shownWidth(el)
          if (full <= shown + 1) continue
          const charsShown = shown / (full / text.length)
          if (charsShown < 8 && charsShown < text.length) {
            out.push({
              rule: 'R4', where: where(el), text: snip(text),
              detail: `shows about ${Math.max(0, Math.floor(charsShown))} of ${text.length} chars (${round(shown)}px of ${round(full)}px)`,
            })
            break
          }
        }
      }
    }

    // One line per offender: the same element and rule once.
    const keyed = new Map<string, (typeof out)[number]>()
    for (const o of out) {
      const key = `${o.rule}|${o.where}|${o.text}|${o.detail.replace(/\d+(\.\d+)?/g, '#')}`
      if (!keyed.has(key)) keyed.set(key, o)
    }
    return [...keyed.values()]
  })
}

export const formatOffender = (o: Offender) => `${o.rule} ${o.where} "${o.text}": ${o.detail}`

/** Audit until two reads 250ms apart agree (the header measures itself after a resize). */
export async function settledAudit(panel: Locator): Promise<Offender[]> {
  let last = JSON.stringify(await auditPanel(panel))
  for (let i = 0; i < 20; i++) {
    await panel.page().waitForTimeout(250)
    const now = JSON.stringify(await auditPanel(panel))
    if (now === last) break
    last = now
  }
  return JSON.parse(last) as Offender[]
}

/**
 * R1 to R4 over everything visible in `panel`; every offender is listed with its text.
 * Soft, so one call reports every rule a layout breaks and the test goes on to its next width.
 */
export async function expectReadablePanel(page: Page, panel: Locator, label = 'panel'): Promise<Offender[]> {
  void page
  const offenders = await settledAudit(panel)
  expect.soft(offenders.map(formatOffender), `${label}: the narrow layout rules (R1-R4)`).toEqual([])
  return offenders
}

/**
 * R5: a host name in a notice stays on one line, cut with an ellipsis, and hovering it shows
 * its whole name in place (truncation-peek-helpers.ts), never in a native title. The element
 * is the deepest one whose text holds the host.
 */
export async function expectHostNameCut(panel: Locator, host: string, label = 'host name'): Promise<void> {
  const facts = await panel.evaluate((root, name) => {
    const holders = Array.from(root.querySelectorAll('*')).filter((el) => (el.textContent ?? '').includes(name))
    const deepest = holders.find((el) => !Array.from(el.children).some((c) => (c.textContent ?? '').includes(name)))
    if (!deepest) return null
    root.querySelectorAll('[data-r5-host]').forEach((el) => el.removeAttribute('data-r5-host'))
    deepest.setAttribute('data-r5-host', '')
    const cs = getComputedStyle(deepest)
    const tops = new Set<number>()
    const walker = document.createTreeWalker(deepest, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent ?? ''
      const at = text.indexOf(name)
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(n, at)
      range.setEnd(n, at + name.length)
      for (const r of Array.from(range.getClientRects())) if (r.width > 0.5) tops.add(Math.round(r.top))
    }
    return {
      tag: `${deepest.tagName.toLowerCase()}.${(deepest.getAttribute('class') ?? '').trim().split(/\s+/).join('.')}`,
      lines: tops.size,
      textOverflow: cs.textOverflow,
      whiteSpace: cs.whiteSpace,
      ownText: (deepest.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
    }
  }, host)
  expect.soft(facts, `${label}: some element in the panel shows the host name`).not.toBeNull()
  if (!facts) return
  const where = `${facts.tag} "${facts.ownText}"`
  expect.soft(facts.lines, `R5 ${label}: the host name in ${where} wraps onto ${facts.lines} lines`).toBe(1)
  expect.soft(facts.textOverflow, `R5 ${label}: ${where} is cut with an ellipsis`).toBe('ellipsis')
  expect.soft(facts.whiteSpace, `R5 ${label}: ${where} never wraps`).toMatch(/nowrap|pre/)
  await expectPeeksInPlace(panel.locator('[data-r5-host]'), host, `R5 ${label}: ${where}`)
}

/** Save a screenshot of the panel under the task's shots folder (per browser project). */
export async function shootPanel(panel: Locator, name: string): Promise<string> {
  const dir = path.join(process.env.WALNUT_TASK_DIR ?? '/tmp', 'shots', 'session-panel-narrow', test.info().project.name)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${name}.png`)
  await panel.screenshot({ path: file, animations: 'disabled' })
  return file
}
