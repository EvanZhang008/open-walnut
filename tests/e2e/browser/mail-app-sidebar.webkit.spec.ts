import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import { expect, test, type Page } from '@playwright/test'

/**
 * The mail sidebar in WEBKIT, which is the engine the Mac app is.
 *
 * Engine-specific rather than a second pass of the same file, and every line of it is a failure this
 * repository has already shipped once: WebKit's always-on scrollbars take layout width from a 204px
 * column (a one-line row then has 15px of room for a 21px line), its late scrollbars do not reflow the
 * ancestors that were measured before they appeared, and a chevron drawn as a text glyph sits on a
 * baseline the two engines disagree about. The 58-row expand is here too, because a height transition
 * over that many rows is what makes WebKit repaint a whole subtree.
 *
 * Self-contained on purpose: a `test.use` browser pin only applies at the top level of its own spec
 * file, so the boot and the locators are duplicated rather than imported from the Chromium spec (that
 * import would also run its tests here).
 *
 * Screenshots land in /tmp/mail-sidebar-ux/sidebar-webkit/.
 */

const SHOT_DIR = '/tmp/mail-sidebar-ux/sidebar-webkit'
const HARBOUR = 'dense:harbour'
const MARINA = 'dense:marina'

test.use({ browserName: 'webkit', viewport: { width: 1280, height: 800 } })
test.describe.configure({ mode: 'serial' })
test.setTimeout(420_000)

let child: ChildProcessWithoutNullStreams | null = null
let output = ''
let fixture: { port: number, home: string } | null = null

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

function waitForReady(): Promise<{ port: number, home: string }> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error(`Mail fixture did not start\n${output.slice(-8000)}`)),
      180_000,
    )
    const timer = setInterval(() => {
      const match = /MAIL_FIXTURE_READY (\{.*\})/.exec(output)
      if (match) {
        clearInterval(timer)
        clearTimeout(deadline)
        resolve(JSON.parse(match[1]!) as { port: number, home: string })
        return
      }
      if (child?.exitCode !== null && child?.exitCode !== undefined) {
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

const PANE = '.mail-accounts-pane'

async function openMail(page: Page): Promise<void> {
  await page.goto(`http://127.0.0.1:${fixture!.port}/`)
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 })
  if (await page.locator('.sidebar.collapsed').count()) {
    await page.locator('.sidebar-collapse-btn').click()
    await expect(page.locator('.sidebar.collapsed')).toHaveCount(0)
  }
  await page.getByTestId('sidebar-core-app-mail').click()
  await expect(page.locator(PANE)).toBeVisible({ timeout: 90_000 })
}

test('really runs in WebKit', async ({ browserName }) => {
  expect(browserName).toBe('webkit')
})

test('nothing scrolls sideways and nothing wraps, at 1280 and at 1000', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await openMail(page)
  await expect(page.locator(`${PANE} .mail-tail-toggle[data-account-id="${HARBOUR}"]`))
    .toBeVisible({ timeout: 90_000 })
  // Open a group and the tail, so the widest rows this pane can hold are on screen while it is measured.
  await page.locator(`${PANE} .mail-twist[data-smart="inbox"]`).click()
  await expect(page.getByTestId('mail-smart-children')).toHaveCount(1)

  const shots: string[] = []
  for (const width of [1280, 1000]) {
    await page.setViewportSize({ width, height: 800 })
    if (width === 1000) {
      // One pane at a time below 1100px: the folder list is reached through the list's own control.
      await page.getByTestId('mail-show-mailboxes').click()
    }
    await expect(page.locator(`${PANE} .mail-mailbox.smart[data-smart="inbox"]`)).toBeVisible()

    const overflow = await page.evaluate(() => {
      const pane = document.querySelector('.mail-accounts-pane') as HTMLElement
      const scroll = document.querySelector('.mail-accounts-scroll') as HTMLElement
      const rows = Array.from(document.querySelectorAll(
        '.mail-accounts-pane .mail-mailbox, .mail-accounts-pane .mail-tail-row',
      )) as HTMLElement[]
      // EVERY row is one line, the collapse row included. It used to be allowed a second line for its
      // unread clause, which made it 45px tall in WebKit against 31px for its neighbours, with two type
      // sizes in it and the chevron against the second line. Both facts now fit one line, because the
      // second clause is a folder count rather than a mail count and gives up its preposition ("6 unread",
      // not "6 with unread"), which is what the measured 154px text slot at a 204px pane can hold.
      const tall = rows
        .filter((row) => row.getBoundingClientRect().height > 34)
        .map((row) => `${row.textContent?.trim()}: ${Math.round(row.getBoundingClientRect().height)}px`)
      const names = Array.from(document.querySelectorAll(
        '.mail-accounts-pane .mail-mailbox-name, .mail-accounts-pane .mail-tail-label,'
        + ' .mail-accounts-pane .mail-tail-unread',
      )) as HTMLElement[]
      // The gap between the two clauses of the collapse row, which is a layout fact rather than a
      // trailing space inside an inline box (WebKit drops that one too).
      const clauses = Array.from(document.querySelectorAll(
        '.mail-accounts-pane .mail-tail-toggle .mail-tail-unread',
      )) as HTMLElement[]
      const gaps = clauses.map((clause) => {
        const label = clause.previousElementSibling as HTMLElement | null
        if (!label) return -1
        return Math.round(clause.getBoundingClientRect().left - label.getBoundingClientRect().right)
      })
      const wrapped = names
        .filter((name) => name.getBoundingClientRect().height > 22)
        .map((name) => name.textContent?.trim() ?? '')
      // Nothing is cut off horizontally either, clause by clause.
      const cut = names
        .filter((name) => name.scrollWidth - name.clientWidth > 1)
        .map((name) => name.textContent?.trim() ?? '')
      return {
        paneSideways: pane.scrollWidth - pane.clientWidth,
        scrollSideways: scroll.scrollWidth - scroll.clientWidth,
        clipped: rows.filter((row) => row.scrollWidth - row.clientWidth > 1).length,
        tall,
        wrapped,
        cut,
        gaps,
      }
    })
    expect(overflow.paneSideways, `no sideways scroll at ${width}`).toBeLessThanOrEqual(1)
    expect(overflow.scrollSideways, `no sideways scroll in the list at ${width}`).toBeLessThanOrEqual(1)
    expect(overflow.clipped, `no row clips its own content at ${width}`).toBe(0)
    expect(overflow.tall, `every row is one line at ${width}`).toEqual([])
    expect(overflow.wrapped, `no name or label wraps at ${width}`).toEqual([])
    expect(overflow.cut, `no name or clause is cut off at ${width}`).toEqual([])
    expect(overflow.gaps.length, `the collapse row still says what it hides at ${width}`)
      .toBeGreaterThan(0)
    expect(overflow.gaps.every((gap) => gap >= 2), `a real gap after the comma at ${width}`).toBe(true)
    shots.push(`${SHOT_DIR}/webkit-${width}.png`)
    await page.locator(PANE).screenshot({ path: `${SHOT_DIR}/webkit-${width}.png` })
  }
  expect(pageErrors).toEqual([])
  console.log(`webkit sidebar screenshots:\n${shots.join('\n')}`)
})

