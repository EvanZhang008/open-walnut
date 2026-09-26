/**
 * The nitpick round on the task panel and notification panel card (BP-N<n>,
 * plus the failed checklist items C25, C30, C31): the first host row always
 * shows its headline and one button, the rows name their host first, counts
 * and cues for clipped rows, result lines in place, no entrance motion when
 * the card only changed place, undo lines that follow the card, one look for
 * one alert on the rail and the bell, and the System pane's host list.
 * Host frames and local health are routed client-side (host-problems-helpers.ts).
 *
 * Run: PW_TEST_PORT=35981 PW_IGNORE_LOAD=1 npx playwright test banner-placement-fixes --project=chromium --workers=1
 *      PW_WEBKIT=1 PW_TEST_PORT=35981 PW_IGNORE_LOAD=1 npx playwright test banner-placement-fixes --project=webkit --workers=1
 */
import fs from 'node:fs'
import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  CHAT_VISIBLE_KEY, banner, connected, failed, hideTaskPanel, isolatePrefs, now, resetServerHostFixture, row,
  showTaskPanel, signedOut,
} from './host-problems-helpers'
import { loadApp, loadFixture, openBell, panelBanner } from './host-problems-fixture-helpers'
import {
  BP_SHOTS, bellDot, bpSetup, cardRow, closePanel, fixtureHosts, goRail, hostErrorRecord, hostsOf, openPanelCard, openRow, railButton,
  toolbarHide,
} from './banner-placement-helpers'

test.describe.configure({ timeout: 90_000 })

test.beforeAll(async ({ request }) => {
  fs.mkdirSync(BP_SHOTS, { recursive: true })
  await resetServerHostFixture(request)
})

/** The user's own layout: the task panel shown, the Ask Walnut slot hidden (call before the first load). */
async function chatHidden(page: Page): Promise<void> {
  await page.addInitScript((c) => { localStorage.setItem(c, 'false') }, CHAT_VISIBLE_KEY)
}

/**
 * Is `sel` inside the card's first host row whole on screen: inside the viewport,
 * the card's box and the host list's scroll box (both clip)?
 */
async function firstRowSeen(card: Locator): Promise<{ scrollH: number; headline: boolean; button: boolean; host: string }> {
  return card.evaluate((el) => {
    const sc = el.querySelector<HTMLElement>('.hpb-scroll')
    const li = sc?.querySelector<HTMLElement>('li.hpb-row')
    const c = el.getBoundingClientRect()
    const s = sc?.getBoundingClientRect()
    const whole = (e: Element | null | undefined): boolean => {
      if (!e || !s) return false
      const r = e.getBoundingClientRect()
      const top = Math.max(0, c.top, s.top) - 1
      const bottom = Math.min(window.innerHeight, c.bottom, s.bottom) + 1
      return r.height > 0 && r.top >= top && r.bottom <= bottom
    }
    const head = li?.querySelector('.hft-headline, .hpb-headline, .hpb-trying')
    const buttons = Array.from(li?.querySelectorAll('.hpb-actions button') ?? [])
    return { scrollH: sc?.clientHeight ?? 0, headline: whole(head), button: buttons.some((b) => whole(b)), host: li?.getAttribute('data-host') ?? '' }
  })
}

