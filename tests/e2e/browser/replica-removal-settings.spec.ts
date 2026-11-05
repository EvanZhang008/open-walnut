/**
 * Settings, Remote Hosts, "Removals to confirm" (docs/plan/walnut-replica-servers-impl.md,
 * section 4): a host's copy refused, three rounds in a row, a copy that would remove
 * most of its tasks. The row says how many would go; "Remove them there" asks first,
 * the page's one way ("Remove them from the copy on <host>?" with Cancel focused,
 * Escape as Cancel, no timer: RemoveConfirmRow; 2026-11-04 review: it armed a red
 * "Confirm remove" that turned back by itself after 3 s, with no Cancel), and its
 * Remove posts exactly the refusal the user read (count and keys); the row then
 * says the next copy takes it. A 409 (the rows moved) says so under the row, until a
 * later read shows the refusal moved again. A copy too old to take the confirm says
 * to update it there first, with no button. No row at all while every copy works.
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
  /** `outdated`: the copy refused the confirm anyway (an older Walnut there). */
  state: 'ok' | 'refused' | 'armed' | 'outdated'
  posts: Array<Record<string, unknown>>
  /** Answer the next confirm with 409 not_refused (the rows moved: one more row here). */
  conflict: boolean
  /** The rows this Mac has, as the refusal names them (3 unless set). */
  entries?: number
  /** The read after an armed one: the round sent the confirm and that copy refused it. */
  refuseConfirm?: boolean
  reads?: number
}

function statusBody(f: Fake): Record<string, unknown> {
  f.reads = (f.reads ?? 0) + 1
  const entries = f.entries ?? 3
  const tasks: Record<string, unknown> = { kind: 'tasks', refusals: 0, needsConfirm: false, action: 'synced', entries }
  if (f.state === 'outdated') {
    // An older build names no size in its refusal, and refused the confirm the user gave.
    Object.assign(tasks, { action: 'failed', refusals: 4, lastRefusal: { error: 'manifest_removes_most_rows', at: Date.now(), entries, keys: KEYS }, confirmRefused: { entries, keys: KEYS, at: Date.now() } })
  } else if (f.state !== 'ok') {
    Object.assign(tasks, { action: 'failed', refusals: 3, lastRefusal: { error: 'manifest_removes_most_rows', at: Date.now(), entries, keys: KEYS, local: 100, removing: 100 - entries } })
    tasks.needsConfirm = f.state === 'refused'
    if (f.state === 'armed') tasks.confirmArmed = { entries, keys: KEYS, at: Date.now(), expiresAt: Date.now() + 10 * 60_000 }
    if (f.state === 'armed' && f.refuseConfirm) f.state = 'outdated'
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
      f.entries = (f.entries ?? 3) + 1
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

/** "Remove them there", then the ask's Remove (RemoveConfirmRow under the row). */
async function confirmRemoval(page: Page): Promise<void> {
  await page.getByTestId(`replica-removal-confirm-${ROW}`).click()
  const ask = page.getByTestId(`replica-removal-ask-${ROW}`)
  await expect(ask).toBeVisible()
  await ask.getByTestId(`replica-removal-ask-${ROW}-remove`).click()
}

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true })
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await page.getByTestId('replica-removals-host').screenshot({ path: `${SHOTS}/${engine}-${name}.png`, scale: 'css' })
}

