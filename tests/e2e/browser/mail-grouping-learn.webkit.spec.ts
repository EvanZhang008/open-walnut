/**
 * Learning in WebKit, the engine of the Mac app (design v2): the correction card from a group row's
 * menu, saved and undone; a group's `These are important...` and `Rename group` cards, at the default
 * 336px middle column and at a 900px window (the one-column narrow mode). Every card opens fully
 * inside the viewport, never scrolls sideways, and completes its main path.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  ALL_INBOXES, MARINA, ROW, fileRules, getGroups, groupLine, groupOfMessage, mailRow, openGroupLine, openGroupMenu,
  openGrouped, startGroupsFixture, statusLine, waitLabeled, waitSorted,
} from './mail-grouping-helpers'
import { shoot, type MailFixture, type MailFixtureServer } from './mail-review-helpers'

test.use({ browserName: 'webkit' })
test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

const SHOTS = '/tmp/mail-grouping/shots/v2/webkit'
let server: MailFixtureServer
let fixture: MailFixture

test.beforeAll(async () => {
  test.setTimeout(240_000)
  ;({ server, fixture } = await startGroupsFixture())
  await waitLabeled(fixture, ALL_INBOXES, 120_000)
})
test.afterAll(async () => { await server?.stop() })

async function fits(page: Page, target: Locator): Promise<void> {
  const box = (await target.boundingBox())!
  const view = page.viewportSize()!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(view.width + 0.5)
  expect(box.y + box.height).toBeLessThanOrEqual(view.height + 0.5)
  expect(await target.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
}

for (const width of [1440, 900]) {
  test(`at ${width}px: a group row's Important... card saves a rule, and Undo takes it out`, async ({ page }) => {
    await page.setViewportSize({ width, height: 860 })
    await openGrouped(page, fixture)
    const groupId = (await groupOfMessage(fixture, MARINA, ROW.review))!
    expect(groupId).toMatch(/^u:/)
    await openGroupLine(page, groupId)
    const more = page.locator(`[data-testid="mail-group"][data-group-id="${groupId}"]`).getByTestId('mail-group-more-rows')
    if (await more.count()) await more.click()
    const row = mailRow(page, MARINA, ROW.review)
    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Important\u2026' }).click()
    const card = page.getByTestId('mail-correct')
    await expect(card).toBeVisible()
    await fits(page, card)
    await expect(card.locator('[data-testid="mail-correct-choice"][data-group-id="important"]')).toBeChecked()
    await card.getByTestId('mail-correct-why').fill(`reviews need me (${width})`)
    await card.getByTestId('mail-correct-next').click()
    await expect(card.getByTestId('mail-correct-rule').first()).toBeVisible({ timeout: 10_000 })
    await fits(page, card)
    await shoot(card, SHOTS, `correct-step2-${width}`)
    await card.getByTestId('mail-correct-save').click()
    await expect(card).toHaveCount(0)
    const status = statusLine(page, /^Saved\. \d+ mails? moved to Important\./)
    await expect(status).toBeVisible()
    const rules = await fileRules(fixture)
    expect(rules[0]).toMatchObject({ then: 'Important', note: `reviews need me (${width})`, source: 'learned' })
    await status.getByTestId('mail-rule-undo').click()
    await expect.poll(async () => (await fileRules(fixture)).length).toBe(rules.length - 1)
    await waitSorted(fixture)
    await expect.poll(() => groupOfMessage(fixture, MARINA, ROW.review), { timeout: 20_000 }).toBe(groupId)
  })
}

test('at 900px: These are important... and Rename group open inside the viewport and save', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 860 })
  await openGrouped(page, fixture)
  const groups = await getGroups(fixture, ALL_INBOXES)
  const surveys = groups.groups.find((one: { label: string }) => one.label === 'Surveys') ?? groups.groups[groups.groups.length - 1]
  await (await openGroupMenu(page, surveys.id)).getByRole('menuitem', { name: 'These are important\u2026' }).click()
  const important = page.getByTestId('mail-group-important-card')
  await expect(important).toBeVisible()
  await fits(page, important)
  await shoot(important, SHOTS, 'group-important-900')
  await important.getByTestId('mail-group-card-cancel').click()
  await (await openGroupMenu(page, surveys.id)).getByRole('menuitem', { name: 'Rename group' }).click()
  const rename = page.getByTestId('mail-group-rename-card')
  await expect(rename).toBeVisible()
  await fits(page, rename)
  await rename.getByTestId('mail-group-card-name').fill('Feedback asks')
  await rename.getByTestId('mail-group-card-save').click()
  await expect(rename).toHaveCount(0)
  await expect(groupLine(page, surveys.id).getByTestId('mail-group-name')).toHaveText('Feedback asks')
  await expect(statusLine(page, /^Renamed to Feedback asks\./)).toBeVisible()
})
