/**
 * Shared machinery for the cross-surface checks on the mail right-click slice: the geometry specs in
 * both engines, and the two read-only audits (the live console, and the Slack rows this menu copies).
 *
 * A helpers MODULE, not an import from a spec: importing a spec file would run its tests again in the
 * other engine, and a `test.use` browser pin only holds at the top level of its own file.
 *
 * The read-only rule is code here rather than a habit. `guardReadOnly` aborts every non-GET request to
 * `/api`, so a driver pointed at the production console cannot mark a real message read, send real
 * mail, or write a draft, even if a click lands somewhere unintended. `requestLog` keeps what went
 * over the wire so the abort can be shown rather than claimed.
 */
import fs from 'node:fs/promises'
import { expect, type Locator, type Page } from '@playwright/test'

export const MENU = '.wn-context-menu'
export const ITEM = '.wn-context-menu-item'
export const ROW = '[data-testid="mail-row"]'
export const LIST = '.mail-list-pane'
/** Every screenshot and evidence note this package leaves behind. Never deleted. */
export const SHOTS = '/tmp/mail-context-ux'

export async function shotsDir(): Promise<string> {
  await fs.mkdir(SHOTS, { recursive: true })
  return SHOTS
}

export function menu(page: Page): Locator {
  return page.locator(MENU)
}

export async function menuCount(page: Page): Promise<number> {
  return page.locator(MENU).count()
}

/** Escape, then prove it is gone: a leftover backdrop swallows the next click and fakes a pass. */
export async function closeMenu(page: Page): Promise<void> {
  if (await menuCount(page)) {
    await page.keyboard.press('Escape')
    await expect(page.locator(MENU)).toHaveCount(0)
  }
}

/** What sits under a viewport point, as a selector-ish description, so a miss says what it hit. */
export async function describePoint(page: Page, x: number, y: number): Promise<string> {
  return page.evaluate(([px, py]) => {
    const node = document.elementFromPoint(px as number, py as number) as HTMLElement | null
    if (!node) return 'nothing'
    const row = node.closest('[data-testid="mail-row"], .mail-mailbox, .mail-mailbox-line') as HTMLElement | null
    const name = (one: HTMLElement) => `${one.tagName.toLowerCase()}.${one.className || '(no class)'}`
    return row ? `${name(row)} via ${name(node)}` : name(node)
  }, [x, y])
}

/** A right-click at an exact viewport point, after proving a row is really there. */
export async function rightClickPoint(page: Page, x: number, y: number, expectRow = true): Promise<void> {
  if (expectRow) {
    const what = await describePoint(page, x, y)
    expect(what, `no row under (${x}, ${y}); found ${what}`).toMatch(/mail-row|mail-mailbox/)
  }
  await page.mouse.click(x, y, { button: 'right' })
}

/** 12px in from the start, the centre, 12px in from the end of one whole line (the G10 sweep). */
export async function sweepPoints(row: Locator): Promise<{ label: string, x: number, y: number }[]> {
  const box = await row.boundingBox()
  expect(box, 'the row has no box').not.toBeNull()
  const { x, y, width, height } = box!
  const mid = Math.round(y + height / 2)
  return [
    { label: 'start+12', x: Math.round(x + 12), y: mid },
    { label: 'centre', x: Math.round(x + width / 2), y: mid },
    { label: 'end-12', x: Math.round(x + width - 12), y: mid },
  ]
}

export interface MenuGeometry {
  x: number
  y: number
  width: number
  height: number
  maxWidth: string
  maxHeight: string
  overflowY: string
  fields: number
  viewport: { width: number, height: number }
}

/** The menu as a box plus the three declarations that decide whether it can be read at all. */
export async function menuGeometry(page: Page): Promise<MenuGeometry> {
  return page.evaluate((selector) => {
    const box = document.querySelector(selector) as HTMLElement
    const rect = box.getBoundingClientRect()
    const style = getComputedStyle(box)
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      maxWidth: style.maxWidth,
      maxHeight: style.maxHeight,
      overflowY: style.overflowY,
      // A native <select> or an <input> inside a menu is the shipped-outage shape the rules ban.
      fields: box.querySelectorAll('select, input, textarea').length,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    }
  }, MENU)
}

/** Whole box inside the viewport, with the numbers in the failure so a flip can be read off it. */
export function expectInsideViewport(geometry: MenuGeometry): void {
  const { x, y, width, height, viewport } = geometry
  expect({ x: x >= 0, y: y >= 0 }, JSON.stringify(geometry)).toEqual({ x: true, y: true })
  expect(x + width, JSON.stringify(geometry)).toBeLessThanOrEqual(viewport.width)
  expect(y + height, JSON.stringify(geometry)).toBeLessThanOrEqual(viewport.height)
}

