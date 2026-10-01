/**
 * The grouped inbox (design v2) on the `PW_MAIL_GROUPS` fixture, driven through the real UI: one
 * line per group that holds UNREAD mail, named by the (faked) labeling model, then Important. Every
 * API check goes to the fixture's own port (`mail-grouping-helpers.ts`), never to the Playwright
 * baseURL.
 */
import { expect, test, type Page } from '@playwright/test'
import {
  ALL_INBOXES, FERRY, MARINA, ROW, allGroupMessages, api, deliver, failMarkRead, flags, getGroups, groupLine,
  markReadLog, openGroupLine, openGroupMenu, openGrouped, setLabelModel, startGroupsFixture, waitLabeled,
  writeRulesFile,
} from './mail-grouping-helpers'
import { folderRow, openMail, shoot, smartRow, type MailFixture, type MailFixtureServer } from './mail-review-helpers'

const SHOTS = '/tmp/mail-grouping/shots/v2/chromium'
test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

/** Every inbox badge's mode, read in ONE frame. */
async function badgeModes(page: Page): Promise<string[]> {
  return page.evaluate(() => [...document.querySelectorAll('[data-testid="mail-smart-unread"], [data-testid="mail-smart-child-unread"], .mail-accounts-pane [data-testid="mail-mailbox-unread"]')]
    .filter((one) => one.closest('[data-mailbox-id="INBOX"], [data-smart="inbox"], [data-testid="mail-smart-child"]'))
    .map((one) => one.getAttribute('data-mode') ?? 'none'))
}

async function pickView(page: Page, label: 'Grouped' | 'All mail' | 'Unread important mail only'): Promise<void> {
  await page.getByTestId('mail-view-menu').first().click()
  const menu = page.getByTestId('mail-view-menu-list')
  await expect(menu).toBeVisible()
  await menu.locator('[role^="menuitem"]').filter({ hasText: label }).first().click()
}