test.describe('the first host row is always readable (N1, N2)', () => {
  const sizes = [
    { name: '1280x800', width: 1280, height: 800, narrow: false },
    { name: '1280x600', width: 1280, height: 600, narrow: false },
    { name: '980x800 chat hidden', width: 980, height: 800, narrow: true },
  ]
  for (const size of sizes) {
    test(`BP-N1: ${size.name}, a local sign-in over four host problems: the first host row shows its headline and a whole button`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height })
      await bpSetup(page, { hosts: fixtureHosts(), local: 'sign-in', ...(size.narrow ? { before: chatHidden } : {}) })
      await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
      await expect(banner(page).locator('[data-testid="setup-banner-sign-in"]')).toBeVisible()
      await expect.poll(() => hostsOf(banner(page)), { timeout: 20_000 }).toEqual(['keybox', 'certbox', 'netbox', 'signbox'])
      await page.waitForTimeout(400)
      const seen = await firstRowSeen(banner(page))
      await banner(page).screenshot({ path: `${BP_SHOTS}/n1-${size.name.replace(/\W+/g, '-')}.png` })
      expect(seen.scrollH).toBeGreaterThan(40)
      expect(seen).toMatchObject({ headline: true, button: true, host: 'keybox' })
    })

    test(`BP-N2: ${size.name}, four host problems: row 1's headline and a whole button show without scrolling`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height })
      await bpSetup(page, { hosts: fixtureHosts(), ...(size.narrow ? { before: chatHidden } : {}) })
      await expect.poll(() => hostsOf(banner(page)), { timeout: 20_000 }).toEqual(['keybox', 'certbox', 'netbox', 'signbox'])
      await page.waitForTimeout(400)
      expect(await firstRowSeen(banner(page))).toMatchObject({ headline: true, button: true, host: 'keybox' })
      // Several rows: row 1 starts closed like the rest (dense, BP-R3-N1); its hint is one click away.
      await expect(row(page, 'keybox').locator('.hft-hint')).toHaveCount(0)
      await row(page, 'keybox').getByRole('button', { name: 'Show details' }).click()
      await expect(row(page, 'keybox').locator('.hft-hint')).toBeVisible()
    })
  }
})

/** Rows whose first line shows in the host list, and the 'N more below' cue. */
async function visibleRows(card: Locator): Promise<{ total: number; visible: number; below: number }> {
  return card.evaluate((el) => {
    const sc = el.querySelector<HTMLElement>('.hpb-scroll')!
    const bottom = Math.min(sc.getBoundingClientRect().bottom, el.getBoundingClientRect().bottom)
    const lis = Array.from(sc.querySelectorAll<HTMLElement>('li.hpb-row[data-host]'))
    const visible = lis.filter((li) => li.getBoundingClientRect().top <= bottom - 12).length
    const cue = el.querySelector('[data-testid="hpb-below"]')?.textContent ?? ''
    return { total: lis.length, visible, below: cue ? parseInt(cue, 10) : 0 }
  })
}

