/**
 * The live host-connect banner: while a remote host connects, a card in the
 * setup banner's place says what Walnut is doing with it right now ("Opening an
 * SSH connection to Big dev box", with a running time), then "Connected to ...",
 * then goes away. A quick reconnect never flashes it; a failure stays with its
 * cause and a Retry. With the chat slot hidden (a draft borrowed its spot) the
 * same banner sits on the leftmost draft column instead.
 *
 * Status frames are dispatched on the app's own socket (no ssh is spawned), the
 * same technique as host-status-live.spec.ts. page.goto only loads the app.
 */
import { test, expect, type Page } from '@playwright/test'
import { draftPanel, openDraft } from './draft-helpers'

const HOST = 'devbox'
const LABEL = 'Big dev box'
const SHOTS = process.env.DRAFT_SHOT_DIR ?? '/tmp/draft-folder-host-project/shots/spec'

type Phase = 'ssh' | 'install-runtime' | 'connected' | 'failed' | 'queued'
const LABELS: Record<Phase, string> = {
  ssh: `Opening an SSH connection to ${LABEL}`,
  'install-runtime': `Installing the session daemon runtime on ${LABEL} (first connect, usually under a minute)`,
  connected: `Connected to ${LABEL}`,
  failed: `Could not connect to ${LABEL}`,
  queued: `Waiting for another host to finish connecting, then ${LABEL}`,
}

function status(phase: Phase, extra: Record<string, unknown> = {}) {
  return {
    host: HOST, label: LABEL, hostname: 'devbox.example.test', connected: phase === 'connected',
    phase, phaseLabel: LABELS[phase], steps: [], phaseElapsedMs: 0, connectElapsedMs: 0,
    at: Date.now(), ...extra,
  }
}

async function captureWs(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = window.WebSocket
    window.WebSocket = class BannerTestWebSocket extends original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        const u = new URL(String(url), window.location.href)
        const holder = window as unknown as { __hsWs?: WebSocket }
        if (u.pathname === '/ws' && !holder.__hsWs) holder.__hsWs = this
      }
    } as typeof WebSocket
    for (const key of Object.getOwnPropertyNames(original)) {
      if (key === 'prototype' || key === 'length' || key === 'name') continue
      try { (window.WebSocket as unknown as Record<string, unknown>)[key] = (original as unknown as Record<string, unknown>)[key] } catch { /* read-only */ }
    }
  })
}

async function push(page: Page, s: ReturnType<typeof status>): Promise<void> {
  await page.evaluate((data) => {
    const ws = (window as unknown as { __hsWs?: WebSocket }).__hsWs
    if (!ws) throw new Error('the app WebSocket was never captured')
    ws.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'event', name: 'host:status', data: { ...data, at: Date.now() }, seq: Date.now() }),
    }))
  }, s)
}

/** Serve the hydrate from `initial`; counts every status read. */
async function load(page: Page, initial: ReturnType<typeof status>[]): Promise<{ reads: () => number }> {
  let reads = 0
  await page.route('**/api/hosts/status', async (route) => { reads++; await route.fulfill({ json: { hosts: initial } }) })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(() => {
    const ws = (window as unknown as { __hsWs?: WebSocket }).__hsWs
    return !!ws && ws.readyState === WebSocket.OPEN
  }, null, { timeout: 20_000 })
  await expect.poll(() => reads, { timeout: 10_000 }).toBeGreaterThan(0)
  return { reads: () => reads }
}

const banner = (page: Page) => page.locator('[data-testid="host-connect-banner"]')

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1000 })
  await captureWs(page)
})

test('a connect that finishes within 1.5s never shows the banner', async ({ page }) => {
  await load(page, [status('connected')])
  await push(page, status('ssh'))
  const seen: boolean[] = []
  const t0 = Date.now()
  while (Date.now() - t0 < 900) { seen.push(await banner(page).count() > 0); await page.waitForTimeout(100) }
  await push(page, status('connected'))
  const t1 = Date.now()
  while (Date.now() - t1 < 3000) { seen.push(await banner(page).count() > 0); await page.waitForTimeout(100) }
  expect(seen.some(Boolean), 'the banner flashed').toBe(false)
})

test('a longer connect shows what is happening in the chat slot, ticks, then says Connected and goes', async ({ page }) => {
  const hydrate = await load(page, [status('connected')])
  const readsBefore = hydrate.reads()
  await push(page, status('install-runtime'))
  await expect(banner(page)).toHaveCount(0)
  await expect(banner(page)).toBeVisible({ timeout: 3_000 })
  await expect(page.locator('.ask-walnut-slot [data-testid="host-connect-banner"]')).toHaveCount(1)
  await expect(banner(page)).toHaveAttribute('role', 'status')
  await expect(banner(page).locator('.setup-banner-title')).toHaveText(`Connecting to ${LABEL}`)
  const row = banner(page).locator(`.host-connect-row[data-host="${HOST}"]`)
  await expect(row).toHaveAttribute('data-state', 'connecting')
  await expect(row).toContainText(LABELS['install-runtime'])
  const sub = row.locator('.host-connect-sub').first()
  const t1 = await sub.textContent()
  await page.waitForTimeout(2200)
  const t2 = await sub.textContent()
  expect(t2, 'the running time ticks with no new frame').not.toBe(t1)
  expect(hydrate.reads(), 'no polling').toBe(readsBefore)
  await banner(page).screenshot({ path: `${SHOTS}/banner-connecting.png` })

  await push(page, status('connected'))
  await expect(banner(page)).toHaveAttribute('data-state', 'success')
  await expect(banner(page).locator('.setup-banner-title')).toHaveText(`✓ Connected to ${LABEL}`)
  await page.waitForTimeout(2000)
  await expect(banner(page)).toBeVisible()
  await expect(banner(page)).toHaveCount(0, { timeout: 3_000 })
})

