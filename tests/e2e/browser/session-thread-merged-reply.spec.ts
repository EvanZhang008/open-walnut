/**
 * Questions answered inside the running turn's reply (2026-10-29 real-CLI run).
 *
 * Two questions were sent while a turn ran a command. The CLI handed both over
 * mid-turn, and the model answered the turn and both questions in its one final
 * reply, each answer under its `[Qn]` line. The whole reply was filed under
 * question 2: question 1 read No answer, question 2's card held question 1's
 * answer, and the main conversation lost its own reply.
 *
 * Now the reply is split at the tags (web/src/utils/tagged-reply-split.ts): the
 * main conversation keeps its own part, and each question's card and Tree page
 * hold the part under its tag.
 *
 * Chromium and WebKit, on pw-threads-merged-session (threads-fixture.ts).
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { openThreadsSession, resetThreadsFixture, switchView } from './threads-helpers'
import { MERGED_ANSWERS, MERGED_READY, MERGED_SESSION, MERGED_TASK, MERGED_TITLES } from './threads-fixture'

async function shot(page: Page, name: string, target?: Locator): Promise<void> {
  const dir = `/tmp/merged-reply/e2e/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  if (target) await target.screenshot({ path: `${dir}/${name}.png` })
  else await page.screenshot({ path: `${dir}/${name}.png` })
}

async function open(page: Page, view: 'stack' | 'linear'): Promise<Locator> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.setViewportSize({ width: 1800, height: 800 })
  await page.addStyleTag({ content: `.main-page-session-column:has(.session-panel[data-session-id="${MERGED_SESSION}"]) {
    flex: 0 0 1100px !important; width: 1100px !important; min-width: 1100px !important; max-width: 1100px !important; }` })
  return openThreadsSession(page, MERGED_SESSION, MERGED_TASK, MERGED_READY, { view })
}

const history = (panel: Locator) => panel.locator('.session-history')
const threadRow = (panel: Locator, title: string) =>
  panel.locator('.thread-map .thread-map-row[data-kind="thread"]', { hasText: title })

test.describe('questions answered inside the running turn\'s reply', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  test.beforeEach(async ({ request }) => {
    await resetThreadsFixture(request, MERGED_SESSION)
  })

  test('Conversation: each card holds its own answer, the main chat keeps the turn\'s', async ({ page }) => {
    const panel = await open(page, 'linear')
    const card = panel.locator('.thread-card')
    await expect(panel.locator('.thread-map .thread-map-row[data-kind="thread"]')).toHaveCount(2)

    // The main conversation keeps the turn's own answer.
    await expect(history(panel)).toContainText(MERGED_ANSWERS.ROOT)

    for (const [n, title, own, other] of [
      ['1', MERGED_TITLES.Q1, MERGED_ANSWERS.Q1, MERGED_ANSWERS.Q2],
      ['2', MERGED_TITLES.Q2, MERGED_ANSWERS.Q2, MERGED_ANSWERS.Q1],
    ] as const) {
      await threadRow(panel, title).click()
      await expect(card.locator('.thread-card-head .thread-map-num')).toHaveText(n)
      await expect(card.locator('.thread-card-title')).toHaveText(title)
      await expect(card.locator('.thread-status-word')).not.toHaveAttribute('data-kind', 'failed')
      await expect(card.locator('.thread-card-noanswer')).toHaveCount(0)
      await expect(card.locator('.thread-card-body')).toContainText(own)
      await expect(card.locator('.thread-card-body')).not.toContainText(other)
      await expect(card.locator('.thread-card-body')).not.toContainText('ROOT-DONE')
      await shot(page, `card-q${n}`, panel)
    }
  })

  test('Tree: the root page keeps the turn\'s answer, each question\'s page its own', async ({ page }) => {
    const panel = await open(page, 'stack')
    await switchView(panel, 'stack')
    await panel.locator('.thread-map .thread-map-row[data-kind="root"]').click()
    await expect(history(panel)).toContainText(MERGED_ANSWERS.ROOT)
    await expect(history(panel)).not.toContainText(MERGED_ANSWERS.Q1)
    await expect(history(panel)).not.toContainText(MERGED_ANSWERS.Q2)
    await shot(page, 'tree-root', panel)

    for (const [n, title, own, other] of [
      ['1', MERGED_TITLES.Q1, MERGED_ANSWERS.Q1, MERGED_ANSWERS.Q2],
      ['2', MERGED_TITLES.Q2, MERGED_ANSWERS.Q2, MERGED_ANSWERS.Q1],
    ] as const) {
      await threadRow(panel, title).click()
      await expect(panel.locator('.thread-stack-header .thread-stack-title')).toHaveText(title)
      await expect(history(panel)).toContainText(own)
      await expect(history(panel)).not.toContainText(other)
      await expect(history(panel)).not.toContainText('ROOT-DONE')
      // The tag line is Walnut's filing mark, never shown.
      expect(await history(panel).innerText()).not.toMatch(/\[Q\s?\d+\]/)
      await shot(page, `tree-q${n}`, panel)
    }
  })
})
