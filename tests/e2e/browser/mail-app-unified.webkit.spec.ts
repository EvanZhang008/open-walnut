import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import { expect, test } from './shortcut-test-fixture'
import { type Locator, type Page } from '@playwright/test'

/**
 * The merged row's account label, measured in WebKit at the widths this console is actually used at.
 *
 * WebKit because the desktop app is a WKWebView, and this is a text-clipping rule: `text-overflow`
 * inside a flex row is exactly the family where Chromium and WebKit have disagreed here before (a
 * late scrollbar that does not reflow its ancestors, a flex item whose min-content wins). The slot
 * this label replaced printed a raw mailbox id, and one provider on the machine this fixture copies
 * answers with 90 character ids, so "it fits" has to be proved with a name that cannot fit.
 *
 * Three cases, all in one row:
 *   - 1280px, where the message column is 300px (the pane beside it is 204px, the everyday layout).
 *   - 1000px, where the console drills and the column is the whole window.
 *   - A name too long for either, written into the label, which is the only way to prove the
 *     ellipsis is doing work rather than the fixture's names simply being short.
 *
 * `test.use` pins the engine, and it only applies at the top level of a file, which is why this is
 * its own spec rather than a case inside mail-app-unified.spec.ts.
 */

const SHOT_DIR = '/tmp/mail-sidebar-ux/unified'
const A = 'dense:harbour'
const TAIL_MAILBOX = 'harbour/label/receipts'
/** As long as the longest mailbox id the dense fixture holds, so the clipping case is a real one. */
const TOO_LONG = 'Marina mail account for the north pontoon and the winter fuel dock roster note'

interface Fixture { port: number; home: string }

let child: ChildProcessWithoutNullStreams | null = null
let fixture: Fixture | null = null
let output = ''

test.describe.configure({ mode: 'serial' })
test.setTimeout(420_000)
test.use({ browserName: 'webkit', viewport: { width: 1280, height: 800 } })

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