test.describe('the model answering', () => {
  let server: MailFixtureServer
  let fixture: MailFixture
  test.beforeAll(async () => {
    // A hook gets the config's 30 s, not the file's timeout: a busy machine boots the fixture slower.
    test.setTimeout(240_000)
    ;({ server, fixture } = await startGroupsFixture())
    await waitLabeled(fixture, ALL_INBOXES, 120_000)
  })
  test.afterAll(async () => { await server?.stop() })

  test('grouped by default: one line per group with unread, named by the model, numbers from /groups', async ({ page }) => {
    await openGrouped(page, fixture)
    const groups = await getGroups(fixture, ALL_INBOXES)
    // The server's groups, in its order (newest first), and nothing else.
    const ids = await page.getByTestId('mail-group-row').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-group-id')))
    expect(ids).toEqual(groups.groups.map((one: { id: string }) => one.id))
    expect(ids.length).toBeGreaterThanOrEqual(6)
    for (const id of ids) expect(id).toMatch(/^[us]:/)
    const labels = groups.groups.map((one: { label: string }) => one.label)
    expect(labels).toEqual(expect.arrayContaining(['Ticket updates', 'Pager alerts', 'Shopping']))
    for (const old of ['Promotions', 'Not sorted yet']) expect(labels).not.toContain(old)
    for (const group of groups.groups) {
      expect(group.unread).toBeGreaterThan(0)
      const line = groupLine(page, group.id)
      await expect(line).toHaveAttribute('data-unread', String(group.unread))
      await expect(line.getByTestId('mail-group-name')).toHaveText(group.label)
      await expect(line.getByTestId('mail-group-unread')).toHaveText(group.unread.toLocaleString())
      await expect(line.getByTestId('mail-group-senders')).toHaveText(group.topSenders.map((one: { label: string }) => one.label).join(', '))
    }
    // A title row and one summary line each, and the tools only on hover.
    const heights = await page.getByTestId('mail-group-row').evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height))
    for (const height of heights) expect(height).toBeLessThanOrEqual(56)
    for (const group of groups.groups) await expect(groupLine(page, group.id).getByTestId('mail-group-summary')).toHaveText(group.summary)
    const first = groupLine(page, ids[0]!)
    await expect(first.getByTestId('mail-group-mark')).toBeHidden()
    await first.hover()
    await expect(first.getByTestId('mail-group-mark')).toBeVisible()
    await expect(first.getByTestId('mail-group-more')).toBeVisible()
    await expect(first.locator('.mail-group-time')).toBeHidden()
    // The header: every unread mail in the view, and the view menu on the same line.
    const unread = groups.important.unread + groups.groups.reduce((sum: number, one: { unread: number }) => sum + one.unread, 0)
    expect(unread).toBe(groups.cachedUnread)
    await expect(page.getByTestId('mail-grouped-unread')).toHaveText(`${unread.toLocaleString()} unread`)
    await expect(page.getByTestId('mail-view-menu')).toHaveText('Grouped')
    await expect(page.getByTestId('mail-grouped-sorting')).toHaveCount(0)
    await expect(page.getByTestId('mail-grouped-no-ai')).toHaveCount(0)
    // Important: the reading list, read mail included, newest first, as the server pages it.
    const important = (await api(fixture, '/messages?scope=role:inbox&group=important&limit=50')).body.messages
    expect(important.some((one: { flags: string[] }) => one.flags.includes('\\Seen'))).toBe(true)
    const shown = await page.locator('.mail-important [data-testid="mail-row"]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-message-id')))
    expect(shown.slice(0, 10)).toEqual(important.slice(0, 10).map((one: { messageId: string }) => one.messageId))
    await expect(page.getByTestId('mail-important-unread')).toHaveText(`${groups.important.unread} unread`)
    // Rows carry no per-mail why line any more.
    await expect(page.getByTestId('mail-why-line')).toHaveCount(0)
    await page.mouse.move(0, 0)
    await shoot(page, SHOTS, 'overview')
  })

  test('opening a group: three rows, N more, Show fewer, and the keyboard', async ({ page }) => {
    await openGrouped(page, fixture)
    const groups = await getGroups(fixture, ALL_INBOXES)
    const big = [...groups.groups].sort((a: { unread: number }, b: { unread: number }) => b.unread - a.unread)[0]
    expect(big.unread).toBeGreaterThan(3)
    const group = await openGroupLine(page, big.id)
    const line = groupLine(page, big.id)
    await expect(line.getByTestId('mail-group-senders')).toHaveText('')
    const kids = group.locator('[data-testid="mail-row"]')
    await expect(kids).toHaveCount(3)
    for (const one of await kids.all()) await expect(one).toHaveAttribute('data-unread', 'true')
    await expect(group.getByTestId('mail-group-more-rows')).toHaveText(`${big.unread - 3} more`)
    await expect(group.getByTestId('mail-group-foot-mark')).toHaveText(`Mark ${big.markableUnread} read`)
    await shoot(page, SHOTS, 'group-open')
    await group.getByTestId('mail-group-more-rows').click()
    const every = await allGroupMessages(fixture, big.id, ALL_INBOXES, { unread: true })
    await expect(kids).toHaveCount(every.length)
    await group.getByTestId('mail-group-fewer').click()
    await expect(kids).toHaveCount(3)
    // Keyboard: arrows walk lines and rows in order; Left closes, Right opens, Enter toggles.
    await line.focus()
    await page.keyboard.press('ArrowDown')
    await expect(kids.first()).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(line).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    await expect(line).toHaveAttribute('aria-expanded', 'false')
    await expect(line).toHaveAttribute('aria-label', `${big.label}, ${big.unread} unread. Open group`)
    await page.keyboard.press('ArrowRight')
    await expect(line).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('Enter')
    await expect(line).toHaveAttribute('aria-expanded', 'false')
    await expect(group.locator('[data-testid="mail-row"]')).toHaveCount(0)
    // A press on check or more (...) never also toggles the line.
    await line.hover()
    await line.getByTestId('mail-group-more').click()
    await expect(page.getByTestId('mail-group-menu')).toBeVisible()
    await expect(line).toHaveAttribute('aria-expanded', 'false')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('mail-group-menu')).toHaveCount(0)
    await expect(line.getByTestId('mail-group-more')).toBeFocused()
  })

  /** `Keep out of Inbox…` is offered for every group it can write a rule for (not `s:unknown`). */
  const filterItem = (id: string) => (id.startsWith('u:') || (id.startsWith('s:') && id !== 's:unknown') ? ['Keep out of Inbox\u2026'] : [])

  test('the group menu says its actions, the unread count and nothing else', async ({ page }) => {
    await openGrouped(page, fixture)
    const groups = await getGroups(fixture, ALL_INBOXES)
    const withUnsub = groups.groups.find((one: { unsubscribable: number }) => one.unsubscribable > 0)
    const menu = await openGroupMenu(page, withUnsub.id)
    const items = await menu.getByRole('menuitem').allTextContents()
    expect(items.map((one) => one.trim())).toEqual([
      `Mark ${withUnsub.markableUnread} read`, 'Unsubscribe\u2026', 'These are important\u2026', ...filterItem(withUnsub.id), 'Rename group',
    ])
    const box = (await menu.boundingBox())!
    const viewport = page.viewportSize()!
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
    await shoot(page, SHOTS, 'group-menu')
    await page.keyboard.press('Escape')
    const without = groups.groups.find((one: { unsubscribable: number }) => one.unsubscribable === 0)
    const second = await openGroupMenu(page, without.id)
    expect((await second.getByRole('menuitem').allTextContents()).map((one) => one.trim()))
      .toEqual([`Mark ${without.markableUnread} read`, 'These are important\u2026', ...filterItem(without.id), 'Rename group'])
    await page.keyboard.press('Escape')
  })

  test('reading a mail from a group marks it read, keeps its row, and the group leaves once closed at zero', async ({ page }) => {
    await openGrouped(page, fixture)
    const groups = await getGroups(fixture, ALL_INBOXES)
    const single = groups.groups.find((one: { unread: number; markableUnread: number }) => one.unread === 1 && one.markableUnread === 1)
    const several = groups.groups.find((one: { unread: number; markableUnread: number }) => one.unread >= 3 && one.markableUnread === one.unread)
    expect(single && several).toBeTruthy()
    // A group with several: the pill counts down by one and the row stays.
    const group = await openGroupLine(page, several.id)
    const kid = group.locator('[data-testid="mail-row"]').first()
    const accountId = (await kid.getAttribute('data-account-id'))!
    const messageId = (await kid.getAttribute('data-message-id'))!
    await kid.click()
    await expect(page.getByTestId('mail-reader')).toBeVisible()
    await expect(groupLine(page, several.id).getByTestId('mail-group-unread')).toHaveText(String(several.unread - 1))
    const same = group.locator(`[data-testid="mail-row"][data-message-id="${messageId}"]`)
    await expect(same).toHaveAttribute('data-unread', 'false')
    await expect.poll(async () => (await flags(fixture, accountId, messageId)).seen, { timeout: 20_000 }).toBe(true)
    // The reader says where the mail is and why, with the way to correct it.
    const sortLine = page.getByTestId('mail-reader-sort')
    await expect(sortLine).toHaveAttribute('data-group-id', several.id)
    await expect(sortLine).toContainText(`In ${several.label}`)
    await expect(sortLine.getByTestId('mail-reader-sort-fix')).toHaveText('Not right?')
    await shoot(page, SHOTS, 'reader-sort-line')
    // A group whose one unread gets read: it shows 0 while open, and leaves once closed.
    const lone = await openGroupLine(page, single.id)
    await lone.locator('[data-testid="mail-row"]').first().click()
    const line = groupLine(page, single.id)
    await expect(line.getByTestId('mail-group-unread')).toHaveText('0')
    await expect(line.getByTestId('mail-group-unread')).toHaveClass(/zero/)
    await expect(lone.locator('[data-testid="mail-row"]')).toHaveCount(1)
    // Nothing to mark at zero: no check button, no footer action, no menu item.
    await line.hover()
    await expect(line.getByTestId('mail-group-mark')).toHaveCount(0)
    await expect(lone.getByTestId('mail-group-foot-mark')).toHaveCount(0)
    await line.getByTestId('mail-group-more').click()
    expect((await page.getByTestId('mail-group-menu').getByRole('menuitem').allTextContents()).some((one) => /^Mark /.test(one.trim()))).toBe(false)
    await page.keyboard.press('Escape')
    // The pointer leaving the list is enough: a group with nothing unread is not kept on screen.
    await page.mouse.move(4, 4)
    await expect(line).toHaveCount(0, { timeout: 20_000 })
    await expect.poll(async () => (await getGroups(fixture, ALL_INBOXES)).groups.some((one: { id: string }) => one.id === single.id)).toBe(false)
  })

  test('new mail waits in Important while the model sorts it, then moves into its group', async ({ page }) => {
    await setLabelModel(fixture, 'slow')
    await openGrouped(page, fixture, MARINA)
    const before = await getGroups(fixture, { accountId: MARINA, mailboxId: 'INBOX' })
    const builds = before.groups.find((one: { label: string }) => one.label === 'Build results')
    const made = (await deliver(fixture, 3, { account: 'marina' })).delivered
    const sorting = page.getByTestId('mail-grouped-sorting')
    await expect(sorting).toHaveText('Sorting 3 new', { timeout: 30_000 })
    for (const one of made) {
      await expect(page.locator(`.mail-important [data-testid="mail-row"][data-message-id="${one.messageId}"]`)).toBeVisible()
    }
    await shoot(page, SHOTS, 'sorting-new')
    await expect(sorting).toHaveCount(0, { timeout: 60_000 })
    await expect(page.getByTestId('mail-grouped-unread')).toBeVisible()
    for (const one of made) {
      await expect(page.locator(`.mail-important [data-testid="mail-row"][data-message-id="${one.messageId}"]`)).toHaveCount(0)
    }
    const line = page.locator('[data-testid="mail-group-row"]').filter({ has: page.getByTestId('mail-group-name').getByText('Build results', { exact: true }) })
    await expect(line).toHaveAttribute('data-unread', String((builds?.unread ?? 0) + 3), { timeout: 20_000 })
    await setLabelModel(fixture, 'ok')
  })

  test('the Grouped view menu switches to All mail and back: one global preference, every badge follows', async ({ page }) => {
    await openGrouped(page, fixture)
    await expect.poll(async () => (await badgeModes(page)).every((mode) => mode === 'grouped')).toBe(true)
    await page.getByTestId('mail-view-menu').click()
    const menu = page.getByTestId('mail-view-menu-list')
    await expect(menu).toBeVisible()
    await shoot(page, SHOTS, 'view-menu')
    await expect(menu.getByRole('menuitemradio')).toHaveCount(2)
    await expect(menu.getByRole('menuitemradio').first()).toHaveAttribute('aria-checked', 'true')
    await expect(menu.getByRole('menuitemcheckbox')).toHaveText(/Unread important mail only/)
    await menu.getByRole('menuitemradio').filter({ hasText: 'All mail' }).click()
    await expect(page.getByTestId('mail-grouped')).toHaveCount(0)
    await expect(page.locator('[data-testid="mail-row"]').first()).toBeVisible()
    await expect(page.getByTestId('mail-view-menu')).toHaveText('All mail')
    await expect(page.getByTestId('mail-view-menu')).toBeFocused()
    expect(await page.evaluate(() => localStorage.getItem('walnut.mail.grouped.v2'))).toBe('{"on":false}')
    await expect.poll(async () => (await badgeModes(page)).every((mode) => mode === 'provider' || mode === 'none')).toBe(true)
    // Remembered across a reload, for All Inboxes AND an account's own inbox.
    await page.reload()
    await expect(page.locator('.mail-accounts-pane')).toBeVisible({ timeout: 90_000 })
    await smartRow(page, 'inbox').click()
    await expect(page.getByTestId('mail-view-menu')).toHaveText('All mail', { timeout: 30_000 })
    await folderRow(page, FERRY, 'INBOX').click()
    await expect(page.getByTestId('mail-view-menu')).toHaveText('All mail')
    await expect(page.getByTestId('mail-grouped')).toHaveCount(0)
    await pickView(page, 'Grouped')
    await expect(page.getByTestId('mail-grouped')).toBeVisible({ timeout: 30_000 })
    await expect.poll(async () => (await badgeModes(page)).every((mode) => mode === 'grouped')).toBe(true)
    // Unread important mail only: Important drops its read rows, the groups stay. Counted once this
    // inbox's groups are in (the view draws before its first answer).
    await expect(page.getByTestId('mail-group-row').first()).toBeVisible({ timeout: 30_000 })
    const groupsBefore = (await getGroups(fixture, { accountId: FERRY, mailboxId: 'INBOX' })).groups.length
    await expect(page.getByTestId('mail-group-row')).toHaveCount(groupsBefore)
    await pickView(page, 'Unread important mail only')
    await expect.poll(async () => page.locator('.mail-important [data-testid="mail-row"][data-unread="false"]').count()).toBe(0)
    expect(await page.getByTestId('mail-group-row').count()).toBe(groupsBefore)
    await pickView(page, 'Unread important mail only')
    await expect(page.locator('.mail-important [data-testid="mail-row"][data-unread="false"]').first()).toBeVisible({ timeout: 20_000 })
  })

  test('other folders and search are the plain list, and the DTO outside a grouped list carries no sort', async ({ page }) => {
    await openMail(page, fixture.port)
    await folderRow(page, MARINA, 'Sent').click()
    await expect(page.getByTestId('mail-message-list')).toBeVisible()
    await expect(page.getByTestId('mail-view-menu')).toHaveCount(0)
    await expect(page.getByTestId('mail-group-row')).toHaveCount(0)
    await smartRow(page, 'inbox').click()
    await expect(page.getByTestId('mail-grouped')).toBeVisible({ timeout: 60_000 })
    await page.getByTestId('mail-search-input').fill('Change')
    await page.getByTestId('mail-search-input').press('Enter')
    await expect(page.getByTestId('mail-search-meta')).toBeVisible()
    await expect(page.getByTestId('mail-group-row')).toHaveCount(0)
    const { body } = await api(fixture, '/messages?scope=role:inbox&limit=50')
    expect(body.messages.length).toBeGreaterThan(0)
    expect(body.messages.every((one: Record<string, unknown>) => !('sort' in one))).toBe(true)
  })

  test('opening an unread Important mail moves the badge and the head in one frame, and a refusal puts both back', async ({ page }) => {
    await openGrouped(page, fixture)
    const head = page.getByTestId('mail-important-unread')
    const badge = smartRow(page, 'inbox').getByTestId('mail-smart-unread')
    await expect(page.locator('.mail-important [data-testid="mail-row"][data-unread="true"]').first()).toBeVisible()
    const start = Number((await head.textContent())!.split(' ')[0])
    await failMarkRead(fixture, 1, 1)
    const seen = await page.evaluate(() => new Promise<Array<[string, string]>>((resolve) => {
      const out: Array<[string, string]> = []
      const read = () => [
        document.querySelector('[data-testid="mail-important-unread"]')?.textContent ?? '',
        document.querySelector('[data-testid="mail-smart-unread"]')?.textContent ?? '0',
      ] as [string, string]
      const observer = new MutationObserver(() => { out.push(read()) })
      observer.observe(document.body, { subtree: true, childList: true, characterData: true })
      ;(document.querySelector('.mail-important [data-testid="mail-row"][data-unread="true"]') as HTMLElement).click()
      setTimeout(() => { observer.disconnect(); resolve(out) }, 4_000)
    }))
    for (const [headText, badgeText] of seen) {
      const n = Number(headText.split(' ')[0])
      expect(n === 0 ? '0' : String(n)).toBe(badgeText === '' ? '0' : badgeText)
    }
    expect(seen.some(([headText]) => Number(headText.split(' ')[0]) === start - 1)).toBe(true)
    await expect(head).toHaveText(`${start} unread`)
    await expect(badge).toHaveText(String(start))
    expect((await markReadLog(fixture)).log.some((one) => !one.ok)).toBe(true)
  })

  test('a failed /groups falls back to all mail in words, and Try again brings the groups back', async ({ page }) => {
    let fail = true
    await page.route('**/api/plugins/mail/groups?**', async (route) => {
      if (!fail) return route.continue()
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'timeout', message: 'Group counts are taking too long.' }) })
    })
    await openMail(page, fixture.port)
    await smartRow(page, 'inbox').click()
    const error = page.getByTestId('mail-groups-error')
    await expect(error).toBeVisible({ timeout: 60_000 })
    await expect(error).toContainText("Walnut couldn't sort this inbox: Group counts are taking too long. Showing all mail.")
    await expect(page.locator('[data-testid="mail-row"]').first()).toBeVisible()
    await expect(page.locator('.mail-view-menu-btn.warn')).toBeVisible()
    fail = false
    await page.getByTestId('mail-groups-retry').click()
    await expect(page.getByTestId('mail-grouped')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('mail-groups-error')).toHaveCount(0)
    await page.unroute('**/api/plugins/mail/groups?**')
  })

  test('a broken rules file is said in the list, and Open Mail rules is an SPA hop', async ({ page }) => {
    await writeRulesFile(fixture, 'version: 1\ngroups: []\nrules:\n  - when: { from: "issues@*" }\n    then: 3\n')
    await openGrouped(page, fixture)
    const line = page.getByTestId('mail-rules-error')
    await expect(line).toBeVisible({ timeout: 20_000 })
    await expect(line).toContainText('Your rules file has an error')
    await page.evaluate(() => { (window as unknown as { __spaMarker: string }).__spaMarker = 'kept' })
    await page.getByTestId('mail-rules-open').click()
    await expect(page).toHaveURL(/\/settings#mail-rules$/)
    expect(await page.evaluate(() => (window as unknown as { __spaMarker?: string }).__spaMarker)).toBe('kept')
    await writeRulesFile(fixture, 'version: 1\ngroups: []\nrules: []\n')
  })

  test('336px column, light and dark: nothing overflows, only names truncate', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openGrouped(page, fixture)
    const width = await page.locator('.mail-list-pane').evaluate((el) => el.clientWidth)
    expect(width).toBeGreaterThanOrEqual(330)
    expect(width).toBeLessThanOrEqual(340)
    const overflow = () => page.evaluate(() => {
      const bad: string[] = []
      const check = (el: Element | null, name: string) => { if (el && el.scrollWidth > el.clientWidth + 1) bad.push(name) }
      const head = document.querySelector('[data-testid="mail-grouped"] [data-testid="mail-list-section"]')!
      check(head, 'head')
      for (const child of [...head.children]) if (!child.classList.contains('mail-list-section-name')) check(child, `head:${child.className}`)
      for (const row of document.querySelectorAll('[data-testid="mail-group-row"]')) {
        check(row, `row:${row.getAttribute('data-group-id')}`)
        check(row.querySelector('[data-testid="mail-group-unread"]'), 'pill')
        check(row.querySelector('.mail-group-time'), 'time')
      }
      check(document.querySelector('.mail-rows.mail-grouped'), 'scroller')
      return bad
    })
    expect(await overflow()).toEqual([])
    await shoot(page, SHOTS, 'overview-336-light')
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    const groups = await getGroups(fixture, ALL_INBOXES)
    await openGroupLine(page, groups.groups[0].id)
    expect(await overflow()).toEqual([])
    await shoot(page, SHOTS, 'overview-336-dark')
  })

  test('all caught up: every group read, only the words and the read Important mail remain', async ({ page }) => {
    await openGrouped(page, fixture)
    // The press on each line, as a person clears an inbox from the top.
    for (let guard = 0; guard < 40; guard += 1) {
      const lines = page.getByTestId('mail-group-row')
      if ((await lines.count()) === 0) break
      const line = lines.first()
      const id = (await line.getAttribute('data-group-id'))!
      await line.hover()
      const mark = line.getByTestId('mail-group-mark')
      await expect(mark).toBeEnabled({ timeout: 20_000 })
      await mark.click()
      await expect(groupLine(page, id)).toHaveCount(0, { timeout: 60_000 })
    }
    // Important's unread too (they are the person's to read; here the fixture clears them).
    const unreadImportant = (await api(fixture, '/messages?scope=role:inbox&group=important&unread=1&limit=200')).body.messages
    for (const one of unreadImportant) {
      await api(fixture, `/messages/${encodeURIComponent(one.accountId)}/${encodeURIComponent(one.messageId)}/read`, { body: { read: true } })
    }
    const caught = page.getByTestId('mail-caught-up')
    await expect(caught).toBeVisible({ timeout: 30_000 })
    await expect(caught).toContainText('All caught up')
    await expect(caught).toContainText('No unread mail. Important mail you have read is below.')
    await expect(page.getByTestId('mail-grouped-unread')).toHaveCount(0)
    await expect(page.locator('.mail-important [data-testid="mail-row"]').first()).toBeVisible()
    await page.mouse.move(0, 0)
    await shoot(page, SHOTS, 'caught-up')
  })
})