test('a failure stays with its cause; Retry asks the server once and the row goes back to connecting', async ({ page }) => {
  await load(page, [status('connected')])
  let posts = 0
  await page.route(`**/api/hosts/${HOST}/connect`, async (route) => {
    posts++
    await new Promise((r) => setTimeout(r, 400))
    await route.fulfill({ json: { ok: true, status: { ...status('ssh', { connectElapsedMs: 10 }), at: Date.now() } } })
  })
  await push(page, status('ssh', { connectElapsedMs: 4000 }))
  await expect(banner(page)).toBeVisible()
  await push(page, status('failed', { error: 'Permission denied (publickey).', hint: 'Check the key in Settings.' }))
  const row = banner(page).locator(`.host-connect-row[data-host="${HOST}"]`)
  await expect(row).toHaveAttribute('data-state', 'failed')
  await expect(row).toContainText('Permission denied (publickey).')
  await expect(row).toContainText('Check the key in Settings.')
  await page.waitForTimeout(4000)
  await expect(banner(page)).toBeVisible()
  await banner(page).screenshot({ path: `${SHOTS}/banner-failed.png` })

  const retry = row.getByRole('button', { name: `Retry connecting to ${LABEL}` })
  await retry.click()
  await expect(retry).toHaveText('Retrying…')
  await expect(retry).toBeDisabled()
  await expect(row).toHaveAttribute('data-state', 'connecting', { timeout: 5_000 })
  expect(posts).toBe(1)
})

test('a Retry the server refuses says why, and a newer failure clears that answer', async ({ page }) => {
  await load(page, [status('connected')])
  await page.route(`**/api/hosts/${HOST}/connect`, (route) => route.fulfill({ status: 404, json: { error: 'unknown host' } }))
  await push(page, status('ssh', { connectElapsedMs: 4000 }))
  await push(page, status('failed', { error: 'Connection refused' }))
  const row = banner(page).locator(`.host-connect-row[data-host="${HOST}"]`)
  await row.getByRole('button', { name: `Retry connecting to ${LABEL}` }).click()
  await expect(row.locator('.host-connect-retry-msg')).toHaveText(`${LABEL} is no longer in your hosts config.`)
  await expect(row.getByRole('button', { name: `Retry connecting to ${LABEL}` })).toHaveCount(0)
  // The host came back into the config and failed again: that answer is stale.
  await push(page, status('failed', { error: 'Connection timed out' }))
  await expect(row).toContainText('Connection timed out')
  await expect(row.locator('.host-connect-retry-msg')).toHaveCount(0)
  await expect(row.getByRole('button', { name: `Retry connecting to ${LABEL}` })).toBeVisible()
})

test('dismiss hides it; the server retrying the same failure stays quiet; a new attempt shows again', async ({ page }) => {
  await load(page, [status('connected')])
  await push(page, status('ssh', { connectElapsedMs: 4000 }))
  await push(page, status('failed', { error: 'Connection timed out', retryInMs: 3000 }))
  await expect(banner(page)).toBeVisible()
  await banner(page).getByRole('button', { name: 'Dismiss host connection status' }).click()
  await expect(banner(page)).toHaveCount(0)
  await push(page, status('ssh', { connectElapsedMs: 0 }))
  await page.waitForTimeout(2500)
  await expect(banner(page)).toHaveCount(0)
  await push(page, status('failed', { error: 'Connection timed out', retryInMs: 6000 }))
  await page.waitForTimeout(500)
  await expect(banner(page)).toHaveCount(0)
})

test('a host that was already down when the page loaded is not news', async ({ page }) => {
  await load(page, [status('failed', { error: 'Connection refused', retryInMs: 60_000 })])
  await page.waitForTimeout(2500)
  await expect(banner(page)).toHaveCount(0)
})

test('with the chat spot borrowed by a draft, the one banner sits above that draft\'s launch bar', async ({ page }) => {
  await load(page, [status('connected')])
  const panel = await openDraft(page)
  await expect(page.locator('.ask-walnut-slot')).toHaveCount(0)
  await push(page, status('install-runtime', { connectElapsedMs: 5000 }))
  const inDraft = panel.locator('.session-panel-input > [data-testid="host-connect-banner"]')
  await expect(inDraft).toBeVisible()
  await expect(banner(page)).toHaveCount(1)
  const b = await inDraft.boundingBox()
  const bar = await panel.locator('.draft-launch-bar').boundingBox()
  expect((b?.y ?? 0) + (b?.height ?? 0)).toBeLessThanOrEqual((bar?.y ?? 0) + 1)
  await draftPanel(page).screenshot({ path: `${SHOTS}/banner-in-draft.png` })
})