test('the chevron rotates, the rows do not animate, and 58 of them open at once', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await openMail(page)
  const twist = page.locator(`${PANE} .mail-twist[data-smart="inbox"]`)
  await expect(twist).toBeVisible({ timeout: 90_000 })

  // Closed it points right (no transform), open it points down (a quarter turn). An inline SVG, so
  // the mark is the same size and on the same line in both engines.
  const closed = await twist.locator('svg').evaluate((el) => getComputedStyle(el).transform)
  expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(closed)
  await twist.click()
  await expect(twist).toHaveAttribute('aria-expanded', 'true')
  // Polled rather than read once: the 120ms rotate is the only animation in this pane, so the matrix
  // right after the click is still the identity one. It has to ARRIVE at a quarter turn.
  await expect.poll(async () => twist.locator('svg').evaluate((el) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(el).transform)
    return [matrix.a, matrix.b, matrix.c, matrix.d].map((one) => Math.round(one)).join(',')
  }), { timeout: 3_000, message: 'a quarter turn' }).toBe('0,1,-1,0')

  // No height animation anywhere in this pane: expanding is navigation and has to be readable at once.
  const animated = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll(
      '.mail-accounts-pane ul, .mail-accounts-pane li, .mail-accounts-pane .mail-mailbox,'
      + ' .mail-accounts-pane .mail-tail-toggle, .mail-accounts-scroll',
    )) as HTMLElement[]
    return nodes
      .map((node) => getComputedStyle(node).transitionProperty)
      .filter((property) => /height/.test(property))
  })
  expect(animated, 'no height or max-height transition').toEqual([])

  const openedIn = await page.evaluate(async (accountId) => {
    const button = document.querySelector(`.mail-tail-toggle[data-account-id="${accountId}"]`)
    if (!(button instanceof HTMLElement)) throw new Error('the collapse row must be on screen')
    const list = button.closest('ul')!
    const started = performance.now()
    button.click()
    for (let tick = 0; tick < 60; tick += 1) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
      if (list.querySelectorAll('.mail-mailbox').length >= 60) return performance.now() - started
    }
    throw new Error('the tail never opened')
  }, HARBOUR)
  expect(openedIn, 'WebKit opens 58 rows immediately').toBeLessThan(200)

  // And the other account's own row is still there with the tail open. Scoped to its SECTION: the
  // expanded smart group holds a child row carrying the same account and the same mailbox id.
  await expect(page.locator(
    `${PANE} .mail-account[data-account-id="${MARINA}"] .mail-mailbox[data-mailbox-id="inbox"]`,
  )).toHaveCount(1)
  await page.locator(PANE).screenshot({ path: `${SHOT_DIR}/webkit-expanded.png` })
})