test.describe('Removals to confirm (copies that held off)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 900 })
  })

  test('while every copy works there is no row at all', async ({ page }) => {
    const f: Fake = { state: 'ok', posts: [], conflict: false }
    await fakeReplicas(page, f)
    const read = page.waitForResponse('**/api/replicas/status')
    await openRemoteHosts(page)
    await read
    // The pane has rendered down to its last part (More settings).
    await expect(page.getByTestId('remote-hosts-more')).toBeVisible()
    await expect(page.getByTestId('replica-removals-host')).toHaveCount(0)
    await expect(page.getByText('Removals to confirm')).toHaveCount(0)
  })

  test('a refusal names the size; it asks first, and its Remove confirms exactly the rows read; the row then says the next copy takes it', async ({ page }) => {
    const f: Fake = { state: 'refused', posts: [], conflict: false }
    await fakeReplicas(page, f)
    await openRemoteHosts(page)
    const group = page.getByTestId('replica-removals-host')
    await expect(group).toBeVisible({ timeout: 30_000 })
    await expect(group).toContainText('Removals to confirm')
    const row = page.getByTestId(`replica-removal-${ROW}`)
    await expect(row).toHaveAttribute('data-removal', 'refused')
    await expect(row).toHaveAttribute('data-state', 'warning')
    await expect(row).toContainText('pw-rr-box')
    await expect(page.getByTestId(`replica-removal-text-${ROW}`)).toHaveText(
      'This Mac has 3 tasks now, and the copy there would drop 97 of its 100. Walnut kept them there, in case this Mac lost them by mistake. If you removed them on purpose, remove them there too.',
    )
    await group.scrollIntoViewIfNeeded()
    await shot(page, 'refused')
    const button = page.getByTestId(`replica-removal-confirm-${ROW}`)
    await expect(button).toHaveText('Remove them there')
    // A press only asks, under the row, Cancel focused: nothing is sent.
    await button.click()
    const ask = page.getByTestId(`replica-removal-ask-${ROW}`)
    await expect(ask).toContainText('Remove them from the copy on pw-rr-box?')
    await expect(ask).toContainText('They are gone there too; this Mac keeps its own.')
    await expect(ask.getByTestId(`replica-removal-ask-${ROW}-cancel`)).toBeFocused()
    await expect(ask.getByTestId(`replica-removal-ask-${ROW}-remove`)).toHaveClass(/settings-button-danger/)
    await shot(page, 'asking')
    // Past the old 3 s timer it still asks; Escape is Cancel, and the focus goes back to the button.
    await page.waitForTimeout(3_300)
    await expect(ask).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(ask).toHaveCount(0)
    await expect(button).toBeFocused()
    expect(f.posts).toEqual([])
    // Asked again, its Remove sends exactly the refusal read.
    await button.click()
    await ask.getByTestId(`replica-removal-ask-${ROW}-remove`).click()
    await expect.poll(() => f.posts).toEqual([{ target: TARGET, kind: 'tasks', entries: 3, keys: KEYS }])
    await expect(row).toHaveAttribute('data-removal', 'armed')
    await expect(ask).toHaveCount(0)
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
    await confirmRemoval(page)
    const row = page.getByTestId(`replica-removal-${ROW}`)
    // The row's error sits right under it (SettingsRow), inside the group.
    await expect(page.getByTestId('replica-removals-host').getByRole('alert')).toContainText('The numbers changed since you read this')
    await expect(row).toHaveAttribute('data-state', 'error')
    await expect(row).toHaveAttribute('data-removal', 'refused')
    // The row shows the refusal as it is now, and the error is about it.
    await expect(page.getByTestId(`replica-removal-text-${ROW}`)).toContainText('This Mac has 4 tasks now')
    expect(f.posts.length).toBe(1)
    await shot(page, 'conflict')
  })

  test('an error under the row stays while the refusal holds, and goes once a later read shows it moved', async ({ page }) => {
    await page.clock.install()
    const f: Fake = { state: 'refused', posts: [], conflict: true }
    await fakeReplicas(page, f)
    await openRemoteHosts(page)
    const button = page.getByTestId(`replica-removal-confirm-${ROW}`)
    await expect(button).toBeVisible({ timeout: 30_000 })
    await confirmRemoval(page)
    const group = page.getByTestId('replica-removals-host')
    const row = page.getByTestId(`replica-removal-${ROW}`)
    const text = page.getByTestId(`replica-removal-text-${ROW}`)
    await expect(group.getByRole('alert')).toContainText('The numbers changed since you read this')
    await expect(text).toContainText('This Mac has 4 tasks now')
    // The next read (30 s later) shows the same refusal: the error stays.
    let reads = f.reads ?? 0
    await page.clock.fastForward(31_000)
    await expect.poll(() => f.reads ?? 0).toBeGreaterThan(reads)
    await expect(text).toContainText('This Mac has 4 tasks now')
    await expect(group.getByRole('alert')).toContainText('The numbers changed since you read this')
    // This Mac's rows move again: the row says the new count and the old error is gone.
    f.entries = 5
    reads = f.reads ?? 0
    await page.clock.fastForward(31_000)
    await expect.poll(() => f.reads ?? 0).toBeGreaterThan(reads)
    await expect(text).toContainText('This Mac has 5 tasks now')
    await expect(group.getByRole('alert')).toHaveCount(0)
    await expect(row).toHaveAttribute('data-state', 'warning')
    await expect(button).toBeVisible()
    await shot(page, 'conflict-cleared')
  })

  test('a copy too old to take the confirm says to update it there first, and offers no button', async ({ page }) => {
    const f: Fake = { state: 'refused', posts: [], conflict: false, refuseConfirm: true }
    await fakeReplicas(page, f)
    await openRemoteHosts(page)
    const button = page.getByTestId(`replica-removal-confirm-${ROW}`)
    await expect(button).toBeVisible({ timeout: 30_000 })
    await confirmRemoval(page)
    const row = page.getByTestId(`replica-removal-${ROW}`)
    // Armed, then the round sends it and that copy refuses it anyway (read every 5 s while armed).
    await expect(row).toHaveAttribute('data-removal', 'outdated', { timeout: 20_000 })
    await expect(page.getByTestId(`replica-removal-text-${ROW}`)).toHaveText(
      'This Mac has 3 tasks now, far fewer than the copy there. That copy runs an older Walnut that cannot take your confirm: update Walnut there first, then confirm here again.',
    )
    await expect(row).toHaveAttribute('data-state', 'warning')
    await expect(page.getByTestId(`replica-removal-confirm-${ROW}`)).toHaveCount(0)
    await expect(page.getByTestId('replica-removals-host').getByRole('alert')).toHaveCount(0)
    expect(f.posts.length).toBe(1)
    await shot(page, 'outdated')
  })
})
