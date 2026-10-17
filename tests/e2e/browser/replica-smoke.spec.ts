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
 * loaded opens from the copy (x-walnut-offline on its request), and a complete
 * is kept on the host (WP10): the row shows done with "Syncs when your Mac is
 * back" while the replica's copy stays the Mac's; the Mac wakes, the line goes
 * with no reload, the Mac's store has the task complete and the mark goes. The full matrix (both engines, both viewports,
 * sessions, notes, the inbox) is replica-away-read.spec.ts on replica.config.ts.
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { startReplicaCluster, WINDOWS, type ReplicaCluster } from '../../helpers/replica-cluster.js'
import { startFakeTunnel, type FakeTunnel } from './replica-tunnel.js'
import { openListProject } from './todo-panel-helpers'

test.describe.configure({ mode: 'serial' })

let cluster: ReplicaCluster | null = null
let tunnel: FakeTunnel | null = null

const NEEDS_MAC = 'Needs your Mac. Changing a task needs your Mac for now.'
const AWAY_SYNC = 'Syncs when your Mac is back'

/** A task's phase in the Mac's own store on disk (read only). */
function macPhase(c: ReplicaCluster, id: string): string | null {
  const Database = createRequire(import.meta.url)('better-sqlite3') as new (file: string, o: { readonly: boolean; fileMustExist: boolean }) => { prepare(q: string): { get(id: string): unknown }; close(): void }
  const db = new Database(path.join(c.macData, 'tasks', 'tasks.sqlite'), { readonly: true, fileMustExist: true })
  try { return ((db.prepare('SELECT phase FROM tasks WHERE id = ?').get(id) as { phase?: string } | undefined)?.phase) ?? null } finally { db.close() }
}
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

test('a host replica: sign in through it, read away, an away complete kept on the host, back with no reload', async ({ page }) => {
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

  // The away write (WP10): kept on the host, the row done with its mark at once (it
  // stays in view for the completion's grace window, about 3 s).
  await row(page, 'Release plan').getByRole('button', { name: 'Mark complete' }).click()
  const done = row(page, 'Release plan')
  await expect(done.getByTestId('away-sync-mark')).toHaveText(AWAY_SYNC, { timeout: 2_500 })
  await expect(done.getByRole('button', { name: 'Reopen (mark To Do)' })).toBeVisible()
  await expect(page.getByText(NEEDS_MAC, { exact: true })).toHaveCount(0)
  // The replica's copy is the Mac's alone: the write is in the host's journal, not in it.
  const copied = (c.stores().taskRows as Array<{ id: string; phase: string }>).find((t) => t.id === c.ids.board)
  expect(copied?.phase).not.toBe('COMPLETE')

  c.wakeMac()
  await expect(page.getByTestId('away-line')).toHaveCount(0, { timeout: 60_000 })
  // The Mac drained it: its store on disk has the task complete, once.
  await expect.poll(() => macPhase(c, c.ids.board), { timeout: 60_000 }).toBe('COMPLETE')
  await expect(page.getByTestId('away-sync-mark')).toHaveCount(0, { timeout: 60_000 })
  expect(await page.evaluate(() => (window as unknown as { __replicaMarker?: string }).__replicaMarker)).toBe('kept')
  expect(errors).toEqual([])
})
