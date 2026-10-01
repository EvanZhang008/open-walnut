/**
 * `Mark N read` and its Undo on the grouped inbox (design v2), on the `PW_MAIL_GROUPS` fixture: only
 * what the line showed is marked (the watermark), Undo reverts exactly that set, nothing is written
 * without a press, the result lands in the list's status strip (the line itself leaves once its
 * unread is gone), and a job belongs to the view it started in. The mail server's own flags and its
 * mark-read log are the proof, read on the fixture's port.
 */
import { expect, test, type Page } from '@playwright/test'
import {
  ALL_INBOXES, FERRY, FERRY_INBOX, MARINA, MARINA_INBOX, api, deliver, failMarkRead, fileHash, flags, getGroups,
  groupLine, markReadLog, openGroupLine, openGroupMenu, openGrouped, resetLogs, setFerryReadDelay,
  startGroupsFixture, statusLine, waitLabeled, waitSorted, type GroupsScope,
} from './mail-grouping-helpers'
import { folderRow, shoot, type MailFixture, type MailFixtureServer } from './mail-review-helpers'

const SHOTS = '/tmp/mail-grouping/shots/v2/chromium'
test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

let server: MailFixtureServer
let fixture: MailFixture

/** Unread mail of one group in one scope, by id, straight from the product's list route. */
async function unreadIds(group: string, scope: GroupsScope): Promise<string[]> {
  const where = 'role' in scope ? 'scope=role:inbox' : `account=${encodeURIComponent(scope.accountId)}&mailbox=INBOX`
  const { body } = await api(fixture, `/messages?${where}&group=${encodeURIComponent(group)}&unread=1&limit=200`)
  return body.messages.map((one: { messageId: string }) => one.messageId)
}

/** The group of this scope with the most unread mail that every account can mark. */
async function biggestMarkable(scope: GroupsScope, minimum = 2): Promise<{ id: string; label: string; unread: number }> {
  const groups = await getGroups(fixture, scope)
  const markable = groups.groups.filter((one: { unread: number; markableUnread: number }) => one.markableUnread === one.unread && one.unread >= minimum)
  markable.sort((a: { unread: number }, b: { unread: number }) => b.unread - a.unread)
  expect(markable.length, 'a markable group').toBeGreaterThan(0)
  return markable[0]
}

async function press(page: Page, id: string): Promise<void> {
  const line = groupLine(page, id)
  await line.hover()
  const mark = line.getByTestId('mail-group-mark')
  await expect(mark).toBeEnabled({ timeout: 20_000 })
  await mark.click()
}