test.describe('counts, cues and reading order (N3, N10, N13, N15)', () => {
  test('BP-N3: the card says how many hosts need attention; a clipped list fades and counts the rows below; and N more counts only unrendered rows', async ({ page }) => {
    await bpSetup(page, { hosts: fixtureHosts() })
    await expect.poll(() => hostsOf(banner(page)), { timeout: 20_000 }).toEqual(['keybox', 'certbox', 'netbox', 'signbox'])
    await expect(banner(page).locator('.hpb-header .hpb-count')).toHaveText('(4)')
    await page.waitForTimeout(300)
    const v = await visibleRows(banner(page))
    expect(v.total).toBe(4)
    expect(v.visible + v.below).toBe(4)
    await expect(banner(page).locator('.hpb-scroll')).toHaveAttribute('data-more-below', v.below > 0 ? 'true' : 'false')
    // Scrolled to the end: nothing below, no fade.
    await banner(page).locator('.hpb-scroll').evaluate((el) => { el.scrollTop = el.scrollHeight })
    await expect(banner(page).locator('[data-testid="hpb-below"]')).toHaveCount(0)
    await expect(banner(page).locator('.hpb-scroll')).toHaveAttribute('data-more-below', 'false')
  })

  test('BP-N3: five problems: 5 hosts in the title; the rendered rows are the visible ones plus the cue; and 2 more are the rest', async ({ page }) => {
    await bpSetup(page, { hosts: [failed('devbox', 'Dev box', 'unreachable'), ...fixtureHosts().filter((h) => h.host !== 'devbox')] })
    await expect(banner(page).locator('.hpb-more')).toHaveText('and 2 more', { timeout: 20_000 })
    await expect(banner(page).locator('.hpb-header .hpb-count')).toHaveText('(5)')
    await page.waitForTimeout(300)
    const v = await visibleRows(banner(page))
    expect(v.total).toBe(3)
    expect(v.visible + v.below).toBe(3)
    await banner(page).screenshot({ path: `${BP_SHOTS}/n3-five-problems.png` })
  })

  test('BP-N10 + BP-N15: every row starts with a bold headline naming its host, then its buttons, then details, then the x', async ({ page }) => {
    await bpSetup(page, { hosts: fixtureHosts() })
    await expect.poll(() => hostsOf(banner(page)), { timeout: 20_000 }).toEqual(['keybox', 'certbox', 'netbox', 'signbox'])
    const order = await banner(page).locator('li.hpb-row[data-host]').evaluateAll((lis) => lis.map((li) => {
      const head = li.querySelector<HTMLElement>('.hft-headline, .hpb-headline')!
      const first = li.querySelector<HTMLElement>('button')!
      const x = li.querySelector<HTMLElement>('.hpb-x')!
      const buttons = Array.from(li.querySelectorAll('button'))
      return {
        host: li.getAttribute('data-host'),
        text: head.textContent ?? '',
        bold: Number(getComputedStyle(head).fontWeight) >= 600,
        headFirst: !!(head.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING),
        xLast: buttons[buttons.length - 1] === x,
      }
    }))
    const labels: Record<string, string> = { keybox: 'Key box', certbox: 'Cert box', netbox: 'Net box', signbox: 'Sign box' }
    for (const o of order) {
      expect(o.text, o.host!).toContain(labels[o.host!])
      expect(o, o.host!).toMatchObject({ bold: true, headFirst: true, xLast: true })
    }
    // The readiness row's headline is its first sentence; the command is in the detail below.
    const sign = order.find((o) => o.host === 'signbox')!
    expect(sign.text).not.toMatch(/ssh|claude once/i)
    expect(sign.text.trim().endsWith('.')).toBe(true)
  })

  test('BP-N13: the host subhead reads Remote hosts, as the System pane label does (no upper case)', async ({ page }) => {
    await bpSetup(page, { hosts: fixtureHosts(), local: 'sign-in' })
    const sub = banner(page).locator('.hpb-subhead')
    await expect(sub).toHaveText('Remote hosts', { timeout: 20_000 })
    expect(await sub.evaluate((el) => [getComputedStyle(el).textTransform, (el as HTMLElement).innerText])).toEqual(['none', 'Remote hosts'])
    await expect(banner(page).locator('.hpb-subhead-row .hpb-count')).toHaveText('(4)')
  })

  test('BP-N12: the local section copies with the same text Copy button as the host rows, at least 24px tall', async ({ page }) => {
    await bpSetup(page, { hosts: fixtureHosts(), local: 'sign-in' })
    const copy = banner(page).locator('[data-testid="setup-banner-sign-in"] .setup-copy-btn')
    await expect(copy).toHaveText('Copy', { timeout: 20_000 })
    expect((await copy.boundingBox())!.height).toBeGreaterThanOrEqual(24)
    await expect(banner(page).getByText('⎘')).toHaveCount(0)
  })
})

test.describe('narrow and phone widths (N6, N11, C30, C31)', () => {
  test('BP-N6 + BP-C31: a 390x844 phone: the first row names its host (the headline wraps, never cut) and a button shows', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await bpSetup(page, { hosts: fixtureHosts() })
    await expect.poll(() => hostsOf(banner(page)), { timeout: 20_000 }).toEqual(['keybox', 'certbox', 'netbox', 'signbox'])
    await page.waitForTimeout(300)
    const head = row(page, 'keybox').locator('.hft-headline')
    const h = await head.evaluate((el) => ({ text: (el as HTMLElement).innerText, cut: el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1 }))
    expect(h).toEqual({ text: 'Could not connect to Key box', cut: false })
    expect(await firstRowSeen(banner(page))).toMatchObject({ headline: true, button: true })
    await banner(page).screenshot({ path: `${BP_SHOTS}/n6-phone-390.png` })
  })

  test('BP-C30: a 980px window with a 300px task panel: the readiness row headline is 2 lines at most, folded and open', async ({ page }) => {
    await page.setViewportSize({ width: 980, height: 800 })
    await bpSetup(page, { hosts: [failed('certbox', 'Cert box', 'cert_expired', { retryAt: now() + 192_000 }), signedOut('signbox', 'Sign box')] })
    await page.addStyleTag({ content: '.main-page-todo { flex: 0 0 300px !important; width: 300px !important; min-width: 0 !important; max-width: 300px !important; }' })
    await expect(row(page, 'signbox')).toBeVisible({ timeout: 20_000 })
    const lines = (l: Locator) => l.evaluate((el) => Math.round(el.getBoundingClientRect().height / (parseFloat(getComputedStyle(el).lineHeight) || 17)))
    const msg = row(page, 'signbox').locator('.hpb-message')
    expect(await lines(msg)).toBeLessThanOrEqual(2)
    await row(page, 'signbox').getByRole('button', { name: 'Show details' }).click()
    expect(await lines(msg)).toBeLessThanOrEqual(2)
    await expect(row(page, 'signbox').locator('.hpb-rest')).toBeVisible()
    expect(await banner(page).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  })

  test('BP-N11: a 980px window: code breaks only between tokens (a host name or URL never splits)', async ({ page }) => {
    await page.setViewportSize({ width: 980, height: 800 })
    await bpSetup(page, { hosts: fixtureHosts(), local: 'sign-in', before: chatHidden })
    await expect(row(page, 'keybox')).toBeVisible({ timeout: 20_000 })
    await openRow(row(page, 'keybox'))
    await expect(row(page, 'keybox').locator('.hft-hint')).toBeVisible()
    // Every whitespace-free token inside a code chip sits on one line.
    const split = await banner(page).evaluate((el) => {
      const out: string[] = []
      for (const code of Array.from(el.querySelectorAll('code'))) {
        const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const text = n.textContent ?? ''
          for (const m of text.matchAll(/\S+/g)) {
            const r = document.createRange()
            r.setStart(n, m.index!)
            r.setEnd(n, m.index! + m[0].length)
            const tops = new Set(Array.from(r.getClientRects()).filter((b) => b.width > 0).map((b) => Math.round(b.top)))
            if (tops.size > 1) out.push(m[0])
          }
        }
      }
      return out
    })
    expect(split).toEqual([])
  })
})

