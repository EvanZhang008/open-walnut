/**
 * On a phone every control on every page takes a finger (C19: 44 px each way, in hit testing).
 *
 * 2026-11-27, the UI audit at 390 px on the user's data: Home, Notes, Mail, Calendar, Routines and
 * Settings passed, because each had been fixed screen by screen, while Org, Memory, Agents,
 * Commands, Apps and the Time page drew 22 to 36 px taps: the shared keys, tabs, segments,
 * disclosures and switches had no phone rule at their definitions. They have one now
 * (buttons.css, choice-controls.css), and this walks every page the router draws, read from the
 * source (the built-in apps in core-app-list.ts, App.tsx's own routes, and every plugin page the
 * Apps page links to), so a new page is checked the day it appears. Each page is read on its first
 * screen and on every screen down its main scroller, and a target whose centre a neighbour's 44 px
 * reaches over (it would take the tap) fails too.
 */
import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isolateUiPrefs } from './todo-panel-helpers'
import { PHONE, TARGET_SELECTOR, findSmallTargets, type SmallTarget } from './phone-helpers'

const read = (rel: string) => fs.readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), 'utf8')

test.use({
  viewport: PHONE.viewport,
  screen: PHONE.screen,
  deviceScaleFactor: PHONE.deviceScaleFactor,
  isMobile: true,
  hasTouch: true,
  userAgent: PHONE.userAgent,
})

/** Every page the router draws with no parameter: the built-in apps and App.tsx's own pages. */
function routedPages(): string[] {
  const apps = [...read('web/src/apps/core-app-list.ts').matchAll(/\bpath:\s*'(\/[^']*)'/g)].map((m) => m[1]!)
  const own = [...read('web/src/App.tsx').matchAll(/<Route path="(\/[^"*:]*)" element=\{<(\w+)/g)]
    // A redirect draws nothing of its own (its target is walked under its own name).
    .filter((m) => !/^(Navigate|\w+Redirect)$/.test(m[2]!))
    // Pages only another app opens with a reference in the URL, never from the rail.
    .filter((m) => !['/open-ref', '/connect-extension'].includes(m[1]!))
    .map((m) => m[1]!)
  return [...new Set([...apps, ...own])]
}

async function boot(page: Page, url: string): Promise<void> {
  await page.goto(url)
  // The bar holds Menu on a page and Back in a pane (a Settings pane): either way it is up.
  await expect(page.locator('.phone-topbar')).toBeVisible({ timeout: 30_000 })
  // The page's data, then one frame for its layout.
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
  await expect(page.locator('body')).not.toContainText(/Loading( \w+)?…/, { timeout: 15_000 }).catch(() => {})
  await page.waitForTimeout(400)
}

/** The shared targets, and what takes a tap without being one of them: a segment (a label over a
 *  hidden radio, which the shared list skips as invisible), a switch, a summary. */
const TARGETS = `${TARGET_SELECTOR}, [role=radio], [role=switch], label.wn-seg-item, summary`

/** The small targets of the page, its first screen and each screen down its tallest scroller. A
 *  target scrolled up to the top bar is read on the screen before (the bar takes its probes). */
async function scanPage(page: Page): Promise<string[]> {
  // A link inside a sentence takes the sentence's line, as the standard's link in text does: the
  // shared check skips what is aria-hidden, so the walk hides those (this page is read, then left).
  await page.evaluate(() => {
    for (const a of document.querySelectorAll<HTMLElement>('a[href]')) {
      const line = a.parentElement?.textContent?.trim().length ?? 0
      if (getComputedStyle(a).display.startsWith('inline') && !getComputedStyle(a).display.includes('flex') && line > (a.textContent?.trim().length ?? 0) + 12) a.setAttribute('aria-hidden', 'true')
    }
    // A card's name whose ::after covers the whole card (the Apps page): the card is its target.
    for (const el of document.querySelectorAll('.apps-card-main')) el.setAttribute('aria-hidden', 'true')
  })
  const out = new Set<string>()
  const add = (list: SmallTarget[], screen: number) => {
    for (const t of list) if (screen === 0 || t.y >= 66) out.add(`${t.tag} "${t.label}" ${t.width}x${t.height}`)
  }
  add(await findSmallTargets(page, 'body', TARGETS, { covered: true }), 0)
  for (let screen = 1; screen <= 6; screen++) {
    const moved = await page.evaluate(() => {
      const scrollers = [...document.querySelectorAll<HTMLElement>('.app-shell *')].filter((el) => {
        const cs = getComputedStyle(el)
        return /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 200
      })
      const main = scrollers.sort((a, b) => b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth)[0]
      if (!main) return false
      const before = main.scrollTop
      main.scrollTop = before + main.clientHeight - 120
      return main.scrollTop > before
    })
    if (!moved) break
    await page.waitForTimeout(250)
    add(await findSmallTargets(page, 'body', TARGETS, { covered: true }), screen)
  }
  return [...out]
}

test('every page the router draws gives every control a 44 px target on a phone', async ({ page }) => {
  test.setTimeout(240_000)
  await isolateUiPrefs(page)
  await page.addInitScript(() => {
    try { localStorage.setItem('open-walnut-home-chat-visible', 'false') } catch { /* storage off */ }
  })
  const pages = routedPages()
  // The source still names the pages the audit found (a rename here would make the walk empty).
  for (const p of ['/', '/notes', '/calendar', '/routines', '/apps', '/settings', '/org', '/agents', '/commands', '/memory']) {
    expect(pages, `the walk reads ${p} from the source`).toContain(p)
  }
  // The plugin pages: every app page the Apps page links to.
  await boot(page, '/apps')
  const pluginPages = await page.evaluate(() => [...new Set([...document.querySelectorAll('a[href^="/apps/"]')]
    .map((a) => a.getAttribute('href') || ''))].filter((h) => /^\/apps\/[^/]+/.test(h)))
  // Every key of the phone's bar sits inside the bar: a key made relative keeps no desktop offset
  // (2026-11-27 review: the Menu key moved 12 px right and down when it stopped being static).
  const outside = await page.evaluate(() => {
    const bar = document.querySelector('.phone-topbar')!.getBoundingClientRect()
    return [...document.querySelectorAll<HTMLElement>('.phone-topbar button')].filter((b) => {
      const r = b.getBoundingClientRect()
      return r.width > 0 && (r.top < bar.top - 0.5 || r.bottom > bar.bottom + 0.5 || r.left < bar.left - 0.5 || r.right > bar.right + 0.5)
    }).map((b) => b.getAttribute('aria-label') || b.textContent || '')
  })
  expect(outside, 'keys that leave the phone bar').toEqual([])
  const found: Record<string, string[]> = {}
  for (const url of [...pages, ...pluginPages, '/settings#usage', '/settings#hooks']) {
    await test.step(url, async () => {
      await boot(page, url)
      const small = await scanPage(page)
      if (small.length) found[url] = small
    })
  }
  expect(found).toEqual({})
})
