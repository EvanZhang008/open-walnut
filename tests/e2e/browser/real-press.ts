// A press must land where the target is now, not where it was before an image or dialog moved it.
// A drag must start on words a person sees, not on a box edge, a button or an icon.
import type { ElementHandle, Frame, Locator, Page } from '@playwright/test'

/** A real wheel turn over a scroller that brings the target toward its visible box. */
interface Wheel { x: number; y: number; dx: number; dy: number; over: string }
/**
 * `reach`: `shown` when part of the target is inside the viewport and every clipping ancestor
 * (a point may still be covered), `scroll` when no part is shown but a person's wheel could
 * show one, `clipped` when every part lies outside an ancestor that clips and that no scroller
 * between it and the target can move it into (a line clamp, overflow hidden or clip): a person
 * cannot reach it, so neither may a test. `none`: no line box to read (`at` says why).
 */
interface Point { x: number; y: number; x2: number; hit: boolean; at: string; reach: 'shown' | 'scroll' | 'clipped' | 'none'; wheel?: Wheel }
type Mode = { kind: 'press' } | { kind: 'text'; width: number }

// Errors of a target a rerender replaced mid-read: read again. Anything else is the helper's own bug and is thrown.
const GONE = /not attached|detached|Node not found|No node with given id|Execution context was destroyed|Target (page, context or browser )?(has been )?closed|Cannot find context|JSHandle is disposed|navigat/i

async function probe(target: Locator, mode: Mode): Promise<Point> {
  try {
    return await readPoint(target, mode)
  } catch (e) {
    if (GONE.test(String(e))) return { x: 0, y: 0, x2: 0, hit: false, at: `the target was replaced mid-read: ${String(e).split('\n')[0]}`, reach: 'none' }
    throw e
  }
}