test.describe('the model down from the start', () => {
  let server: MailFixtureServer
  let fixture: MailFixture
  test.beforeAll(async () => {
    test.setTimeout(240_000)
    ;({ server, fixture } = await startGroupsFixture({ labelModel: 'down' }))
  })
  test.afterAll(async () => { await server?.stop() })

  test('sorted without AI: the simple rules decide Important, the rest is grouped by sender', async ({ page }) => {
    await openGrouped(page, fixture)
    await expect(page.getByTestId('mail-grouped-no-ai')).toHaveText('Sorted without AI', { timeout: 60_000 })
    await expect(page.getByTestId('mail-grouped-sorting')).toHaveCount(0)
    const groups = await getGroups(fixture, ALL_INBOXES)
    expect(groups.ai.state).toBe('down')
    expect(groups.groups.length).toBeGreaterThan(0)
    for (const one of groups.groups) expect(one.id).toMatch(/^s:/)
    // A person writing to Robin directly is Important; a pager alert sits in its sender's group.
    const important = await allGroupMessages(fixture, 'important')
    expect(important.some((one) => one.messageId === ROW.direct)).toBe(true)
    const pager = groups.groups.find((one: { topSenders: Array<{ label: string }> }) => one.topSenders.some((s) => s.label === 'Pager'))
    expect(pager).toBeTruthy()
    await expect(groupLine(page, pager.id).getByTestId('mail-group-name')).toHaveText(pager.label)
    // A sender group opens like any other (its id carries the sender's address).
    const group = await openGroupLine(page, pager.id)
    await expect(group.locator('[data-testid="mail-row"]')).toHaveCount(Math.min(3, pager.unread))
    await expect(page.locator('.mail-inline-error')).toHaveCount(0)
    // A name-only sender's group too (spaces and a colon in the id).
    const named = groups.groups.find((one: { id: string }) => one.id.startsWith('s:name:'))
    expect(named, 'a name-only sender group').toBeTruthy()
    const second = await openGroupLine(page, named.id)
    await expect(second.locator('[data-testid="mail-row"]').first()).toBeVisible()
    await page.mouse.move(0, 0)
    await shoot(page, SHOTS, 'sorted-without-ai')
  })
})