/** The focused element and its row, measured against the host list's visible box. */
async function focusInView(page: Page): Promise<{ inCard: boolean; whole: boolean; rowTopShown: boolean; fits: boolean }> {
  return page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null
    const sc = a?.closest<HTMLElement>('.hpb-scroll')
    if (!a || !sc) return { inCard: !!a?.closest('[data-testid="attention-banner"]'), whole: true, rowTopShown: true, fits: true }
    const s = sc.getBoundingClientRect()
    const r = a.getBoundingClientRect()
    const li = a.closest('li')!.getBoundingClientRect()
    return {
      inCard: true, whole: r.top >= s.top - 1 && r.bottom <= s.bottom + 1,
      rowTopShown: li.top >= s.top - 1, fits: r.bottom - li.top <= sc.clientHeight,
    }
  })
}

test.describe('acting on a row (N4, N19)', () => {
  test('BP-N4: Retry on row 1 reads its result in place: the list never scrolls, the row keeps its height, the headline stays', async ({ page }) => {
    await bpSetup(page, { hosts: fixtureHosts() })
    await expect.poll(() => hostsOf(banner(page)), { timeout: 20_000 }).toEqual(['keybox', 'certbox', 'netbox', 'signbox'])
    const r = row(page, 'keybox')
    const sc = banner(page).locator('.hpb-scroll')
    const before = (await r.boundingBox())!
    await r.getByTestId('hpb-retry').click()
    await expect(r.getByTestId('hpb-receipt')).toHaveText('Tried again just now: same result', { timeout: 10_000 })
    expect(await sc.evaluate((el) => el.scrollTop)).toBe(0)
    expect(Math.abs((await r.boundingBox())!.height - before.height)).toBeLessThanOrEqual(1)
    expect(await firstRowSeen(banner(page))).toMatchObject({ headline: true, host: 'keybox' })
    await expect(r.getByTestId('hpb-receipt')).toHaveCount(0, { timeout: 10_000 })
    expect(await sc.evaluate((el) => el.scrollTop)).toBe(0)
    expect(Math.abs((await r.boundingBox())!.height - before.height)).toBeLessThanOrEqual(1)
  })

  test('BP-N4: tabbing through the rows keeps each focused control whole and its row headline in view', async ({ page, browserName }) => {
    const TAB = browserName === 'webkit' ? 'Alt+Tab' : 'Tab'
    await bpSetup(page, { hosts: fixtureHosts() })
    await expect.poll(() => hostsOf(banner(page)), { timeout: 20_000 }).toEqual(['keybox', 'certbox', 'netbox', 'signbox'])
    await toolbarHide(page).focus()
    let inCard = 0
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press(TAB)
      await page.waitForTimeout(50)
      const f = await focusInView(page)
      if (!f.inCard) break
      inCard++
      expect(f.whole, `stop ${i}`).toBe(true)
      if (f.fits) expect(f.rowTopShown, `stop ${i}`).toBe(true)
    }
    expect(inCard).toBeGreaterThan(4)
  })

  test('BP-N19: a successful Retry: the success line keeps the row height while the pointer is in the card; the rows below stay put', async ({ page }) => {
    const h = await bpSetup(page, { hosts: fixtureHosts() })
    await expect.poll(() => hostsOf(banner(page)), { timeout: 20_000 }).toEqual(['keybox', 'certbox', 'netbox', 'signbox'])
    h.connectAnswer = (host) => (host === 'netbox' ? connected('netbox', 'Net box') : null)
    const net = row(page, 'netbox')
    // The click's own scroll-into-view and focus first, so the positions below are the ones the click sees.
    await net.getByTestId('hpb-retry').scrollIntoViewIfNeeded()
    await net.getByTestId('hpb-retry').focus()
    await page.waitForTimeout(150)
    const before = (await net.boundingBox())!
    const signTop = (await row(page, 'signbox').boundingBox())!.y
    await net.getByTestId('hpb-retry').click()
    const ready = banner(page).locator('li.hpb-row[data-host="netbox"][data-type="ready"]')
    await expect(ready).toBeVisible({ timeout: 10_000 })
    expect((await ready.boundingBox())!.height).toBeGreaterThanOrEqual(before.height - 1)
    // 3px: WebKit nudges the list's scroll by 2px when the row's element is swapped (no script scrolls it);
    // the bug this pins moved the next row up by the whole row (about 50px).
    expect(Math.abs((await row(page, 'signbox').boundingBox())!.y - signTop)).toBeLessThanOrEqual(3)
    await expect(ready).not.toHaveClass(/check/)
    expect(await ready.innerText()).not.toContain('✓')
  })
})