/** Runs in the target's document: where on it a press or a drag may land, or why nowhere. Self-contained. */
async function locate(el: Element, mode: Mode): Promise<Point> {
  const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  const doc = el.ownerDocument
  const view = doc.defaultView!
  const css = (e: Element) => view.getComputedStyle(e)
  const describe = (at: Element | null) => (at ? `${at.tagName.toLowerCase()}.${String(at.className).slice(0, 60)}` : 'nothing')
  const none = (why: string): Point => ({ x: 0, y: 0, x2: 0, hit: false, at: why, reach: 'none' })
  const until = performance.now() + 5_000
  const shown = (img: HTMLImageElement) => {
    const s = css(img)
    if (s.display === 'none' || s.visibility === 'hidden' || !img.getClientRects().length) return false
    const r = img.getBoundingClientRect()
    return r.bottom >= 0 && r.right >= 0 && r.top <= view.innerHeight && r.left <= view.innerWidth
  }
  while (Array.from(doc.images).some((img) => !img.complete && shown(img)) && performance.now() < until) await frame()
  const boxes = () => Array.from(el.getClientRects()).map((r) => `${r.x},${r.y},${r.width},${r.height}`).join(';')
  let last = boxes()
  if (!last) return none(`${describe(el)} has no line box (display ${css(el).display})`)
  let steady = false
  while (!steady && performance.now() < until + 2_000) {
    await frame()
    const next = boxes()
    steady = next === last
    last = next
  }
  if (!steady) return none(`${describe(el)} kept moving`)

  // The ancestors that really clip the target, nearest first: a box with overflow other than visible
  // (an inline box has none: overflow does not apply to it) or paint containment, on the target's
  // containing block chain (an absolute box escapes static ancestors, a fixed one all but a
  // transformed one). `wheelX/Y`: a person's wheel scrolls it on that axis now.
  interface Box { l: number; t: number; r: number; b: number }
  interface Clip { el: Element; box: Box; wheelX: boolean; wheelY: boolean; fixedX: boolean; fixedY: boolean }
  const clips: Clip[] = []
  const escapes = (position: string) => (position === 'absolute' ? 'positioned' : position === 'fixed' ? 'transformed' : '')
  let skip = escapes(css(el).position)
  // A scroller between the target and a clip can move the target into that clip's box.
  let movableX = false
  let movableY = false
  for (let a = el.parentElement; a && a !== doc.documentElement; a = a.parentElement) {
    const s = css(a)
    const paint = /paint|strict|content/.test(s.contain)
    const transformed = s.transform !== 'none' || s.filter !== 'none' || paint || s.willChange.includes('transform')
    if (skip === 'positioned' && s.position === 'static' && !transformed) continue
    if (skip === 'transformed' && !transformed) continue
    skip = escapes(s.position)
    if (s.display === 'contents' || s.display === 'inline') continue
    // The body's overflow belongs to the viewport while the root's is visible.
    if (a === doc.body && css(doc.documentElement).overflow === 'visible') continue
    const ox = paint ? 'clip' : s.overflowX
    const oy = paint ? 'clip' : s.overflowY
    if (ox === 'visible' && oy === 'visible') continue
    const r = a.getBoundingClientRect()
    const l = r.left + a.clientLeft
    const t = r.top + a.clientTop
    const wheelX = (ox === 'auto' || ox === 'scroll') && a.scrollWidth > a.clientWidth + 1
    const wheelY = (oy === 'auto' || oy === 'scroll') && a.scrollHeight > a.clientHeight + 1
    clips.push({
      el: a,
      box: {
        l: ox === 'visible' ? -Infinity : l,
        r: ox === 'visible' ? Infinity : l + a.clientWidth,
        t: oy === 'visible' ? -Infinity : t,
        b: oy === 'visible' ? Infinity : t + a.clientHeight,
      },
      wheelX,
      wheelY,
      fixedX: ox !== 'visible' && !wheelX && !movableX,
      fixedY: oy !== 'visible' && !wheelY && !movableY,
    })
    movableX ||= wheelX
    movableY ||= wheelY
  }
  const screen: Box = { l: 0, t: 0, r: doc.documentElement.clientWidth || view.innerWidth, b: doc.documentElement.clientHeight || view.innerHeight }
  const cut = (a: Box, b: Box): Box => ({ l: Math.max(a.l, b.l), t: Math.max(a.t, b.t), r: Math.min(a.r, b.r), b: Math.min(a.b, b.b) })
  const some = (b: Box) => b.r - b.l >= 1 && b.b - b.t >= 1
  const visible = (r: Box) => clips.reduce((v, c) => cut(v, c.box), cut(r, screen))
  // The axes no wheel can change: a clip a person cannot scroll with no scroller under it.
  const fixedPart = (c: Clip): Box => ({
    l: c.fixedX ? c.box.l : -Infinity, r: c.fixedX ? c.box.r : Infinity,
    t: c.fixedY ? c.box.t : -Infinity, b: c.fixedY ? c.box.b : Infinity,
  })
  const cutBy = (r: Box) => clips.find((c) => !some(cut(r, fixedPart(c))))
  const boxOf = (r: DOMRect): Box => ({ l: r.left, t: r.top, r: r.right, b: r.bottom })
  const inside = (at: Element | null) => Boolean(at && (at === el || el.contains(at)))
  const inButton = (n: Node) => {
    const button = (n instanceof Element ? n : n.parentElement)?.closest('button')
    return Boolean(button && (button === el || el.contains(button)))
  }

  // The line boxes a point may land on: the target's own, or for a drag the lines of its words.
  const lines: Box[] = []
  if (mode.kind === 'press') {
    for (const r of Array.from(el.getClientRects())) if (r.width >= 1 && r.height >= 1) lines.push(boxOf(r))
  } else {
    let unselectable = 0
    let inButtons = 0
    const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const parent = n.parentElement
      if (!parent || !n.textContent?.trim()) continue
      if (inButton(n)) { inButtons++; continue }
      const s = css(parent) as CSSStyleDeclaration & { webkitUserSelect?: string }
      if (s.userSelect === 'none' || s.webkitUserSelect === 'none') { unselectable++; continue }
      const range = doc.createRange()
      range.selectNodeContents(n)
      for (const r of Array.from(range.getClientRects())) if (r.width >= 6 && r.height >= 1) lines.push(boxOf(r))
    }
    if (!lines.length) return none(`${describe(el)} has no selectable words: ${unselectable} text runs are user-select none, ${inButtons} are in a button`)
  }
  if (!lines.length) return none(`${describe(el)} has no line box of any size`)

  // The node a press there puts the caret in; undefined when the engine has no way to say.
  const caretAt = (x: number, y: number): Node | null | undefined => {
    const d = doc as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node } | null
    }
    if (d.caretPositionFromPoint) return d.caretPositionFromPoint(x, y)?.offsetNode ?? null
    if (d.caretRangeFromPoint) return d.caretRangeFromPoint(x, y)?.startContainer ?? null
    return undefined
  }
  let shownAt = ''
  let reachable: Box | null = null
  let clippedBy: Element | null = null
  for (const line of lines) {
    const by = cutBy(line)
    if (!by) reachable ??= line
    else clippedBy ??= by.el
    const v = visible(line)
    if (!some(v)) continue
    // A point a pixel inside the visible part, at the visible middle of the line.
    const y = (v.t + v.b) / 2
    const l = v.l + 1
    const w = v.r - 1 - l
    if (w < 0) continue
    if (mode.kind === 'press') {
      const xs = [l + Math.min(w / 2, 24), l + w / 2, ...[0.1, 0.3, 0.7, 0.9].map((f) => l + w * f), l]
      for (const x of xs) {
        const at = doc.elementFromPoint(x, y)
        if (inside(at)) return { x, y, x2: x, hit: true, at: describe(at), reach: 'shown' }
        shownAt ||= `${Math.round(x)},${Math.round(y)} hits ${describe(at)}`
      }
    } else {
      const x = v.l + 2
      const x2 = Math.min(v.r - 2, x + mode.width)
      if (x2 - x < 4) continue
      const a1 = doc.elementFromPoint(x, y)
      const a2 = doc.elementFromPoint(x2, y)
      const caret = caretAt(x, y)
      const onWords = caret === undefined || (caret?.nodeType === Node.TEXT_NODE && el.contains(caret) && !inButton(caret))
      if (inside(a1) && inside(a2) && a1 && a2 && !inButton(a1) && !inButton(a2) && onWords) {
        return { x, y, x2, hit: true, at: describe(a1), reach: 'shown' }
      }
      shownAt ||= `${Math.round(x)},${Math.round(y)} hits ${describe(a1)}, ${Math.round(x2)} hits ${describe(a2)}, caret in ${caret === null ? 'nothing' : caret?.nodeName ?? 'unknown'}${onWords ? '' : ' (not its words)'}`
    }
  }
  const first = lines[0]!
  const x = Math.max(first.l + 1, 0)
  const y = (first.t + first.b) / 2
  if (!shownAt && !reachable) return { x, y, x2: x, hit: false, at: `every line is cut off by ${describe(clippedBy)}`, reach: 'clipped' }

  // Nothing shown, yet a scroll can show it: the nearest scroller (the page's last) that has the
  // line outside its box takes a wheel turn that centres the line, from a point over it whose
  // own nearest scroller in that direction is that one.
  const page = doc.scrollingElement ?? doc.documentElement
  const scrollers: Array<{ el: Element; box: Box; x: boolean; y: boolean; outer: Box }> = []
  clips.forEach((c, i) => {
    if (c.wheelX || c.wheelY) scrollers.push({ el: c.el, box: c.box, x: c.wheelX, y: c.wheelY, outer: clips.slice(i + 1).reduce((v, o) => cut(v, o.box), screen) })
  })
  scrollers.push({ el: page, box: screen, x: page.scrollWidth > page.clientWidth + 1, y: page.scrollHeight > page.clientHeight + 1, outer: screen })
  // Set unless the target is shown under a cover, which returns before `line` is read.
  const line = reachable ?? first
  const scrollsUnder = (at: Element | null, dx: number, dy: number): Element => {
    for (let e = at; e && e !== doc.documentElement && e !== doc.body; e = e.parentElement) {
      const s = css(e)
      const canY = dy !== 0 && /auto|scroll/.test(s.overflowY) && (dy > 0 ? e.scrollTop + e.clientHeight < e.scrollHeight - 1 : e.scrollTop > 0)
      const canX = dx !== 0 && /auto|scroll/.test(s.overflowX) && (dx > 0 ? e.scrollLeft + e.clientWidth < e.scrollWidth - 1 : e.scrollLeft > 0)
      if (canY || canX) return e
    }
    return page
  }
  /** A point over the scroller whose wheel there turns that scroller, or none. */
  const wheelOver = (sc: (typeof scrollers)[number], dx: number, dy: number): Wheel | null => {
    const over = cut(sc.box, sc.outer)
    if (!some(over)) return null
    for (const fy of [0.5, 0.25, 0.75, 0.1, 0.9]) {
      for (const fx of [0.5, 0.25, 0.75, 0.1, 0.9]) {
        const wx = over.l + (over.r - over.l) * fx
        const wy = over.t + (over.b - over.t) * fy
        if (scrollsUnder(doc.elementFromPoint(wx, wy), dx, dy) === sc.el) return { x: wx, y: wy, dx, dy, over: describe(sc.el) }
      }
    }
    return null
  }
  // Shown, yet every point is covered by something laid over its scroller's edge (a panel header
  // the chat scrolls under): a person turns the wheel to bring it out toward the scroller's middle.
  // Only a press, and only while that turn still moves it; a cover at the middle stays a refusal.
  if (shownAt) {
    const sc = mode.kind === 'press' ? scrollers.find((c) => c.y) : undefined
    const seenLine = lines.find((l) => some(visible(l))) ?? first
    if (sc) {
      const dy = Math.round((seenLine.t + seenLine.b) / 2 - (sc.box.t + sc.box.b) / 2)
      const can = dy > 0 ? sc.el.scrollTop + sc.el.clientHeight < sc.el.scrollHeight - 1 : sc.el.scrollTop > 0
      const wheel = Math.abs(dy) >= 8 && can ? wheelOver(sc, 0, dy) : null
      if (wheel) return { x, y, x2: x, hit: false, at: `covered (${shownAt})`, reach: 'scroll', wheel }
    }
    return { x, y, x2: x, hit: false, at: shownAt, reach: 'shown' }
  }
  for (const sc of scrollers) {
    const outY = line.t < sc.box.t || line.b > sc.box.b
    const outX = line.l < sc.box.l || line.r > sc.box.r
    const dy = sc.y && outY ? Math.round((line.t + line.b) / 2 - (sc.box.t + sc.box.b) / 2) : 0
    const dx = sc.x && outX ? Math.round((line.l + line.r) / 2 - (sc.box.l + sc.box.r) / 2) : 0
    if (!dx && !dy) continue
    if (!some(cut(sc.box, sc.outer))) return { x, y, x2: x, hit: false, at: `its scroller ${describe(sc.el)} is not on screen`, reach: 'scroll' }
    const wheel = wheelOver(sc, dx, dy)
    if (wheel) return { x, y, x2: x, hit: false, at: 'off screen', reach: 'scroll', wheel }
    return { x, y, x2: x, hit: false, at: `no point over ${describe(sc.el)} that its wheel scrolls`, reach: 'scroll' }
  }
  return { x, y, x2: x, hit: false, at: 'off screen, and no scroller has it outside its box', reach: 'scroll' }
}

