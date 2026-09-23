/**
 * Mail read on another device leaves an open All Inboxes list by itself (reported 2026-09-23: "I already
 * read these, why do they still show").
 *
 * The production shape, reproduced by `PW_MAIL_READ_ELSEWHERE=1`: the provider's poll never lists an old
 * message again (so it cannot carry the new read flag), the folder's own count does drop, and the
 * provider's unread list answers in seconds. The server's smart list waits only a moment for that answer,
 * then replies from the cache and lets the call run on; the correction lands AFTER the page. What is
 * graded is that the open page hears about it (`plugin:mail:unread-reconciled`) and drops the rows with no
 * further input from the person.
 *
 * No `browserName` pin, so the same cases run in WebKit (the engine the Mac app is) with
 * `PW_WEBKIT=1 --project=webkit`.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { MailFixtureServer, openMail, shoot, smartRow } from './mail-review-helpers'

const SHOT_DIR = '/tmp/mail-read-elsewhere'
const WRITER = 'fixture:ctx-writer@example.invalid'
const KEEPER = 'INBOX:1:31'
const LUNCH = 'INBOX:1:30'

test.describe.configure({ mode: 'default' })
test.setTimeout(420_000)

const server = new MailFixtureServer()
let port = 0
let home = ''

test.beforeAll(async () => {
  test.setTimeout(300_000)
  await fs.mkdir(SHOT_DIR, { recursive: true })
  const fixture = await server.start({ PW_MAIL_CTX: '1', PW_MAIL_DENSE: '', PW_MAIL_READ_ELSEWHERE: '1' })
  port = fixture.port
  home = fixture.home
})

test.afterAll(async () => { await server.stop() })

function row(page: Page, messageId: string): Locator {
  return page.locator(`.mail-row[data-account-id="${WRITER}"][data-message-id="${messageId}"]`)
}

/** "Read on the phone": the provider stops counting these, and its poll will never say so. */
async function readOnAnotherDevice(messageIds: string[], delayMs = 2_500): Promise<void> {
  await fs.writeFile(path.join(home, 'mail-fixture-read-elsewhere.json'), JSON.stringify({ messageIds, delayMs }))
}

async function openAllInboxesUnread(page: Page): Promise<void> {
  await openMail(page, port)
  await expect(smartRow(page, 'inbox')).toHaveCount(1, { timeout: 90_000 })
  await smartRow(page, 'inbox').click()
  const chip = page.getByTestId('mail-unread-filter')
  await expect(chip).toBeVisible({ timeout: 60_000 })
  await chip.click()
  await expect(chip).toContainText('showing unread only')
}

test('a mail read on another device leaves the open All Inboxes list with no click', async ({ page }) => {
  await readOnAnotherDevice([])
  await openAllInboxesUnread(page)
  await expect(row(page, KEEPER)).toBeVisible({ timeout: 60_000 })
  await expect(row(page, LUNCH)).toBeVisible()

  const pages: number[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (request.method() === 'GET' && url.pathname.endsWith('/api/plugins/mail/messages')
      && url.searchParams.get('scope')) pages.push(Date.now())
  })

  // Read on the phone, then the poll that learns the folder's new count. The Refresh control is the
  // person's own way of asking for that poll, and it reads the list again as part of it.
  await readOnAnotherDevice([KEEPER])
  const refreshedAt = Date.now()
  await page.getByTestId('mail-refresh').click()

  // The one assertion that matters: the row goes, and nothing else was pressed to make it go.
  await expect(row(page, KEEPER), 'the mail read on the phone leaves the list by itself')
    .toHaveCount(0, { timeout: 20_000 })
  const goneAfterMs = Date.now() - refreshedAt
  await expect(row(page, LUNCH), 'mail still unread on the server stays').toBeVisible()
  console.log(`gone ${goneAfterMs}ms after Refresh; list reads since: ${pages.map((at) => at - refreshedAt).join(', ')}ms`)
  console.log(`shot: ${await shoot(page.locator('.mail-console'), SHOT_DIR, 'after-correction')}`)

  // And it stays gone: the re-read the correction caused does not start another correction.
  const settled = pages.length
  await page.waitForTimeout(4_000)
  expect(pages.length, 'the correction is not a loop of list reads').toBe(settled)
  await expect(row(page, KEEPER)).toHaveCount(0)
})
