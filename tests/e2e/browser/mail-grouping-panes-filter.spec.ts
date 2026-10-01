/**
 * Three follow-ups to the grouped inbox, through the real UI on the `PW_MAIL_GROUPS` fixture, in
 * Chromium and (PW_WEBKIT=1 --project=webkit) WebKit, the Mac app's engine:
 *
 * - the folder column and the message list column are drag-resizable, by pointer and keyboard,
 *   remembered across a reload, reset by double-click, and never squeeze the reader under 380px;
 * - each group line has a title row and a one-line summary under it (the model's line for two or
 *   more unread, the subject for one);
 * - `Keep out of Inbox…` saves a rule that moves the group's mail to the Archive: the unread now
 *   (when asked), and new arrivals on their own, unread; an account that cannot move says so.
 *
 * Every API check goes to the fixture's own port (mail-grouping-helpers.ts).
 */
import { expect, test, type Page } from '@playwright/test'
import {
  ALL_INBOXES, MARINA, MARINA_INBOX, deliver, fileRules, getGroups, groupLine, openGroupMenu, openGrouped,
  startGroupsFixture, statusLine, waitLabeled,
} from './mail-grouping-helpers'
import { shoot, type MailFixture, type MailFixtureServer } from './mail-review-helpers'

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

const PANES_KEY = 'walnut.mail.panes.v1'

let server: MailFixtureServer
let fixture: MailFixture
let shots = '/tmp/mail-grouping/shots/v2/chromium'

test.beforeAll(async ({ browserName }) => {
  test.setTimeout(240_000)
  shots = `/tmp/mail-grouping/shots/v2/${browserName}`
  ;({ server, fixture } = await startGroupsFixture())
  await waitLabeled(fixture, ALL_INBOXES, 120_000)
})
test.afterAll(async () => { await server?.stop() })

async function widthOf(page: Page, selector: string): Promise<number> {
  return page.locator(selector).first().evaluate((node) => Math.round(node.getBoundingClientRect().width))
}

async function stored(page: Page): Promise<Record<string, number> | null> {
  return page.evaluate((key) => {
    const text = window.localStorage.getItem(key)
    return text ? JSON.parse(text) as Record<string, number> : null
  }, PANES_KEY)
}

/** A real pointer drag on a splitter, `dx` pixels, releasing wherever it ends (over the reader too). */
async function drag(page: Page, testId: string, dx: number, options: { escape?: boolean } = {}): Promise<void> {
  const handle = page.getByTestId(testId)
  const box = (await handle.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + Math.min(200, box.height / 2)
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let step = 1; step <= 8; step += 1) await page.mouse.move(x + (dx * step) / 8, y)
  if (options.escape) await page.keyboard.press('Escape')
  await page.mouse.up()
}

async function archiveLog(): Promise<Array<{ messageId: string; ok: boolean; seen?: boolean }>> {
  const response = await fetch(`http://localhost:${fixture.port}/__fixture/archive-log`)
  return ((await response.json()) as { log: Array<{ messageId: string; ok: boolean; seen?: boolean }> }).log
}

