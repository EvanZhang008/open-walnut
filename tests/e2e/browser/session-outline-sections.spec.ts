/**
 * The outline's sections (2026-11-03, the user: "the TOC should be auto
 * generated to make sense for long ones"): a long conversation's outline lists
 * one entry per message sent in the main conversation, named by the server's AI
 * (here its deterministic stub: the message's first three words), mixed in
 * transcript order with the pins. A click lands on that message; a section has
 * no unpin. In a session with questions the question map shows instead, and the
 * sections are its `<n> sections` group, reachable from a question's page too.
 */
import { expect, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { openThreadsSession, resetThreadsFixture, test } from './threads-helpers'
import {
  buildSectionsMapSession, buildSectionsSession, SECTION_MESSAGES, SECTIONS_MAP_QUESTION_TITLE, SECTIONS_MAP_SESSION,
  SECTIONS_MAP_TASK, SECTIONS_PIN_PASSAGE, SECTIONS_SESSION, SECTIONS_TASK, stubSectionTitle,
} from './sections-fixture'

const IDS = buildSectionsSession(Date.now()).ids
const MAP_IDS = buildSectionsMapSession(Date.now()).ids
const TITLES = SECTION_MESSAGES.map(stubSectionTitle)

async function shot(page: Page, name: string): Promise<void> {
  const dir = `${process.env.WALNUT_TASK_DIR ?? '/tmp'}/shots/outline-sections/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  await page.screenshot({ path: `${dir}/${name}.png` })
}

async function open(page: Page, sessionId: string, taskId: string): Promise<Locator> {
  await resetThreadsFixture(page.request, sessionId)
  await page.setViewportSize({ width: 1280, height: 860 })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.addStyleTag({ content: '.notification-toaster { display: none !important; }' })
  await page.addStyleTag({ content: `.main-page-session-column:has(.session-panel[data-session-id="${sessionId}"]) {
    flex: 0 0 760px !important; width: 760px !important; min-width: 760px !important; max-width: 760px !important; }` })
  return openThreadsSession(page, sessionId, taskId, SECTION_MESSAGES.at(-1))
}

/** The message row `msgId` sits inside the timeline's visible box. */
async function expectInView(panel: Locator, msgId: string): Promise<void> {
  const history = panel.locator('.session-history')
  const row = history.locator(`[data-message-id="${msgId}"]`).first()
  await expect(async () => {
    const box = await history.boundingBox()
    const r = await row.boundingBox()
    expect(box && r).toBeTruthy()
    expect(r!.y).toBeGreaterThanOrEqual(box!.y - 1)
    expect(r!.y).toBeLessThan(box!.y + box!.height - 20)
  }).toPass({ timeout: 10_000 })
}

test.describe('outline sections', () => {
  test('a long conversation lists its messages as AI-named sections beside the pin, and a click lands on one', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(String(e)))
    const panel = await open(page, SECTIONS_SESSION, SECTIONS_TASK)
    const toc = panel.locator('.session-toc')
    // Ten sections and the pin: one tick each.
    await expect(toc.locator('.session-toc-tick')).toHaveCount(11)
    await expect(toc.locator('.session-toc-tick--section')).toHaveCount(10)
    await toc.locator('.session-toc-rail').hover()
    const sections = toc.locator('.session-toc-row[data-section]')
    // The names arrive from the server (the client asks for them once): each
    // section reads its title, in transcript order.
    await expect(sections.locator('.session-toc-label')).toHaveText(TITLES, { timeout: 20_000 })
    // The pin sits after the section of the message it is in, before the next one.
    const labels = await toc.locator('.session-toc-row .session-toc-label').allTextContents()
    expect(labels.indexOf(`\u275d ${SECTIONS_PIN_PASSAGE}`)).toBe(2)
    // A section is no pin: nothing to unpin; the pin still has its ×.
    await expect(sections.locator('.session-toc-unpin')).toHaveCount(0)
    await expect(toc.locator('.session-toc-row:not([data-section]) .session-toc-unpin')).toHaveCount(1)
    await shot(page, 'outline-open')

    // The fourth section lands on the fourth message.
    await sections.nth(3).locator('.session-toc-item').click()
    await expectInView(panel, IDS.user[3])
    await toc.locator('.session-toc-rail').hover()
    await expect(toc.locator('.session-toc-back')).toBeVisible()
    await shot(page, 'outline-jumped')

    // The titles live on the session record: a reload shows them straight away.
    await page.reload()
    await page.waitForLoadState('networkidle')
    const again = await openThreadsSession(page, SECTIONS_SESSION, SECTIONS_TASK, SECTION_MESSAGES.at(-1))
    // The pointer may still sit where the list opens: open it only when it is shut.
    if (!(await again.locator('.session-toc-panel').isVisible())) await again.locator('.session-toc-rail').hover()
    await expect(again.locator('.session-toc-row[data-section] .session-toc-label')).toHaveText(TITLES, { timeout: 5_000 })
    expect(errors).toEqual([])
  })

  test('with questions, the map holds the sections as one group, reachable from a question page too', async ({ page }) => {
    const panel = await open(page, SECTIONS_MAP_SESSION, SECTIONS_MAP_TASK)
    const map = panel.locator('.thread-map')
    // The map's own box is a zero-height sticky anchor: its rows are what shows.
    await expect(map.locator('.thread-map-row[data-kind="root"]')).toBeVisible()
    await expect(panel.locator('.session-toc')).toHaveCount(0)
    const group = map.locator('.thread-map-row[data-kind="section-group"]')
    await expect(group).toHaveText(/10 sections/)
    await expect(group).toHaveAttribute('aria-expanded', 'false')
    await expect(map.locator('.thread-map-row[data-kind="section"]')).toHaveCount(0)
    await group.click()
    await expect(group).toHaveAttribute('aria-expanded', 'true')
    const rows = map.locator('.thread-map-row[data-kind="section"]')
    await expect(rows.locator('.thread-map-label')).toHaveText(TITLES, { timeout: 20_000 })
    await shot(page, 'map-sections')

    // On the question's page (Tree Mode), a section goes back to the main
    // conversation and lands on its message.
    await map.locator('.thread-map-row[data-kind="thread"]', { hasText: SECTIONS_MAP_QUESTION_TITLE }).click()
    await expect(map.locator('.thread-map-row[data-kind="thread"][data-current="true"]')).toBeVisible()
    await rows.nth(7).click()
    await expect(map.locator('.thread-map-row[data-kind="root"][data-current="true"]')).toBeVisible()
    await expectInView(panel, MAP_IDS.user[7])
    await shot(page, 'map-section-jumped')
  })
})
