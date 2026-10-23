/**
 * A question whose answer is more than prose opens its card expanded (2026-10-23,
 * the user: "can it enlarge itself when it is not plain text, when there is a table
 * or an HTML diagram" / "the default is too small"). A prose answer keeps the
 * resting size; the reader's own shrink holds for that question; a table that
 * streams into an open card grows it then.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { openThreadsSession, resetThreadsFixture, switchView } from './threads-helpers'
import { buildMapSession, MAP_SESSION, MAP_TITLES } from './threads-fixture'

const MAP_TASK = 'pw-task-threads-map'
const MAP_READY = 'Summarize the open risks.'
const IDS = buildMapSession(Date.now()).ids

const TABLE_ANSWER = [
  'Here is how the three layers line up:',
  '',
  '| Layer | Who writes | What the reader sees |',
  '| --- | --- | --- |',
  '| Buffer | the flush worker, once per tick | nothing until the page lands |',
  '| Page | one worker per slot | the newest version it can prove |',
].join('\n')

async function shot(page: Page, name: string): Promise<void> {
  const dir = `/tmp/card-auto-expand/e2e/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  await page.screenshot({ path: `${dir}/${name}.png` })
}

/** Serve the map session with Q1's answer replaced by a table. */
async function withTableAnswer(page: Page): Promise<void> {
  await page.route(`**/api/sessions/${MAP_SESSION}/history**`, async (route) => {
    const res = await route.fetch()
    const json = await res.json() as { messages?: Array<Record<string, unknown>> }
    for (const m of json.messages ?? []) {
      if (m.role === 'assistant' && [m.msgId, m.id, m.uuid].includes(IDS.Q1.a)) m.text = TABLE_ANSWER
    }
    await route.fulfill({ response: res, json })
  })
}

async function open(page: Page): Promise<Locator> {
  await page.setViewportSize({ width: 1400, height: 900 })
  await withTableAnswer(page)
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.addStyleTag({ content: '.notification-toaster { display: none !important; }' })
  await page.addStyleTag({ content: `.main-page-session-column:has(.session-panel[data-session-id="${MAP_SESSION}"]) {
    flex: 0 0 900px !important; width: 900px !important; min-width: 900px !important; max-width: 900px !important; }` })
  const panel = await openThreadsSession(page, MAP_SESSION, MAP_TASK, MAP_READY, { view: 'linear' })
  await switchView(panel, 'linear')
  return panel
}

const mapRow = (panel: Locator, title: string) => panel.locator('.thread-map .thread-map-row', { hasText: title }).first()
const card = (panel: Locator) => panel.locator('.thread-card')

test.describe('The comment card grows for a table or a diagram', () => {
  test.setTimeout(180_000)
  test.beforeEach(async ({ request }) => { await resetThreadsFixture(request, MAP_SESSION) })
  test.afterEach(async ({ request }) => { await resetThreadsFixture(request, MAP_SESSION) })

  test('a table answer opens expanded, a prose one at its size; the reader’s shrink holds', async ({ page }) => {
    const panel = await open(page)

    // Prose: the resting size.
    await mapRow(panel, MAP_TITLES.Q4).click()
    await expect(card(panel)).toBeVisible()
    await expect(card(panel).locator('.thread-card-title')).toHaveText(MAP_TITLES.Q4)
    await expect(card(panel)).not.toHaveAttribute('data-expanded', 'true')
    const resting = (await card(panel).boundingBox())!
    await shot(page, '01-prose-resting')

    // A table: expanded from the first frame, wider than the resting card.
    await mapRow(panel, MAP_TITLES.Q1).click()
    await expect(card(panel).locator('.thread-card-title')).toHaveText(MAP_TITLES.Q1)
    await expect(card(panel)).toHaveAttribute('data-expanded', 'true')
    await expect(card(panel).locator('.markdown-body table')).toBeVisible()
    const grown = (await card(panel).boundingBox())!
    expect(grown.width).toBeGreaterThan(resting.width + 40)
    await shot(page, '02-table-expanded')

    // The reader shrinks it: it stays at its size while the table is there.
    await card(panel).locator('.thread-card-expand').click()
    await expect(card(panel)).not.toHaveAttribute('data-expanded', 'true')
    await card(panel).locator('.markdown-body').first().evaluate((el) => el.appendChild(document.createElement('p')))
    await page.waitForTimeout(300)
    await expect(card(panel)).not.toHaveAttribute('data-expanded', 'true')

    // Reopened, it opens expanded again (the shrink was for that visit).
    await card(panel).locator('.thread-card-close').click()
    await expect(card(panel)).toHaveCount(0)
    await mapRow(panel, MAP_TITLES.Q1).click()
    await expect(card(panel)).toHaveAttribute('data-expanded', 'true')
  })

  test('a table that arrives while a prose card is open grows it', async ({ page }) => {
    const panel = await open(page)
    await mapRow(panel, MAP_TITLES.Q4).click()
    await expect(card(panel)).not.toHaveAttribute('data-expanded', 'true')
    // Stand-in for the answer streaming a table in: the card watches its body.
    await card(panel).locator('.markdown-body').last().evaluate((el) => {
      const t = document.createElement('table')
      t.innerHTML = '<tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr>'
      el.appendChild(t)
    })
    await expect(card(panel)).toHaveAttribute('data-expanded', 'true')
    await shot(page, '03-streamed-table-expanded')
  })
})
