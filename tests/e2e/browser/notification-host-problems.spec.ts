/**
 * The notification panel's problems block and System host list (host-attention.ts):
 * no card on the page carries a host problem. All and Errors lead with the
 * problems block (this machine's Claude Code notice, then one dense row per
 * problem host, in the model's order, no cap); System lists every host once
 * (a problem host as its row, every other host as a plain line). One attempt
 * per host whichever view starts it, receipts in the row, Open Settings, the
 * Errors view's cards under their host's row, the rail counts, and the screen
 * reader line.
 * Host frames and local health are routed client-side; the Settings and System
 * checks marked "server fixture" use the server's host fixture (Settings and the
 * health list name the server's hosts).
 */
import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Locator } from '@playwright/test'
import {
  connected, failed, isolatePrefs, outdated, resetServerHostFixture, routeHealth, signedOut,
} from './host-problems-helpers'
import { fixtureFile, HEALTHY, loadApp, loadFixture, openBell, openPicker, picker } from './host-problems-fixture-helpers'
import {
  FIXTURE_ORDER, askRecord, bpSetup, closePanel, errorsBadge, fixtureHosts, healthyGitSync, hostErrorRecord, hostRowsOutsidePanel,
  openProblems, openRow, openSystemHosts, panelLocalCard, panelProblems, pickRail, problemCards, problemHosts, problemRow,
  problemRowHosts, railButton, seedFeed, systemBadge, systemHostLine, systemHostRow, systemHosts, systemListHosts, systemRowHosts, triples,
} from './host-attention-helpers'

test.describe.configure({ timeout: 90_000 })

test.beforeAll(async ({ request }) => { await resetServerHostFixture(request) })
test.afterAll(async ({ request }) => { await resetServerHostFixture(request) })

// Six problems of the person's: an unreachable host or a broken proxy is Walnut Health's and takes no row in All.
const six = () => [
  failed('keybox', 'Key box', 'auth'), failed('netbox', 'Net box', 'dns'), failed('proxybox', 'Proxy box', 'proxy_login'),
  failed('lanbox', 'Lan box', 'host_key'), failed('certbox', 'Cert box', 'cert_expired'), signedOut('signbox', 'Sign box'),
]
const box = async (l: Locator) => (await l.boundingBox())!

