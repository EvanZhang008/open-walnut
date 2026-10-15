/**
 * Settings, Remote Hosts, "Copies that held off" (docs/plan/walnut-replica-servers-impl.md,
 * section 4): a host's copy refused, three rounds in a row, a copy that would remove
 * most of its tasks. The row says how many would go; "Remove them there" takes two
 * clicks and posts exactly the refusal the user read (count and keys); the row then
 * says the next copy takes it. A 409 (the rows moved) says so under the row. No row
 * at all while every copy works.
 *
 * The fixture server has no follower to refuse anything, so this spec answers
 * GET /api/replicas/status and POST /api/replicas/confirm-removal itself
 * (page.route); the routes are pinned on the real router by
 * tests/web/routes/replicas-status.test.ts. Navigation is by clicks.
 * WebKit: `PW_WEBKIT=1 ... --project=webkit`.
 */
import { mkdirSync } from 'node:fs'
import { test, expect, type Page, type Route } from '@playwright/test'

test.setTimeout(120_000)

const SHOTS = '/tmp/replica-removal-settings'
const TARGET = 'host:pw-rr-box'
const ROW = `${TARGET}/tasks`
const KEYS = 'abcdef012345'

interface Fake {
  state: 'ok' | 'refused' | 'armed'
  posts: Array<Record<string, unknown>>
  /** Answer the next confirm with 409 not_refused. */
  conflict: boolean
}

function statusBody(f: Fake): Record<string, unknown> {
  const tasks: Record<string, unknown> = { kind: 'tasks', refusals: 0, needsConfirm: false, action: 'synced', entries: 3 }
  if (f.state !== 'ok') {
    Object.assign(tasks, { action: 'failed', refusals: 3, lastRefusal: { error: 'manifest_removes_most_rows', at: Date.now(), entries: 3, keys: KEYS, local: 100, removing: 97 } })
    tasks.needsConfirm = f.state === 'refused'
    if (f.state === 'armed') tasks.confirmArmed = { entries: 3, keys: KEYS, at: Date.now(), expiresAt: Date.now() + 5 * 60_000 }
  }
  return { ok: true, targets: [{ id: TARGET, kind: 'host', label: 'pw-rr-box', kinds: [tasks, { kind: 'registry', refusals: 0, needsConfirm: false }] }] }
}

async function fakeReplicas(page: Page, f: Fake): Promise<void> {
  await page.route('**/api/replicas/status', (route: Route) => route.fulfill({ json: statusBody(f) }))
  await page.route('**/api/replicas/confirm-removal', async (route: Route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    f.posts.push(body)
    if (f.conflict) {
      f.conflict = false
      await route.fulfill({ status: 409, json: { ok: false, error: 'not_refused' } })
      return
    }
    f.state = 'armed'
    await route.fulfill({ json: { ok: true } })
  })
}

async function openRemoteHosts(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('link', { name: /settings/i }).first().click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({ timeout: 30_000 })
  const nav = page.getByTestId('settings-nav-remote-hosts')
  await nav.click()
  await expect(nav).toHaveAttribute('aria-current', 'page')
}

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true })
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await page.getByTestId('replica-removals-host').screenshot({ path: `${SHOTS}/${engine}-${name}.png`, scale: 'css' })
}

test.describe('Copies that held off', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 900 })
  })

  test('while every copy works there is no row at all', async ({ page }) => {
    const f: Fake = { state: 'ok', posts: [], conflict: false }
    await fakeReplicas(page, f)
    const read = page.waitForResponse('**/api/replicas/status')
    await openRemoteHosts(page)
    await read
    await expect(page.getByRole('heading', { name: 'Session limits' })).toBeVisible()
    await expect(page.getByTestId('replica-removals-host')).toHaveCount(0)
    await expect(page.getByText('Copies that held off')).toHaveCount(0)
  })

  test('a refusal names the size; two clicks confirm exactly the rows read; the row then says the next copy takes it', async ({ page }) => {
    const f: Fake = { state: 'refused', posts: [], conflict: false }
    await fakeReplicas(page, f)
    await openRemoteHosts(page)
    const group = page.getByTestId('replica-removals-host')
    await expect(group).toBeVisible({ timeout: 30_000 })
    await expect(group).toContainText('Copies that held off')
    const row = page.getByTestId(`replica-removal-${ROW}`)
    await expect(row).toHaveAttribute('data-removal', 'refused')
    await expect(row).toHaveAttribute('data-state', 'warning')
    await expect(row).toContainText('pw-rr-box')
    await expect(page.getByTestId(`replica-removal-text-${ROW}`)).toHaveText(
      'This Mac has 3 tasks now, and the copy there would drop 97 of its 100. Walnut held off in case this Mac lost them. If you removed them on purpose, remove them there too.',
    )
    await group.scrollIntoViewIfNeeded()
    await shot(page, 'refused')
    const button = page.getByTestId(`replica-removal-confirm-${ROW}`)
    await expect(button).toHaveText('Remove them there')
    // The first click only arms it: nothing is sent.
    await button.click()
    await expect(button).toHaveText('Confirm remove')
    expect(f.posts).toEqual([])
    await button.click()
    await expect.poll(() => f.posts).toEqual([{ target: TARGET, kind: 'tasks', entries: 3, keys: KEYS }])
    await expect(row).toHaveAttribute('data-removal', 'armed')
    await expect(page.getByTestId(`replica-removal-text-${ROW}`)).toContainText('Confirmed: the next copy keeps only this Mac\'s 3 tasks there.')
    await expect(page.getByTestId(`replica-removal-confirm-${ROW}`)).toHaveCount(0)
    await shot(page, 'armed')
  })

  test('the rows moved before the click: the row says so and stays to confirm again', async ({ page }) => {
    const f: Fake = { state: 'refused', posts: [], conflict: true }
    await fakeReplicas(page, f)
    await openRemoteHosts(page)
    const button = page.getByTestId(`replica-removal-confirm-${ROW}`)
    await expect(button).toBeVisible({ timeout: 30_000 })
    await button.click()
    await button.click()
    const row = page.getByTestId(`replica-removal-${ROW}`)
    // The row's error sits right under it (SettingsRow), inside the group.
    await expect(page.getByTestId('replica-removals-host').getByRole('alert')).toContainText('The rows changed since you read this')
    await expect(row).toHaveAttribute('data-state', 'error')
    await expect(row).toHaveAttribute('data-removal', 'refused')
    expect(f.posts.length).toBe(1)
    await shot(page, 'conflict')
  })
})
