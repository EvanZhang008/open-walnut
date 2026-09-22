import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import { expect, test } from './shortcut-test-fixture'
import { type Page } from '@playwright/test'

/**
 * The Mail console's read path, end to end, against a real server with a canned provider plugin.
 *
 * One user story, in order, because each step is the setup for the next: add an account (getting
 * the credential wrong first), read the mailbox it syncs, open a hostile HTML message, and search
 * for a word that only exists deep inside that body.
 *
 * What this pins that no unit test can:
 *
 *   a. A refused credential KEEPS THE FORM and says what usually fixes it. The plugin answers 401
 *      with the provider's own sentence; the dialog adds the one hint that fixes most of them.
 *   b. The HTML body renders in a sandboxed iframe whose srcdoc carries no `<script`, no
 *      `onerror` and no javascript: URL, and whose CSP allows NO http(s) image until the human
 *      asks for this one message. Only a real browser can prove this half: DOMPurify is a
 *      passthrough without a DOM, so the node tier grades the string pass and this grades the
 *      document the browser actually builds.
 *   c. Opening a message clears its unread weight, the mailbox badge and the sidebar badge, and
 *      the numbers agree with the provider afterwards (the fixture holds read state like a server).
 *   d. Cached search finds a word that appears nowhere but inside a fetched body, and says it came
 *      from the cache, which is a different claim from "the provider found nothing".
 *
 * Runs against its OWN server (tests/e2e/browser/mail-app-server.ts) with a throwaway home: the
 * account it creates and the mail it caches must not outlive the run.
 */

const SCREENSHOT_DIR = '/tmp/plugin-platform/pw'

interface Fixture {
  port: number
  home: string
}

let child: ChildProcessWithoutNullStreams | null = null
let fixture: Fixture | null = null
let output = ''

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

async function reservePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not reserve a mail fixture port')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

function waitForReady(): Promise<Fixture> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error(`Mail fixture did not start\n${output.slice(-8000)}`)),
      180_000,
    )
    const check = () => {
      const match = /MAIL_FIXTURE_READY (\{.*\})/.exec(output)
      if (!match) return false
      clearTimeout(deadline)
      resolve(JSON.parse(match[1]!) as Fixture)
      return true
    }
    const timer = setInterval(() => {
      if (check()) clearInterval(timer)
      else if (child?.exitCode !== null && child?.exitCode !== undefined) {
        clearInterval(timer)
        clearTimeout(deadline)
        reject(new Error(`Mail fixture exited early (${child.exitCode})\n${output.slice(-8000)}`))
      }
    }, 250)
  })
}

async function expandSidebar(page: Page): Promise<void> {
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 })
  if (await page.locator('.sidebar.collapsed').count()) {
    await page.locator('.sidebar-collapse-btn').click()
    await expect(page.locator('.sidebar.collapsed')).toHaveCount(0)
  }
}

/** The CSP directive list out of the frame's srcdoc. */
function cspOf(srcdoc: string): string {
  const match = /content="(default-src[^"]*)"/.exec(srcdoc)
  if (!match) throw new Error(`no CSP meta in the frame document:\n${srcdoc.slice(0, 400)}`)
  return match[1]!
}

