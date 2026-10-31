/**
 * The composer's "@" picker with its tabs (MentionPalette + mention-sources-model):
 *
 *   All · Tasks · Notes · Chat · Late · Stuck    (Notes is built in; Chat, Late and Stuck
 *                                                 come from mention-sources-fixture.ts, the
 *                                                 way a plugin's would)
 *
 * All searches every source: Tasks, Notes and Files at once, then the plugin sources below,
 * a few rows each, as they answer (Late after 1.5 s, Stuck never), without moving the
 * highlight or holding the list. A picked row lands as a token naming its source, and the
 * model receives a card naming the source, the row's kind, its title and its ref: checked
 * in the session's Raw input view, which shows the input as the model got it.
 *
 * Real pipeline: the fixture server's /api/mention-sources routes, its notes folder, and a
 * Start that reaches the mock CLI. Nothing is route-mocked.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { discoverFixtureRoot, draftComposer, loadHome, openDraftOnCwd, REAL_PANEL } from './draft-helpers'
import { openKebabGroup } from './kebab-group-helpers'

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
const groupOf = (page: Page, id: string) => page.locator(`${PALETTE} [data-group="${id}"]`)

async function retype(page: Page, input: Locator, text: string): Promise<void> {
  await input.fill('')
  await page.keyboard.type(text)
}

/** The data-group of every group head and group box in the list, in screen order. */
async function groupOrder(page: Page): Promise<string[]> {
  return page.locator(`${PALETTE} .mention-list [data-group]`).evaluateAll((els) => {
    const out: string[] = []
    for (const el of els) {
      const g = el.getAttribute('data-group')!
      if (out[out.length - 1] !== g) out.push(g)
    }
    return out
  })
}

