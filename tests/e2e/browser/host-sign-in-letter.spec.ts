/**
 * The host sign-in letter against the SERVER's host fixture: the frames are
 * the real buildHostStatus over the real classifier, the letter is the real
 * store's, and the Inbox is the real notification center.
 *
 * Reported 2026-10-27: the Mac's SSH login expired, every dial to a dev box was
 * refused for hours, and nobody told the user. Pinned here: one letter for the
 * expired login (none for a host that is only unreachable), the same letter
 * however often the failure repeats, and the letter leaving the live Inbox by
 * itself, without a reload, once the host connects again.
 *
 * The letter is off on the fixture server (its hosts fail on purpose); this
 * spec turns it on with no grace and turns it off again.
 *
 * Like every host fixture spec it shares the server's ONE fixture, so it runs with --workers=1.
 *
 * Run: PW_TEST_PORT=35993 npx playwright test host-sign-in-letter --project=chromium-host-fixture --workers=1 --retries=0
 */
import fs from 'node:fs'
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { HEALTHY, fixtureFile, hostFixture, isolatePrefs, loadApp, loadFixture, resetServerHostFixture } from './host-problems-fixture-helpers'

const SHOTS = process.env.PW_SHOTS_DIR || '/tmp/host-sign-in-letter'
const CERT = 'Permission denied (publickey).\nwalnut-ssh-evidence: cert-expired (SSH certificate expired)'
const SUBJECT = 'SSH sign-in to Cert box failed: refresh your login credentials'

const FILE = fixtureFile({
  devbox: { label: 'Dev box', hostname: 'dev.example.com', phase: 'connected', claude: HEALTHY },
  certbox: { label: 'Cert box', hostname: 'cert.example.com', phase: 'failed', error: CERT, retryInSec: 60 },
  netbox: { label: 'Net box', hostname: 'net.example.com', phase: 'failed', error: 'ssh: connect to host net.example.com port 22: No route to host' },
})

/** The open sign-in letter (the fixture's hosts share one login episode), or null. */
async function signInLetter(request: APIRequestContext, body: Record<string, unknown>): Promise<string | null> {
  const res = await hostFixture(request, { action: 'sign-in-letter', ...body }) as { letterIds?: string[] }
  expect((res.letterIds ?? []).length).toBeLessThanOrEqual(1)
  return res.letterIds?.[0] ?? null
}

async function openInbox(page: Page) {
  await page.getByRole('button', { name: /^Notifications/ }).click()
  const panel = page.locator('.notification-panel')
  await expect(panel).toBeVisible()
  await panel.locator('.nfc-rail-btn', { hasText: 'Inbox' }).click()
  await expect(panel.locator('.hib-toolbar')).toBeVisible()
  return panel
}

test.beforeAll(() => { fs.mkdirSync(SHOTS, { recursive: true }) })
test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[console.error] ${m.text().slice(0, 300)}`) })
  await isolatePrefs(page)
})
test.afterAll(async ({ request }) => {
  // The reset removes the hosts, which archives any letter still open; then the letter goes off again.
  await resetServerHostFixture(request)
  await signInLetter(request, { enabled: false }).catch(() => null)
})

test('one letter for an expired login, none for an unreachable host, gone once the host connects', async ({ page, request }) => {
  test.setTimeout(150_000)
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await signInLetter(request, { enabled: true, graceMs: 0 })
  await loadFixture(request, FILE)
  const letterId = await signInLetter(request, { check: true })
  expect(letterId).toMatch(/^lt-/)

  // The same failure again (the reconnect loop, the warmup, a session start): the same letter.
  await hostFixture(request, { action: 'set-status', host: 'certbox', phase: 'failed', kind: 'cert_expired' })
  expect(await signInLetter(request, { check: true })).toBe(letterId)

  // The API view: exactly one live letter about the sign-in, and it does not name the unreachable host.
  const listed = await (await request.get('/api/v1/human-inbox')).json() as { letters: Array<{ id: string; subject: string; textPreview?: string }> }
  const ours = listed.letters.filter((l) => l.subject.startsWith('SSH sign-in to'))
  expect(ours.map((l) => l.id)).toEqual([letterId])
  expect(ours[0].subject).toBe(SUBJECT)
  expect(JSON.stringify(ours[0])).not.toContain('Net box')

  await page.setViewportSize({ width: 1280, height: 800 })
  await loadApp(page)
  const panel = await openInbox(page)
  const row = panel.locator('.hib-row').filter({ hasText: SUBJECT })
  await expect(row).toHaveCount(1, { timeout: 20_000 })
  await row.screenshot({ path: `${SHOTS}/${test.info().project.name}-letter-row.png` })
  await row.locator('.hib-subject').click()
  const view = page.locator('.hib-reader .hib-view')
  await expect(view).toBeVisible()
  await page.locator('.notification-panel').screenshot({ path: `${SHOTS}/${test.info().project.name}-letter-open.png` })

  // The user logged in: the host connects, the letter leaves the live Inbox with no reload.
  await page.keyboard.press('Escape')
  await expect(view).toBeHidden()
  await hostFixture(request, { action: 'set-status', host: 'certbox', phase: 'connected' })
  expect(await signInLetter(request, {})).toBeNull()
  await expect(panel.locator('.hib-row').filter({ hasText: SUBJECT })).toHaveCount(0, { timeout: 20_000 })
  const after = await (await request.get('/api/v1/human-inbox')).json() as { letters: Array<{ id: string }> }
  expect(after.letters.some((l) => l.id === letterId)).toBe(false)
  await page.locator('.notification-panel').screenshot({ path: `${SHOTS}/${test.info().project.name}-after-connect.png` })

  // A later expiry is a new letter, once.
  await hostFixture(request, { action: 'set-status', host: 'certbox', phase: 'failed', kind: 'cert_expired' })
  const second = await signInLetter(request, { check: true })
  expect(second).toMatch(/^lt-/)
  expect(second).not.toBe(letterId)
  await expect(panel.locator('.hib-row').filter({ hasText: SUBJECT })).toHaveCount(1, { timeout: 20_000 })
  await hostFixture(request, { action: 'set-status', host: 'certbox', phase: 'connected' })
  await expect(panel.locator('.hib-row').filter({ hasText: SUBJECT })).toHaveCount(0, { timeout: 20_000 })
  expect(pageErrors).toEqual([])
})