/**
 * A frame whose sandbox bars scripts (a letter's html) has no script context on Chromium: an
 * `evaluate` inside it never returns. WebKit answers there and keeps every check of `locate`, so
 * this branch is Chromium's only.
 */
async function runsNoScripts(handle: ElementHandle<Element>, page: Page): Promise<boolean> {
  if (page.context().browser()?.browserType().name() !== 'chromium') return false
  for (let frame: Frame | null = await handle.ownerFrame(); frame?.parentFrame(); frame = frame.parentFrame()) {
    const host = await frame.frameElement()
    try {
      const sandbox = await host.getAttribute('sandbox')
      if (sandbox !== null && !/(^|\s)allow-scripts(\s|$)/.test(sandbox)) return true
    } finally {
      await host.dispose()
    }
  }
  return false
}

/**
 * Where a press may land on a target inside a frame that runs no scripts: the middle of its box as
 * the browser reports it, only while that point is on screen and the page's topmost element there
 * is the frame itself. What is drawn inside the frame (a cover, a clip) cannot be read from here,
 * and neither can its words, so a drag over them is refused with the reason.
 */
async function measureFromOutside(target: Locator, mode: Mode): Promise<Point> {
  const none = (at: string): Point => ({ x: 0, y: 0, x2: 0, hit: false, at, reach: 'none' })
  if (mode.kind !== 'press') return none('its frame runs no scripts, so the words cannot be read')
  const box = await target.boundingBox()
  if (!box || box.width < 1 || box.height < 1) return none('no box (its frame runs no scripts)')
  // A link broken over lines has a box taller than a line, and the middle of that box can sit in the gap
  // between its lines (Chromium wraps a long path where WebKit does not): press at the end of its first line.
  const wrapped = box.height > 30
  const x = wrapped ? box.x + box.width - Math.min(24, box.width / 2) : box.x + box.width / 2
  const y = wrapped ? box.y + 9 : box.y + box.height / 2
  const outer = await target.page().evaluate(({ px, py }) => {
    const at = document.elementFromPoint(px, py)
    const inView = px >= 0 && py >= 0 && px < innerWidth && py < innerHeight
    return { inView, frame: !!at && at.tagName === 'IFRAME', at: at ? `${at.tagName.toLowerCase()}.${String(at.className).slice(0, 60)}` : 'nothing' }
  }, { px: x, py: y })
  if (!outer.inView) return { x, y, x2: x, hit: false, at: 'off screen (its frame runs no scripts, so no wheel is turned for it)', reach: 'none' }
  if (!outer.frame) return { x, y, x2: x, hit: false, at: `covered by ${outer.at}`, reach: 'shown' }
  return { x, y, x2: x, hit: true, at: 'its frame', reach: 'shown' }
}

