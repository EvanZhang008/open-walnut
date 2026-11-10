/**
 * "Filter mails like these…" in WebKit, the Mac app's engine (2026-11-09, the person: "I want all of
 * these go to a filter folder, this is crazy too crowded").
 *
 * From a letter: the card starts with its sender and its group's name, says how many inbox mails
 * match, and Save files the mail into the folder in the account (the fixture's `moveMany`, which makes
 * the folder), the row leaves the inbox, the folder shows in the sidebar, and the rule is the person's
 * own with `moveTo`. From a group: the card starts from the group's own mail. A filter with neither
 * From nor Subject cannot be saved.
 */
import { devices, expect, test, type Page } from '@playwright/test'
import {
  ALL_INBOXES, MARINA, ROW, fileRules, groupLine, groupOfMessage, mailRow, openGroupLine, openGroupMenu, openGrouped, startGroupsFixture, waitLabeled,
} from './mail-grouping-helpers'
import { folderRow, shoot, type MailFixture, type MailFixtureServer } from './mail-review-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

test.use({ browserName: 'webkit', userAgent: devices['Desktop Safari'].userAgent })
test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

const SHOTS = '/tmp/mail-grouping/shots/folder-filter/webkit'
let server: MailFixtureServer
let fixture: MailFixture

test.beforeAll(async () => {
  test.setTimeout(240_000)
  ;({ server, fixture } = await startGroupsFixture())
  await waitLabeled(fixture, ALL_INBOXES, 120_000)
})
test.afterAll(async () => { await server?.stop() })

async function moveLog(): Promise<{ log: Array<{ messageId?: string; folder?: string; created?: string; seen?: boolean }>; folders: string[] }> {
  const response = await fetch(`http://localhost:${fixture.port}/__fixture/move-log`)
  return response.json() as Promise<{ log: Array<{ messageId?: string; folder?: string; created?: string; seen?: boolean }>; folders: string[] }>
}

async function inside(page: Page, testId: string): Promise<boolean> {
  const box = await page.getByTestId(testId).boundingBox()
  const view = page.viewportSize()!
  return !!box && box.x >= 0 && box.y >= 0 && box.x + box.width <= view.width + 0.5 && box.y + box.height <= view.height + 0.5
}

test('a letter\'s "Filter mails like this…" files it into a new folder that then shows in the sidebar', async ({ page }) => {
  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await openGrouped(page, fixture)
  const groupId = (await groupOfMessage(fixture, MARINA, ROW.issues))!
  await openGroupLine(page, groupId)
  const label = (await groupLine(page, groupId).getByTestId('mail-group-name').textContent())!.trim()
  const row = mailRow(page, MARINA, ROW.issues)
  await row.click({ button: 'right' })
  await page.getByRole('menuitem').filter({ hasText: 'Filter mails like this…' }).first().click()
  const card = page.getByTestId('mail-filter-card')
  await expect(card).toBeVisible()
  expect(await inside(page, 'mail-filter-card')).toBe(true)
  await expect(card.getByTestId('mail-filter-from')).toHaveValue('issues@tickets.example.invalid')
  await expect(card.getByTestId('mail-filter-folder')).toHaveValue(label)
  await expect(card.getByTestId('mail-filter-count')).toHaveText(/^(1 mail in the Inbox matches|\d+ mails in the Inbox match)\.$/, { timeout: 20_000 })
  await expect(card.getByTestId('mail-filter-move-now')).toBeChecked()
  await expect(card.getByTestId('mail-filter-reach')).toHaveText(/^Only mail in .+\.$/)
  await card.getByTestId('mail-filter-folder').fill('Tickets')
  await shoot(card, SHOTS, 'letter-card')
  await card.getByTestId('mail-filter-save').click()
  await expect(card).toHaveCount(0)
  await expect(page.getByText(/^Filter saved: mail like this goes to Tickets\. Moving \d+ now\.$/)).toBeVisible({ timeout: 20_000 })

  await expect.poll(async () => (await moveLog()).log.filter((one) => one.messageId === ROW.issues).map((one) => one.folder), { timeout: 60_000 })
    .toEqual(['Tickets'])
  const log = await moveLog()
  expect(log.folders).toEqual(['Tickets'])
  expect(log.log.find((one) => one.messageId === ROW.issues)?.seen).toBe(false)
  await expect(row).toHaveCount(0, { timeout: 30_000 })
  // The new folder shows in the sidebar, kept in view as a filter's folder (the refresh lists folders again).
  const folder = folderRow(page, MARINA, 'Tickets')
  await expect(async () => {
    if (!(await folder.count())) await page.getByTestId('mail-refresh').click().catch(() => undefined)
    await expect(folder).toBeVisible({ timeout: 5_000 })
  }).toPass({ timeout: 90_000 })
  await page.mouse.move(2, 2)
  await shoot(page, SHOTS, 'after-save')

  // The person's own rule, first in the file, for this letter's account only.
  expect((await fileRules(fixture))[0]).toMatchObject({
    when: { fromContains: 'issues@tickets.example.invalid', account: MARINA }, then: 'Tickets', moveTo: 'Tickets', source: 'user',
  })
})

test('a group\'s "Filter mails like these…" starts from the group\'s mail, and needs From or Subject', async ({ page }) => {
  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await openGrouped(page, fixture)
  const first = page.getByTestId('mail-group-row').first()
  const groupId = (await first.getAttribute('data-group-id'))!
  const label = (await first.getByTestId('mail-group-name').textContent())!.trim()
  await openGroupLine(page, groupId)
  const menu = await openGroupMenu(page, groupId)
  await menu.getByRole('menuitem', { name: 'Filter mails like these…' }).click()
  const card = page.getByTestId('mail-filter-card')
  await expect(card).toBeVisible()
  expect(await inside(page, 'mail-filter-card')).toBe(true)
  await expect(card.getByTestId('mail-filter-folder')).toHaveValue(label)
  await expect(card.getByTestId('mail-filter-from')).not.toHaveValue('')
  // A group of the merged inbox may hold several accounts' mail.
  await expect(card.getByTestId('mail-filter-reach')).toHaveText('Mail in every account that can file it.')
  await expect(card.getByTestId('mail-filter-count')).toContainText(/match/, { timeout: 20_000 })
  await shoot(card, SHOTS, 'group-card')
  await card.getByTestId('mail-filter-from').fill('')
  await card.getByTestId('mail-filter-subject').fill('')
  await expect(card.getByTestId('mail-filter-error')).toHaveText('Fill in From or Subject: a filter with neither would take every mail.')
  await expect(card.getByTestId('mail-filter-save')).toBeDisabled()
  const before = (await fileRules(fixture)).length
  await page.keyboard.press('Escape')
  await expect(card).toHaveCount(0)
  expect((await fileRules(fixture)).length).toBe(before)
})
