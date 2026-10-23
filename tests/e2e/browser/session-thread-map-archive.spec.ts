/**
 * The question map's × (2026-10-15, the user: "shouldn't there be a x button
 * that will archive?"). An open question's row shows an × on hover or focus in
 * place of its status word; it archives the question with the panel toast's
 * Undo, never opens it. A question with open follow-ups asks first, the same
 * question the page header and the drawer ask. Archived rows, pins and the main
 * conversation have no ×.
 *
 * On the map fixture: Q1 has two open follow-ups (Q1a, Q1b), Q4 one (Q4a), Q4a
 * none, Q3 is archived. Each test starts from the seeded record.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { openThreadsSession, readRecord, resetThreadsFixture, switchView } from './threads-helpers'
import { buildMapSession, MAP_SESSION, MAP_TITLES } from './threads-fixture'

const MAP_TASK = 'pw-task-threads-map'
const MAP_IDS = buildMapSession(Date.now()).ids
const MAP_READY = 'Summarize the open risks.'
const WIDE = 720
const NARROW = 480

async function shot(page: Page, name: string): Promise<void> {
  const dir = `/tmp/map-archive/e2e/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  await page.screenshot({ path: `${dir}/${name}.png` })
}

async function openAt(page: Page, width: number, view: 'stack' | 'linear' = 'stack'): Promise<Locator> {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.addStyleTag({ content: '.notification-toaster { display: none !important; }' })
  await page.addStyleTag({ content: `.main-page-session-column:has(.session-panel[data-session-id="${MAP_SESSION}"]) {
    flex: 0 0 ${width}px !important; width: ${width}px !important; min-width: ${width}px !important; max-width: ${width}px !important; }` })
  const panel = await openThreadsSession(page, MAP_SESSION, MAP_TASK, MAP_READY, { view })
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().endTime !== Infinity)
    .map((a) => a.finished.catch(() => undefined))))
  return panel
}

const mapOf = (panel: Locator) => panel.locator('.thread-map')
const itemOf = (scope: Locator, title: string) => scope.locator('.thread-map-item', { has: scope.page().locator('.thread-map-label', { hasText: title }) }).first()
const rowOf = (scope: Locator, title: string) => scope.locator('.thread-map-row', { hasText: title }).first()
const xOf = (item: Locator) => item.locator('.thread-map-archive')

async function statusOf(request: Parameters<typeof readRecord>[0], q: keyof typeof MAP_IDS): Promise<unknown> {
  const rec = await readRecord(request, MAP_SESSION)
  return rec.threadMeta?.find((m) => m.headId === MAP_IDS[q].u)?.status
}

test.describe('Question map: archive from a row', () => {
  test.setTimeout(180_000)
  test.beforeEach(async ({ request }) => { await resetThreadsFixture(request, MAP_SESSION) })
  test.afterEach(async ({ request }) => { await resetThreadsFixture(request, MAP_SESSION) })

  test('wide panel: hover shows the × in the status slot; it archives without opening, and Undo brings it back', async ({ page, request }) => {
    const panel = await openAt(page, WIDE)
    const map = mapOf(panel)
    await expect(map).toHaveAttribute('data-shape', 'panel')
    await expect(map.locator('.thread-map-count')).toHaveText('5 open')
    const item = itemOf(map, MAP_TITLES.Q4a)
    const x = xOf(item)
    // At rest the × is invisible and the status word shows.
    await expect(x).toHaveCSS('opacity', '0')
    await item.hover()
    await expect(x).toHaveCSS('opacity', '1')
    await expect(x).toHaveAttribute('aria-label', `Archive “${MAP_TITLES.Q4a}”`)
    if (await item.locator('.thread-map-status').count()) {
      await expect(item.locator('.thread-map-status')).toHaveCSS('visibility', 'hidden')
    }
    // The × sits inside the row's box, at its right edge.
    const rb = (await rowOf(map, MAP_TITLES.Q4a).boundingBox())!
    const xb = (await x.boundingBox())!
    expect(xb.x + xb.width).toBeLessThanOrEqual(rb.x + rb.width + 0.5)
    expect(xb.y).toBeGreaterThanOrEqual(rb.y - 0.5)
    expect(xb.y + xb.height).toBeLessThanOrEqual(rb.y + rb.height + 0.5)
    await shot(page, 'wide-hover')

    await x.click()
    const toast = page.locator('.thread-toast')
    await expect(toast).toContainText(`Archived: ${MAP_TITLES.Q4a}`)
    // Archived, not opened: still the main conversation, no page pushed.
    await expect(panel.locator('.thread-stack')).toHaveAttribute('data-thread-depth', '0')
    await expect(rowOf(map, 'Main conversation')).toHaveAttribute('aria-current', 'page')
    await expect(itemOf(map, MAP_TITLES.Q4a)).toHaveCount(0)
    // An archived follow-up folds into its parent's own group, under Q4.
    await expect(map.locator('.thread-map-row[data-kind="done-group"]')).toHaveText(['1 archived', '1 archived'])
    await expect(map.locator('.thread-map-count')).toHaveText('4 open')
    await expect.poll(() => statusOf(request, 'Q4a')).toBe('resolved')
    await shot(page, 'wide-archived')

    await toast.getByRole('button', { name: 'Undo' }).click()
    await expect(itemOf(map, MAP_TITLES.Q4a)).toHaveCount(1)
    await expect(map.locator('.thread-map-count')).toHaveText('5 open')
    await expect.poll(() => statusOf(request, 'Q4a')).toBe('open')
  })

  test('archived rows, pins and the main conversation have no ×', async ({ page }) => {
    const panel = await openAt(page, WIDE)
    const map = mapOf(panel)
    await map.locator('.thread-map-row[data-kind="done-group"]').click()
    await expect(rowOf(map, MAP_TITLES.Q3)).toBeVisible()
    await expect(itemOf(map, MAP_TITLES.Q3)).toHaveCount(0)
    await expect(map.locator('.thread-map-item:has(.thread-map-row[data-kind="pin"])')).toHaveCount(0)
    await expect(map.locator('.thread-map-item:has(.thread-map-row[data-kind="root"])')).toHaveCount(0)
    // Every open question has one (Q1, Q1a, Q1b, Q2 suggested, Q4, Q4a).
    await expect(map.locator('.thread-map-archive')).toHaveCount(6)
  })

  test('a question with open follow-ups asks first: Only this one, then Archive all', async ({ page, request }) => {
    const panel = await openAt(page, WIDE)
    const map = mapOf(panel)
    const confirm = page.locator('.thread-confirm')
    await itemOf(map, MAP_TITLES.Q1).hover()
    await xOf(itemOf(map, MAP_TITLES.Q1)).click()
    await expect(confirm.locator('.thread-confirm-title')).toHaveText('Also archive 2 follow-ups?')
    await shot(page, 'wide-confirm')
    await confirm.getByRole('button', { name: 'Only this one' }).click()
    await expect(confirm).toHaveCount(0)
    await expect.poll(() => statusOf(request, 'Q1')).toBe('resolved')
    expect(await statusOf(request, 'Q1a')).toBe('open')
    expect(await statusOf(request, 'Q1b')).toBe('open')
    await expect(panel.locator('.thread-stack')).toHaveAttribute('data-thread-depth', '0')

    await resetThreadsFixture(request, MAP_SESSION)
    await page.reload()
    await page.waitForLoadState('networkidle')
    const panel2 = await openThreadsSession(page, MAP_SESSION, MAP_TASK, MAP_READY)
    const map2 = mapOf(panel2)
    await expect(map2.locator('.thread-map-count')).toHaveText('5 open')
    await itemOf(map2, MAP_TITLES.Q1).hover()
    await xOf(itemOf(map2, MAP_TITLES.Q1)).click()
    await confirm.getByRole('button', { name: 'Archive all' }).click()
    await expect.poll(() => statusOf(request, 'Q1')).toBe('resolved')
    await expect.poll(() => statusOf(request, 'Q1a')).toBe('resolved')
    await expect.poll(() => statusOf(request, 'Q1b')).toBe('resolved')
    await expect(map2.locator('.thread-map-count')).toHaveText('2 open')
  })

  test('keyboard: ArrowRight reaches the ×, ArrowLeft goes back, Enter archives and focus stays in the map; Esc drops the confirm', async ({ page, request }) => {
    const panel = await openAt(page, WIDE)
    const map = mapOf(panel)
    const row = rowOf(map, MAP_TITLES.Q4a)
    await row.focus()
    await page.keyboard.press('ArrowRight')
    const x = xOf(itemOf(map, MAP_TITLES.Q4a))
    await expect(x).toBeFocused()
    await expect(x).toHaveCSS('opacity', '1')
    await page.keyboard.press('ArrowLeft')
    await expect(row).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Enter')
    await expect.poll(() => statusOf(request, 'Q4a')).toBe('resolved')
    // Focus moved to a neighbouring row, never to <body>.
    const focused = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      return { inMap: !!el?.closest('.thread-map'), isRow: !!el?.matches('[data-map-row]'), text: el?.textContent ?? '' }
    })
    expect(focused.inMap).toBe(true)
    expect(focused.isRow).toBe(true)
    expect(focused.text).not.toContain(MAP_TITLES.Q4a)

    // Q4 has an open follow-up only while Q4a is open: put it back, then Esc the confirm.
    await page.locator('.thread-toast').getByRole('button', { name: 'Undo' }).click()
    await expect.poll(() => statusOf(request, 'Q4a')).toBe('open')
    await rowOf(map, MAP_TITLES.Q4).focus()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Enter')
    const confirm = page.locator('.thread-confirm')
    await expect(confirm.locator('.thread-confirm-title')).toHaveText('Also archive 1 follow-up?')
    await page.keyboard.press('Escape')
    await expect(confirm).toHaveCount(0)
    // Esc closed one layer: nothing archived, no page popped or pushed.
    await page.waitForTimeout(400)
    expect(await statusOf(request, 'Q4')).toBe('open')
    await expect(panel.locator('.thread-stack')).toHaveAttribute('data-thread-depth', '0')
  })

  test('narrow rail: the list stays open across an × and while the follow-ups question is up', async ({ page, request }) => {
    const panel = await openAt(page, NARROW)
    const map = mapOf(panel)
    await expect(map).toHaveAttribute('data-shape', 'rail')
    await map.locator('.thread-map-rail').hover()
    const overlay = map.locator('.thread-map-overlay')
    await expect(overlay).toBeVisible()
    await itemOf(overlay, MAP_TITLES.Q4a).hover()
    await xOf(itemOf(overlay, MAP_TITLES.Q4a)).click()
    await expect.poll(() => statusOf(request, 'Q4a')).toBe('resolved')
    await page.waitForTimeout(400)
    await expect(overlay).toBeVisible()
    await shot(page, 'rail-after-archive')

    await itemOf(overlay, MAP_TITLES.Q1).hover()
    await xOf(itemOf(overlay, MAP_TITLES.Q1)).click()
    const confirm = page.locator('.thread-confirm')
    await expect(confirm).toBeVisible()
    // The pointer leaves the list for the confirm (a portal): the list holds.
    await confirm.locator('.thread-confirm-title').hover()
    await page.waitForTimeout(400)
    await expect(overlay).toBeVisible()
    await shot(page, 'rail-confirm')
    await confirm.getByRole('button', { name: 'Only this one' }).click()
    await expect.poll(() => statusOf(request, 'Q1')).toBe('resolved')
    expect(await statusOf(request, 'Q1a')).toBe('open')
  })

  test('Conversation Mode: the × archives and leaves the composer on the main conversation', async ({ page, request }) => {
    const panel = await openAt(page, WIDE, 'linear')
    await switchView(panel, 'linear')
    const map = mapOf(panel)
    await itemOf(map, MAP_TITLES.Q4a).hover()
    await xOf(itemOf(map, MAP_TITLES.Q4a)).click()
    await expect.poll(() => statusOf(request, 'Q4a')).toBe('resolved')
    await expect(panel.locator('[data-testid="composer-thread-target"]')).toHaveCount(0)
    await expect(rowOf(map, 'Main conversation')).toHaveAttribute('aria-current', 'page')
  })
})