test.describe('the ordinary fixture', () => {
  test.beforeAll(async () => {
    test.setTimeout(240_000)
    ;({ server, fixture } = await startGroupsFixture())
    await waitLabeled(fixture, ALL_INBOXES, 120_000)
  })
  test.afterAll(async () => { await server?.stop() })

  test('opening an inbox, a group, its menu and both cards writes no read flag and no rule', async ({ page }) => {
    await resetLogs(fixture)
    const hash = await fileHash(fixture)
    await openGrouped(page, fixture)
    const target = await biggestMarkable(ALL_INBOXES)
    await openGroupLine(page, target.id)
    const menu = await openGroupMenu(page, target.id)
    await menu.getByRole('menuitem', { name: 'These are important\u2026' }).click()
    await expect(page.getByTestId('mail-group-important-card')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('mail-group-important-card')).toHaveCount(0)
    await (await openGroupMenu(page, target.id)).getByRole('menuitem', { name: 'Rename group' }).click()
    await expect(page.getByTestId('mail-group-rename-card')).toBeVisible()
    await page.getByTestId('mail-group-card-cancel').click()
    await groupLine(page, target.id).getByTestId('mail-group-name').click()
    expect((await markReadLog(fixture)).calls).toBe(0)
    expect(await fileHash(fixture)).toBe(hash)
  })

  test('the press marks only what the line showed, and the result goes to the status strip with Undo', async ({ page }) => {
    await openGrouped(page, fixture, FERRY)
    const target = await biggestMarkable(FERRY_INBOX)
    const line = groupLine(page, target.id)
    await expect(line).toHaveAttribute('data-unread', String(target.unread))
    await line.hover()
    await expect(line.getByTestId('mail-group-mark')).toHaveAttribute('aria-label', `Mark ${target.unread} read`)
    const before = await unreadIds(target.id, FERRY_INBOX)
    await page.evaluate((id) => {
      const w = window as unknown as { __texts: string[] }
      w.__texts = []
      const row = document.querySelector(`[data-testid="mail-group-row"][data-group-id="${CSS.escape(id)}"]`)!
      new MutationObserver(() => { w.__texts.push(row.textContent ?? '') }).observe(row, { subtree: true, childList: true, characterData: true })
    }, target.id)
    await press(page, target.id)
    const done = statusLine(page, new RegExp(`^Marked ${target.unread} read in ${target.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`))
    await expect(done).toBeVisible({ timeout: 60_000 })
    await expect(done.getByTestId('mail-bulk-undo')).toBeVisible()
    expect(await page.evaluate(() => (window as unknown as { __texts: string[] }).__texts.some((text) => text.includes('Marking')))).toBe(true)
    await shoot(page, SHOTS, 'bulk-marked')
    for (const id of before.slice(0, 5)) expect((await flags(fixture, FERRY, id)).seen).toBe(true)
    // All of its unread gone: the line has left the list.
    await expect(line).toHaveCount(0, { timeout: 20_000 })
  })

  test('the watermark: mail that arrived after the line drew stays unread', async ({ page }) => {
    await openGrouped(page, fixture, FERRY)
    // ferry's delivered mail is `payroll` notices: the fixture's model names them Pay & statements.
    const groups = await getGroups(fixture, FERRY_INBOX)
    const pay = groups.groups.find((one: { label: string }) => one.label === 'Pay & statements')
    expect(pay, 'a Pay & statements group').toBeTruthy()
    const line = groupLine(page, pay.id)
    await expect(line).toHaveAttribute('data-unread', String(pay.unread))
    // The line keeps the answer it drew from (every later read of /groups answers the same), so the
    // press carries that answer's watermark while the late mail is already in the group on the server.
    await page.route('**/api/plugins/mail/groups?**', (route) => route.fulfill({ json: groups }))
    const late = (await deliver(fixture, 1, { account: 'ferry' })).delivered[0]!
    await waitLabeled(fixture, FERRY_INBOX)
    await expect.poll(async () => (await unreadIds(pay.id, FERRY_INBOX)).includes(late.messageId), { timeout: 30_000 }).toBe(true)
    await press(page, pay.id)
    await expect(statusLine(page, /^Marked \d+ read in Pay & statements\./)).toBeVisible({ timeout: 60_000 })
    await page.unroute('**/api/plugins/mail/groups?**')
    expect((await flags(fixture, FERRY, late.messageId)).seen).toBe(false)
    expect(await unreadIds(pay.id, FERRY_INBOX)).toEqual([late.messageId])
    // A fresh read of the groups draws the one that is left.
    await folderRow(page, MARINA, 'INBOX').click()
    await folderRow(page, FERRY, 'INBOX').click()
    await expect(groupLine(page, pay.id)).toHaveAttribute('data-unread', '1', { timeout: 20_000 })
  })

  test('Undo reverts exactly the mails this job changed', async ({ page }) => {
    await openGrouped(page, fixture, MARINA)
    const target = await biggestMarkable(MARINA_INBOX, 3)
    const before = await unreadIds(target.id, MARINA_INBOX)
    // One of them is read BEFORE the job; it must stay read after the Undo.
    const early = before[0]!
    await api(fixture, `/messages/${encodeURIComponent(MARINA)}/${encodeURIComponent(early)}/read`, { body: { read: true } })
    await expect(groupLine(page, target.id)).toHaveAttribute('data-unread', String(before.length - 1), { timeout: 20_000 })
    await press(page, target.id)
    const done = statusLine(page, /^Marked \d+ read in /)
    await expect(done.getByTestId('mail-bulk-undo')).toBeVisible({ timeout: 60_000 })
    expect(await unreadIds(target.id, MARINA_INBOX)).toEqual([])
    await done.getByTestId('mail-bulk-undo').click()
    await expect(statusLine(page, /unread again/)).toBeVisible({ timeout: 60_000 })
    await expect.poll(async () => (await unreadIds(target.id, MARINA_INBOX)).sort()).toEqual(before.slice(1).sort())
    for (const id of before.slice(1)) expect((await flags(fixture, MARINA, id)).seen).toBe(false)
    expect((await flags(fixture, MARINA, early)).seen).toBe(true)
    // The line is back, with the reverted number.
    await expect(groupLine(page, target.id)).toHaveAttribute('data-unread', String(before.length - 1), { timeout: 20_000 })
  })

  test('the footer Mark N read of an open group is the same press', async ({ page }) => {
    await openGrouped(page, fixture, MARINA)
    const target = await biggestMarkable(MARINA_INBOX)
    const group = await openGroupLine(page, target.id)
    await expect(group.getByTestId('mail-group-foot-mark')).toHaveText(`Mark ${target.unread} read`)
    await group.getByTestId('mail-group-foot-mark').click()
    await expect(statusLine(page, /^Marked \d+ read in /)).toBeVisible({ timeout: 60_000 })
    expect(await unreadIds(target.id, MARINA_INBOX)).toEqual([])
    // Open, so it stays on screen at 0 until closed.
    await expect(groupLine(page, target.id).getByTestId('mail-group-unread')).toHaveText('0')
    await groupLine(page, target.id).getByTestId('mail-group-name').click()
    await expect(groupLine(page, target.id)).toHaveCount(0)
  })

  test('a press with a stale rules revision is refused and changes nothing', async ({ page }) => {
    await openGrouped(page, fixture, MARINA)
    await resetLogs(fixture)
    await page.route('**/api/plugins/mail/groups/read', async (route) => {
      const body = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>
      await route.continue({ postData: JSON.stringify({ ...body, rulesRev: 'stale0000000' }) })
    })
    const target = await biggestMarkable(MARINA_INBOX, 1)
    await press(page, target.id)
    await expect(statusLine(page, /^This group changed\. Check the new count and try again\./)).toBeVisible({ timeout: 20_000 })
    expect((await markReadLog(fixture)).calls).toBe(0)
    await page.unroute('**/api/plugins/mail/groups/read')
  })

  test('while groups recompute, the press is disabled and says why', async ({ page }) => {
    await page.route('**/api/plugins/mail/groups?**', async (route) => {
      const response = await route.fetch()
      const body = await response.json() as Record<string, unknown>
      await route.fulfill({ response, json: { ...body, recomputing: { done: 400, total: 3615 } } })
    })
    await openGrouped(page, fixture, MARINA)
    const line = page.getByTestId('mail-group-row').first()
    await line.hover()
    const mark = line.getByTestId('mail-group-mark')
    await expect(mark).toBeDisabled()
    await expect(mark).toHaveAttribute('title', 'Groups are updating')
    await expect(page.getByTestId('mail-sort-progress')).toContainText(/(Updating groups|Sorting your mail)\u2026 400 of 3,615/)
    await page.unroute('**/api/plugins/mail/groups?**')
  })

  test('a job keeps its result in the view that started it', async ({ page }) => {
    await deliver(fixture, 6, { account: 'ferry' })
    await waitLabeled(fixture, FERRY_INBOX)
    await openGrouped(page, fixture, FERRY)
    const target = await biggestMarkable(FERRY_INBOX, 1)
    await press(page, target.id)
    await folderRow(page, MARINA, 'INBOX').click()
    await expect(page.getByTestId('mail-grouped')).toBeVisible()
    await expect(statusLine(page, /^Marked /)).toHaveCount(0)
    await expect(page.getByTestId('mail-bulk-progress')).toHaveCount(0)
    await folderRow(page, FERRY, 'INBOX').click()
    await expect(statusLine(page, /^Marked \d+ read in /)).toBeVisible({ timeout: 60_000 })
    const groups = await waitSorted(fixture, FERRY_INBOX)
    const ids = await page.getByTestId('mail-group-row').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-group-id')))
    expect(ids).toEqual(groups.groups.map((one: { id: string }) => one.id))
  })
})