test.describe('the problems block: which hosts, in which order', () => {
  test('HP-1: default Home: no host row outside the panel; All leads with each problem host of the person\'s in the model order (healthy, outdated and unreachable hosts take none); System gives the same rows and the unreachable host\'s in Settings order and the others plain lines, each host once', async ({ page }) => {
    await bpSetup(page)
    await expect(hostRowsOutsidePanel(page)).toHaveCount(0)
    const hosts = await openProblems(page)
    await expect.poll(() => problemRowHosts(page), { timeout: 20_000 }).toEqual(FIXTURE_ORDER)
    await expect(problemHosts(page).locator('li.hpb-row').first()).toBeInViewport()
    const inAll = await triples(hosts)
    expect(inAll.slice(0, 2).every((t) => t.split('|')[1] === 'connect')).toBe(true)
    expect(inAll[2]).toBe('signbox|readiness|claude_not_logged_in')
    // Net box is unreachable: Walnut Health's, so no row in All (System below still lists it).
    for (const host of ['devbox', 'buildbox', 'netbox']) await expect(problemRow(page, host), host).toHaveCount(0)
    await expect(hostRowsOutsidePanel(page)).toHaveCount(0)
    await closePanel(page, 'escape')
    const system = await openSystemHosts(page)
    // Remote hosts is System's first block (this machine is fine), every configured host once.
    expect(await system.evaluate((el) => el.closest('.nfc-detail')!.querySelector('.notification-card') === el)).toBe(true)
    const listed = await systemListHosts(page)
    expect(listed).toEqual(['devbox', 'buildbox', 'signbox', 'keybox', 'certbox', 'netbox'])
    expect(new Set(listed).size).toBe(listed.length)
    const inSystem = await triples(system)
    expect(inSystem.map((t) => t.split('|')[0])).toEqual(['signbox', 'keybox', 'certbox', 'netbox'])
    expect(inSystem.filter((t) => !t.startsWith('netbox|')).sort()).toEqual([...inAll].sort())
    expect(inSystem).toContain('netbox|connect|unreachable')
    for (const host of ['devbox', 'buildbox']) {
      await expect(systemHostRow(page, host), host).toHaveCount(0)
      await expect(systemHostLine(page, host), host).toBeVisible()
      await expect(systemHostLine(page, host).locator('button'), host).toHaveCount(0)
    }
  })

  test('HP-2: 1280x900, six problems and a local sign-in: All leads with the Claude Code notice, then every host once inside the top 60% (no cap, no "more" link), nothing wider than the panel, the rail the whole height; System holds no Claude Code notice and lists all six', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await bpSetup(page, { hosts: six(), local: 'sign-in' })
    const hosts = await openProblems(page)
    const panel = await box(page.locator('.notification-panel'))
    // All's blocks are notice cards (NoticeCard); System's keep their notification-card frame.
    const first = await box(page.locator('.notification-panel .nfc-detail .wn-notice').first())
    const local = await box(panelLocalCard(page))
    expect(Math.abs(first.y - local.y)).toBeLessThanOrEqual(1)
    const list = await box(hosts)
    expect(list.y).toBeGreaterThanOrEqual(local.y + local.height - 1)
    expect(list.y - panel.y).toBeLessThanOrEqual(panel.height * 0.6)
    await expect.poll(() => problemRowHosts(page)).toEqual(['keybox', 'netbox', 'proxybox', 'lanbox', 'certbox', 'signbox'])
    await expect(hosts.locator('.hpb-more')).toHaveCount(0)
    expect(await page.locator('.notification-panel .nfc-detail').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    const rail = await box(page.locator('.notification-panel .nfc-rail'))
    expect(rail.y).toBeLessThanOrEqual(first.y)
    expect(rail.y + rail.height).toBeGreaterThanOrEqual(panel.y + panel.height - 2)
    await pickRail(page, 'System')
    await expect(panelLocalCard(page)).toHaveCount(0)
    expect(await systemHosts(page).evaluate((el) => el.closest('.nfc-detail')?.querySelector('.notification-card') === el)).toBe(true)
    expect(await systemListHosts(page)).toEqual(['keybox', 'netbox', 'proxybox', 'lanbox', 'certbox', 'signbox'])
    await expect(systemHosts(page).locator('.hpb-more')).toHaveCount(0)
    expect(await page.locator('.notification-panel .nfc-detail').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  })

  test('HP-3: all healthy and this machine fine: no problems block and no Errors count; System lists both hosts as plain lines and counts nothing', async ({ page }) => {
    await bpSetup(page, { hosts: [connected('devbox', 'Dev box'), outdated('buildbox', 'Build box')] })
    await page.waitForTimeout(1500)
    await expect(hostRowsOutsidePanel(page)).toHaveCount(0)
    await openBell(page)
    // The rail's picked entry is the shared nav item, aria-current="page" (0a5209345f).
    await expect(railButton(page, 'All')).toHaveAttribute('aria-current', 'page')
    await expect(panelProblems(page)).toHaveCount(0)
    await expect(errorsBadge(page)).toHaveCount(0)
    await pickRail(page, 'System')
    await expect(systemHostLine(page, 'devbox')).toBeVisible()
    await expect(systemHostLine(page, 'buildbox')).toBeVisible()
    await expect(systemHosts(page).locator('li.hpb-row')).toHaveCount(0)
    await expect(systemBadge(page)).toHaveCount(0)
  })
})

test.describe('a problem row reads at a glance', () => {
  test('HP-4: 1280x800, three problems of the person\'s: each row starts closed as its headline and one action (Retry, or Check again for the sign-in); its hint is one Show details away', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await bpSetup(page, { hosts: fixtureHosts() })
    await openProblems(page)
    await expect.poll(() => problemRowHosts(page), { timeout: 20_000 }).toEqual(FIXTURE_ORDER)
    const rows = await problemHosts(page).locator('li.hpb-row[data-host]').evaluateAll((lis) => lis.map((li) => ({
      host: li.getAttribute('data-host'), open: li.classList.contains('hpb-open'), dense: li.classList.contains('hpb-dense'),
      hint: !!li.querySelector('.hft-hint'),
      buttons: Array.from(li.querySelectorAll<HTMLElement>('.hpb-actions button')).map((b) => (b.textContent ?? '').trim()),
    })))
    for (const r of rows) expect(r, r.host!).toMatchObject({ open: false, dense: true, hint: false })
    expect(rows.map((r) => r.buttons)).toEqual([['Retry'], ['Retry'], ['Check again']])
    await problemRow(page, 'keybox').getByRole('button', { name: 'Show details' }).click()
    await expect(problemRow(page, 'keybox').locator('.hft-hint')).toBeVisible()
  })

  test('HP-5: every row starts with a bold headline naming its host (whole, never clipped), then its buttons in a group named for the host, then details, then its x; Show details sits centred on the primary button; the dot does not repeat the headline', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await bpSetup(page, { hosts: fixtureHosts() })
    await openProblems(page)
    await expect.poll(() => problemRowHosts(page), { timeout: 20_000 }).toEqual(FIXTURE_ORDER)
    const order = await problemHosts(page).locator('li.hpb-row[data-host]').evaluateAll((lis) => lis.map((li) => {
      const head = li.querySelector<HTMLElement>('.hft-headline, .hpb-headline')!
      const first = li.querySelector<HTMLElement>('button')!
      const x = li.querySelector<HTMLElement>('.hpb-x')
      const buttons = Array.from(li.querySelectorAll('button'))
      return {
        host: li.getAttribute('data-host'),
        text: head.textContent ?? '',
        bold: Number(getComputedStyle(head).fontWeight) >= 600,
        clipped: head.scrollHeight > head.clientHeight + 1 || head.scrollWidth > head.clientWidth + 1,
        headFirst: !!(head.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING),
        xLast: !!x && buttons[buttons.length - 1] === x,
      }
    }))
    const labels: Record<string, string> = { keybox: 'Key box', certbox: 'Cert box', netbox: 'Net box', signbox: 'Sign box' }
    for (const o of order) {
      expect(o.text, o.host!).toContain(labels[o.host!])
      expect(o, o.host!).toMatchObject({ bold: true, clipped: false, headFirst: true, xLast: true })
    }
    // The readiness row's headline is its first sentence; the command is in the detail below.
    const sign = order.find((o) => o.host === 'signbox')!
    expect(sign.text).not.toMatch(/ssh|claude once/i)
    expect(sign.text.trim().endsWith('.')).toBe(true)
    const cert = problemRow(page, 'certbox')
    const retry = await box(cert.locator('.hpb-actions .hpb-btn').first())
    const details = await box(cert.getByRole('button', { name: 'Show details' }))
    expect(Math.abs((retry.y + retry.height / 2) - (details.y + details.height / 2))).toBeLessThanOrEqual(1.5)
    await expect(cert.locator('.hpb-dot [role="img"]')).toHaveCount(0)
    const label = await cert.locator('.hpb-body').getAttribute('data-label')
    await expect(cert.getByRole('group', { name: label! })).toBeVisible()
  })

  test('HP-6: an opened row keeps the closed row\'s button height; a retry time long past (no attempt came) does not say Trying again', async ({ page }) => {
    // Seven minutes after its retryAt, with frames still arriving: a stale promise.
    await page.setViewportSize({ width: 1280, height: 800 })
    await bpSetup(page, { hosts: [failed('keybox', 'Key box', 'auth'), failed('certbox', 'Cert box', 'cert_expired', { retryAt: Date.now() - 7 * 60_000 })] })
    await openProblems(page)
    await expect(problemRow(page, 'certbox')).toBeVisible({ timeout: 20_000 })
    const closedH = (await box(problemRow(page, 'keybox').getByTestId('hpb-retry'))).height
    await openRow(problemRow(page, 'certbox'))
    const heights = await problemRow(page, 'certbox').locator('.hpb-btn').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)))
    for (const h of heights) expect(Math.abs(h - closedH)).toBeLessThanOrEqual(1)
    await expect(problemRow(page, 'certbox')).not.toContainText('Trying again')
    await expect(problemRow(page, 'certbox')).not.toContainText('tries again')
  })

  test('HP-7: a 390x844 phone: the first row names its host on its own line (wrapped, never cut) with its action under it; the System host list spans the sheet, its rows and Retry whole across', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await bpSetup(page, { hosts: fixtureHosts() })
    await openProblems(page)
    await expect.poll(() => problemRowHosts(page), { timeout: 20_000 }).toEqual(FIXTURE_ORDER)
    const r = problemRow(page, 'keybox')
    const head = r.locator('.hft-headline')
    const h = await head.evaluate((el) => ({ text: (el as HTMLElement).innerText, cut: el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1 }))
    expect(h).toEqual({ text: 'Could not connect to Key box', cut: false })
    const hb = await box(head)
    expect((await box(r.locator('.hpb-actions'))).y).toBeGreaterThanOrEqual(hb.y + hb.height - 1)
    await expect(r.getByTestId('hpb-retry')).toBeInViewport({ ratio: 1 })
    await pickRail(page, 'System')
    const pb = await box(page.locator('.notification-panel'))
    const cb = await box(systemHosts(page))
    expect(cb.x).toBeGreaterThanOrEqual(pb.x - 1)
    expect(cb.x + cb.width).toBeLessThanOrEqual(pb.x + pb.width + 1)
    expect(cb.width).toBeGreaterThanOrEqual(pb.width - 48)
    const nb = await box(systemHostRow(page, 'netbox'))
    expect(nb.x + nb.width).toBeLessThanOrEqual(cb.x + cb.width + 1)
    const retry = await box(systemHostRow(page, 'netbox').getByTestId('hpb-retry'))
    expect(retry.x + retry.width).toBeLessThanOrEqual(cb.x + cb.width + 1)
  })

  test('HP-8: a 980px window: code in an opened row breaks only between tokens (a host name or URL never splits)', async ({ page }) => {
    await page.setViewportSize({ width: 980, height: 800 })
    await bpSetup(page, { hosts: fixtureHosts(), local: 'sign-in' })
    await openProblems(page)
    await openRow(problemRow(page, 'keybox'))
    await expect(problemRow(page, 'keybox').locator('.hft-hint')).toBeVisible()
    // Every whitespace-free token inside a code chip sits on one line.
    const split = await panelProblems(page).evaluate((el) => {
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

  test('HP-9: dark theme: problem rows and System rows draw no background of their own; the row CSS has no literal colours', async ({ page }) => {
    await bpSetup(page, {
      // dns: the person's to clear, so the row is drawn in All as well as System.
      hosts: [failed('netbox', 'Net box', 'dns')],
      before: async (p) => { await p.addInitScript(() => { document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.theme = 'dark' }) }) },
    })
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    const bg = (l: Locator) => l.evaluate((el) => getComputedStyle(el).backgroundColor)
    await openProblems(page)
    // A row sits on its Remote hosts block, never on a card of its own.
    expect(await bg(problemRow(page, 'netbox'))).toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/)
    await pickRail(page, 'System')
    expect(await bg(systemHostRow(page, 'netbox'))).toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/)
    const css = fs.readFileSync(path.resolve(process.cwd(), 'web/src/styles/attention-banner.css'), 'utf-8')
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/)
  })
})