/** WCAG contrast of an element's text against its own background, walking up for a real backdrop. */
export async function contrastOf(page: Page, selector: string): Promise<number> {
  return page.evaluate((one) => {
    const node = document.querySelector(one) as HTMLElement
    const channels = (value: string): number[] => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
    const opaque = (node2: HTMLElement | null): string => {
      let at: HTMLElement | null = node2
      while (at) {
        const background = getComputedStyle(at).backgroundColor
        const parts = (background.match(/[\d.]+/g) ?? []).map(Number)
        if (parts.length < 4 || parts[3]! > 0.5) return background
        at = at.parentElement
      }
      return 'rgb(255, 255, 255)'
    }
    const luminance = (value: string): number => {
      const linear = channels(value).map((part) => {
        const ratio = part / 255
        return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!
    }
    const text = luminance(getComputedStyle(node).color)
    const back = luminance(opaque(node))
    const light = Math.max(text, back)
    const dark = Math.min(text, back)
    return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100
  }, selector)
}

export interface RequestLog {
  /** Everything the page asked for, in order: `GET /api/...` or `ABORTED POST /api/...`. */
  lines: string[]
  /** Anything that was let through and was not a GET. Must stay empty on a live console. */
  writes: string[]
}

/**
 * The read-only rule for a driver pointed at a console with real mail in it (C52, C81).
 *
 * Aborts every non-GET request whose URL contains `/api`, before it leaves the browser. A right-click
 * is not supposed to write anything, which is exactly why this has to be enforced rather than trusted:
 * one stray click on `Mark as read`, on a send item or on a draft save would touch a real mailbox.
 * `HEAD` and `OPTIONS` are aborted too, on purpose: nothing a survey does needs them, and a narrow
 * allowlist is easier to defend in evidence than a list of forbidden verbs.
 *
 * The evidence this leaves is `log.lines` (what the page asked for, aborts marked) and `log.writes`,
 * which must be empty. Also blocks anything leaving the machine for a third party host, so a Slack
 * survey cannot post to a real workspace.
 *
 * `alsoBlock` is for the GETs that write anyway. Reading ONE message is the example that matters here:
 * the mail plugin marks a message read as a side effect of serving its body, so on a console with real
 * mail in it that GET is a write. A verb list alone would let it through.
 */
export async function guardReadOnly(page: Page, alsoBlock: RegExp[] = []): Promise<RequestLog> {
  const log: RequestLog = { lines: [], writes: [] }
  await page.route('**/*', async (route) => {
    const request = route.request()
    const method = request.method()
    const url = request.url()
    const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)
    const api = url.includes('/api')
    if (!local) {
      log.lines.push(`ABORTED ${method} ${url} (not this machine)`)
      await route.abort()
      return
    }
    if (api && method !== 'GET') {
      log.lines.push(`ABORTED ${method} ${url}`)
      await route.abort()
      return
    }
    if (alsoBlock.some((one) => one.test(url))) {
      log.lines.push(`ABORTED ${method} ${url} (reads with a side effect)`)
      await route.abort()
      return
    }
    if (method !== 'GET' && api) log.writes.push(`${method} ${url}`)
    log.lines.push(`${method} ${url}`)
    await route.continue()
  })
  return log
}

/** One evidence note per audit, next to its screenshots, so the numbers are not only in a transcript. */
export async function writeEvidence(name: string, sections: string[]): Promise<string> {
  const dir = await shotsDir()
  const target = `${dir}/${name}`
  await fs.writeFile(target, `${sections.join('\n')}\n`, 'utf8')
  return target
}

/** Screenshot into this package's own directory, and hand back the path for the log. */
export async function shoot(target: Locator | Page, name: string): Promise<string> {
  const dir = await shotsDir()
  const target2 = `${dir}/${name}.png`
  await target.screenshot({ path: target2 })
  return target2
}

export interface CornerPoint {
  x: number
  y: number
  /** How far above the viewport's bottom edge the lowest row actually is. */
  above: number
  /** What sits at the corner itself, which is usually the pane's `Load older` footer. */
  atCorner: string
}

/**
 * The lowest point over a message row at a given x, probing up from the bottom edge.
 *
 * The bottom of the message pane is not a row: `Load older` is a footer SIBLING of the scroller, so it
 * owns the last ~34px of the pane whenever another page exists. A test that right-clicked the literal
 * corner would either hit that button or pass vacuously. This finds the closest a row ever gets to the
 * corner and reports the distance, so the geometry is still measured at the edge the menu has to flip at.
 */
export async function lowestRowPointAt(page: Page, x: number, limit = 120): Promise<CornerPoint> {
  // Polled, because the layout at this width is a RENDER rather than a media query: a viewport change
  // is applied, the reader pane is dropped and the list grows into the space over the next frames, and
  // WebKit finishes that later than Chromium. A single probe caught the reader pane at the corner.
  let found = await probeOnce(page, x, limit)
  const deadline = Date.now() + 12_000
  while (found.y < 0 && Date.now() < deadline) {
    await page.waitForTimeout(400)
    found = await probeOnce(page, x, limit)
  }
  expect(found.y, `no message row within ${limit}px of the bottom edge; the corner holds ${found.atCorner}`)
    .toBeGreaterThan(0)
  return found
}

async function probeOnce(page: Page, x: number, limit: number): Promise<CornerPoint> {
  return page.evaluate(([px, cap]) => {
    const height = window.innerHeight
    const at = (y: number) => document.elementFromPoint(px as number, y) as HTMLElement | null
    const corner = at(height - 8)
    const describe = (node: HTMLElement | null) => node ? `${node.tagName.toLowerCase()}.${node.className || '(no class)'}` : 'nothing'
    for (let y = height - 8; y > height - (cap as number); y -= 4) {
      if (at(y)?.closest('[data-testid="mail-row"]')) {
        return { x: px as number, y, above: height - y, atCorner: describe(corner) }
      }
    }
    return { x: px as number, y: -1, above: -1, atCorner: describe(corner) }
  }, [x, limit])
}