const fmt = (n: number) => n.toLocaleString('en-US')

test.describe('the dense fixture', () => {
  test.beforeAll(async () => {
    // A hook gets the config's 30 s, not the file's timeout: a busy machine boots slower.
    test.setTimeout(300_000)
    ;({ server, fixture } = await startGroupsFixture({ dense: true }))
    await waitLabeled(fixture, ALL_INBOXES, 180_000)
  })
  test.afterAll(async () => { await server?.stop() })

  test('failures in the middle: the strip counts them and Retry reruns only those', async ({ page }) => {
    await setFerryReadDelay(fixture, 0)
    await openGrouped(page, fixture)
    const target = await biggestMarkable(ALL_INBOXES, 40)
    const after = Math.floor(target.unread / 2)
    const count = Math.min(24, target.unread - after)
    await resetLogs(fixture)
    await failMarkRead(fixture, after, count)
    await press(page, target.id)
    const note = statusLine(page, new RegExp(`^Marked ${fmt(target.unread - count)} read\\. ${count} couldn't be changed:`))
    await expect(note).toBeVisible({ timeout: 180_000 })
    const retry = note.getByTestId('mail-bulk-retry')
    await expect(retry).toHaveText(`Retry ${count}`)
    await shoot(page, SHOTS, 'bulk-dense-failed')
    const first = await markReadLog(fixture)
    const failed = first.log.filter((one) => !one.ok)
    expect(failed).toHaveLength(count)
    await retry.click()
    await expect(statusLine(page, new RegExp(`^Marked ${count} read`))).toBeVisible({ timeout: 60_000 })
    const rerun = (await markReadLog(fixture)).log.slice(first.calls)
    expect(rerun.map((one) => one.messageId).sort()).toEqual(failed.map((one) => one.messageId).sort())
    for (const one of failed.slice(0, 4)) expect((await flags(fixture, one.accountId, one.messageId)).seen).toBe(true)
    await expect(groupLine(page, target.id)).toHaveCount(0, { timeout: 30_000 })
  })

  test('Stop halts within two changes; Undo reverts only what ran and counts its failures', async ({ page }) => {
    await setFerryReadDelay(fixture, 60)
    await openGrouped(page, fixture, FERRY)
    const target = await biggestMarkable(FERRY_INBOX, 40)
    await resetLogs(fixture)
    await press(page, target.id)
    const line = groupLine(page, target.id)
    await expect(line.getByTestId('mail-bulk-progress')).toContainText('Marking', { timeout: 30_000 })
    await expect.poll(async () => (await markReadLog(fixture)).calls, { timeout: 30_000 }).toBeGreaterThan(20)
    await line.getByTestId('mail-bulk-stop').click()
    const atClick = (await markReadLog(fixture)).calls
    const note = statusLine(page, /^Stopped\. Marked [\d,]+ read\./)
    await expect(note).toBeVisible({ timeout: 60_000 })
    const after = await markReadLog(fixture)
    expect(after.calls - atClick).toBeLessThanOrEqual(2)
    const changed = after.log.filter((one) => one.read && one.ok).map((one) => one.messageId)
    await expect(note).toContainText(`Stopped. Marked ${fmt(changed.length)} read.`)
    // The rest is still unread, so the line is still there with what is left.
    await expect(line).toHaveAttribute('data-unread', String(target.unread - changed.length), { timeout: 20_000 })
    // Undo, slow enough to watch, with its first two changes refused by the mail server.
    await setFerryReadDelay(fixture, 120)
    await failMarkRead(fixture, 1, 2)
    await note.getByTestId('mail-bulk-undo').click()
    const undone = statusLine(page, new RegExp(`^Marked ${fmt(changed.length - 2)} unread again\\. 2 couldn't be changed:`))
    await expect(undone).toBeVisible({ timeout: 120_000 })
    await expect(undone.getByTestId('mail-bulk-retry')).toHaveText('Retry 2')
    const reverted = (await markReadLog(fixture)).log.filter((one) => !one.read).map((one) => one.messageId)
    expect(reverted.sort()).toEqual([...changed].sort())
    await shoot(page, SHOTS, 'bulk-undo-failed')
  })
})