test('tabs: All, Tasks, Notes, then the plugin sources; All searches every source, the slow ones below', async ({ page }) => {
  test.setTimeout(180_000)
  const shots = `${process.env.WALNUT_TASK_DIR ?? "/tmp"}/shots/wn-at-sources/${test.info().project.name}`
  await fs.mkdir(shots, { recursive: true })
  const input = await openComposer(page)

  // Bare "@": All first, Tasks second, then the sources in the server's order.
  // All shows Tasks, then Notes (its recent notes), then Files.
  await page.keyboard.type('@')
  await expect(page.locator(PALETTE)).toBeVisible({ timeout: 10_000 })
  await expect(page.locator(`${PALETTE} .mention-tab`)).toHaveText(['All', 'Tasks', 'Notes', 'Chat', 'Late', 'Stuck'])
  await expect(activeTab(page)).toHaveText('All')
  await expect(groupOf(page, 'src:notes').locator('.mention-title').filter({ hasText: 'Vault note' })).toBeVisible({ timeout: 10_000 })
  await expect(groupNames(page)).toHaveText(['Tasks', 'Notes', 'Files'])
  await page.locator('.draft-session-panel').screenshot({ path: `${shots}/01-all.png` })

  // Tab → Tasks (tasks only), Tab → Notes, Tab → Chat; Shift+Tab back. The query is kept.
  await page.keyboard.press('Tab')
  await expect(activeTab(page)).toHaveText('Tasks')
  await expect(groupNames(page)).toHaveText(['Tasks'])
  await expect(page.locator(`${PALETTE} .mention-row-task`).first()).toBeVisible({ timeout: 10_000 })
  await page.keyboard.press('Tab')
  await expect(activeTab(page)).toHaveText('Notes')
  await expect(page.locator(`${PALETTE} .mention-row-source`).filter({ hasText: 'Vault note' })).toBeVisible({ timeout: 15_000 })
  await page.keyboard.press('Tab')
  await expect(activeTab(page)).toHaveText('Chat')
  await expect(page.locator(`${PALETTE} .mention-row-source .mention-title`)).toHaveText(['Alice Chen', 'Bob Stone', '#deploy-alerts', '#garden-club'])
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Shift+Tab')
  await expect(activeTab(page)).toHaveText('Tasks')
  await expect(input).toHaveValue('@')

  // A keyword and a space jump to its tab, "@tasks " included; the keyword alone is an
  // ordinary search.
  await retype(page, input, '@chat ali')
  await expect(activeTab(page)).toHaveText('Chat')
  await expect(selectedTitle(page)).toHaveText('Alice Chen', { timeout: 10_000 })
  await retype(page, input, '@tasks x')
  await expect(activeTab(page)).toHaveText('Tasks')
  await retype(page, input, '@chat')
  await expect(activeTab(page)).toHaveText('All')

  // Leaving a keyword's tab drops the keyword: "@tc deploy" ⇥ ⇥ → Stuck, "@deploy".
  // Stuck never answers, so its tab says so instead of spinning forever.
  await retype(page, input, '@tc deploy')
  await expect(activeTab(page)).toHaveText('Chat')
  await page.keyboard.press('Tab')
  await expect(activeTab(page)).toHaveText('Late')
  await expect(input).toHaveValue('@deploy')
  await page.keyboard.press('Tab')
  await expect(activeTab(page)).toHaveText('Stuck')
  await expect(page.locator(`${PALETTE} .mention-empty`)).toHaveText('Stuck did not answer in time.', { timeout: 10_000 })

  // ←/→ switch tabs only at the edges of the query.
  await retype(page, input, '@depl')
  await expect(activeTab(page)).toHaveText('All')
  await page.keyboard.press('ArrowLeft')
  await expect(activeTab(page)).toHaveText('All')
  expect(await input.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(4)
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(activeTab(page)).toHaveText('Tasks')
  await page.keyboard.press('ArrowLeft')
  await expect(activeTab(page)).toHaveText('All')

  // All searches the plugin sources too, on a loose match ("ali" finds Alice Chen), and
  // draws them under Tasks, Notes and Files. Late answers 1.5 s later and joins at the
  // foot; the highlight stays where it was; Stuck never answers and never shows.
  await retype(page, input, '@vault')
  const typedAt = Date.now()
  await expect(groupOf(page, 'src:notes').locator('.mention-title')).toHaveText(['Vault note'], { timeout: 10_000 })
  const notesAfter = Date.now() - typedAt
  await expect(groupOf(page, 'src:late')).toHaveCount(0)
  const highlighted = (await selectedTitle(page).textContent())!.trim()
  await expect(groupOf(page, 'src:late').locator('.mention-title')).toHaveText(['Late answer for vault'], { timeout: 10_000 })
  await expect(selectedTitle(page)).toHaveText(highlighted)
  const order = await groupOrder(page)
  expect(order.indexOf('src:notes')).toBeGreaterThan(order.indexOf('task'))
  expect(order.indexOf('files')).toBeGreaterThan(order.indexOf('src:notes'))
  expect(order.indexOf('src:late')).toBeGreaterThan(order.indexOf('files'))
  expect(order).not.toContain('src:stuck')
  expect(notesAfter, 'Notes is not held behind the slow sources').toBeLessThan(1500)
  await page.locator('.draft-session-panel').screenshot({ path: `${shots}/02-all-everything.png` })

  // A two-word query nothing local matches keeps the picker open until the slow
  // sources have answered, so their rows still arrive (the picker closes only when
  // every source is settled and empty).
  await retype(page, input, '@zq xv')
  await expect(groupOf(page, 'src:late').locator('.mention-title')).toHaveText(['Late answer for zq xv'], { timeout: 10_000 })
  await expect(page.locator(PALETTE)).toBeVisible()

  await retype(page, input, '@ali')
  await expect(groupOf(page, 'src:team-chat').locator('.mention-title')).toHaveText(['Alice Chen'], { timeout: 10_000 })
  expect((await groupOrder(page)).indexOf('src:team-chat')).toBeGreaterThan((await groupOrder(page)).indexOf('files'))
  await page.locator('.draft-session-panel').screenshot({ path: `${shots}/03-all-loose-plugin.png` })

  // Directory browsing still rewrites the query in place.
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

test('picked rows land as tokens naming their source, and the model receives cards saying what each one is', async ({ page }) => {
  test.setTimeout(240_000)
  const shots = `${process.env.WALNUT_TASK_DIR ?? "/tmp"}/shots/wn-at-sources/${test.info().project.name}`
  await fs.mkdir(shots, { recursive: true })
  const input = await openComposer(page)

  // A Chat person from its tab, a note from All.
  await page.keyboard.type('ask @chat ')
  await expect(activeTab(page)).toHaveText('Chat', { timeout: 10_000 })
  await page.keyboard.type('bob')
  await expect(selectedTitle(page)).toHaveText('Bob Stone', { timeout: 10_000 })
  await page.keyboard.press('Enter')
  await expect(page.locator(PALETTE)).toHaveCount(0)
  await expect(input).toHaveValue('ask @[Chat · Bob Stone] ')
  await page.keyboard.type('about @vault')
  const noteRow = groupOf(page, 'src:notes').locator('.mention-row-source').filter({ hasText: 'Vault note' })
  await expect(noteRow).toBeVisible({ timeout: 10_000 })
  await noteRow.dispatchEvent('mousedown')
  await expect(input).toHaveValue('ask @[Chat · Bob Stone] about @[Notes · Vault note] ')
  await page.keyboard.type('echo-input')
  await page.locator('.draft-session-panel').screenshot({ path: `${shots}/04-tokens.png` })

  const quickStartResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/sessions/quick-start')
  await page.keyboard.press('Enter')
  const quickStart = await quickStartResponse
  expect(quickStart.status()).toBe(200)
  const { sessionId } = await quickStart.json() as { sessionId: string }
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${sessionId}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })

  // The bubble: a pill per row, its source's name drawn in front, never the card block.
  const bubble = panel.locator('.session-msg-user').filter({ hasText: 'about' }).first()
  const chatPill = bubble.locator('span.source-link[data-source="team-chat"]')
  await expect(chatPill).toHaveText('Bob Stone', { timeout: 30_000 })
  await expect(chatPill).toHaveAttribute('data-source-name', 'Chat')
  expect(await chatPill.evaluate((el) => getComputedStyle(el, '::before').content)).toContain('Chat')
  await expect(bubble.locator('span.source-link[data-source="notes"]')).toHaveText('Vault note')
  await expect(bubble).not.toContainText('walnut-refs')
  await panel.screenshot({ path: `${shots}/05-sent-pills.png` })

  // A second message from the session's own composer (the send path of an open chat):
  // a Chat channel, picked in All on a loose match.
  const composer = panel.locator('.chat-input-textarea')
  await composer.click()
  await page.keyboard.type('then @deplo')
  const channelRow = panel.locator('.mention-palette [data-group="src:team-chat"] .mention-row-source').filter({ hasText: '#deploy-alerts' })
  await expect(channelRow).toBeVisible({ timeout: 10_000 })
  await channelRow.dispatchEvent('mousedown')
  await expect(composer).toHaveValue('then @[Chat · #deploy-alerts] ')
  await page.keyboard.type('turn-two echo-input')
  await page.keyboard.press('Enter')
  await expect(panel.locator('.session-msg-user').filter({ hasText: 'turn-two' }).locator('span.source-link[data-source="team-chat"]'))
    .toHaveText('#deploy-alerts', { timeout: 30_000 })

  // What the model got, in the Raw input view (the mock CLI echoes each input it read).
  await panel.locator('.session-panel-header .task-kebab-btn').click()
  const debug = await openKebabGroup(page.locator('.task-kebab-menu'), 'session-kebab-debug')
  await debug.getByTestId('session-kebab-raw-view').click()
  const raw = page.getByTestId('session-raw-view')
  await expect(raw).toBeVisible()
  await expect(raw).toContainText('---walnut-refs---', { timeout: 60_000 })
  await expect(raw).toContainText('- Chat person "Bob Stone" (ref team-chat:user:U2): Chat person Bob Stone (user:U2). FIXTURE_SOURCE_CARD')
  await expect(raw).toContainText('- Notes note "Vault note" (ref notes:vault-note.md): A note in the user\'s notes vault at vault path vault-note.md')
  await expect(raw).toContainText('note_read path="vault-note.md"')
  await expect(raw).toContainText('- Chat channel "#deploy-alerts" (ref team-chat:channel:C9): Chat channel #deploy-alerts (channel:C9). FIXTURE_SOURCE_CARD', { timeout: 60_000 })
  await raw.screenshot({ path: `${shots}/06-raw-input.png` })
  await page.keyboard.press('Escape')
  await expect(raw).toHaveCount(0)
})
