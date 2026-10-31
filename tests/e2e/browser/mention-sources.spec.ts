/**
 * The composer's "@" picker with source tabs (MentionPalette + mention-sources-model):
 *
 *   All · Notes · Chat · Stuck      (Notes is built in; Chat and Stuck come from
 *                                    mention-sources-fixture.ts, the way a plugin's would)
 *
 * Real pipeline: the fixture server's /api/mention-sources routes, its notes folder, and a
 * Start that reaches the mock CLI, which echoes its whole input, so the reference card the
 * server built from the picked row shows in the reply. Nothing is route-mocked.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { discoverFixtureRoot, draftComposer, loadHome, openDraftOnCwd, REAL_PANEL } from './draft-helpers'

const PALETTE = '.draft-session-panel .mention-palette'

async function openComposer(page: Page): Promise<Locator> {
  const fixtureRoot = await discoverFixtureRoot()
  await loadHome(page)
  await openDraftOnCwd(page, `${fixtureRoot}/projects/walnut`)
  const input = draftComposer(page)
  await input.click()
  return input
}

const activeTab = (page: Page) => page.locator(`${PALETTE} .mention-tab.on`)
const groupNames = (page: Page) => page.locator(`${PALETTE} .mention-group-name`)
const selectedTitle = (page: Page) => page.locator(`${PALETTE} .mention-row.selected .mention-title`)

async function retype(page: Page, input: Locator, text: string): Promise<void> {
  await input.fill('')
  await page.keyboard.type(text)
}

test('source tabs: Tab and arrows cycle them, a keyword jumps to one, and the mixed view takes only exact plugin rows', async ({ page }) => {
  test.setTimeout(180_000)
  const shots = `/tmp/wn-at-sources/${test.info().project.name}`
  await fs.mkdir(shots, { recursive: true })
  const input = await openComposer(page)

  // Bare "@": the tab bar, All first; All is Tasks and Files as before.
  await page.keyboard.type('@')
  await expect(page.locator(PALETTE)).toBeVisible({ timeout: 10_000 })
  await expect(page.locator(`${PALETTE} .mention-tab`)).toHaveText(['All', 'Notes', 'Chat', 'Stuck'])
  await expect(activeTab(page)).toHaveText('All')
  await expect(groupNames(page)).toContainText(['Tasks', 'Files'])
  await page.locator('.draft-session-panel').screenshot({ path: `${shots}/01-all.png` })

  // Tab → Notes (recent notes from the fixture vault), Tab → Chat (frequent people
  // and channels), Shift+Tab back to Notes. The query is kept as typed.
  await page.keyboard.press('Tab')
  await expect(activeTab(page)).toHaveText('Notes')
  await expect(page.locator(`${PALETTE} .mention-row-source`).filter({ hasText: 'Vault note' })).toBeVisible({ timeout: 15_000 })
  await page.keyboard.press('Tab')
  await expect(activeTab(page)).toHaveText('Chat')
  await expect(page.locator(`${PALETTE} .mention-row-source .mention-title`)).toHaveText(['Alice Chen', 'Bob Stone', '#deploy-alerts', '#garden-club'])
  await page.locator('.draft-session-panel').screenshot({ path: `${shots}/02-chat-tab.png` })
  await page.keyboard.press('Shift+Tab')
  await expect(activeTab(page)).toHaveText('Notes')
  await expect(input).toHaveValue('@')

  // A keyword and a space jump to its source; the keyword alone is an ordinary search.
  await retype(page, input, '@chat ali')
  await expect(activeTab(page)).toHaveText('Chat')
  await expect(selectedTitle(page)).toHaveText('Alice Chen', { timeout: 10_000 })
  await retype(page, input, '@chat')
  await expect(activeTab(page)).toHaveText('All')

  // Leaving a keyword's tab drops the keyword: "@tc deploy" ⇥ → Stuck, "@deploy".
  // Stuck never answers, so its tab says so instead of spinning forever.
  await retype(page, input, '@tc deploy')
  await expect(activeTab(page)).toHaveText('Chat')
  await page.keyboard.press('Tab')
  await expect(activeTab(page)).toHaveText('Stuck')
  await expect(input).toHaveValue('@deploy')
  await expect(page.locator(`${PALETTE} .mention-empty`)).toHaveText('Stuck did not answer in time.', { timeout: 10_000 })

  // ←/→ switch tabs only at the edges of the query: → at its end, ← right after
  // the "@" (or right after a switch). In the middle of the query ← moves the caret.
  await retype(page, input, '@depl')
  await expect(activeTab(page)).toHaveText('All')
  await page.keyboard.press('ArrowLeft')
  await expect(activeTab(page)).toHaveText('All')
  expect(await input.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(4)
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(activeTab(page)).toHaveText('Notes')
  await page.keyboard.press('ArrowLeft')
  await expect(activeTab(page)).toHaveText('All')
  expect(await input.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(5)

  // All takes a plugin row only on an exact name: "@alice" (a key) yes, "@ali" no.
  await retype(page, input, '@alice')
  const chatGroup = page.locator(`${PALETTE} [data-group="src:team-chat"]`)
  await expect(chatGroup).toBeVisible({ timeout: 10_000 })
  await expect(page.locator(`${PALETTE} .mention-row-source[data-source="team-chat"] .mention-title`)).toHaveText(['Alice Chen'])
  await page.locator('.draft-session-panel').screenshot({ path: `${shots}/03-all-exact.png` })
  await retype(page, input, '@ali')
  await page.waitForTimeout(700)
  await expect(chatGroup).toHaveCount(0)

  // Directory browsing still rewrites the query in place: a folder row descends
  // ("@<dir>/"), and ← on a path-shaped query goes back up, not to another tab.
  await retype(page, input, '@')
  const dirRow = page.locator(`${PALETTE} .mention-row:has(.mention-into)`).first()
  await expect(dirRow).toBeVisible({ timeout: 10_000 })
  const dirName = (await dirRow.locator('.mention-title').textContent())!.trim()
  await dirRow.dispatchEvent('mousedown')
  await expect(input).toHaveValue(`@${dirName}/`)
  await expect(page.locator(PALETTE)).toBeVisible()
  await page.keyboard.press('ArrowLeft')
  await expect(input).toHaveValue('@')
  await expect(activeTab(page)).toHaveText('All')

  await page.keyboard.press('Escape')
  await expect(page.locator(PALETTE)).toHaveCount(0)
})

test('a picked source row lands as a token and reaches the agent as a reference card', async ({ page, request }) => {
  test.setTimeout(240_000)
  const shots = `/tmp/wn-at-sources/${test.info().project.name}`
  await fs.mkdir(shots, { recursive: true })
  const input = await openComposer(page)

  await page.keyboard.type('ask @chat ')
  await expect(activeTab(page)).toHaveText('Chat', { timeout: 10_000 })
  await page.keyboard.type('bob')
  await expect(selectedTitle(page)).toHaveText('Bob Stone', { timeout: 10_000 })
  await page.keyboard.press('Enter')
  await expect(page.locator(PALETTE)).toHaveCount(0)
  await expect(input).toHaveValue('ask @[Bob Stone] ')
  await page.keyboard.type('about the deploy echo-input')
  await page.locator('.draft-session-panel').screenshot({ path: `${shots}/04-token.png` })

  const quickStartResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/sessions/quick-start')
  await page.keyboard.press('Enter')
  const quickStart = await quickStartResponse
  expect(quickStart.status()).toBe(200)
  const { sessionId } = await quickStart.json() as { sessionId: string }
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${sessionId}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })

  // The human's bubble shows the row as a pill, never the card block; the mock CLI
  // echoes its input, so the card the server resolved through the source is there.
  const bubble = panel.locator('.session-msg-user').filter({ hasText: 'about the deploy' })
  await expect(bubble.locator('span.source-link[data-source="team-chat"]')).toHaveText('Bob Stone', { timeout: 30_000 })
  await expect(bubble).not.toContainText('walnut-refs')
  await expect(panel).toContainText('FIXTURE_SOURCE_CARD', { timeout: 60_000 })
  await expect(panel).toContainText('(ref team-chat:user:U2)')
  await panel.screenshot({ path: `${shots}/05-sent-pill-and-card.png` })

  const session = await (await request.get(`/api/sessions/${sessionId}`)).json() as { session: { title?: string } }
  expect(session.session.title ?? '').not.toContain('<source-ref')
})
