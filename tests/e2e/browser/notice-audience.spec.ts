/**
 * One rule for every notice (src/core/notifications/audience.ts), end to end on the fixture
 * server. 2026-11-17, the user: only the errors he needs to see are shown; the rest goes to
 * Walnut Health, where whoever investigates finds them; the notification center keeps only
 * what matters.
 *
 *  1. A background error: a phone's freeze report reaches the server (POST /api/v1/client-logs,
 *     the real incident path). No toast, nothing in the bell's Errors list; the bell's one
 *     line leads to Settings > Walnut Health > Background errors, where it is grouped with
 *     how often, first and last seen, and its details.
 *  2. The person's own action fails for good (Save as task, the server answers 500 with its
 *     internals): a toast says in words that it did not go through, with no raw internals.
 *  3. A host Walnut reconnects by itself (a Mac on the host network that is off) never toasts or
 *     sits in the bell; Walnut Health lists it. A login only the person can do still reaches them.
 *  4. During a focus block nothing pops up outside the window, asks included; its end raises
 *     ONE notice for what waited.
 */
import fs from 'node:fs/promises'
import { test, expect, type Page, type WebSocketRoute } from '@playwright/test'
import { connected, failed, setup } from './host-problems-helpers'
import { draftComposer, loadHome, openDraft } from './draft-helpers'

const SHOTS = process.env.NOTICE_SHOT_DIR ?? '/tmp/notice-audience'

test.use({ viewport: { width: 1440, height: 900 } })
test.setTimeout(150_000)
test.beforeAll(async () => { await fs.mkdir(SHOTS, { recursive: true }) })

const toasts = (page: Page) => page.locator('.notification-toast')

/** Every toast text seen while `fn` runs (sampled every 150 ms). */
async function watchToasts(page: Page, fn: () => Promise<void>): Promise<string[]> {
  const seen = new Set<string>()
  let on = true
  const loop = (async () => {
    while (on) {
      for (const t of await toasts(page).allInnerTexts().catch(() => [])) seen.add(t.replace(/\s+/g, ' ').trim())
      await page.waitForTimeout(150)
    }
  })()
  try { await fn() } finally { on = false; await loop }
  return [...seen].filter(Boolean)
}

test('a background error goes to Walnut Health only: no toast, not in the bell', async ({ page }) => {
  const device = `pw-phone-${Date.now().toString(36)}`
  const title = `iOS app froze — main thread unresponsive ${device}`
  await loadHome(page)

  const seen = await watchToasts(page, async () => {
    const res = await page.request.post('/api/v1/client-logs', {
      data: {
        device, appVersion: '9.9', os: 'iOS 26',
        lines: [{ ts: new Date().toISOString(), level: 'error', subsystem: 'freeze', message: `main thread unresponsive ${device}`, m_ms: 4200 }],
      },
    })
    expect(res.ok()).toBe(true)
    // The record is written and broadcast after the answer: wait for it, then a beat for any toast.
    await expect.poll(async () => {
      const { feed } = await (await page.request.get('/api/notifications')).json() as { feed: Array<{ title: string; audience?: string }> }
      return feed.find((n) => n.title === title)?.audience ?? null
    }, { timeout: 15_000 }).toBe('health')
    await page.waitForTimeout(2500)
  })
  expect(seen.filter((t) => t.includes(device)), 'no toast for a background error').toEqual([])
  await page.screenshot({ path: `${SHOTS}/1-home-no-toast.png` })

  // The bell: not in Errors; one line says where Walnut's own errors are.
  await page.getByRole('button', { name: 'Notifications' }).click()
  const panel = page.locator('.notification-panel')
  await expect(panel).toBeVisible()
  await panel.locator('.nfc-rail-btn', { hasText: 'Errors' }).first().click()
  await expect(panel.locator('.notification-feed-item', { hasText: device })).toHaveCount(0)
  const link = panel.getByTestId('nfc-health-link')
  await expect(link).toBeVisible()
  await page.waitForTimeout(800)
  await panel.screenshot({ path: `${SHOTS}/2-bell-errors.png` })
  await link.click()

  // Walnut Health: grouped under the phone app, with its count, times and details.
  const log = page.getByTestId('health-errors')
  await expect(log).toBeVisible({ timeout: 20_000 })
  await log.scrollIntoViewIfNeeded()
  const group = log.getByTestId('health-errors-group').filter({ hasText: 'Phone app' })
  await expect(group).toBeVisible()
  const row = group.getByTestId('health-errors-row').filter({ hasText: device })
  await expect(row).toBeVisible()
  await expect(row).toContainText('Happening')
  await expect(row).toContainText('once')
  await page.waitForTimeout(800)
  await row.locator('.health-errors-row-head').click()
  const detail = row.getByTestId('health-errors-detail')
  await expect(detail).toContainText('First seen')
  await expect(detail).toContainText('last seen')
  await page.waitForTimeout(1200)
  await log.screenshot({ path: `${SHOTS}/3-walnut-health.png` })
})