test.describe('this machine\'s Claude Code notice in All', () => {
  test('HP-10: the notice copies with a text Copy button at least 24px tall and re-checks with Check again, the same verb as a host\'s readiness row', async ({ page }) => {
    await bpSetup(page, { hosts: fixtureHosts(), local: 'sign-in' })
    await openProblems(page)
    const local = panelLocalCard(page)
    const copy = local.locator('[data-testid="setup-banner-sign-in"] .setup-copy-btn')
    await expect(copy).toHaveText('Copy')
    expect((await box(copy)).height).toBeGreaterThanOrEqual(24)
    await expect(local.getByText('\u2398')).toHaveCount(0)
    await expect(local.getByTestId('setup-banner-check')).toHaveText('Check again')
    await expect(problemRow(page, 'signbox').getByTestId('hpb-check')).toHaveText('Check again')
  })
})

test.describe('one attempt per host, whichever view starts it', () => {
  test('HP-11: Retry in All\'s row: the new attempt\'s failure replaces the headline; a second Retry with the same answer says Tried again just now: same result in place, the row keeping its height, and the line then goes', async ({ page }) => {
    // Net box starts on a kind of the person's (dns), so All has its row; once the person pressed
    // Retry, its timeout answers their own action ('own-action') and keeps the row.
    const h = await bpSetup(page, { hosts: [failed('netbox', 'Net box', 'dns'), signedOut('signbox', 'Sign box')] })
    await openProblems(page)
    const r = problemRow(page, 'netbox')
    await expect(r).toBeVisible({ timeout: 20_000 })
    h.connectAnswer = (host) => failed(host, 'Net box', 'timeout')
    await r.getByTestId('hpb-retry').click()
    await expect(r.locator('.hft-headline')).toHaveText('Connecting to Net box timed out', { timeout: 10_000 })
    await page.waitForTimeout(300)
    const before = Math.round((await box(r)).height)
    await r.getByTestId('hpb-retry').click()
    await expect(r.getByTestId('hpb-receipt')).toHaveText('Tried again just now: same result', { timeout: 10_000 })
    expect(Math.abs(Math.round((await box(r)).height) - before)).toBeLessThanOrEqual(1)
    await expect(r.getByTestId('hpb-receipt')).toHaveCount(0, { timeout: 10_000 })
    expect(Math.abs(Math.round((await box(r)).height) - before)).toBeLessThanOrEqual(1)
    await expect(r.locator('.hft-headline')).toHaveText('Connecting to Net box timed out')
  })

  test('HP-12: connect held 2s, Retry in All, then System at 300ms: the System row is the same pending attempt (Retrying..., disabled), one connect request, and the receipt lands there; Show details holds by row across the two views', async ({ page }) => {
    const h = await bpSetup(page, { hosts: fixtureHosts() })
    await openProblems(page)
    await expect.poll(() => problemRowHosts(page), { timeout: 20_000 }).toEqual(FIXTURE_ORDER)
    await problemRow(page, 'keybox').getByRole('button', { name: 'Show details' }).click()
    await expect(problemRow(page, 'keybox')).toHaveClass(/hpb-open/)
    h.connectDelayMs = 2_000
    // A frame for this host inside the old 1s slack of the click.
    await h.push(failed('certbox', 'Cert box', 'cert_expired'))
    await problemRow(page, 'certbox').getByTestId('hpb-retry').click()
    await page.waitForTimeout(300)
    await pickRail(page, 'System')
    const pr = systemHostRow(page, 'certbox')
    const retry = pr.getByTestId('hpb-retry')
    await expect(retry).toHaveText('Retrying...')
    await expect(retry).toBeDisabled()
    await retry.click({ force: true }).catch(() => {})
    await expect(pr.getByTestId('hpb-receipt')).toHaveText('Tried again just now: same result', { timeout: 10_000 })
    expect(h.connects.get('certbox')).toBe(1)
    await expect(systemHostRow(page, 'keybox')).toHaveClass(/hpb-open/)
    await expect(systemHostRow(page, 'netbox')).not.toHaveClass(/hpb-open/)
    await pickRail(page, 'All')
    await expect(problemRow(page, 'keybox')).toHaveClass(/hpb-open/)
  })

  test('HP-13: Retry in a System row keeps the panel open and the row height while it tries; the host then reads Connected there for good (never the old failure again, with the pointer resting in the section) and leaves All\'s problems', async ({ page }) => {
    const h = await bpSetup(page, { hosts: [failed('netbox', 'Net box', 'unreachable'), signedOut('signbox', 'Sign box')] })
    h.connectDelayMs = 1500
    h.connectAnswer = (host) => connected(host, 'Net box')
    await openSystemHosts(page)
    const target = systemHostRow(page, 'netbox')
    const before = (await box(target)).height
    await target.getByTestId('hpb-retry').click()
    await expect(target).toContainText('Connecting to Net box...')
    expect(Math.abs((await box(target)).height - before)).toBeLessThanOrEqual(1)
    // The pointer rests in the System section, below the host list.
    const detail = await box(page.locator('.notification-panel .nfc-detail'))
    const lb = await box(systemHosts(page))
    const y = Math.min(detail.y + detail.height - 40, lb.y + lb.height + 20)
    expect(y).toBeGreaterThan(lb.y + lb.height)
    await page.mouse.move(detail.x + detail.width / 2, y, { steps: 4 })
    await expect(systemHostLine(page, 'netbox').locator('.nfc-daemon-status')).toHaveText('Connected', { timeout: 10_000 })
    await expect(target).toHaveCount(0)
    const net = systemHosts(page).locator('li[data-host="netbox"]')
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(700)
      await expect(net).toHaveCount(1)
      expect(await net.innerText()).not.toContain('Could not connect')
    }
    await expect(page.locator('.notification-panel')).toBeVisible()
    await pickRail(page, 'All')
    await expect.poll(() => problemRowHosts(page)).toEqual(['signbox'])
  })

  test('HP-14: a different result after a frame re-stamped with the old kind: the new sentence, and no same-result line', async ({ page }) => {
    const h = await bpSetup(page, { hosts: fixtureHosts() })
    await openProblems(page)
    await expect.poll(() => problemRowHosts(page), { timeout: 20_000 }).toEqual(FIXTURE_ORDER)
    h.connectDelayMs = 1_500
    h.connectAnswer = (host) => (host === 'keybox' ? failed('keybox', 'Key box', 'unreachable') : null)
    await problemRow(page, 'keybox').getByTestId('hpb-retry').click()
    // The server's push just before its answer: the OLD kind with a fresh `at`.
    await page.waitForTimeout(700)
    await h.push(failed('keybox', 'Key box', 'auth'))
    await expect(problemRow(page, 'keybox')).toHaveAttribute('data-kind', 'unreachable', { timeout: 10_000 })
    await expect(problemRow(page, 'keybox').getByTestId('hpb-receipt')).toHaveCount(0)
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(500)
      await expect(problemRow(page, 'keybox').getByTestId('hpb-receipt')).toHaveCount(0)
    }
  })

  test('HP-15 (server fixture): Open Settings in All\'s row closes the panel and lands the host row in the upper part of the pane, where it stays and takes focus', async ({ page, request }) => {
    await isolatePrefs(page)
    await loadFixture(request, 'host-problems')
    await loadApp(page)
    await openProblems(page)
    await expect(problemRow(page, 'certbox')).toBeVisible({ timeout: 20_000 })
    await openRow(problemRow(page, 'certbox'))
    await problemRow(page, 'certbox').getByTestId('hpb-open-settings').click()
    await expect(page.locator('.notification-panel')).toHaveCount(0)
    await expect(page).toHaveURL(/\/settings#rh-host-certbox$/)
    const target = page.locator('#rh-host-certbox')
    await expect(target).toBeVisible({ timeout: 10_000 })
    const vh = page.viewportSize()!.height
    for (const wait of [600, 1500, 2500]) {
      await page.waitForTimeout(wait === 600 ? 600 : wait - 600)
      const b = await box(target)
      expect(b.y, `row top at ${wait}ms`).toBeLessThanOrEqual(vh / 3)
      expect(b.y + Math.min(b.height, 160)).toBeLessThanOrEqual(vh)
    }
    // A section above arriving late (seconds in, on a busy machine) pushes the row down; the landing still holds it.
    await target.evaluate((el) => {
      let sc: HTMLElement | null = el.parentElement
      while (sc && !(/(auto|scroll)/.test(getComputedStyle(sc).overflowY) && sc.scrollHeight > sc.clientHeight + 1)) sc = sc.parentElement
      const first = (sc ?? document.body).firstElementChild as HTMLElement
      first.dataset.lateLayout = '1'
      first.style.paddingTop = '400px'
    })
    await page.waitForTimeout(500)
    expect((await box(target)).y, 'row top after a late section above').toBeLessThanOrEqual(vh / 3)
    await page.locator('[data-late-layout]').evaluate((el) => { (el as HTMLElement).style.paddingTop = '' })
    await expect(target).toBeFocused()
  })
})

