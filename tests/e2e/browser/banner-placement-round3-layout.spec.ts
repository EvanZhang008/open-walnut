/**
 * The third nitpick round on the attention card, layout (BP-R3-N<n>): every
 * problem reads at a glance (dense rows), the host list is the one scroll
 * region and ends on a row or line boundary, the footer's controls never move
 * and never look like a fix, and a narrow task panel never scrolls sideways.
 * Host frames and local health are routed client-side (host-problems-helpers.ts).
 *
 * Run: PW_TEST_PORT=35987 PW_IGNORE_LOAD=1 npx playwright test banner-placement-round3 --project=chromium --workers=1
 *      PW_WEBKIT=1 PW_TEST_PORT=35987 PW_IGNORE_LOAD=1 npx playwright test banner-placement-round3 --project=webkit --workers=1
 */
import fs from 'node:fs'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { CHAT_VISIBLE_KEY, banner, failed, hideTaskPanel, isolatePrefs, resetServerHostFixture, row } from './host-problems-helpers'
import { openDraft } from './draft-helpers'
import { loadApp, loadFixture, openPicker, picker } from './host-problems-fixture-helpers'
import { BP_SHOTS, boxGap, bpSetup, fixtureHosts, hostsOf } from './banner-placement-helpers'

test.describe.configure({ timeout: 90_000 })
test.beforeAll(async ({ request }) => {
  fs.mkdirSync(BP_SHOTS, { recursive: true })
  await resetServerHostFixture(request)
})

const chatHidden = async (p: Page): Promise<void> => { await p.addInitScript((c) => { localStorage.setItem(c, 'false') }, CHAT_VISIBLE_KEY) }

interface ListView { rows: Array<{ host: string; headWhole: boolean; headShown: boolean; buttons: string[]; hint: boolean; open: boolean }>; sliced: string[]; cue: string; overflowX: boolean }

/** What the host list shows: per row, is its headline whole in view; what the list's bottom edge cuts in half. */
function listView(card: Locator): Promise<ListView> {
  return card.evaluate((el) => {
    const sc = el.querySelector<HTMLElement>('.hpb-scroll')!
    const s = sc.getBoundingClientRect()
    const top = Math.max(0, s.top) - 1, bottom = Math.min(window.innerHeight, s.bottom) + 1
    const rows = Array.from(sc.querySelectorAll<HTMLElement>('li.hpb-row[data-host]')).map((li) => {
      const head = li.querySelector<HTMLElement>('.hft-headline, .hpb-headline')!
      const r = head.getBoundingClientRect()
      return {
        host: li.dataset.host!, headWhole: r.top >= top && r.bottom <= bottom, headShown: r.top < bottom - 4,
        buttons: Array.from(li.querySelectorAll<HTMLElement>('.hpb-actions button')).map((b) => (b.textContent ?? '').trim()),
        hint: !!li.querySelector('.hft-hint'), open: li.classList.contains('hpb-open'),
      }
    })
    const sliced = Array.from(sc.querySelectorAll<HTMLElement>('button, .hft-headline, .hpb-headline')).filter((e) => {
      const r = e.getBoundingClientRect()
      return r.height > 0 && r.top < s.bottom - 1 && r.bottom > s.bottom + 1
    }).map((e) => (e.textContent ?? '').trim().slice(0, 30))
    return { rows, sliced, cue: el.querySelector('[data-testid="hpb-below"]')?.textContent ?? '', overflowX: sc.scrollWidth > sc.clientWidth + 1 }
  })
}

