/**
 * The host replica path in the MAIN Playwright config, so CI covers it
 * (docs/plan/walnut-replica-servers-impl.md, WP7): one chromium spec that
 * starts its own cluster (tests/helpers/replica-cluster.ts: a real Mac, a host
 * daemon, the replica it supervises) and a fake tunnel in front of the replica
 * whose pages come from this config's own page server (the :3457 fixture's Vite).
 *
 * Away read and one away write: signed in through the tunnel with a code the
 * Mac made, the Mac sleeps, the away line comes by itself, the board reads
 * from the copy (titles matched exactly), a task's Board page this page never
 * loaded opens from the copy (x-walnut-offline on its request), and an edit
 * says "Needs your Mac" and leaves the task open (WP10 turns this row into a
 * write kept on the host, "Syncs when your Mac is back"); the Mac wakes and the
 * line goes with no reload. The full matrix (both engines, both viewports,
 * sessions, notes, the inbox) is replica-away-read.spec.ts on replica.config.ts.
 */
import { test, expect, type Page } from '@playwright/test'
import { startReplicaCluster, WINDOWS, type ReplicaCluster } from '../../helpers/replica-cluster.js'
import { startFakeTunnel, type FakeTunnel } from './replica-tunnel.js'
import { openListProject } from './todo-panel-helpers'

test.describe.configure({ mode: 'serial' })

let cluster: ReplicaCluster | null = null
let tunnel: FakeTunnel | null = null

const NEEDS_MAC = 'Needs your Mac. Changing a task needs your Mac for now.'
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** A task row whose title is exactly `title`. */
const row = (page: Page, title: string) => page.locator('.todo-panel .todo-panel-item')
  .filter({ has: page.locator('.todo-item-title', { hasText: new RegExp(`^\\s*${escapeRe(title)}\\s*$`) }) }).first()

test.beforeAll(async () => {
  test.setTimeout(900_000)
  cluster = await startReplicaCluster({ twin: 'source' })
  // The pages come from this config's own page server (its baseURL).
  const pagePort = Number(new URL(test.info().project.use.baseURL ?? 'http://localhost:3457').port || 80)
  tunnel = await startFakeTunnel({ port: 0, replicaPort: cluster.replicaPort, pagePort })
})

test.afterAll(async () => {
  test.setTimeout(180_000)
  await tunnel?.close().catch(() => undefined)
  await cluster?.stop()
})

test('a host replica: sign in through it, read away, an away edit needs the Mac, back with no reload', async ({ page }) => {
  test.setTimeout(300_000)
  const c = cluster!
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const tunnelUrl = `http://127.0.0.1:${tunnel!.port}`

  await page.goto(`${tunnelUrl}/`)
  const notice = page.getByTestId('unpaired-notice')
  await expect(notice).toBeVisible({ timeout: 120_000 })
  const devices = () => ((c.deviceCopy() as { devices?: unknown[] } | null)?.devices ?? []).length
  const before = devices()
  await page.getByTestId('unpaired-code-input').fill(await c.browserCode())
  await page.getByTestId('unpaired-code-submit').click()
  await expect(notice).toBeHidden({ timeout: 60_000 })
  // A fresh browser shows the project folded: open it as the person does.
  await openListProject(page, 'Acme')
  await expect(row(page, 'Release plan')).toBeVisible({ timeout: 120_000 })
  await expect.poll(devices, { timeout: 60_000 }).toBeGreaterThan(before)
  await page.evaluate(() => { (window as unknown as { __replicaMarker?: string }).__replicaMarker = 'kept' })

  const t0 = Date.now()
  c.sleepMac()
  await expect(page.getByTestId('away-line')).toBeVisible({ timeout: WINDOWS.quietMs + 5_000 })
  expect(Date.now() - t0).toBeLessThan(WINDOWS.quietMs + 5_000)
  await expect(page.getByTestId('away-line')).toContainText('Your Mac is away. This is the copy on devbox')
  await expect(row(page, 'Release plan')).toBeVisible()
  await expect(row(page, 'Fix the flaky build \u00e9t\u00e9')).toBeVisible()

  // A view this page never loaded: the task's Board, from the copy.
  await row(page, 'Release plan').locator('.todo-item-title').click()
  const panel = page.locator(`.session-panel[data-session-id="${c.ids.macSid}"]`).first()
  await expect(panel).toBeVisible({ timeout: 30_000 })
  const boardRead = page.waitForResponse((r) => r.request().method() === 'GET' && new URL(r.url()).pathname.startsWith(`/api/v1/tasks/${c.ids.board}/board`), { timeout: 30_000 })
  await panel.getByTestId('session-board-chip').click()
  const pane = page.getByTestId('task-board-pane')
  await expect(pane).toBeVisible({ timeout: 30_000 })
  const custom = pane.getByTestId('board-view-custom')
  await expect(custom).toBeVisible({ timeout: 15_000 })
  if ((await custom.getAttribute('aria-pressed')) !== 'true') await custom.click()
  await expect(page.frameLocator('.task-board-frame').locator('#build')).toHaveText('Build: green', { timeout: 30_000 })
  const read = await boardRead
  expect(read.status()).toBe(200)
  expect(Number(read.headers()['x-walnut-offline'])).toBeGreaterThan(0)
  const exit = page.getByRole('button', { name: 'Exit full screen' })
  for (let i = 0; i < 3 && (await exit.count()) > 0; i++) { await exit.first().click(); await page.waitForTimeout(300) }

  await row(page, 'Release plan').getByRole('button', { name: 'Mark complete' }).click()
  await expect(page.getByText(NEEDS_MAC, { exact: true }).first()).toBeVisible({ timeout: 15_000 })
  // Refused: the task is still open, on the page and in the replica's copy.
  await page.waitForTimeout(1_500)
  await expect(row(page, 'Release plan').getByRole('button', { name: 'Mark complete' })).toBeVisible()
  const copied = (c.stores().taskRows as Array<{ id: string; phase: string }>).find((t) => t.id === c.ids.board)
  expect(copied?.phase).not.toBe('COMPLETE')

  c.wakeMac()
  await expect(page.getByTestId('away-line')).toHaveCount(0, { timeout: 60_000 })
  expect(await page.evaluate(() => (window as unknown as { __replicaMarker?: string }).__replicaMarker)).toBe('kept')
  expect(errors).toEqual([])
})