test.describe('the Errors view and the rail counts', () => {
  test('HP-16: Errors leads with Dev box\'s row and its cards right under it (indented, inside the Remote hosts block, above the next row), with no group of their own and no Shown in System link; the keyboard goes from the row into its cards; its x takes the row out and the cards stand as a Can\'t reach Dev box group below the problems, while System keeps the row; recovering keeps the group', async ({ page, browserName }) => {
    const h = await bpSetup(page, {
      hosts: [failed('devbox', 'Dev box', 'cert_expired'), signedOut('signbox', 'Sign box')],
      feed: [hostErrorRecord('devbox', 1), hostErrorRecord('devbox', 2)],
    })
    await openBell(page)
    await pickRail(page, 'Errors')
    await expect.poll(() => problemRowHosts(page)).toEqual(['devbox', 'signbox'])
    const dev = problemRow(page, 'devbox')
    const cards = problemCards(page, 'devbox')
    const header = page.locator('.notification-panel .nfc-cause-header')
    await expect(cards).toBeVisible()
    await expect(cards.locator('.notification-feed-item')).toHaveCount(1)
    await expect(cards.locator('.notification-group-toggle')).toHaveText('Show 1 more')
    await expect(header).toHaveCount(0)
    await expect(page.locator('.notification-panel .nfc-cat-shown, .notification-panel .nfc-cat-shown-link')).toHaveCount(0)
    const rb = await box(dev)
    const cb = await box(cards)
    const outer = await box(problemHosts(page))
    const next = await box(problemRow(page, 'signbox'))
    expect(cb.y).toBeGreaterThanOrEqual(rb.y + rb.height - 1)
    expect(cb.x).toBeGreaterThan(rb.x)
    expect(cb.x + cb.width).toBeLessThanOrEqual(outer.x + outer.width + 1)
    expect(next.y).toBeGreaterThanOrEqual(cb.y + cb.height - 1)
    // By keyboard: past the row's last control, the next stop is in its cards (WebKit tabs buttons with Option held).
    await dev.evaluate((el) => {
      const f = Array.from(el.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')).filter((e) => e.offsetParent !== null)
      f[f.length - 1]?.focus()
    })
    expect(await page.evaluate(() => !!document.activeElement?.closest('li.hpb-row[data-host="devbox"]'))).toBe(true)
    await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab')
    expect(await page.evaluate(() => !!document.activeElement?.closest('li.nfc-problem-cards[data-host-cards="devbox"]'))).toBe(true)
    // Two cards and two hosts.
    await expect(errorsBadge(page)).toHaveText('4')
    // The row's x ("I know"): the row and its cards leave the problems; the cards come back as a group named by the host label.
    await dev.getByRole('button', { name: 'Dismiss Dev box' }).click()
    await expect.poll(() => problemRowHosts(page)).toEqual(['signbox'])
    await expect(dev).toHaveCount(0)
    await expect(cards).toHaveCount(0)
    await expect(header).toHaveCount(1)
    await expect(header.locator('.nfc-cat-name')).toHaveText("Can't reach Dev box")
    const problemsBox = await box(problemHosts(page))
    expect((await box(header)).y).toBeGreaterThanOrEqual(problemsBox.y + problemsBox.height - 1)
    await expect(errorsBadge(page)).toHaveText('3')
    // System is the inventory: it still gives the host its row, with no x.
    await pickRail(page, 'System')
    await expect(systemHostRow(page, 'devbox')).toBeVisible()
    await expect(systemHosts(page).getByRole('button', { name: 'Dismiss Dev box' })).toHaveCount(0)
    // Recovered: a plain line in System, and the group in Errors stays, named by the label.
    await h.push(connected('devbox', 'Dev box'))
    await expect(systemHostRow(page, 'devbox')).toHaveCount(0, { timeout: 10_000 })
    await pickRail(page, 'Errors')
    await expect(header.locator('.nfc-cat-name')).toHaveText("Can't reach Dev box")
    await expect(errorsBadge(page)).toHaveText('3')
  })

  test('HP-17 (server fixture): an unreachable host is Walnut Health\'s: no count on the Errors rail and no row in All, the Errors view points to Walnut Health; System wears no count and no dot and still lists it under Remote hosts; an outdated host alone counts nothing and leads nothing, but is listed', async ({ page, browser, request }) => {
    await loadFixture(request, fixtureFile({
      devbox: { label: 'Dev box', hostname: 'dev.example.com', phase: 'connected', claude: HEALTHY },
      netbox: { label: 'Net box', hostname: 'net.example.com', phase: 'failed', error: 'ssh: connect to host net.example.com port 22: Network is unreachable' },
    }))
    await isolatePrefs(page)
    await healthyGitSync(page)
    // The Errors badge counts the feed's error cards too: the fixture server's feed holds what
    // every earlier spec on it left (2026-11-02 CI: 6 for 1), so the page reads an empty one.
    await seedFeed(page, [])
    // This machine ready: the count is the host alone.
    await routeHealth(page)
    await loadApp(page)
    await openSystemHosts(page)
    const system = railButton(page, 'System')
    // System lists it first (proof its frame arrived), then the absences are read.
    await expect(page.locator('.notification-panel .notification-card-label', { hasText: /^Remote hosts$/ })).toHaveCount(1)
    await expect(systemHostRow(page, 'netbox')).toHaveAttribute('data-kind', 'unreachable', { timeout: 20_000 })
    await expect(systemBadge(page)).toHaveCount(0)
    await expect(system.locator('.nfc-rail-dot')).toHaveCount(0)
    await expect(errorsBadge(page)).toHaveCount(0)
    await pickRail(page, 'All')
    await expect(panelProblems(page)).toHaveCount(0)
    await pickRail(page, 'Errors')
    await expect(problemRow(page, 'netbox')).toHaveCount(0)
    await expect(page.locator('.notification-panel [data-testid="nfc-health-link"]')).toHaveText('1 background error Walnut is handling: see Walnut Health')
    await expect(errorsBadge(page)).toHaveCount(0)
    await loadFixture(request, fixtureFile({
      devbox: { label: 'Dev box', hostname: 'dev.example.com', phase: 'connected', claude: HEALTHY },
      buildbox: { label: 'Build box', hostname: 'build.example.com', phase: 'connected', claude: { version: '2.1.220', auth: 'ok', installMethod: 'other' } },
    }))
    const ctx = await browser.newContext()
    const page2 = await ctx.newPage()
    try {
      await isolatePrefs(page2)
      await healthyGitSync(page2)
      await seedFeed(page2, [])
      await routeHealth(page2)
      await loadApp(page2)
      await openBell(page2)
      await expect(railButton(page2, 'All')).toHaveAttribute('aria-current', 'page')
      await expect(panelProblems(page2)).toHaveCount(0)
      const system2 = railButton(page2, 'System')
      await system2.click()
      await expect(systemHostLine(page2, 'buildbox')).toBeVisible({ timeout: 20_000 })
      await expect(system2.locator('.nfc-rail-dot')).toHaveCount(0)
      await expect(systemBadge(page2)).toHaveCount(0)
      await expect(errorsBadge(page2)).toHaveCount(0)
      await expect(page2.locator('.notification-panel li.hpb-row')).toHaveCount(0)
    } finally {
      await ctx.close()
    }
  })

  test('HP-18: two asks and four host problems: the bell lands on Needs Action, the asks alone (no problems block there); the Errors badge counts the person\'s three hosts (not the unreachable one), System nothing; System lists all four as dense rows, never the one-line form', async ({ page }) => {
    await bpSetup(page, {
      hosts: [failed('keybox', 'Key box', 'auth'), failed('netbox', 'Net box', 'unreachable'), failed('certbox', 'Cert box', 'cert_expired'), signedOut('signbox', 'Sign box')],
      feed: [askRecord(1), askRecord(2)],
    })
    await openBell(page)
    await expect(railButton(page, 'Needs you')).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('.notification-panel .nfc-perm-card')).toHaveCount(2)
    const panelBox = await box(page.locator('.notification-panel'))
    const askTop = (await box(page.locator('.notification-panel .nfc-perm-card').first())).y
    expect(askTop - panelBox.y).toBeLessThanOrEqual(panelBox.height * 0.6)
    await expect(problemHosts(page)).toHaveCount(0)
    // The person's hosts are errors: the Errors rail counts three (no feed errors, this machine ready;
    // Net box, unreachable, is Walnut Health's); System (git sync healthy) counts nothing.
    await expect(errorsBadge(page)).toHaveText('3')
    await expect(systemBadge(page)).toHaveCount(0)
    await pickRail(page, 'System')
    const hosts = systemHosts(page)
    await expect(hosts).toBeVisible()
    await expect(hosts.locator('li.hpb-row[data-host]')).toHaveCount(4)
    await expect(systemBadge(page)).toHaveCount(0)
    await expect(errorsBadge(page)).toHaveText('3')
    for (const r of await hosts.locator('li.hpb-row[data-host]').all()) {
      await expect(r).toHaveClass(/hpb-dense/)
      await expect(r).not.toHaveClass(/hpb-single/)
    }
    await expect(systemHostRow(page, 'keybox').getByTestId('hpb-retry')).toBeVisible()
  })
})