test.describe('every problem at a glance (N1, N9)', () => {
  test('BP-R3-N1: 1280x800, four problems: each row starts as its headline and one action, and all four headlines show', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await bpSetup(page, { hosts: fixtureHosts() })
    await expect.poll(() => hostsOf(banner(page)), { timeout: 20_000 }).toEqual(['keybox', 'certbox', 'netbox', 'signbox'])
    await page.waitForTimeout(400)
    const v = await listView(banner(page))
    await banner(page).screenshot({ path: `${BP_SHOTS}/r3-n1-1280x800.png` })
    for (const r of v.rows) expect(r, r.host).toMatchObject({ headWhole: true, open: false, hint: false })
    expect(v.rows.map((r) => r.buttons.length)).toEqual([1, 1, 1, 1])
    expect(v.rows.map((r) => r.buttons[0])).toEqual(['Retry', 'Retry', 'Retry', 'Check again'])
    expect(v.sliced).toEqual([])
    expect(v.cue).toBe('')
  })

  test('BP-R3-N1: 980x800, chat hidden (the report): shown headlines are whole, the rest are one click away, nothing is cut in half', async ({ page }) => {
    await page.setViewportSize({ width: 980, height: 800 })
    await bpSetup(page, { hosts: fixtureHosts(), before: chatHidden })
    await expect.poll(() => hostsOf(banner(page)), { timeout: 20_000 }).toEqual(['keybox', 'certbox', 'netbox', 'signbox'])
    await page.waitForTimeout(400)
    const v = await listView(banner(page))
    await banner(page).screenshot({ path: `${BP_SHOTS}/r3-n1-980x800.png` })
    const shown = v.rows.filter((r) => r.headShown)
    expect(shown.length).toBeGreaterThanOrEqual(3)
    for (const r of shown) expect(r.headWhole, r.host).toBe(true)
    expect(v.sliced).toEqual([])
    expect(v.overflowX).toBe(false)
    const hidden = v.rows.length - shown.length
    if (hidden > 0) {
      // 'N more below' is a real button: it brings the next row up.
      const cue = banner(page).getByRole('button', { name: /more below$/ })
      await expect(cue).toBeVisible()
      await cue.click()
      await expect.poll(async () => (await listView(banner(page))).rows.at(-1)!.headWhole).toBe(true)
    }
  })
})

test.describe('one scroll region, a whole local sentence, a footer that stays (N2, N4, N8, N16)', () => {
  test('BP-R3-N2: 980x600, local sign-in over four hosts: the card never scrolls, the host list is the one scroller, the fix reads whole, Dismiss all shows', async ({ page }) => {
    await page.setViewportSize({ width: 980, height: 600 })
    await bpSetup(page, { hosts: fixtureHosts(), local: 'sign-in', before: chatHidden })
    await expect(banner(page).locator('[data-testid="setup-banner-sign-in"]')).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => hostsOf(banner(page)), { timeout: 20_000 }).toEqual(['keybox', 'certbox', 'netbox', 'signbox'])
    await page.waitForTimeout(400)
    const m = await banner(page).evaluate((el) => {
      const scrollers = [el, ...Array.from(el.querySelectorAll<HTMLElement>('*'))].filter((e) => {
        const oy = getComputedStyle(e).overflowY
        return (oy === 'auto' || oy === 'scroll') && e.scrollHeight > e.clientHeight + 1
      }).map((e) => e.className)
      const lead = el.querySelector<HTMLElement>('.setup-lead')!
      const all = el.querySelector<HTMLElement>('.ab-dismiss-all')!.getBoundingClientRect()
      const c = el.getBoundingClientRect()
      return {
        cardScrolls: el.scrollHeight > el.clientHeight + 1, scrollers, leadText: lead.innerText.trim(),
        leadClipped: lead.scrollHeight > lead.clientHeight + 1, allInCard: all.top >= c.top && all.bottom <= c.bottom + 1 && all.bottom <= window.innerHeight,
      }
    })
    await banner(page).screenshot({ path: `${BP_SHOTS}/r3-n2-980x600-local.png` })
    expect(m.cardScrolls).toBe(false)
    expect(m.scrollers).toEqual(['hpb-scroll'])
    expect(m.leadText).toBe('Run claude in a terminal and sign in.')
    expect(m.leadClipped).toBe(false)
    expect(m.allInCard).toBe(true)
    expect((await listView(banner(page))).sliced).toEqual([])
  })

  test('BP-R3-N4: five problems: the cap link reads and 2 more and no scroll cue says more below beside it', async ({ page }) => {
    await bpSetup(page, { hosts: [failed('devbox', 'Dev box', 'unreachable'), ...fixtureHosts().filter((h) => h.host !== 'devbox')] })
    await expect(banner(page).locator('.hpb-more')).toHaveText('and 2 more', { timeout: 20_000 })
    await page.waitForTimeout(300)
    await expect(banner(page).locator('[data-testid="hpb-below"]')).toHaveCount(0)
    await expect(banner(page).locator('.hpb-foot')).not.toContainText('below')
  })

  test('BP-R3-N8 + N16: Dismiss all is a quiet text button that stays put while the list scrolls', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 600 })
    await bpSetup(page, { hosts: fixtureHosts(), local: 'sign-in' })
    await expect.poll(() => hostsOf(banner(page)), { timeout: 20_000 }).toEqual(['keybox', 'certbox', 'netbox', 'signbox'])
    const all = banner(page).locator('.ab-dismiss-all')
    const retry = row(page, 'keybox').getByTestId('hpb-retry')
    const look = (l: Locator) => l.evaluate((e) => { const cs = getComputedStyle(e); return { color: cs.color, border: cs.borderTopStyle, bg: cs.backgroundColor } })
    const [a, r] = [await look(all), await look(retry)]
    expect(a.color).not.toBe(r.color)
    expect(a.border).toBe('none')
    await all.hover()
    const allHover = (await look(all)).bg
    await retry.hover()
    expect(allHover).not.toBe((await look(retry)).bg)
    const xs: number[] = []
    const sc = banner(page).locator('.hpb-scroll')
    for (const to of [0, 60, 10_000]) {
      await sc.evaluate((e, t) => { e.scrollTop = t }, to)
      await page.waitForTimeout(150)
      xs.push(Math.round((await all.boundingBox())!.x))
    }
    expect(Math.max(...xs) - Math.min(...xs), JSON.stringify(xs)).toBeLessThanOrEqual(1)
  })
})