test.describe('resizable columns', () => {
  test('drag, keyboard, reload, reset, Escape, and the reader keeps 380px', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openGrouped(page, fixture)
    await page.evaluate((key) => window.localStorage.removeItem(key), PANES_KEY)
    const list = '.mail-console > .mail-list-pane'
    const folders = '.mail-console > .mail-accounts-pane'
    const reader = '.mail-console > :last-child'
    const start = await widthOf(page, list)
    expect(start).toBe(336)

    // Open a mail first: the reader's body is an iframe, and the drag must survive the pointer over it.
    await groupLine(page, (await getGroups(fixture, ALL_INBOXES)).groups[0].id).getByTestId('mail-group-name').click()
    await page.locator('.mail-group-kids [data-testid="mail-row"]').first().click()
    await expect(page.getByTestId('mail-reader')).toBeVisible()
    await drag(page, 'mail-splitter-list', 150)
    await expect.poll(() => widthOf(page, list)).toBe(start + 150)
    expect(await stored(page)).toEqual({ list: start + 150 })
    await shoot(page, shots, 'panes-list-wider')

    // Keyboard: two steps back.
    await page.getByTestId('mail-splitter-list').focus()
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await expect.poll(() => widthOf(page, list)).toBe(start + 150 - 32)
    await expect(page.getByTestId('mail-splitter-list')).toHaveAttribute('aria-valuenow', String(start + 150 - 32))

    // Escape mid-drag puts the column back where the drag began.
    await drag(page, 'mail-splitter-list', 90, { escape: true })
    await expect.poll(() => widthOf(page, list)).toBe(start + 150 - 32)

    // The folder column: clamped at its minimum.
    await drag(page, 'mail-splitter-accounts', -200)
    await expect.poll(() => widthOf(page, folders)).toBe(168)
    // That narrow, New message keeps its whole button: the label goes, the icon stays.
    const compose = page.getByTestId('mail-compose-new')
    await expect(compose.locator('.mail-compose-new-label')).toBeHidden()
    expect(await compose.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    await expect(compose).toHaveAccessibleName('New message')

    // Remembered across a reload.
    await page.reload()
    await expect(page.getByTestId('mail-grouped')).toBeVisible({ timeout: 60_000 })
    await expect.poll(() => widthOf(page, list)).toBe(start + 150 - 32)
    expect(await widthOf(page, folders)).toBe(168)

    // Far right: the list stops where the reader would drop under 380px, and stays so when the
    // window narrows afterwards.
    await drag(page, 'mail-splitter-list', 900)
    expect(await widthOf(page, reader)).toBeGreaterThanOrEqual(380)
    await page.setViewportSize({ width: 1100, height: 900 })
    await expect.poll(() => widthOf(page, reader)).toBeGreaterThanOrEqual(380)
    await shoot(page, shots, 'panes-narrowed')
    await page.setViewportSize({ width: 1440, height: 900 })

    // Double-click: back to the stylesheet's defaults, and nothing left in storage.
    await page.getByTestId('mail-splitter-list').dblclick()
    await page.getByTestId('mail-splitter-accounts').dblclick()
    await expect.poll(() => widthOf(page, list)).toBe(336)
    expect(await widthOf(page, folders)).toBe(232)
    expect(await stored(page)).toBeNull()
    await expect(page.getByTestId('mail-compose-new').locator('.mail-compose-new-label')).toBeVisible()
    expect(await page.getByTestId('mail-compose-new').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)

    // Under 1360px the default folder column is 204px: the whole label still shows, not an ellipsis.
    await page.setViewportSize({ width: 1280, height: 800 })
    await expect.poll(() => widthOf(page, folders)).toBe(204)
    const label = page.getByTestId('mail-compose-new').locator('.mail-compose-new-label')
    await expect(label).toBeVisible()
    expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    expect(await page.getByTestId('mail-compose-new').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    await shoot(page, shots, 'panes-default-1280')
  })
})

test.describe('the summary line under each group', () => {
  test('title row plus one summary line: the model for two or more, the subject for one', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openGrouped(page, fixture)
    const groups = (await getGroups(fixture, ALL_INBOXES)).groups as Array<{ id: string; unread: number; summary: string; summaryBy?: string }>
    expect(groups.some((one) => one.summaryBy === 'ai')).toBe(true)
    for (const group of groups) {
      const line = groupLine(page, group.id)
      const summary = line.getByTestId('mail-group-summary')
      await expect(summary).toHaveText(group.summary)
      await expect(summary).toHaveAttribute('data-by', group.summaryBy ?? 'subject')
      if (group.unread === 1) expect(group.summaryBy).toBeUndefined()
      const [height, lines] = await line.evaluate((node) => {
        const text = node.querySelector('.mail-group-summary') as HTMLElement
        return [node.getBoundingClientRect().height, Math.round(text.getBoundingClientRect().height / parseFloat(getComputedStyle(text).lineHeight))]
      })
      expect(height).toBeGreaterThanOrEqual(40)
      expect(height).toBeLessThanOrEqual(56)
      // One line, cut with an ellipsis, never wrapped.
      expect(lines).toBe(1)
    }
    await page.mouse.move(0, 0)
    await shoot(page, shots, 'group-summaries')
  })

  test('new mail in a group rewrites its line', async ({ page }) => {
    await openGrouped(page, fixture, MARINA)
    const before = (await getGroups(fixture, MARINA_INBOX)).groups.find((one: { label: string }) => one.label === 'Build results')
    const made = (await deliver(fixture, 2, { account: 'marina' })).delivered
    const newest = made.at(-1)!.subject.split(' ').slice(0, 4).join(' ')
    const line = groupLine(page, 'u:build-results')
    await expect(line.getByTestId('mail-group-summary')).toContainText(newest, { timeout: 60_000 })
    await expect(line.getByTestId('mail-group-summary')).toHaveAttribute('data-by', 'ai')
    if (before) expect(await line.getByTestId('mail-group-summary').textContent()).not.toBe(before.summary)
  })
})