async function readPoint(target: Locator, mode: Mode): Promise<Point> {
  const handle = await target.elementHandle({ timeout: 5_000 }).catch((error) => {
    if (String(error).includes('strict mode violation')) throw error
    return null
  })
  if (!handle) return { x: 0, y: 0, x2: 0, hit: false, at: 'no element matches the target yet', reach: 'none' }
  try {
    if (await runsNoScripts(handle, target.page())) return await measureFromOutside(target, mode)
    const point = await handle.evaluate(locate, mode)
    for (let frame: Frame | null = await handle.ownerFrame(); frame?.parentFrame(); frame = frame.parentFrame()) {
      const host = await frame.frameElement()
      try {
        const outer = await host.evaluate((f, p) => {
          const r = f.getBoundingClientRect()
          const s = getComputedStyle(f)
          const px = (v: string) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : 0)
          const dx = r.x + f.clientLeft + px(s.paddingLeft)
          const dy = r.y + f.clientTop + px(s.paddingTop)
          const x = dx + p.x
          const y = dy + p.y
          const x2 = dx + p.x2
          const at = f.ownerDocument.elementFromPoint(x, y)
          const hit = at === f && f.ownerDocument.elementFromPoint(x2, y) === f
          const wheel = p.wheel ? { ...p.wheel, x: dx + p.wheel.x, y: dy + p.wheel.y } : undefined
          return { x, y, x2, hit, wheel, at: at ? `${at.tagName.toLowerCase()}.${String(at.className).slice(0, 60)}` : 'nothing' }
        }, { x: point.x, y: point.y, x2: point.x2, wheel: point.wheel })
        point.x = outer.x
        point.y = outer.y
        point.x2 = outer.x2
        point.wheel = outer.wheel
        if (!outer.hit && point.hit) {
          point.hit = false
          point.at = `outside its frame: ${outer.at}`
          // The frame itself is not shown here: where this document's wheel can bring it, that turn comes first.
          const framed = await (host as ElementHandle<Element>).evaluate(locate, { kind: 'press' } as Mode)
          if (framed.reach === 'scroll' || framed.reach === 'clipped') {
            point.reach = framed.reach
            point.wheel = framed.wheel
            point.at = `its frame: ${framed.at}`
          }
        }
      } finally {
        await host.dispose()
      }
    }
    return point
  } finally {
    await handle.dispose()
  }
}

