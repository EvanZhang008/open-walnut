import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import { expect, test } from './shortcut-test-fixture'
import { type Locator, type Page } from '@playwright/test'

/**
 * Mail leaving the console: one message becoming a task, and the day's unread becoming one letter.
 *
 * One user story, in order, because each step sets up the next: prime the human inbox (so the
 * letter cache is warm and its staleness rule is really being tested), turn a message into a task,
 * follow the pill into the task, come back, send the digest from the pane menu, and read the letter
 * in the bell.
 *
 * What this pins that no unit test can:
 *
 *   a. The button BECOMES the pill, and the pill is the shared `a.task-link` with the task's real
 *      title from the entity-label store, not a mail-shaped copy of one. The task is in the homepage
 *      panel by then with nothing having reloaded, because a plugin's `tasks.create` emits
 *      `task:created` like every other create path.
 *   b. The backlink is DERIVED on every read: leaving the message and coming back to it shows the
 *      pill again with nothing in the console remembering it.
 *   c. Following the pill lands on the task, whose description carries the provenance block and the
 *      way back into Mail.
 *   d. The digest letter arrives in the bell on the FIRST open after it was sent. The letter list is
 *      cached for 15s and a letter event with the panel shut used to leave that cache in place, so
 *      the letter a human reached for was missing from the list; the mail console's `digest-sent`
 *      handler now marks it stale.
 *   e. The digest is a DOCUMENT, not a question: it has no action buttons.
 *
 * Runs against its OWN server (tests/e2e/browser/mail-app-server.ts) with a throwaway home, and with
 * `PW_MAIL_DIGEST_OFF=1` so the only digest in the run is the one this spec asks for.
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

/** Add an account through the dialog, exactly as a human does. */
async function addAccount(page: Page, address: string): Promise<void> {
  await page.getByTestId('mail-add-account').click()
  const dialog = page.getByTestId('mail-add-dialog')
  await expect(dialog).toBeVisible()
  await page.locator('[data-testid="mail-provider-option"][data-provider-id="fixture"]').click()
  await page.getByTestId('mail-setup-address').fill(address)
  await page.getByTestId('mail-setup-token').fill('ok')
  await page.getByTestId('mail-add-submit').click()
  await expect(dialog).toHaveCount(0, { timeout: 30_000 })
}

/** Open the human inbox the way a human does: the bell, then the section. */
async function openLetters(page: Page): Promise<Locator> {
  await page.locator('.sidebar-notification-btn').click()
  const panel = page.locator('.notification-panel')
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await panel.locator('.nfc-rail-btn', { hasText: 'Inbox' }).first().click()
  return panel
}

async function closeLetters(page: Page): Promise<void> {
  if (await page.locator('.hib-reader-close').count()) await page.locator('.hib-reader-close').click()
  await page.locator('.notification-panel-close').click()
  await expect(page.locator('.notification-panel')).toHaveCount(0)
}