test.describe('keep out of the Inbox', () => {
  test('an account that cannot move mail is named on the card, and Cancel saves nothing', async ({ page }) => {
    await openGrouped(page, fixture)
    const groups = (await getGroups(fixture, ALL_INBOXES)).groups as Array<{ id: string; label: string; cannotArchive?: string[] }>
    const mixed = groups.find((one) => (one.cannotArchive ?? []).length > 0 && (one.id.startsWith('u:') || !one.id.endsWith(':unknown')))
    expect(mixed).toBeTruthy()
    const menu = await openGroupMenu(page, mixed!.id)
    await menu.getByRole('menuitem', { name: 'Keep out of Inbox…' }).click()
    const card = page.getByTestId('mail-group-filter-card')
    await expect(card).toBeVisible()
    await expect(card).toContainText(`Keep ${mixed!.label} out of the Inbox?`)
    await expect(card.getByTestId('mail-group-filter-cannot')).toHaveText(`Mail in ${mixed!.cannotArchive!.join(', ')} can't be moved from Walnut; it stays in this group.`)
    await shoot(page, shots, 'filter-card-cannot')
    await card.getByTestId('mail-group-card-cancel').click()
    await expect(card).toHaveCount(0)
    expect((await fileRules(fixture)).filter((one) => one.skipInbox)).toEqual([])
  })

  test('save with "move now": the unread go to Archive unread, new arrivals follow, Undo stops it', async ({ page }) => {
    await openGrouped(page, fixture, MARINA)
    let builds = (await getGroups(fixture, MARINA_INBOX)).groups.find((one: { id: string }) => one.id === 'u:build-results')
    if (!builds) {
      await deliver(fixture, 3, { account: 'marina' })
      await expect(groupLine(page, 'u:build-results')).toBeVisible({ timeout: 60_000 })
      builds = (await getGroups(fixture, MARINA_INBOX)).groups.find((one: { id: string }) => one.id === 'u:build-results')
    }
    const unread = builds.unread as number
    expect(unread).toBeGreaterThan(0)
    const logBefore = (await archiveLog()).length

    const menu = await openGroupMenu(page, 'u:build-results')
    await menu.getByRole('menuitem', { name: 'Keep out of Inbox…' }).click()
    const card = page.getByTestId('mail-group-filter-card')
    const moveNow = card.getByTestId('mail-group-filter-move-now')
    await expect(moveNow).toBeChecked()
    await expect(card).toContainText(unread === 1 ? 'Also move the 1 unread mail in it now' : `Also move the ${unread} unread in it now`)
    await expect(card.getByTestId('mail-group-filter-cannot')).toHaveCount(0)
    await shoot(page, shots, 'filter-card')
    await card.getByTestId('mail-group-card-save').click()
    await expect(card).toHaveCount(0)
    const saved = statusLine(page, /New mail in Build results now skips the Inbox\. Moving \d+ to Archive\./)
    await expect(saved).toBeVisible({ timeout: 20_000 })
    // The note (with its Undo) lives 12 s unless hovered; the pointer rests on it for the rest of the case.
    await saved.hover()
    // The group's unread leave the inbox (and the list), and arrive in Archive still unread.
    await expect(groupLine(page, 'u:build-results')).toHaveCount(0, { timeout: 30_000 })
    const moved = (await archiveLog()).slice(logBefore)
    expect(moved).toHaveLength(unread)
    for (const one of moved) expect(one).toMatchObject({ ok: true, seen: false })
    const rule = (await fileRules(fixture)).find((one) => one.skipInbox)
    expect(rule).toMatchObject({ when: { group: 'Build results' }, then: 'Build results', skipInbox: true })
    await shoot(page, shots, 'filter-saved')

    // A new build arrives: the model files it under Build results, and it is moved on its own.
    const arrived = (await deliver(fixture, 1, { account: 'marina' })).delivered[0]!
    await expect.poll(async () => (await archiveLog()).some((one) => one.messageId === arrived.messageId && one.ok), { timeout: 60_000 }).toBe(true)
    await expect(groupLine(page, 'u:build-results')).toHaveCount(0)

    // Undo removes the rule: the next build stays in the Inbox, in its group.
    await saved.getByTestId('mail-rule-undo').click()
    await expect.poll(async () => (await fileRules(fixture)).some((one) => one.skipInbox), { timeout: 20_000 }).toBe(false)
    const kept = (await deliver(fixture, 1, { account: 'marina' })).delivered[0]!
    await expect(groupLine(page, 'u:build-results')).toBeVisible({ timeout: 60_000 })
    expect((await archiveLog()).some((one) => one.messageId === kept.messageId)).toBe(false)
  })
})