test.describe('the System host list (server fixture)', () => {
  test('HP-19: System gives each problem host the problems block\'s row (same headline, dot and tone, never a bare Disconnected) and every other host a plain line: the name on one line, the status under it, outdated not in warn colour, Disabled as in Settings, under a warn header', async ({ page, request }) => {
    await isolatePrefs(page)
    await loadFixture(request, 'host-problems')
    await loadApp(page)
    await openProblems(page)
    const look = (r: Locator) => r.evaluate((el) => {
      const dot = el.querySelector<HTMLElement>('.hpb-dot .hsd')!
      const head = el.querySelector<HTMLElement>('.hft-headline, .hpb-headline')!
      return { kind: dot.getAttribute('data-kind'), dot: getComputedStyle(dot).backgroundColor, head: getComputedStyle(head).color, text: head.innerText }
    })
    const inAll: Record<string, Awaited<ReturnType<typeof look>>> = {}
    for (const host of ['signbox', 'keybox', 'certbox']) {
      await expect(problemRow(page, host), host).toBeVisible({ timeout: 20_000 })
      inAll[host] = await look(problemRow(page, host))
    }
    // Net box (unreachable) is Walnut Health's: a row in System only.
    await expect(problemRow(page, 'netbox')).toHaveCount(0)
    await pickRail(page, 'System')
    const hosts = systemHosts(page)
    await expect(hosts).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => systemRowHosts(page), { timeout: 20_000 }).toEqual(['signbox', 'keybox', 'certbox', 'netbox'])
    for (const [host, text] of [['keybox', 'Could not connect to Key box'], ['certbox', 'Could not connect to Cert box: SSH certificate expired'], ['netbox', 'Could not connect to Net box']]) {
      await expect(systemHostRow(page, host).locator('.hft-headline'), host).toHaveText(text, { timeout: 10_000 })
      await expect(systemHostRow(page, host), host).not.toContainText('Disconnected')
    }
    for (const host of ['signbox', 'keybox', 'certbox', 'netbox']) {
      await expect(hosts.locator(`.nfc-daemon-row[data-host="${host}"]`), host).toHaveCount(0)
      if (host !== 'netbox') expect(await look(systemHostRow(page, host)), host).toEqual(inAll[host])
    }
    expect(inAll.certbox.kind).not.toBe(inAll.signbox.kind)
    await expect(systemHostLine(page, 'devbox').locator('.nfc-daemon-status')).toHaveText('Connected')
    await expect(systemHostLine(page, 'buildbox').locator('.nfc-daemon-status')).not.toHaveClass(/\b(warn|error)\b/)
    await expect(hosts).toHaveClass(/\bwarn\b/)
    await expect(hosts.locator('.notification-card-icon')).toHaveText('\u26a0')
    const lines = await hosts.locator('.nfc-daemon-row').evaluateAll((els) => els.map((el) => {
      const name = el.querySelector<HTMLElement>('.nfc-daemon-label')!
      const status = el.querySelector<HTMLElement>('.nfc-daemon-status')!
      const lh = parseFloat(getComputedStyle(name).lineHeight) || 18
      return {
        host: el.getAttribute('data-host'), oneLine: name.getBoundingClientRect().height <= lh + 2,
        below: status.getBoundingClientRect().top >= name.getBoundingClientRect().bottom - 1,
        warn: status.classList.contains('warn'), text: status.textContent ?? '',
      }
    }))
    for (const l of lines) expect(l, l.host!).toMatchObject({ oneLine: true, below: true })
    expect(lines.find((l) => l.host === 'buildbox')?.warn).toBe(false)
    expect(lines.find((l) => l.host === 'fixture-remote')?.text).toBe('Disabled')
  })
})