test.describe('undo lines (N7, N8)', () => {
  // Round 4 (N3-1): the line keeps its row's height whether or not the pointer is in the
  // card; holding it only under the pointer made it grow back after an owner switch.
  test('BP-N7: an undo line holds its row height with the pointer in the card or away, until it collapses', async ({ page }) => {
    await bpSetup(page, { hosts: fixtureHosts() })
    await expect.poll(() => hostsOf(banner(page)), { timeout: 20_000 }).toEqual(['keybox', 'certbox', 'netbox', 'signbox'])
    const key = (await row(page, 'keybox').boundingBox())!
    await row(page, 'keybox').getByRole('button', { name: 'Dismiss Key box' }).click()
    const undo = banner(page).getByTestId('hpb-undo-row').first()
    await expect(undo).toBeVisible()
    expect((await undo.boundingBox())!.height).toBeGreaterThanOrEqual(key.height - 2)
    await page.mouse.move(2, 2)
    await page.waitForTimeout(800)
    expect((await undo.boundingBox())!.height).toBeGreaterThanOrEqual(key.height - 2)
    await expect(banner(page).getByTestId('hpb-undo-row')).toHaveCount(0, { timeout: 12_000 })
  })

  // Round 4 (N3-12): the card keeps its height until the line collapses (one shrink, not two),
  // and its title no longer says 'need attention' over a hidden list.
  test('BP-N7: Dismiss all holds the card height under a plain section title', async ({ page }) => {
    await bpSetup(page, { hosts: fixtureHosts() })
    await expect.poll(() => hostsOf(banner(page)), { timeout: 20_000 }).toEqual(['keybox', 'certbox', 'netbox', 'signbox'])
    const h0 = (await banner(page).boundingBox())!.height
    await banner(page).getByRole('button', { name: 'Dismiss all' }).click()
    await expect(banner(page).getByTestId('hpb-undo-row')).toHaveText(/hidden until they change\./i)
    await expect(banner(page).locator('.setup-banner-title')).toHaveText('Remote hosts')
    await page.mouse.move(2, 2)
    await page.waitForTimeout(600)
    expect(Math.abs((await banner(page).boundingBox())!.height - h0)).toBeLessThanOrEqual(1)
  })

  test('BP-N8: an undo line from the notification panel moves with the card to the task panel and still undoes', async ({ page }) => {
    await bpSetup(page, { hosts: fixtureHosts() })
    await expect.poll(() => hostsOf(banner(page)), { timeout: 20_000 }).toEqual(['keybox', 'certbox', 'netbox', 'signbox'])
    const card = await openPanelCard(page)
    await cardRow(card, 'certbox').getByRole('button', { name: 'Dismiss Cert box' }).click()
    await expect(card.getByTestId('hpb-undo-row')).toBeVisible()
    await page.waitForTimeout(500)
    await closePanel(page, 'escape')
    await expect(banner(page).getByTestId('hpb-undo-row')).toHaveText(/hidden until it changes\./i)
    await banner(page).getByRole('button', { name: 'Undo' }).click()
    await expect.poll(() => hostsOf(banner(page))).toEqual(['keybox', 'certbox', 'netbox', 'signbox'])
  })
})

