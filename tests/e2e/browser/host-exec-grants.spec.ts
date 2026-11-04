/**
 * Settings › Remote Hosts › Tasks using other hosts (HostExecGrantsGroup.tsx; server:
 * src/core/hosts/exec-grants.ts): each task the user let run commands on another host,
 * with where, since when and what it ran, and a Revoke that sends the DELETE and drops
 * the row; a task the user declined, with an Allow that grants it after all; with
 * none, one line says so. A grant a task on a registered host made by itself says so.
 * Each host has a switch, the hard stop, that sends the PUT. Navigation is by clicks.
 * WebKit: `PW_WEBKIT=1 ... --project=webkit`.
 */
import { mkdirSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

test.setTimeout(120_000)

const SHOTS = process.env.PW_SHOTS_DIR || '/tmp/host-exec-grants'
const NOW = Date.now()

const GRANTS = [
  { id: 'xg-aaaa', taskId: 't-ios', taskTitle: 'Run the iOS tests', host: '__local__', grantedAt: NOW - 3_600_000, via: 'own-host', runs: 4, lastRunAt: NOW - 60_000, lastCommand: 'xcodebuild test -scheme Walnut -destination "platform=iOS Simulator,name=iPhone 17"' },
  { id: 'xg-bbbb', taskId: 't-gpu', taskTitle: 'Train the small model on the box with the GPU and report the loss curve every hour', host: 'devbox', grantedAt: NOW - 86_400_000, via: 'settings', runs: 0 },
]

async function openRemoteHosts(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('link', { name: /settings/i }).first().click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('settings-nav-remote-hosts').click()
  // The group sits under More settings, both closed by default.
  await page.getByTestId('remote-hosts-more-toggle').click()
  await page.getByTestId('host-exec-grants-toggle').click()
  await expect(page.getByTestId('host-exec-grants-toggle')).toHaveAttribute('aria-expanded', 'true')
}

test('grants read in words and Revoke drops one', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  let grants = [...GRANTS]
  let denied = [{ taskId: 't-ci', taskTitle: 'CI health', host: 'devbox', askedAt: NOW - 7_200_000, answeredAt: NOW - 7_000_000 }]
  const deleted: string[] = []
  const allowed: unknown[] = []
  await page.route('**/api/v1/host-exec/grants', (route) => {
    if (route.request().method() === 'POST') {
      const b = route.request().postDataJSON() as { task_id: string; host: string }
      allowed.push(b)
      denied = denied.filter((d) => d.taskId !== b.task_id)
      const g = { id: 'xg-cccc', taskId: b.task_id, taskTitle: 'CI health', host: b.host, grantedAt: Date.now(), via: 'settings', runs: 0 }
      grants = [...grants, g]
      return route.fulfill({ json: { grant: g } })
    }
    return route.fulfill({ json: { grants, denied } })
  })
  await page.route('**/api/v1/host-exec/grants/*', (route) => {
    const id = decodeURIComponent(route.request().url().split('/').pop()!)
    deleted.push(`${route.request().method()} ${id}`)
    const g = grants.find((x) => x.id === id)
    grants = grants.filter((x) => x.id !== id)
    return route.fulfill({ json: { grant: { ...g, revokedAt: Date.now() } } })
  })
  await openRemoteHosts(page)
  const group = page.getByTestId('host-exec-grants')
  await expect(group).toBeVisible({ timeout: 30_000 })
  const rows = group.locator('[data-grant-id]')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText('Run the iOS tests')
  await expect(rows.nth(0)).toContainText('On this Mac, allowed (your own host)')
  await expect(rows.nth(0)).toContainText('4 uses, last')
  await expect(rows.nth(0)).toContainText('xcodebuild test -scheme Walnut')
  await expect(rows.nth(1)).toContainText('not used yet')
  const declined = group.locator('[data-denied]')
  await expect(declined).toHaveCount(1)
  await expect(declined).toContainText('CI health')
  await expect(declined).toContainText('On devbox, you declined')
  // A long title and a long command never push the row past its group.
  for (let i = 0; i < 2; i++) {
    expect(await rows.nth(i).evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
  }
  await group.scrollIntoViewIfNeeded()
  mkdirSync(SHOTS, { recursive: true })
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await group.screenshot({ path: `${SHOTS}/${engine}-1-grants.png`, scale: 'css' })

  // Allow on a Deny grants it after all: the row moves up to the grants.
  await declined.getByRole('button', { name: /Allow CI health on devbox/ }).click()
  await expect(declined).toHaveCount(0)
  await expect(rows).toHaveCount(3)
  expect(allowed).toEqual([{ task_id: 't-ci', host: 'devbox' }])

  await rows.nth(0).getByRole('button', { name: /Revoke Run the iOS tests/ }).click()
  await expect(rows).toHaveCount(2)
  expect(deleted).toEqual(['DELETE xg-aaaa'])
  await rows.nth(0).getByRole('button', { name: /^Revoke/ }).click()
  await expect(rows).toHaveCount(1)
  await rows.nth(0).getByRole('button', { name: /^Revoke/ }).click()
  await expect(group).toContainText('No task has used another host yet')
  await group.screenshot({ path: `${SHOTS}/${engine}-2-empty.png`, scale: 'css' })
  expect(errors).toEqual([])
})

test('each host has a hard stop switch that sends the PUT and sticks', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  let closed: string[] = []
  const puts: Array<{ host: string; body: unknown }> = []
  await page.route('**/api/v1/host-exec/grants', (route) => route.fulfill({ json: { grants: [], denied: [], closedHosts: closed } }))
  let slowFirst = false
  await page.route('**/api/v1/host-exec/hosts/*', async (route) => {
    const host = decodeURIComponent(route.request().url().split('/').pop()!)
    const body = route.request().postDataJSON() as { closed: boolean }
    puts.push({ host, body })
    closed = body.closed ? [...new Set([...closed, host])].sort() : closed.filter((h) => h !== host)
    const answer = { closedHosts: closed }
    // The first of a quick pair answers last (its answer is the older state).
    if (slowFirst) { slowFirst = false; await new Promise((r) => setTimeout(r, 800)) }
    return route.fulfill({ json: answer })
  })
  // The cloud companion is no Settings row; the host status push names it, and it gets a switch too.
  await page.route('**/api/hosts/status*', async (route) => {
    const r = await route.fetch()
    const body = await r.json() as { hosts?: Array<Record<string, unknown>> }
    body.hosts = [...(body.hosts ?? []).filter((h) => h.host !== '__cloudbox__'), { host: '__cloudbox__', label: 'Cloud', connected: true, phase: 'connected' }]
    return route.fulfill({ response: r, json: body })
  })
  await openRemoteHosts(page)
  const group = page.getByTestId('host-exec-grants')
  await expect(group).toBeVisible({ timeout: 30_000 })
  await expect(group).toContainText('without asking you')
  // One line says what the switches mean; each host's row is its name and its switch.
  await expect(group.locator('[data-exec-host="__cloudbox__"]')).toContainText('Cloud')
  await expect(group.locator('[data-exec-host="__cloudbox__"]').getByRole('switch', { name: 'Tasks on other hosts may use Cloud' })).toBeVisible()
  await expect(group).not.toContainText('__cloudbox__')
  const mac = group.locator('[data-exec-host="__local__"]')
  const sw = mac.getByRole('switch', { name: 'Tasks on other hosts may use this Mac' })
  await expect(sw).toHaveAttribute('aria-checked', 'true')
  await sw.click()
  await expect(sw).toHaveAttribute('aria-checked', 'false')
  await expect(mac).toContainText('Off: nothing new starts there')
  expect(puts).toEqual([{ host: '__local__', body: { closed: true } }])
  await group.scrollIntoViewIfNeeded()
  mkdirSync(SHOTS, { recursive: true })
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await group.screenshot({ path: `${SHOTS}/${engine}-3-switch-off.png`, scale: 'css' })
  // Settings opened again reads the stop back from the server.
  await page.getByTestId('settings-nav-general').click()
  await page.getByTestId('settings-nav-remote-hosts').click()
  // More settings and the group stay open for this tab.
  await expect(page.getByTestId('remote-hosts-more-toggle')).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByTestId('host-exec-grants-toggle')).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByTestId('host-exec-grants').locator('[data-exec-host="__local__"]').getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  await page.getByTestId('host-exec-grants').locator('[data-exec-host="__local__"]').getByRole('switch').click()
  await expect.poll(() => puts.length).toBe(2)
  expect(puts[1]).toEqual({ host: '__local__', body: { closed: false } })
  // Two quick flips whose answers come back in the wrong order: the switch ends on the server's word.
  slowFirst = true
  const sw2 = page.getByTestId('host-exec-grants').locator('[data-exec-host="__local__"]').getByRole('switch')
  await sw2.click()
  await sw2.click()
  await expect.poll(() => puts.length).toBe(4)
  await expect.poll(() => closed.includes('__local__')).toBe(false)
  await expect(sw2).toHaveAttribute('aria-checked', 'true')
  await page.waitForTimeout(1_500)
  await expect(sw2).toHaveAttribute('aria-checked', 'true')
  expect(errors).toEqual([])
})
