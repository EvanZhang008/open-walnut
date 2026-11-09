/**
 * A group whose mail failed to load on a dropped link loads by itself, in WebKit (the Mac app's engine).
 *
 * 2026-11-09, the person: "why this is not reload correctly? automatically". A deploy restarted the
 * server under an open Mail window; five groups sat on WebKit's "Load failed" with a Retry button each.
 * Here the group page reads fail as network errors (the restart's shape), then the server answers
 * again: the groups fill with no click, the backoff gives way at once when the browser is back online,
 * and only a refusal that lasts shows its reason with Retry.
 */
import { devices, expect, test, type Page, type Route } from '@playwright/test'
import { ALL_INBOXES, getGroups, groupLine, openGrouped, startGroupsFixture, waitLabeled } from './mail-grouping-helpers'
import { shoot, type MailFixture, type MailFixtureServer } from './mail-review-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

test.use({ browserName: 'webkit', userAgent: devices['Desktop Safari'].userAgent })
test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

const SHOTS = '/tmp/mail-grouping/shots/load-retry/webkit'
let server: MailFixtureServer
let fixture: MailFixture

test.beforeAll(async () => {
  test.setTimeout(240_000)
  ;({ server, fixture } = await startGroupsFixture())
  await waitLabeled(fixture, ALL_INBOXES, 120_000)
})
test.afterAll(async () => { await server?.stop() })

/** A group page read (not Important's): `/messages?group=<id>`. */
const isGroupRead = (url: URL) => url.pathname.endsWith('/messages') && !!url.searchParams.get('group') && url.searchParams.get('group') !== 'important'

/** Fail every group page read the way a server restart does, until `heal()`. */
async function breakGroupReads(page: Page, how: (route: Route) => Promise<void>): Promise<{ failed: () => number; heal: () => Promise<void> }> {
  let failed = 0
  const handler = async (route: Route) => {
    if (!isGroupRead(new URL(route.request().url()))) return route.fallback()
    failed += 1
    await how(route)
  }
  await page.route('**/messages?**', handler)
  return { failed: () => failed, heal: () => page.unroute('**/messages?**', handler) }
}

const kids = (page: Page, id: string) => page.locator(`[data-testid="mail-group"][data-group-id="${id}"] [data-testid="mail-row"]`)

test('groups that failed on a dropped link fill by themselves, with no Retry pressed', async ({ page }) => {
  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  const groups = await getGroups(fixture, ALL_INBOXES)
  const first = groups.groups[0]
  const broken = await breakGroupReads(page, (route) => route.abort('failed'))
  await openGrouped(page, fixture)
  const line = page.locator(`[data-testid="mail-group"][data-group-id="${first.id}"]`)
  await expect(line.getByTestId('mail-load-retrying')).toHaveText('Connection lost, reconnecting…', { timeout: 20_000 })
  await expect(page.getByTestId('mail-group-retry')).toHaveCount(0)
  await page.mouse.move(2, 2)
  await shoot(page, SHOTS, 'reconnecting')
  await broken.heal()
  // The next try of the backoff (at most a few seconds in) reads every group again.
  for (const group of groups.groups.slice(0, 5)) {
    await expect(kids(page, group.id).first()).toBeVisible({ timeout: 20_000 })
  }
  await expect(page.getByTestId('mail-load-retrying')).toHaveCount(0)
  await expect(page.getByTestId('mail-group-retry')).toHaveCount(0)
  await expect(groupLine(page, first.id)).toBeVisible()
  await shoot(page, SHOTS, 'recovered')
})

test('the browser back online reads at once instead of waiting out the backoff', async ({ page, context }) => {
  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  const groups = await getGroups(fixture, ALL_INBOXES)
  const first = groups.groups[0]
  const broken = await breakGroupReads(page, (route) => route.abort('failed'))
  await openGrouped(page, fixture)
  // Four failures of one page put its next try 8 s out.
  await expect.poll(() => broken.failed() / Math.max(1, groups.groups.length), { timeout: 30_000 }).toBeGreaterThanOrEqual(4)
  await broken.heal()
  const at = Date.now()
  await context.setOffline(true)
  await context.setOffline(false)
  await expect(kids(page, first.id).first()).toBeVisible({ timeout: 5_000 })
  expect(Date.now() - at).toBeLessThan(5_000)
  await expect(page.getByTestId('mail-load-retrying')).toHaveCount(0)
})

test('a refusal that lasts shows its reason and Retry, and Retry loads it', async ({ page }) => {
  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  const groups = await getGroups(fixture, ALL_INBOXES)
  const first = groups.groups[0]
  const broken = await breakGroupReads(page, (route) => route.fulfill({
    status: 401, contentType: 'application/json',
    body: JSON.stringify({ error: 'auth', message: 'The mail account needs signing in again' }),
  }))
  await openGrouped(page, fixture)
  const line = page.locator(`[data-testid="mail-group"][data-group-id="${first.id}"]`)
  await expect(line.locator('.mail-inline-error')).toContainText('The mail account needs signing in again', { timeout: 20_000 })
  await expect(line.getByTestId('mail-load-retrying')).toHaveCount(0)
  const tries = broken.failed()
  await page.waitForTimeout(3_000)
  expect(broken.failed()).toBe(tries)
  await shoot(page, SHOTS, 'refused')
  await broken.heal()
  await line.getByTestId('mail-group-retry').click()
  await expect(kids(page, first.id).first()).toBeVisible({ timeout: 20_000 })
})