/** From the next click on, record the task panel mount's height and grow phase every frame for `ms`. */
async function sampleMountAfterClick(page: Page, ms = 450): Promise<void> {
  await page.evaluate((dur) => {
    const w = window as unknown as { __bpMount?: Array<{ h: number; phase: string | null }> }
    w.__bpMount = []
    document.addEventListener('click', () => {
      const t0 = performance.now()
      const tick = () => {
        const m = document.querySelector<HTMLElement>('.todo-panel > .ab-mount')
        const card = m?.querySelector<HTMLElement>('[data-testid="attention-banner"]')
        if (m && card) w.__bpMount!.push({ h: Math.round(m.getBoundingClientRect().height), phase: m.querySelector('.ab-mount-anim')?.getAttribute('data-phase') ?? null })
        if (performance.now() - t0 < dur) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }, { capture: true, once: true })
  }, ms)
}
const mountSamples = (page: Page) => page.evaluate(() => (window as unknown as { __bpMount: Array<{ h: number; phase: string | null }> }).__bpMount)

test.describe('the card only changed place (N5, N18)', () => {
  test('BP-N5: back on Home from /notes the card paints at its final height on its first frame (no grow)', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __bpOpening: number }
      w.__bpOpening = 0
      new MutationObserver((ms) => { for (const m of ms) if ((m.target as HTMLElement).getAttribute?.('data-phase') === 'opening') w.__bpOpening++ })
        .observe(document, { subtree: true, attributes: true, attributeFilter: ['data-phase'] })
    })
    await bpSetup(page, { hosts: fixtureHosts() })
    await expect.poll(() => hostsOf(banner(page)), { timeout: 20_000 }).toEqual(['keybox', 'certbox', 'netbox', 'signbox'])
    // The first load is part of the load: no grow either.
    expect(await page.evaluate(() => (window as unknown as { __bpOpening: number }).__bpOpening)).toBe(0)
    await goRail(page, 'notes')
    await expect(banner(page)).toHaveCount(0)
    await sampleMountAfterClick(page)
    await goRail(page, 'home')
    await expect(banner(page)).toHaveCount(1)
    await page.waitForTimeout(500)
    const s = await mountSamples(page)
    expect(s.length).toBeGreaterThan(3)
    const final = s[s.length - 1].h
    expect(s.every((x) => Math.abs(x.h - final) <= 1), JSON.stringify(s)).toBe(true)
    expect(s.some((x) => x.phase === 'opening'), JSON.stringify(s)).toBe(false)
  })

  test('BP-N18: showing the task panel: the card never rewraps at a growing width', async ({ page }) => {
    await bpSetup(page, { hosts: fixtureHosts() })
    await expect.poll(() => hostsOf(banner(page)), { timeout: 20_000 }).toEqual(['keybox', 'certbox', 'netbox', 'signbox'])
    const finalWidth = (await banner(page).boundingBox())!.width
    await hideTaskPanel(page)
    await page.waitForTimeout(400)
    await page.evaluate(() => {
      const w = window as unknown as { __bpW: number[] }
      w.__bpW = []
      document.addEventListener('click', () => {
        const t0 = performance.now()
        const tick = () => {
          const c = document.querySelector<HTMLElement>('[data-testid="attention-banner"][data-mount="tasks"]')
          if (c) w.__bpW.push(Math.round(c.getBoundingClientRect().width))
          if (performance.now() - t0 < 600) requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }, { capture: true, once: true })
    })
    await showTaskPanel(page)
    await page.waitForTimeout(700)
    const widths = await page.evaluate(() => (window as unknown as { __bpW: number[] }).__bpW)
    expect(widths.length).toBeGreaterThan(3)
    expect(widths.every((w) => Math.abs(w - finalWidth) <= 2), JSON.stringify(widths)).toBe(true)
  })
})

