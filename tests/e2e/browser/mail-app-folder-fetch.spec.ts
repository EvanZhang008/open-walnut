import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import { expect, test, type Page } from '@playwright/test'

/**
 * A folder with a number and no mail, which is what the reported bug looked like on screen.
 *
 * The report was a screenshot: `SENT MAIL · 1,962 · 2 unread` in the list header, and directly under
 * it "No mail in this folder yet." Both halves came from somewhere real — the counts from the mailbox
 * list, which works, and the rows from the local cache, which was empty — and the only reading
 * available to the human was that Walnut had lost their sent mail.
 *
 * Underneath, on a Gmail account with 67 folders, one label the server refuses to open ended the
 * whole sweep on every pass, so the 55 folders after it in order were never polled once. What this
 * spec pins, with real clicks:
 *
 *   1. CONTAINMENT. The fixture refuses one folder, and it is the FIRST non-inbox folder in sweep
 *      order. Every folder behind it still has its mail. That is the property whose absence starved
 *      a real account for a day.
 *   2. THE PANE DOES NOT LIE. A folder that has never been fetched says so, and offers to fetch it.
 *      A folder that WAS fetched and holds nothing says that instead, with its size in the sentence.
 *      Neither is "No mail in this folder yet", which is reserved for a folder that is really empty.
 *   3. A REFUSAL IS REPORTED. Pressing the offer on a folder the server will not open shows what the
 *      server said and leaves a way to try again, rather than spinning or going quiet.
 *
 * Its own fixture server: `MAIL_FIXTURE_COLD_FOLDER=1` changes the folder list, and the other mail
 * specs count those rows.
 */

const SHOT_DIR = '/tmp/mail-folder-fetch/pw'

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

/**
 * Add the account through the dialog, exactly as a human does.
 *
 * The wait for the first field to be FOCUSED is load-bearing, not politeness. The dialog focuses it
 * on a 10ms timer once a provider is picked, and a fill that starts before that timer fires can have
 * the focus yanked out from under it mid-insert: the observed result was `alice@example.invalidok`,
 * the address plus the password, in one box, with the submit button correctly disabled.
 */
async function addAccount(page: Page): Promise<void> {
  await page.getByTestId('mail-add-account').click()
  const dialog = page.getByTestId('mail-add-dialog')
  await expect(dialog).toBeVisible()
  await page.locator('[data-testid="mail-provider-option"][data-provider-id="fixture"]').click()
  const address = page.getByTestId('mail-setup-address')
  await expect(address).toBeFocused({ timeout: 15_000 })
  await address.fill('alice@example.invalid')
  await page.getByTestId('mail-setup-token').fill('ok')
  // Both values where they belong, so a future race fails here instead of as a disabled button.
  await expect(address).toHaveValue('alice@example.invalid')
  await expect(page.getByTestId('mail-setup-token')).toHaveValue('ok')
  await page.getByTestId('mail-add-submit').click()
  await expect(dialog).toHaveCount(0, { timeout: 30_000 })
}

function folder(page: Page, mailboxId: string) {
  return page.locator(`.mail-mailbox[data-mailbox-id="${mailboxId}"]`)
}

/**
 * `Aged` is role 'other', so the pane keeps it in the collapsed tail behind "1 more folder".
 * Every folder this spec is about is still one click away; what is asserted below is the SWEEP,
 * not the sidebar, so reveal the tail once and let the folder assertions read as they did.
 */
async function revealTail(page: Page): Promise<void> {
  const toggle = page.locator('.mail-tail-toggle')
  if ((await toggle.count()) === 0) return
  if ((await toggle.first().getAttribute('aria-expanded')) === 'true') return
  await toggle.first().click()
  await expect(toggle.first()).toHaveAttribute('aria-expanded', 'true')
}