test.beforeAll(async () => {
  test.setTimeout(300_000)
  await fs.mkdir(SHOT_DIR, { recursive: true })
  const port = await reservePort()
  child = spawn('./node_modules/.bin/tsx', ['tests/e2e/browser/mail-app-server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PW_MAIL_PORT: String(port), PW_MAIL_DENSE: '1', PW_MAIL_DIGEST_OFF: '1' },
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

test('really runs in WebKit', async ({ browserName }) => {
  expect(browserName).toBe('webkit')
})

async function openMergedInbox(page: Page): Promise<void> {
  await page.addInitScript(([accountId, mailboxId]) => {
    window.localStorage.setItem('walnut.mail.sidebar.v1', JSON.stringify({
      smart: {}, tail: {}, recent: {}, selected: { accountId, mailboxId },
    }))
  }, [A, TAIL_MAILBOX])
  await page.goto(`http://127.0.0.1:${fixture!.port}/`)
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 })
  if (await page.locator('.sidebar.collapsed').count()) {
    await page.locator('.sidebar-collapse-btn').click()
    await expect(page.locator('.sidebar.collapsed')).toHaveCount(0)
  }
  await page.getByTestId('sidebar-core-app-mail').click()
  await expect(page.getByTestId('mail-accounts-pane')).toContainText('Marina mail', { timeout: 90_000 })
  await page.locator('.mail-accounts-pane .mail-mailbox.smart[data-smart="inbox"]').click()
  await expect(page.getByTestId('mail-row').first()).toBeVisible({ timeout: 90_000 })
  await expect(page.getByTestId('mail-row-account').first()).toBeVisible({ timeout: 30_000 })
}

/** One line, inside its row, and no sideways scroll anywhere the row lives. */
async function pinLabel(page: Page, where: string): Promise<void> {
  const label = page.getByTestId('mail-row-account').first()
  const row = page.getByTestId('mail-row').first()
  const style = await label.evaluate((element) => {
    const computed = window.getComputedStyle(element)
    return {
      whiteSpace: computed.whiteSpace,
      textOverflow: computed.textOverflow,
      overflow: computed.overflowX,
      lines: element.getClientRects().length,
    }
  })
  expect(style.whiteSpace, `${where}: the account label never wraps`).toBe('nowrap')
  expect(style.textOverflow, `${where}: it ends in an ellipsis when it has to`).toBe('ellipsis')
  expect(style.overflow, `${where}: which needs its own overflow`).not.toBe('visible')
  expect(style.lines, `${where}: one line, one box`).toBe(1)

  const labelBox = await label.boundingBox()
  const rowBox = await row.boundingBox()
  expect(labelBox, `${where}: the label is laid out`).not.toBeNull()
  expect(rowBox, `${where}: so is its row`).not.toBeNull()
  expect(labelBox!.height, `${where}: one line high`).toBeLessThan(22)
  expect(labelBox!.x + labelBox!.width, `${where}: and inside its row`)
    .toBeLessThanOrEqual(rowBox!.x + rowBox!.width + 0.5)

  const overflowed = await page.locator('.mail-rows').evaluate(
    (element) => element.scrollWidth - element.clientWidth,
  )
  expect(overflowed, `${where}: the message column has no sideways scroll`).toBeLessThanOrEqual(1)
}

test('the account label stays one line at 1280px, at 1000px, and with a name that cannot fit', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const shots: string[] = []

  await openMergedInbox(page)

  // The everyday layout: the folder pane is 204px and the message column 300px (mail.css caps both
  // below 1360px), which is the tightest the label is ever asked to fit in normal use.
  const pane = await page.locator('.mail-accounts-pane').boundingBox()
  expect(pane!.width, 'the folder pane is the 204px baseline this was measured against')
    .toBeLessThanOrEqual(205)
  await pinLabel(page, 'at 1280px')
  shots.push(await shoot(page.locator('.mail-list-pane'), 'label-1280'))

  // A name too long for any column. Written into the DOM rather than into the fixture, because what
  // is being proved is the RULE: the fixture's real names are short enough to fit, so they can never
  // show whether this clips or pushes the time off the row.
  await page.getByTestId('mail-row-account').first().evaluate((element, text) => {
    element.textContent = text
  }, TOO_LONG)
  await pinLabel(page, 'with a name that cannot fit')
  const clipped = await page.getByTestId('mail-row-account').first().evaluate(
    (element) => element.scrollWidth - element.clientWidth,
  )
  expect(clipped, 'a name that cannot fit is clipped, not laid out past the row').toBeGreaterThan(0)
  // The time is still on the row's title line, which is what a pushed-out label would have taken.
  const time = page.locator('.mail-row').first().locator('.mail-row-time')
  await expect(time).toBeVisible()
  shots.push(await shoot(page.locator('.mail-list-pane'), 'label-too-long'))

  // The drill: one pane at a time, so the column is the whole window.
  await page.setViewportSize({ width: 1000, height: 800 })
  await expect(page.locator('.mail-console')).toHaveAttribute('data-narrow-pane', /list|accounts/, { timeout: 30_000 })
  if (await page.getByTestId('mail-row').first().isVisible() === false) {
    await page.locator('.mail-accounts-pane .mail-mailbox.smart[data-smart="inbox"]').click()
  }
  await expect(page.getByTestId('mail-row-account').first()).toBeVisible({ timeout: 30_000 })
  await pinLabel(page, 'at 1000px')
  shots.push(await shoot(page.locator('.mail-list-pane'), 'label-1000'))

  expect(pageErrors, 'the mail console must not throw in WebKit').toEqual([])
  console.log(`webkit label screenshots:\n${shots.join('\n')}`)
})

async function shoot(target: Locator | Page, step: string): Promise<string> {
  const path = `${SHOT_DIR}/webkit-${step}.png`
  await target.screenshot({ path })
  return path
}