test.describe('the rail and the bell (N16; N9 moved to BP-R3-N12)', () => {
  test('BP-N16: a new outage held back under a resting pointer lights the bell until its row lands', async ({ page }) => {
    const h = await bpSetup(page, { hosts: [connected('netbox', 'Net box')], allTasks: true })
    const first = page.locator('.todo-panel .todo-panel-item').first()
    await expect(first).toBeVisible({ timeout: 20_000 }).catch(() => {})
    test.skip(await first.count() === 0, 'the fixture has no task rows')
    const fb = (await first.boundingBox())!
    await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2)
    await expect(bellDot(page)).toHaveCount(0)
    await h.push(failed('netbox', 'Net box', 'unreachable'))
    await expect(bellDot(page)).toHaveClass(/is-host-warn/, { timeout: 3_000 })
    await expect(row(page, 'netbox')).toHaveCount(0)
    await page.mouse.move(2, 2)
    await expect(row(page, 'netbox')).toBeVisible({ timeout: 5_000 })
    await expect(bellDot(page)).toHaveCount(0)
  })
})

test.describe('the System pane and panel keyboard (N14, C25; N17 moved to BP-R3-N11)', () => {
  test('BP-C25: with a feed item, Tab from the card\'s last stop reaches the rail\'s Needs Action (WebKit too)', async ({ page, browserName }) => {
    const TAB = browserName === 'webkit' ? 'Alt+Tab' : 'Tab'
    await bpSetup(page, { hosts: fixtureHosts(), feed: [hostErrorRecord('devbox', 1)] })
    await expect.poll(() => hostsOf(banner(page)), { timeout: 20_000 }).toEqual(['keybox', 'certbox', 'netbox', 'signbox'])
    const card = await openPanelCard(page)
    await expect(page.locator('.notification-panel .notification-feed-item').first()).toBeVisible({ timeout: 10_000 })
    await card.getByRole('button', { name: 'Dismiss all' }).focus()
    await page.keyboard.press(TAB)
    await expect(railButton(page, 'Needs Action')).toBeFocused()
  })

  test('BP-N14: System: host names on one line with the status under them, a warn header, outdated not in warn colour, Disabled as in Settings', async ({ page, request }) => {
    await isolatePrefs(page)
    await loadFixture(request, 'host-problems')
    await loadApp(page)
    await openBell(page)
    await railButton(page, 'System').click()
    const hosts = page.locator('[data-testid="nfc-remote-hosts"]')
    await expect(hosts).toBeVisible({ timeout: 20_000 })
    await expect(hosts.locator('.nfc-daemon-row[data-host="signbox"] .nfc-daemon-status')).toContainText('Connected', { timeout: 20_000 })
    await expect(hosts).toHaveClass(/\bwarn\b/)
    await expect(hosts.locator('.notification-card-icon')).toHaveText('⚠')
    const rows = await hosts.locator('.nfc-daemon-row').evaluateAll((els) => els.map((el) => {
      const name = el.querySelector<HTMLElement>('.nfc-daemon-label')!
      const status = el.querySelector<HTMLElement>('.nfc-daemon-status')!
      const lh = parseFloat(getComputedStyle(name).lineHeight) || 18
      return {
        host: el.getAttribute('data-host'), oneLine: name.getBoundingClientRect().height <= lh + 2,
        below: status.getBoundingClientRect().top >= name.getBoundingClientRect().bottom - 1,
        warn: status.classList.contains('warn'), text: status.textContent ?? '',
      }
    }))
    for (const r of rows) expect(r, r.host!).toMatchObject({ oneLine: true, below: true })
    expect(rows.find((r) => r.host === 'buildbox')?.warn).toBe(false)
    expect(rows.find((r) => r.host === 'signbox')?.warn).toBe(true)
    expect(rows.find((r) => r.host === 'fixture-remote')?.text).toBe('Disabled')
    await hosts.screenshot({ path: `${BP_SHOTS}/n14-system-hosts.png` })
  })
})