test.describe('narrow and compact (N3, N10)', () => {
  test('BP-R3-N10: a task panel dragged to 20% of 980: whole host names, no sideways scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 980, height: 800 })
    await bpSetup(page, { hosts: fixtureHosts(), before: async (p) => { await chatHidden(p); await p.addInitScript(() => localStorage.setItem('open-walnut-todo-width', '20')) } })
    await expect.poll(() => hostsOf(banner(page)), { timeout: 20_000 }).toEqual(['keybox', 'certbox', 'netbox', 'signbox'])
    await page.waitForTimeout(400)
    const m = await banner(page).evaluate((el) => {
      const sc = el.querySelector<HTMLElement>('.hpb-scroll')!
      const head = el.querySelector<HTMLElement>('li.hpb-row[data-host="keybox"] .hft-headline')!
      return { card: Math.round(el.getBoundingClientRect().width), overflowX: sc.scrollWidth > sc.clientWidth + 1, headCut: head.scrollWidth > head.clientWidth + 1 || head.scrollHeight > head.clientHeight + 1, head: head.innerText }
    })
    await banner(page).screenshot({ path: `${BP_SHOTS}/r3-n10-narrow.png` })
    expect(m.card).toBeLessThan(200)
    expect(m).toMatchObject({ overflowX: false, headCut: false })
    expect(m.head.replace(/\s+/g, ' ')).toContain('Key box')
  })

  test('BP-R3-N3: the compact draft card: no corner x; Dismiss all is text at the end, 24px or more from every row x', async ({ page }) => {
    await bpSetup(page, { hosts: fixtureHosts(), before: chatHidden })
    const draft = await openDraft(page)
    await hideTaskPanel(page)
    const compact = draft.locator('[data-testid="attention-banner"][data-mount="draft"]')
    await expect(compact).toHaveCount(1, { timeout: 10_000 })
    await expect(compact.locator('.ab-dismiss-all-x')).toHaveCount(0)
    const all = compact.getByRole('button', { name: 'Dismiss all', exact: true })
    await expect(all).toHaveText('Dismiss all')
    const allBox = (await all.boundingBox())!
    for (const x of await compact.locator('.hpb-x').all()) expect(boxGap(allBox, (await x.boundingBox())!)).toBeGreaterThanOrEqual(24)
    await compact.screenshot({ path: `${BP_SHOTS}/r3-n3-compact.png` })
  })
})

test.describe('copy next to the card (N17)', () => {
  test('BP-R3-N17: the draft folder picker says its purpose and placeholder without an em or en dash', async ({ page, request }) => {
    await loadFixture(request, 'host-problems')
    await isolatePrefs(page)
    await loadApp(page)
    await openPicker(page)
    const text = await picker(page).evaluate((el) => {
      // What the picker shows: its words and its input placeholder (N17's two strings).
      const inputs = Array.from(el.querySelectorAll<HTMLInputElement>('input')).map((i) => i.placeholder)
      return [(el as HTMLElement).innerText, ...inputs].join('\n')
    })
    expect(text).toContain('A task is created automatically to track it.')
    expect(text).not.toMatch(/[\u2013\u2014]/)
  })
})