async function openFolder(page: Page, mailboxId: string): Promise<void> {
  await folder(page, mailboxId).click()
  await expect(page.getByTestId('mail-list-section')).toBeVisible({ timeout: 30_000 })
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  await fs.mkdir(SHOT_DIR, { recursive: true })
  const port = await reservePort()
  child = spawn('./node_modules/.bin/tsx', ['tests/e2e/browser/mail-app-server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PW_MAIL_PORT: String(port),
      PW_MAIL_PROVIDER: '1',
      MAIL_FIXTURE_DENSE: '1',
      // Junk declares five figures of mail and holds none, which is the second empty state: a
      // folder that WAS polled and whose mail is all outside what the cache keeps.
      MAIL_FIXTURE_DEEP: '1',
      // The folder the server lists and refuses to open.
      MAIL_FIXTURE_COLD_FOLDER: '1',
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

test('one folder the server refuses does not starve the folders behind it', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto(`http://127.0.0.1:${fixture!.port}/`)
  await page.waitForLoadState('domcontentloaded')
  await expandSidebar(page)
  await page.getByTestId('sidebar-core-app-mail').click()
  // With no accounts the console is its empty state, not the three panes: the accounts pane only
  // exists once there is an account to draw in it.
  await expect(page.getByTestId('mail-app-empty')).toBeVisible({ timeout: 60_000 })
  await addAccount(page)
  await expect(page.getByTestId('mail-accounts-pane')).toBeVisible({ timeout: 60_000 })

  // `Aged` is the refused folder and it sorts FIRST among the non-inbox folders, so everything else
  // is queued behind it. Before the fix its refusal ended the sweep here and nothing below was ever
  // polled; the folders' own sizes still showed, because the mailbox LIST is a different request.
  await revealTail(page)
  await expect(folder(page, 'Aged')).toBeVisible({ timeout: 60_000 })

  // The inbox, which the sweep reaches before the refusal.
  await openFolder(page, 'INBOX')
  await expect(page.getByTestId('mail-row').first()).toBeVisible({ timeout: 60_000 })

  // And Archive, which is BEHIND the refusal in sweep order. This is the assertion the bug fails:
  // before the fix the sweep ended at `Aged`, so Archive was never polled and this pane was empty
  // under a header that still reported the folder's size. A named message rather than a count,
  // because what matters is that this folder's mail is here at all.
  await openFolder(page, 'Archive')
  await expect(page.getByTestId('mail-row').first()).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.mail-rows')).toContainText('boardwalk')
  await expect(page.getByTestId('mail-folder-unfetched')).toHaveCount(0)

  expect(pageErrors, 'no page errors while the folders load').toEqual([])
})

test('a folder that was never fetched says so, and offers to fetch it', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto(`http://127.0.0.1:${fixture!.port}/`)
  await page.waitForLoadState('domcontentloaded')
  await expandSidebar(page)
  await page.getByTestId('sidebar-core-app-mail').click()
  await expect(page.getByTestId('mail-accounts-pane')).toBeVisible({ timeout: 60_000 })

  await revealTail(page)
  await openFolder(page, 'Aged')

  // The header still reports the folder's real size, which is right: the mailbox list knows it.
  const section = page.getByTestId('mail-list-section')
  await expect(section).toContainText('Aged')
  await expect(section.locator('.mail-list-section-count')).toHaveText('1,962')

  // What must NOT be under it is the sentence that was there before. The console asks for the folder
  // by itself first (once per folder), so either state is a pass here as long as it is honest: the
  // fetch is in flight, or it failed, or the folder is waiting to be fetched.
  const honest = page.locator(
    '[data-testid="mail-folder-fetching"], [data-testid="mail-folder-fetch-failed"],'
    + ' [data-testid="mail-folder-unfetched"]',
  )
  await expect(honest.first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('mail-list-empty')).toHaveCount(0)

  // The automatic attempt hits the server's refusal, so it settles on the failure with a way back.
  const failed = page.getByTestId('mail-folder-fetch-failed')
  await expect(failed).toBeVisible({ timeout: 60_000 })
  // The server's own words, not a code: this is the whole reason the provider's message is carried.
  await expect(failed).toContainText('will not open')
  // On its own line, not run onto the end of Walnut's own sentence: a provider writes this text and
  // nothing can promise it starts with a capital letter.
  await expect(failed.locator('.mail-folder-detail')).toHaveCount(1)
  const retry = page.getByTestId('mail-folder-fetch')
  await expect(retry).toBeVisible()
  await page.locator('.mail-list-pane').screenshot({ path: `${SHOT_DIR}/never-fetched.png` })

  // Pressing it asks again rather than doing nothing, and lands on the same honest answer.
  await retry.click()
  await expect(failed).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('mail-list-empty')).toHaveCount(0)

  expect(pageErrors, 'no page errors on the unfetched folder').toEqual([])
})

test('a folder that was fetched and kept nothing says that, with its size', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${fixture!.port}/`)
  await page.waitForLoadState('domcontentloaded')
  await expandSidebar(page)
  await page.getByTestId('sidebar-core-app-mail').click()
  await expect(page.getByTestId('mail-accounts-pane')).toBeVisible({ timeout: 60_000 })

  // Junk is polled successfully and holds nothing, while declaring 45,231 messages: the shape of a
  // real folder whose mail is all older than the cache window. "No mail in this folder yet" over a
  // header reading 45,231 is the same contradiction the report was about, one step further along.
  await openFolder(page, 'Junk')

  const outside = page.getByTestId('mail-folder-outside-window')
  await expect(outside).toBeVisible({ timeout: 60_000 })
  await expect(outside).toContainText('45,231')
  // The sentence states what Walnut can SEE (fetched, holding none) and then the cache's rule. It
  // used to assert that all 45,231 were older than the window, which is a claim it cannot make.
  await expect(outside).toContainText('kept none of its 45,231 messages')
  await expect(page.getByTestId('mail-list-empty')).toHaveCount(0)
  // Nothing to fetch: it HAS been fetched, so there is no button offering to do it again.
  await expect(page.getByTestId('mail-folder-fetch')).toHaveCount(0)
  await page.locator('.mail-list-pane').screenshot({ path: `${SHOT_DIR}/outside-window.png` })
})