test.describe('the screen reader line', () => {
  test('HP-20: one announcer for the page and none inside a host row; opening and closing System says nothing new; a same-result Retry is said', async ({ page }) => {
    const h = await bpSetup(page, { hosts: [failed('keybox', 'Key box', 'auth')] })
    const announcer = page.locator('[data-testid="host-banner-announcer"]')
    await expect(announcer).toHaveCount(1)
    await openProblems(page)
    await expect(page.locator('li.hpb-row [aria-live]')).toHaveCount(0)
    await closePanel(page, 'escape')
    const said = await announcer.textContent()
    for (let i = 0; i < 3; i++) { await openSystemHosts(page); await closePanel(page, 'escape') }
    expect(await announcer.textContent()).toBe(said)
    h.connectAnswer = (host) => failed(host, 'Key box', 'auth')
    await openProblems(page)
    await problemRow(page, 'keybox').getByTestId('hpb-retry').click()
    await expect(announcer).toHaveText('Tried again just now: same result', { timeout: 10_000 })
  })
})

test.describe('the draft folder picker beside the host fixture (server fixture)', () => {
  test('HP-21: the draft folder picker says its purpose and placeholder without an em or en dash', async ({ page, request }) => {
    await loadFixture(request, 'host-problems')
    await isolatePrefs(page)
    await loadApp(page)
    await openPicker(page)
    const text = await picker(page).evaluate((el) => {
      const inputs = Array.from(el.querySelectorAll<HTMLInputElement>('input')).map((i) => i.placeholder)
      return [(el as HTMLElement).innerText, ...inputs].join('\n')
    })
    // The draft's picker says what the folder is for (647b662c6: "the session runs in this
    // folder once you start it"; the draft's own Start launches, so it no longer says a task is made).
    expect(text).toContain('The session runs in this folder once you start it.')
    expect(text).not.toMatch(/[\u2013\u2014]/)
  })
})