/** A point that holds still on the target; when no part is shown and a wheel can show one, real wheel turns first. */
async function steadyPoint(page: Page, target: Locator, mode: Mode, tries: number): Promise<Point> {
  let seen = ''
  for (let i = 0; i < tries; i++) {
    const before = await probe(target, mode)
    // A shown target is never scrolled (a scroll can hide a clamped line), nor a clipped one (a person cannot scroll it).
    if (before.reach === 'scroll' && before.wheel) {
      const w = before.wheel
      await page.mouse.move(w.x, w.y, { steps: 6 })
      await page.mouse.wheel(w.dx, w.dy)
      seen = `read ${i + 1}: turned the wheel ${w.dx},${w.dy} over ${w.over}`
      continue
    }
    if (!before.hit) { seen = `read ${i + 1}: no visible point (${before.reach}): ${before.at}`; continue }
    if (!(await target.isEnabled().catch(() => true))) { seen = 'disabled'; continue }
    await page.mouse.move(before.x, before.y, { steps: 12 })
    const now = await probe(target, mode)
    if (now.hit && Math.abs(now.x - before.x) < 1 && Math.abs(now.y - before.y) < 1 && Math.abs(now.x2 - before.x2) < 1) return now
    seen = `read ${before.x},${before.y}, then ${now.x},${now.y} (${now.reach}), where the point hits ${now.at}`
  }
  throw new Error(`No steady point to ${mode.kind === 'press' ? 'press on the target' : 'drag across the target\'s words'} after ${tries} reads: ${seen}`)
}

// Exactly one down/up, and only on a point that held still and hits the target: a failed check reads again.
export async function press(page: Page, target: Locator, tries = 5): Promise<void> {
  await steadyPoint(page, target, { kind: 'press' }, tries)
  await page.mouse.down()
  await page.mouse.up()
}

/**
 * One real press and drag across a visible line of the target's own words (never a button's,
 * an icon or padding), up to `width` px; returns what its document selected.
 */
export async function dragAcrossWords(page: Page, target: Locator, width = 60, tries = 5): Promise<string> {
  const at = await steadyPoint(page, target, { kind: 'text', width }, tries)
  await page.mouse.down()
  await page.mouse.move(at.x2, at.y, { steps: 12 })
  await page.mouse.up()
  return target.evaluate((el) => el.ownerDocument.getSelection()?.toString() ?? '')
}