test.beforeAll(async () => {
  // A hook does NOT inherit the file's test timeout: it gets the config default, and booting a
  // server plus Vite takes longer than that whenever the machine is busy.
  test.setTimeout(240_000)
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
  const port = await reservePort()
  child = spawn('./node_modules/.bin/tsx', ['tests/e2e/browser/mail-app-server.ts'], {
    cwd: process.cwd(),
    // PW_MAIL_PROVIDER: link the canned provider plugin. The gate spec's server deliberately
    // runs without it, because its subject is what a stock install does.
    env: { ...process.env, PW_MAIL_PORT: String(port), PW_MAIL_PROVIDER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  child.stderr.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  fixture = await waitForReady()
})

test.afterAll(async () => {
  if (child) {
    child.kill('SIGTERM')
    const deadline = Date.now() + 15_000
    while (child.exitCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (child.exitCode === null) child.kill('SIGKILL')
  }
  if (fixture?.home.includes('walnut-mail-app-')) {
    await fs.rm(fixture.home, { recursive: true, force: true }).catch(() => undefined)
  }
})

test('add an account, read the mailbox, open a hostile HTML body, search the cache', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto(`http://127.0.0.1:${fixture!.port}/`)
  await page.waitForLoadState('domcontentloaded')
  await expandSidebar(page)

  const mailRow = page.getByTestId('sidebar-core-app-mail')
  await expect(mailRow).toBeVisible({ timeout: 60_000 })
  await mailRow.click()

  // ── (a) the credential is refused, then accepted ──

  await expect(page.getByTestId('mail-app-empty')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('mail-add-account').click()

  const dialog = page.getByTestId('mail-add-dialog')
  await expect(dialog).toBeVisible()
  // Two provider plugins are active (the builtin IMAP one and the fixture), so the picker is
  // what a real install with a choice shows.
  await expect(page.getByTestId('mail-provider-option')).toHaveCount(2)
  await page.locator('[data-testid="mail-provider-option"][data-provider-id="fixture"]').click()

  // The form is rendered from the provider's declared setupFields alone, and its first field has
  // the caret: a credential dialog that needs a click before you can type is a dialog that made
  // the human do its work.
  await expect(page.getByTestId('mail-setup-address')).toBeFocused({ timeout: 15_000 })

  // ── (a1) a known service fills the servers from the address, and hand typing wins ──
  // The fixture declares one preset (its server.mjs), so this is the console's own arithmetic in
  // the browser that runs it, with no mail host involved. The domain is the fixture's own, not
  // the `example.invalid` the account below uses.
  const presetChip = page.getByTestId('mail-preset-fixturehost')
  const presetHost = page.getByTestId('mail-setup-host')
  const presetPort = page.getByTestId('mail-setup-port')
  await expect(presetChip).toBeVisible()
  await expect(page.getByTestId('mail-preset-other')).toBeVisible()
  // EMPTY before, and the preset's port is deliberately not the number the placeholder shows: a
  // filled 993 under a `993` placeholder is indistinguishable from nothing having happened, both
  // in this assertion and in the screenshot a human reviews.
  await expect(presetHost).toHaveValue('')
  await expect(presetPort).toHaveValue('')

  await page.getByTestId('mail-setup-address').fill('owner@preset.invalid')
  await expect(presetChip).toHaveAttribute('aria-checked', 'true')
  await expect(presetHost).toHaveValue('mail.preset.invalid')
  await expect(presetPort).toHaveValue('1143')

  // The credential sentence for THAT service, and under it the steps that get you one, so the
  // whole job is click, copy, paste rather than "go and find out how".
  const presetHelp = page.getByTestId('mail-preset-help')
  await expect(presetHelp).toContainText('app password')
  const steps = page.getByTestId('mail-preset-steps').locator('li')
  await expect(steps).toHaveCount(3)
  await expect(steps.nth(0)).toContainText('Open the security page')
  await expect(steps.nth(2)).toContainText('Paste the 16 letters')

  // A step that names a page IS the link, opening in a new tab like every external link here.
  const stepLinks = page.getByTestId('mail-preset-step-link')
  await expect(stepLinks).toHaveCount(1)
  await expect(stepLinks.first()).toHaveAttribute('href', 'https://example.invalid/security')
  await expect(stepLinks.first()).toHaveAttribute('target', '_blank')
  await expect(stepLinks.first()).toHaveAttribute('rel', /noopener/)

  // The fixture's second step carries a `javascript:` url: a plugin cannot get a click-to-execute
  // href onto this screen, so that step renders as text and there is no anchor to click.
  await expect(steps.nth(1)).toContainText('Create an app password named Walnut')
  await expect(steps.nth(1).locator('a')).toHaveCount(0)

  // With steps on screen the trailing "setup help" link stands down: the same page is step one now,
  // and two links to the same place is the kind of duplication somebody has to read twice.
  await expect(page.getByTestId('mail-preset-help-link')).toHaveCount(0)

  // ONE instruction about the credential, not three. The field's own generic line ("use an app
  // password, never your main password") is right for somebody on Other and noise directly above a
  // service's own sentence plus its steps, so it stands down while a service is chosen. Read from
  // the credential row itself, because other fields keep their help either way.
  const tokenRow = dialog.locator('.mail-setup-row', { has: page.getByTestId('mail-setup-token') })
  await expect(tokenRow.locator('.mail-setup-help')).toHaveCount(0)
  await dialog.screenshot({ path: `${SCREENSHOT_DIR}/mail-preset-autofill.png` })

  // A hand-typed port is a decision (some mail hosts really do need another one), so re-typing
  // the address must not quietly undo it. What nobody touched is still the preset's.
  await presetPort.fill('1993')
  await page.getByTestId('mail-setup-address').fill('owner2@preset.invalid')
  await expect(presetPort).toHaveValue('1993')
  await expect(presetHost).toHaveValue('mail.preset.invalid')

  await page.getByTestId('mail-setup-address').fill('alice@example.invalid')
  await expect(page.getByTestId('mail-setup-token')).toHaveAttribute('type', 'password')
  await page.getByTestId('mail-setup-token').fill('wrong-token')
  await page.getByTestId('mail-add-submit').click()

  const addError = page.getByTestId('mail-add-error')
  await expect(addError).toBeVisible({ timeout: 30_000 })
  // The provider's own words travel unedited.
  await expect(addError).toContainText('The mail server refused that token.')

  // ── (a2) ONE credential sentence, whichever one is the specific one ──
  // A service is still chosen here, so its own help line is the credential sentence and the
  // generic 401 hint must stand down. Both at once is how the console ended up telling somebody on
  // Outlook.com "this must be an app password" directly under "an app password is refused".
  const authHint = page.locator('.mail-setup-error-lead')
  await expect(presetHelp).toBeVisible()
  await expect(authHint).toHaveCount(0)
  await expect(addError).not.toContainText('must be an app password')

  // Choosing Other retires that sentence, and the generic hint takes over: still exactly one.
  await page.getByTestId('mail-preset-other').click()
  await expect(presetHelp).toHaveCount(0)
  await expect(authHint).toHaveCount(1)
  // …and with no service chosen the field's own generic line is what explains the credential, so
  // it comes back rather than leaving the field bare.
  await expect(tokenRow.locator('.mail-setup-help')).toHaveCount(1)
  await expect(addError).toContainText('app password')
  // Other clears nothing, so the servers the preset filled are still there to look at.
  await expect(presetHost).toHaveValue('mail.preset.invalid')

  // The form STAYS, with what was typed: a dialog that closes here makes the human retype
  // every field to find out which one was wrong.
  await expect(page.getByTestId('mail-setup-address')).toHaveValue('alice@example.invalid')
  await dialog.screenshot({ path: `${SCREENSHOT_DIR}/mail-add-account-error.png` })

  await page.getByTestId('mail-setup-token').fill('ok')
  await page.getByTestId('mail-add-submit').click()
  await expect(dialog).toHaveCount(0, { timeout: 30_000 })

  // The account, its two mailboxes, and the inbox selected with its page loaded.
  const accountsPane = page.getByTestId('mail-accounts-pane')
  await expect(accountsPane).toContainText('Fixture Mail', { timeout: 60_000 })
  const inbox = page.locator('.mail-mailbox[data-mailbox-id="INBOX"]')
  const archive = page.locator('.mail-mailbox[data-mailbox-id="Archive"]')
  await expect(inbox).toBeVisible({ timeout: 60_000 })
  await expect(archive).toBeVisible()
  await expect(inbox).toHaveClass(/active/)
  await expect(inbox.locator('.mail-unread-badge')).toHaveText('2', { timeout: 60_000 })

  const rows = page.getByTestId('mail-row')
  await expect(rows).toHaveCount(3, { timeout: 60_000 })
  await expect(rows.first()).toContainText('Quarterly keeper report')
  await expect(rows.nth(1)).toContainText('Lunch tomorrow')

  // ── (e) the sidebar badge is the total unread across accounts ──
  const sidebarBadge = mailRow.locator('.notification-badge-count')
  await expect(sidebarBadge).toHaveText('2', { timeout: 30_000 })

  await page.locator('.mail-console').screenshot({ path: `${SCREENSHOT_DIR}/mail-three-pane.png` })

  // ── (b) the hostile HTML body ──

  const hostile = page.locator('[data-testid="mail-row"]', { hasText: 'Quarterly keeper report' })
  await expect(hostile).toHaveAttribute('data-unread', 'true')
  await hostile.click()

  await expect(page.getByTestId('mail-reader-subject')).toContainText('Quarterly keeper report', { timeout: 30_000 })
  const frame = page.getByTestId('mail-html-frame')
  await expect(frame).toBeVisible({ timeout: 30_000 })
  await expect(frame).toHaveAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox')

  const blocked = await frame.getAttribute('srcdoc')
  expect(blocked, 'the frame renders from srcdoc, never from a URL').toBeTruthy()
  expect(blocked!).not.toContain('<script')
  expect(blocked!.toLowerCase()).not.toContain('onerror')
  expect(blocked!.toLowerCase()).not.toContain('javascript:')
  expect(blocked!).toContain('<base target="_blank">')
  // The pixel's markup survives; the POLICY is what stops it leaving.
  expect(cspOf(blocked!)).toContain('img-src data: cid:')
  expect(cspOf(blocked!)).not.toMatch(/https?:/)

  // Every OTHER remote fetch is gone from the document, which is what makes the count below a
  // promise rather than an estimate: widening `img-src` for this one body cannot release a picture
  // the banner never mentioned. This is the half the node tier cannot prove, because DOMPurify (a
  // passthrough without a DOM) runs after the string pass and could have put them back.
  expect(blocked!.toLowerCase()).not.toContain('poster=')
  // And the <video> itself is gone: media cannot load under this policy, so a player with
  // controls would be a control that does nothing (it rendered on top of the prose).
  expect(blocked!.toLowerCase()).not.toContain('<video')
  expect(blocked!.toLowerCase()).not.toContain('svg.png')
  expect(blocked!).not.toContain('bg.png')
  expect(blocked!).not.toContain('paper.png')
  expect(blocked!.toLowerCase()).not.toContain('url(http')
  // The one remaining remote URL is the pixel's, and only the POLICY stops it leaving.
  expect(blocked!).toContain('pixel.png')
  expect(cspOf(blocked!)).toContain("base-uri 'none'")

  const banner = page.getByTestId('mail-blocked-images')
  await expect(banner).toContainText('1 remote image blocked')
  await expect(page.getByTestId('mail-attachments')).toContainText('attendance.pdf')
  await page.getByTestId('mail-reader').screenshot({ path: `${SCREENSHOT_DIR}/mail-reader-blocked-images.png` })

  await page.getByTestId('mail-load-images').click()
  await expect(banner).toHaveCount(0)
  await expect.poll(
    async () => cspOf((await frame.getAttribute('srcdoc')) ?? ''),
    { timeout: 15_000 },
  ).toContain('https:')

  // ── (c) the read flag moved the row and both badges ──

  await expect(hostile).toHaveAttribute('data-unread', 'false', { timeout: 30_000 })
  await expect(inbox.locator('.mail-unread-badge')).toHaveText('1', { timeout: 30_000 })
  await expect(sidebarBadge).toHaveText('1', { timeout: 30_000 })

  // ── (d) cached search finds a word only the body contains ──

  await page.getByTestId('mail-search-input').fill('zebra')
  await page.getByTestId('mail-search-input').press('Enter')

  const meta = page.getByTestId('mail-search-meta')
  await expect(meta).toContainText('1 result', { timeout: 30_000 })
  // The fixture provider declares `search: false`, so the plugin answers from its own FTS index
  // over bodies it has fetched. Saying so matters: "nothing matched" means something different.
  await expect(meta).toContainText('from cache')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('Quarterly keeper report')

  await page.getByTestId('mail-search-clear').click()
  await expect(rows).toHaveCount(3, { timeout: 30_000 })

  // ── narrow viewport: one pane at a time, and a way back ──
  // Three panes cannot all be readable under 900px, so the console drills to whichever one the
  // human is in: a message is still open here, so that is the reader. The panes stay MOUNTED and
  // are hidden with display, which is why coming back does not refetch the page and the reader
  // still knows this body's images were allowed.
  await page.setViewportSize({ width: 700, height: 900 })
  const accountsPaneNarrow = page.getByTestId('mail-accounts-pane')
  const listPane = page.getByTestId('mail-message-list')
  const readerPane = page.getByTestId('mail-reader')
  // The shell turns its sidebar into a drawer at this width and SLIDES it out. Waiting for that
  // to land is not cosmetic: a screenshot taken during the transition shows the nav painted over
  // the console, which is not what the user is looking at.
  await expect(page.locator('.sidebar')).not.toBeInViewport()

  await expect(readerPane).toBeVisible()
  await expect(listPane).toBeHidden()
  await expect(accountsPaneNarrow).toBeHidden()
  await expect(page.getByTestId('mail-blocked-images')).toHaveCount(0)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/mail-narrow-reader.png` })

  await page.getByTestId('mail-reader-back').click()
  await expect(listPane).toBeVisible()
  await expect(readerPane).toBeHidden()
  await expect(rows).toHaveCount(3)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/mail-narrow-list.png` })

  // And out of the list to the mailboxes, which is the only way back to another account.
  await page.getByTestId('mail-show-mailboxes').click()
  await expect(accountsPaneNarrow).toBeVisible()
  await expect(listPane).toBeHidden()

  expect(pageErrors, 'the mail console must not throw in the browser').toEqual([])
})

/**
 * A tab whose FIRST provider read failed still marks a message read.
 *
 * The reported failure (2026-09-16): a tab that opened while the mail plugin was still starting got
 * `Not found: GET /api/plugins/mail/providers`, kept an empty provider list, and read that as "this
 * account cannot mark read" — so clicking a message did nothing at all for the life of the tab: no
 * request, no error, no visible change. The 404 is injected here because that is exactly what the
 * browser log recorded, and the account and mailbox this runs against are the ones the story above
 * left behind (one message still unread).
 */
test('a tab that could not read the provider list still marks a message read', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  let providerReads = 0
  await page.route(
    (url) => url.pathname === '/api/plugins/mail/providers',
    (route) => {
      providerReads += 1
      if (providerReads > 1) return route.continue()
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'not-found', message: 'Not found: GET /api/plugins/mail/providers' }),
      })
    },
  )

  await page.goto(`http://127.0.0.1:${fixture!.port}/`)
  await page.waitForLoadState('domcontentloaded')
  await expandSidebar(page)
  await page.getByTestId('sidebar-core-app-mail').click()

  const rows = page.getByTestId('mail-row')
  await expect(rows.first()).toBeVisible({ timeout: 60_000 })
  // Pinned by message id, not by the unread flag: a locator whose own predicate is the thing under
  // test stops matching the moment the fix works, which reads as "element not found".
  const firstUnread = page.locator('[data-testid="mail-row"][data-unread="true"]').first()
  await expect(firstUnread).toBeVisible({ timeout: 30_000 })
  const messageId = await firstUnread.getAttribute('data-message-id')
  const unread = page.locator(`[data-testid="mail-row"][data-message-id="${messageId}"]`)
  const inbox = page.locator('.mail-mailbox[data-mailbox-id="INBOX"]')
  const badge = inbox.locator('.mail-unread-badge')
  // A mailbox with nothing unread has NO badge, so the count is read as a number either way.
  const unreadCount = async () => ((await badge.count()) === 0 ? 0 : Number((await badge.textContent()) ?? '0'))
  const badgeBefore = await unreadCount()
  expect(badgeBefore).toBeGreaterThan(0)

  await unread.click()
  await expect(page.getByTestId('mail-reader-subject')).toBeVisible({ timeout: 30_000 })

  // The flag actually moved — the row, the mailbox badge, and the provider itself, which holds read
  // state like a server — and the console asked for the list again rather than assuming. Polled,
  // because the read flag rides an answer that lands after the body is on screen.
  await expect(unread).toHaveAttribute('data-unread', 'false', { timeout: 30_000 })
  await expect.poll(unreadCount, { timeout: 30_000 }).toBe(badgeBefore - 1)
  await expect
    .poll(() => providerReads, { message: 'the console must re-read a provider list it never got', timeout: 15_000 })
    .toBeGreaterThan(1)
  await page.getByTestId('mail-reader').screenshot({ path: `${SCREENSHOT_DIR}/mail-read-after-provider-404.png` })
  expect(pageErrors, 'the mail console must not throw in the browser').toEqual([])
})
