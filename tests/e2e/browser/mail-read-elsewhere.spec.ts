/**
 * Mail read on another device leaves an open All Inboxes list by itself (reported 2026-09-23: "I already
 * read these, why do they still show"; 2026-09-24: "make sure it is periodically checking").
 *
 * The production shape, reproduced by `PW_MAIL_READ_ELSEWHERE=1`: the provider's poll never lists an old
 * message again (so it cannot carry the new read flag), the folder's own count does drop, and the
 * provider's unread list answers in seconds. Two things are graded:
 *
 * - With the list open and NOTHING pressed, the poll loop's own unread check (every tick, on a shared
 *   one-minute clock) takes the mail off the list. `PW_MAIL_POLL_SECONDS` makes a tick every few seconds,
 *   so the wait is the one-minute clock, which is the production bound too.
 * - Refresh does the list on screen first, and `Checking…` stays up for exactly as long as the provider is
 *   still being asked, including after the refresh request itself has answered.
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
  const fixture = await server.start({
    PW_MAIL_CTX: '1', PW_MAIL_DENSE: '', PW_MAIL_READ_ELSEWHERE: '1', PW_MAIL_POLL_SECONDS: '5',
  })
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
  if (!(await chip.textContent())?.includes('showing unread only')) await chip.click()
  await expect(chip).toContainText('showing unread only')
}

test('with the list open and nothing pressed, the next poll takes a mail read elsewhere off it', async ({ page }) => {
  await readOnAnotherDevice([])
  await openAllInboxesUnread(page)
  await expect(row(page, KEEPER)).toBeVisible({ timeout: 60_000 })
  await expect(row(page, LUNCH)).toBeVisible()

  const presses: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (request.method() === 'POST' && url.pathname.startsWith('/api/plugins/mail/')) presses.push(url.pathname)
  })

  await readOnAnotherDevice([KEEPER])
  const readAt = Date.now()
  // The bound is the shared clock: nothing may ask the same folder twice within a minute, so the first
  // tick allowed to ask is at most a minute (plus one tick) after the last question.
  await expect(row(page, KEEPER), 'the mail read on the phone leaves the list by itself')
    .toHaveCount(0, { timeout: 90_000 })
  const goneAfterMs = Date.now() - readAt
  await expect(row(page, LUNCH), 'mail still unread on the server stays').toBeVisible()
  expect(presses, 'nothing was pressed to make it go').toEqual([])
  console.log(`gone ${goneAfterMs}ms after the read elsewhere, with no click`)
  console.log(`shot: ${await shoot(page.locator('.mail-console'), SHOT_DIR, 'no-click-correction')}`)
})

test('Refresh does the list on screen first and says Checking… until the provider has answered', async ({ page }) => {
  await openAllInboxesUnread(page)
  await expect(row(page, LUNCH)).toBeVisible({ timeout: 60_000 })

  const seen: string[] = []
  let refreshAnsweredAt = 0
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/plugins/mail/')) return
    if (url.pathname.endsWith('/mailboxes/fetch')) seen.push('fetch')
    else if (url.pathname.endsWith('/refresh')) seen.push('refresh')
    else if (url.pathname.endsWith('/messages') && url.searchParams.get('fresh') === '1') seen.push('page:fresh')
  })
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.endsWith('/api/plugins/mail/refresh')) refreshAnsweredAt = Date.now()
  })

  // Slower than the whole refresh, so the check is still running once the refresh has answered.
  await readOnAnotherDevice([KEEPER, LUNCH], 6_000)
  const line = page.getByTestId('mail-sync-line')
  const pressedAt = Date.now()
  await page.getByTestId('mail-refresh').click()
  await expect(line).toHaveText('Checking…', { timeout: 5_000 })

  await expect.poll(() => refreshAnsweredAt, { timeout: 20_000 }).toBeGreaterThan(0)
  expect(seen.indexOf('fetch'), 'the folder on screen is polled first').toBe(0)
  expect(seen.indexOf('page:fresh')).toBeLessThan(seen.indexOf('refresh'))
  // The refresh request is done; the provider is not, and the line says so rather than a stale age.
  if (Date.now() - pressedAt < 5_000) await expect(line).toHaveText('Checking…')
  console.log(`shot: ${await shoot(page.locator('.mail-console'), SHOT_DIR, 'refresh-still-checking')}`)

  await expect(row(page, LUNCH), 'the answer lands and takes the read mail off').toHaveCount(0, { timeout: 20_000 })
  await expect(line).not.toHaveText('Checking…', { timeout: 20_000 })
  await expect(line).toContainText('Checked')
  console.log(`settled ${Date.now() - pressedAt}ms after Refresh; requests: ${seen.join(', ')}`)
  console.log(`shot: ${await shoot(page.locator('.mail-console'), SHOT_DIR, 'refresh-settled')}`)
})