test('the person\'s own action that fails shows a toast in words', async ({ page }) => {
  await loadHome(page)
  await openDraft(page)
  const words = `Buy oat milk ${Date.now().toString(36)}`
  await draftComposer(page).fill(words)
  // The server fails on its side and answers with its internals (a lock path), as on 2026-11-16.
  await page.route(/\/api\/(v1\/)?tasks(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    await route.fulfill({
      status: 500, contentType: 'application/json',
      body: JSON.stringify({ error: 'File lock timeout after 10000ms: /home/acme/.open-walnut/tasks/tasks.json.lock' }),
    })
  })
  await page.waitForTimeout(600)
  await page.locator('.draft-later-btn').first().click()
  const toast = toasts(page).filter({ hasText: /did not go through/i }).first()
  await expect(toast).toBeVisible({ timeout: 15_000 })
  const text = (await toast.innerText()).replace(/\s+/g, ' ')
  expect(text).toMatch(/Try again/)
  expect(text).not.toMatch(/lock|tasks\.json|\{|reqId|stack/)
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${SHOTS}/4-own-action-toast.png` })
  await page.unroute(/\/api\/(v1\/)?tasks(\?.*)?$/)
})

/**
 * 2026-11-17, the user: a Mac on the host network that was not connected asked him to run
 * `walnut net status`, during a focus block. A host problem only he can clear (a login) still
 * reaches him; one Walnut reconnects by itself goes to Walnut Health.
 */
test('a host Walnut reconnects by itself is Walnut Health\'s; a login only the person can do still reaches them', async ({ page }) => {
  const netHint = 'Is Other Mac on, with Walnut running? On it, `walnut net status` says whether it is on the host network.'
  const seen = await watchToasts(page, async () => {
    await setup(page, [
      connected('devbox', 'Dev box'),
      failed('othermac', 'Other Mac', 'daemon', { hint: netHint, phaseLabel: 'Could not reach Other Mac through the host network' }),
      failed('certbox', 'Cert box', 'cert_expired'),
    ], 'ready', { listHosts: true })
    await page.waitForTimeout(3000)
  })
  expect(seen.filter((t) => /Other Mac|net status/.test(t)), 'no toast for a machine Walnut reconnects').toEqual([])
  expect(seen.some((t) => /Cert box/.test(t)), 'the login the person must do toasts').toBe(true)
  await page.screenshot({ path: `${SHOTS}/5-host-toasts.png` })

  // The bell lists only the login; one line says what Walnut is handling.
  await page.getByRole('button', { name: /Notifications/ }).first().click()
  const panel = page.locator('.notification-panel')
  await expect(panel).toBeVisible()
  await panel.locator('.nfc-rail-btn', { hasText: 'Errors' }).first().click()
  const problems = panel.getByTestId('nfc-problem-hosts')
  await expect(problems.locator('li.hpb-row[data-host="certbox"]')).toBeVisible()
  await expect(problems.locator('li.hpb-row[data-host="othermac"]')).toHaveCount(0)
  await expect(panel).not.toContainText('walnut net status')
  const link = panel.getByTestId('nfc-health-link')
  await expect(link).toContainText('Walnut is handling')
  await page.waitForTimeout(800)
  await panel.screenshot({ path: `${SHOTS}/6-bell-hosts.png` })
  await link.click()

  // Walnut Health keeps it, with the full hint, for whoever investigates.
  const log = page.getByTestId('health-errors')
  await expect(log).toBeVisible({ timeout: 20_000 })
  const row = log.getByTestId('health-host-row').filter({ hasText: 'Other Mac' })
  await expect(row).toBeVisible()
  await expect(row).toContainText('walnut net status')
  await expect(log.getByTestId('health-host-row').filter({ hasText: 'Cert box' })).toHaveCount(0)
  await row.scrollIntoViewIfNeeded()
  await page.waitForTimeout(1000)
  await log.screenshot({ path: `${SHOTS}/7-health-hosts.png` })
})

/** A focus block holds every notice outside the window, asks included; its end raises one. */
test('during a focus block nothing pops up outside the window, and its end raises one notice', async ({ page }) => {
  const focus = { active: true, allowPermissions: true, holds: [{ source: 'plugin:walnut-rhythm', since: Date.now() - 60_000, reason: 'Focus block, macOS Focus: Do Not Disturb' }] }
  let socket: WebSocketRoute | null = null
  await page.routeWebSocket(/\/ws(?:\?|$)/, (route) => { socket = route; route.connectToServer() })
  // The server's quiet as this page reads it (a test run's page reads it again on every quiet:changed).
  let served: Record<string, unknown> = focus
  await page.route('**/api/quiet', (r) => r.request().method() === 'GET' ? r.fulfill({ json: served }) : r.fallback())
  await page.addInitScript(() => {
    const posted: Array<{ title: string; body?: string }> = []
    ;(window as unknown as { __posted: typeof posted }).__posted = posted
    class Recorder {
      static permission = 'granted'
      static requestPermission = async () => 'granted'
      onclick: unknown = null
      constructor(title: string, opts: { body?: string } = {}) { posted.push({ title, body: opts.body }) }
      close() { /* closed */ }
    }
    ;(window as unknown as { Notification: unknown }).Notification = Recorder
    // The window is in the background, as when the person works in another app.
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
  })
  await loadHome(page)
  await expect.poll(() => socket !== null, { timeout: 30_000 }).toBe(true)
  const posted = () => page.evaluate(() => (window as unknown as { __posted: Array<{ title: string; body?: string }> }).__posted)
  const event = (name: string, data: unknown) => socket!.send(JSON.stringify({ type: 'event', name, seq: -1, data }))

  // Two asks arrive while the person focuses: permission prompts, which an agent waits on.
  for (const n of [1, 2]) {
    event('notification:new', {
      dedupKey: `perm:focus-${n}-${Date.now()}`, kind: 'permission', severity: 'warning', title: `Bash ${n}`, body: `ls ${n}`,
      requestId: `focus-r${n}`, toolName: 'Bash', input: { command: `ls ${n}` }, sessionId: `focus-s${n}`, timestamp: Date.now(),
    })
  }
  await page.waitForTimeout(2000)
  expect(await posted(), 'nothing outside the window during the focus block').toEqual([])
  await page.screenshot({ path: `${SHOTS}/8-focus-no-system-notice.png` })

  // The block ends: ONE notice says what waited.
  served = { active: false, allowPermissions: true, holds: [] }
  event('quiet:changed', served)
  await expect.poll(async () => (await posted()).length, { timeout: 10_000 }).toBe(1)
  await page.waitForTimeout(1500)
  const [one] = await posted()
  expect(one!.title).toBe('2 things waited for you')
  expect(one!.body).toContain('Bash 1')
  expect((await posted()).length).toBe(1)
})