test.beforeAll(async () => {
  // A hook does NOT inherit the file's test timeout: it gets the config default, and booting a
  // server plus Vite takes longer than that whenever the machine is busy.
  test.setTimeout(240_000)
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
  const port = await reservePort()
  child = spawn('./node_modules/.bin/tsx', ['tests/e2e/browser/mail-app-server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PW_MAIL_PORT: String(port),
      PW_MAIL_PROVIDER: '1',
      // The only digest in this run is the one the menu item asks for.
      PW_MAIL_DIGEST_OFF: '1',
    },
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

test('make a task from a message, follow its pill, then send the digest and read it', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto(`http://127.0.0.1:${fixture!.port}/`)
  await page.waitForLoadState('domcontentloaded')
  await expandSidebar(page)

  // ── prime the letter list, so step (d) is a real test of its staleness rule ──
  //
  // Opening the bell now loads the list and starts its 15s freshness window. Without this the first
  // open later would be a cold read and would pass whatever the invalidation rule did.
  const panel = await openLetters(page)
  await expect(panel.locator('.notification-feed-empty')).toHaveText('No letters yet', { timeout: 30_000 })
  await closeLetters(page)

  const mailRow = page.getByTestId('sidebar-core-app-mail')
  await expect(mailRow).toBeVisible({ timeout: 60_000 })
  await mailRow.click()

  await expect(page.getByTestId('mail-app-empty')).toBeVisible({ timeout: 30_000 })
  await addAccount(page, 'alice@example.invalid')

  const rows = page.getByTestId('mail-row')
  await expect(rows).toHaveCount(3, { timeout: 60_000 })

  // ── (a) the button becomes the pill ──

  const lunch = page.locator('[data-testid="mail-row"]', { hasText: 'Lunch tomorrow' })
  await lunch.click()
  await expect(page.getByTestId('mail-reader-subject')).toContainText('Lunch tomorrow', { timeout: 30_000 })

  const makeTask = page.getByTestId('mail-make-task')
  await expect(makeTask).toBeVisible()
  await expect(page.getByTestId('mail-task-pill')).toHaveCount(0)
  await makeTask.click()

  const pill = page.getByTestId('mail-task-pill')
  await expect(pill).toBeVisible({ timeout: 30_000 })
  // The action is not offered twice: a button that stays put after it worked invites the second
  // press and then looks broken.
  await expect(makeTask).toHaveCount(0)
  await expect(page.getByTestId('mail-task-error')).toHaveCount(0)
  // Labelled from the shared entity-label store, so it reads as the task it is. The title is the
  // subject, because nobody typed one.
  await expect(pill).toHaveText('Lunch tomorrow', { timeout: 30_000 })
  const taskId = await pill.getAttribute('data-task-id')
  expect(taskId, 'the pill carries the task id the rest of Walnut keys on').toBeTruthy()
  // `href` stays honest, so a middle click and the context menu still do the right thing.
  await expect(pill).toHaveAttribute('href', `/tasks/${taskId}`)
  await page.locator('.mail-reader-actions').screenshot({ path: `${SCREENSHOT_DIR}/mail-task-pill.png` })

  // ── (a2) the task is in the human's own list, with no reload ──
  //
  // The homepage panel, reached the way a human reaches it. It is here because a task a plugin makes
  // used to be invisible until something else refreshed the list: `tasks.create` now emits
  // `task:created` like every other create path, and this row is that emit arriving.
  //
  // The row itself carries no tag chips (it is one line: title, date pills, badges, kebab), so the
  // `mail` tag is asserted on the task's own page in step (c), which is where tags render.
  await page.getByTestId('sidebar-core-app-home').click()
  // The All section, because a mail task is not pinned to anything: Focus (the tab a fresh home
  // opens on) is the pinned shelf and shows "Drag tasks here" whatever else exists.
  await page.locator('.todo-section-tab-all').click()
  const todoRow = page.locator(`.todo-panel-item[data-task-id="${taskId}"]`)
  await expect(todoRow).toBeVisible({ timeout: 30_000 })
  await expect(todoRow).toContainText('Lunch tomorrow')

  await mailRow.click()
  await expect(page.getByTestId('mail-app')).toBeVisible({ timeout: 30_000 })
  await expect(rows).toHaveCount(3, { timeout: 60_000 })

  // ── (b) the backlink is derived, not remembered ──
  // Leave the message for another one and come back: the pill is on the reopened message because
  // every read carries `taskId`, not because this console wrote it down.
  await page.locator('[data-testid="mail-row"]', { hasText: 'Signed lease' }).click()
  await expect(page.getByTestId('mail-reader-subject')).toContainText('Signed lease', { timeout: 30_000 })
  await expect(page.getByTestId('mail-task-pill')).toHaveCount(0)
  await expect(page.getByTestId('mail-make-task')).toBeVisible()

  await lunch.click()
  await expect(page.getByTestId('mail-reader-subject')).toContainText('Lunch tomorrow', { timeout: 30_000 })
  await expect(page.getByTestId('mail-task-pill')).toHaveAttribute('data-task-id', taskId!, { timeout: 30_000 })

  // ── (c) the pill opens the task, and the task says where it came from ──

  await page.getByTestId('mail-task-pill').click()
  const detail = page.locator(`.task-detail-v2[data-task-id="${taskId}"]`)
  await expect(detail).toBeVisible({ timeout: 30_000 })
  await expect(detail.locator('.tdv2-title')).toHaveText('Lunch tomorrow')
  // The `mail` tag, which is what makes these findable as a group later.
  await expect(detail.locator('.tag-chip', { hasText: 'mail' })).toHaveCount(1, { timeout: 30_000 })
  // The provenance block: who sent it, the snippet, and the way back into Mail with the ids encoded.
  await expect(detail).toContainText('alice@example.invalid', { timeout: 30_000 })
  await expect(detail).toContainText('Lunch tomorrow at one?')
  // A real LINK, not a path printed as text: the description is rendered markdown, so a bare URL
  // here would be something to copy by hand rather than something to press.
  const backlink = detail.locator('a[href*="/mail?account=fixture%3A"]')
  await expect(backlink).toHaveCount(1)
  await expect(backlink).toHaveText('open in Mail')

  // Back into Mail the way a human does.
  await page.goBack()
  await expect(page.getByTestId('mail-app')).toBeVisible({ timeout: 30_000 })
  await expect(rows).toHaveCount(3, { timeout: 60_000 })

  // ── (d) the digest, from the pane's overflow menu ──

  await page.getByTestId('mail-pane-menu').click()
  const menu = page.getByTestId('mail-pane-menu-popup')
  await expect(menu).toBeVisible({ timeout: 15_000 })
  await menu.getByText('Send digest now').click()
  await expect(menu).toHaveCount(0)

  const note = page.getByTestId('mail-refresh-note')
  // One unread left: opening `Lunch tomorrow` cleared its flag, so the report is about the other one.
  await expect(note).toContainText('Digest sent: 1 unread across 1 account', { timeout: 60_000 })

  // The FIRST open finds it. Before the invalidation rule the 15s cache primed above would still be
  // served here, and the human who reached for the bell because a digest landed would see the old list.
  const letters = await openLetters(page)
  const letter = letters.locator('.hib-row', { hasText: 'Mail digest' })
  await expect(letter).toHaveCount(1, { timeout: 30_000 })
  await expect(letter).toContainText('Mail digest: 1 unread across 1 account')
  await letter.click()

  const body = page.locator('.hib-reader-body')
  await expect(body).toContainText('Fixture Mail (1 unread)', { timeout: 30_000 })
  await expect(body).toContainText('Quarterly keeper report')
  await expect(body).toContainText('Keeper Reports')
  // The message that was read is not in it, which is the whole point of a digest.
  await expect(body).not.toContainText('Lunch tomorrow')
  // "Open Mail" is a real link, not a path printed as text: on the phone this letter is read on,
  // a path is a copy-and-paste job.
  await expect(body.locator('a[href*="/mail?account="]')).toHaveCount(1)

  // ── (e) a document, not a question ──
  await expect(page.locator('.hib-action-btn')).toHaveCount(0)
  // The whole viewport: the letter reader is a portal that is wider than the panel it opened from,
  // so a screenshot of the panel alone cuts the body in half.
  await page.screenshot({ path: `${SCREENSHOT_DIR}/mail-digest-letter.png` })

  expect(pageErrors, 'the mail console must not throw in the browser').toEqual([])
})
