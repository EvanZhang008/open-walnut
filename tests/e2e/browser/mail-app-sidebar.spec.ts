import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import { expect, test } from './shortcut-test-fixture'
import { type Locator, type Page } from '@playwright/test'

/**
 * The mail sidebar at production density: the smart mailbox group, the collapsed long tail, and the
 * geometry both of them are judged on.
 *
 * Graded against the DENSE fixture (two accounts, 64 folders against 6, the same roles under different
 * mailbox ids, six labels holding stale unread) because every claim this slice makes is only interesting
 * at that density: a pane with four folders collapses nothing, and a fixture where one inbox has all the
 * unread cannot show a badge disagreeing with a header.
 *
 * What is pinned here:
 *   a. THE SINGLE ACCOUNT INSTALL IS UNTOUCHED. No smart list, no group title, no hairline, no collapse
 *      row, the same rows in the same order, and the scroll container's padding unchanged. Everyone who
 *      has one account gets today's pane, to the DOM.
 *   b. THE COLLAPSED PANE FITS. Seven rows for the 64-folder account, six for the other, three smart
 *      rows and a group title: both inboxes are on screen at 1280x800 with the pane at its usual 204px.
 *   c. THE COLLAPSE ROW IS HONEST. `58 more folders, 6 with unread` on ONE line, never a badge, and the six labels
 *      holding months-old unread stay down there rather than moving in permanently.
 *   d. A PROMOTION NEVER MOVES A ROW UNDER THE POINTER. Mail arriving in a collapsed folder lifts it
 *      out, but the insertion waits until the pointer leaves the pane.
 *   e. THE HIERARCHY IS MEASURED FROM THE PANE'S OWN EDGE, not eyeballed and not per list: 35px for a
 *      smart parent, 51px for its children, 35px for an ordinary folder row and for the collapse row, at
 *      both pane widths in both themes. Per-list numbers hid that the two lists are inset differently,
 *      which is how a parent ended up 3px LEFT of the rows it aggregates with children 8px inside it.
 *
 * Screenshots land in /tmp/mail-sidebar-ux/sidebar/<engine>-<theme>-<step>.png. WebKit has its own file
 * (mail-app-sidebar.webkit.spec.ts): a `test.use` pin only applies at a spec file's top level.
 */

const SHOT_DIR = '/tmp/mail-sidebar-ux/sidebar'

/** Account ids and one folder id of the dense fixture. Invented names, nothing resolves. */
const HARBOUR = 'dense:harbour'
const MARINA = 'dense:marina'
const TAIL_FOLDER = 'harbour/label/receipts'

/** The pane is 204px at 1280 wide and 232px above 1360, and both widths are graded. */
const NARROW_COLUMN = { width: 1280, height: 800 }
const WIDE_COLUMN = { width: 1440, height: 900 }

interface Fixture {
  port: number
  home: string
}

test.setTimeout(420_000)
test.use({ viewport: NARROW_COLUMN })

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

/** One fixture server with a throwaway home, and the handle that stops it. */
class FixtureServer {
  child: ChildProcessWithoutNullStreams | null = null
  output = ''
  fixture: Fixture | null = null

  async start(env: Record<string, string>): Promise<Fixture> {
    const port = await reservePort()
    this.child = spawn('./node_modules/.bin/tsx', ['tests/e2e/browser/mail-app-server.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, PW_MAIL_PORT: String(port), PW_MAIL_DIGEST_OFF: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child.stdout.on('data', (chunk) => { this.output = `${this.output}${String(chunk)}`.slice(-20_000) })
    this.child.stderr.on('data', (chunk) => { this.output = `${this.output}${String(chunk)}`.slice(-20_000) })
    this.fixture = await this.waitForReady()
    return this.fixture
  }

  private waitForReady(): Promise<Fixture> {
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error(`Mail fixture did not start\n${this.output.slice(-8000)}`)),
        180_000,
      )
      const timer = setInterval(() => {
        const match = /MAIL_FIXTURE_READY (\{.*\})/.exec(this.output)
        if (match) {
          clearInterval(timer)
          clearTimeout(deadline)
          resolve(JSON.parse(match[1]!) as Fixture)
          return
        }
        if (this.child?.exitCode !== null && this.child?.exitCode !== undefined) {
          clearInterval(timer)
          clearTimeout(deadline)
          reject(new Error(`Mail fixture exited early (${this.child.exitCode})\n${this.output.slice(-8000)}`))
        }
      }, 250)
    })
  }

  async stop(): Promise<void> {
    if (this.child) {
      this.child.kill('SIGTERM')
      const deadline = Date.now() + 15_000
      while (this.child.exitCode === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      if (this.child.exitCode === null) this.child.kill('SIGKILL')
    }
    if (this.fixture?.home.includes('walnut-mail-app-')) {
      await fs.rm(this.fixture.home, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

async function expandSidebar(page: Page): Promise<void> {
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 })
  if (await page.locator('.sidebar.collapsed').count()) {
    await page.locator('.sidebar-collapse-btn').click()
    await expect(page.locator('.sidebar.collapsed')).toHaveCount(0)
  }
}

/** Open Mail the way a person does: load the app, then click the rail row. */
async function openMail(page: Page, port: number): Promise<void> {
  await page.goto(`http://127.0.0.1:${port}/`)
  await page.waitForLoadState('domcontentloaded')
  await expandSidebar(page)
  await page.getByTestId('sidebar-core-app-mail').click()
}

/** Switch the theme the way the app does: Settings, the picker, back to Mail. */
async function pickTheme(page: Page, label: 'Light' | 'Dark'): Promise<void> {
  await page.getByTestId('sidebar-core-app-settings').click()
  const option = page.locator('.theme-picker-btn', { hasText: label }).first()
  await expect(option).toBeVisible({ timeout: 30_000 })
  await option.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', label.toLowerCase(), { timeout: 15_000 })
  await page.getByTestId('sidebar-core-app-mail').click()
  await expect(page.getByTestId('mail-app')).toBeVisible({ timeout: 30_000 })
}

const PANE = '.mail-accounts-pane'

function smartRow(page: Page, role: string): Locator {
  return page.locator(`${PANE} .mail-mailbox.smart[data-smart="${role}"]`)
}

function twist(page: Page, role: string): Locator {
  return page.locator(`${PANE} .mail-twist[data-smart="${role}"]`)
}

function tailToggle(page: Page, accountId: string): Locator {
  return page.locator(`${PANE} .mail-tail-toggle[data-account-id="${accountId}"]`)
}

/**
 * One folder row inside its ACCOUNT's section.
 *
 * Scoped to the section on purpose: an expanded smart group holds a child row carrying the same account
 * and the same mailbox id, and an unscoped locator matches both.
 */
function folderRow(page: Page, accountId: string, mailboxId: string): Locator {
  return page.locator(
    `${PANE} .mail-account[data-account-id="${accountId}"] .mail-mailbox[data-mailbox-id="${mailboxId}"]`,
  )
}

function section(page: Page, accountId: string): Locator {
  return page.locator(`${PANE} .mail-account[data-account-id="${accountId}"]`)
}

/** Every clickable row of one account's list, in DOM order. */
async function rowNames(page: Page, accountId: string): Promise<string[]> {
  return section(page, accountId).locator('.mail-mailbox .mail-mailbox-name').allInnerTexts()
}

/**
 * How far a row's TEXT starts from the PANE's own left edge.
 *
 * Measured against the pane rather than against each row's own `ul`, and that is the whole point: the
 * per-list numbers agreed with each other while hiding that the two lists are inset differently, so a
 * pane whose smart parent sat 3px LEFT of the folder rows it aggregates measured as a clean 28/31. A
 * person scans one column, so the numbers have to come from one origin.
 */
async function textLeft(row: Locator): Promise<number> {
  return row.evaluate((element) => {
    const name = element.querySelector('.mail-mailbox-name, .mail-tail-label') as HTMLElement | null
    const pane = element.closest('.mail-accounts-pane') as HTMLElement | null
    if (!name || !pane) throw new Error('a sidebar row must carry a name inside the pane')
    return Math.round(name.getBoundingClientRect().left - pane.getBoundingClientRect().left)
  })
}

async function shoot(target: Locator | Page, theme: string, step: string): Promise<string> {
  const path = `${SHOT_DIR}/${test.info().project.name}-${theme}-${step}.png`
  await target.screenshot({ path })
  return path
}

/**
 * The role rows, by the ROLE's name rather than the provider's (F16): one account here answers the raw
 * identifier `INBOX` and the other `Inbox` for the same folder, directly under a group naming the same
 * roles uniformly. The provider's own name stays on hover.
 */
/**
 * The role rows, by the PROVIDER's own name and in the SERVER's order (round 3, N10 and C9): relabelling
 * them to canonical role names left the real name reachable only on hover, invisible to the tail filter,
 * and re-ordered the rows of every install. The role is on the row as its glyph.
 */
const ROLE_ROWS = ['INBOX', 'Archive', 'Drafts', 'Sent', 'Spam', 'Trash']
/** The other account's own six, in its own server order (its names sort Bin before Drafts). */
const ROLE_ROWS_MARINA = ['Inbox', 'Archived', 'Bin', 'Drafts', 'Junk', 'Sent Mail']

/**
 * Drop the transport stubs before the page goes away.
 *
 * Several cases below reach their state by rewriting an answer at the transport, and the console keeps
 * POLLING those endpoints: a handler can be inside `route.fetch()` when the test ends, the page closes
 * under it, and the throw fails a test whose every assertion has already passed. Playwright suggests
 * exactly this. One hook rather than a line per case, so a new stub cannot forget it.
 */
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test.describe('the dense pane', () => {
  const server = new FixtureServer()
  let port = 0

  test.beforeAll(async () => {
    test.setTimeout(300_000)
    await fs.mkdir(SHOT_DIR, { recursive: true })
    const fixture = await server.start({ PW_MAIL_DENSE: '1' })
    port = fixture.port
  })

  test.afterAll(async () => { await server.stop() })

  test('collapsed, honest, and measured in both themes at both column widths', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await openMail(page, port)
    await expect(page.locator(PANE)).toBeVisible({ timeout: 90_000 })
    await expect(folderRow(page, MARINA, 'inbox')).toBeVisible({ timeout: 90_000 })

    // The group names itself, on one line, so three rows above two accounts do not read as a third.
    const head = page.getByTestId('mail-smart-head')
    await expect(head).toHaveText('Smart mailboxes')
    // One LINE, proven against its own line box rather than against a pixel guess, and not a
    // character of it cut off at 204px.
    const lines = await head.evaluate((el) => {
      const style = getComputedStyle(el)
      const content = el.clientHeight
        - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom)
      return Math.round(content / Number.parseFloat(style.lineHeight))
    })
    expect(lines, 'the group title stays on one line').toBe(1)
    expect(await head.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)

    await expect(page.getByTestId('mail-smart')).toHaveAttribute('aria-label', 'Smart mailboxes')
    await expect(smartRow(page, 'inbox')).toHaveAttribute('title', "Every account's inbox in one list")
    await expect(smartRow(page, 'sent')).toHaveAttribute('title', "Every account's sent mail in one list")
    await expect(smartRow(page, 'drafts')).toHaveAttribute('title', "Every account's drafts in one list")
    // Two accounts, three rows, and the badge is the exact sum of the two inbox rows (0 and 7).
    await expect(smartRow(page, 'inbox').getByTestId('mail-smart-unread')).toHaveText('7')
    await expect(smartRow(page, 'inbox')).toHaveAttribute('aria-current', 'true')
    await expect(page.getByTestId('mail-smart-children')).toHaveCount(0)
    for (const role of ['inbox', 'sent', 'drafts']) {
      await expect(twist(page, role)).toHaveAttribute('aria-expanded', 'false')
    }

    // The 64-folder account: its six role rows and nothing else, and one row standing for the rest.
    expect(await rowNames(page, HARBOUR), 'the roles only, in SERVER order').toEqual(ROLE_ROWS)
    const tail = tailToggle(page, HARBOUR)
    await expect(tail).toHaveText('58 more folders, 6 with unread')
    await expect(tail).toHaveAttribute('aria-expanded', 'false')
    await expect(tail).toHaveAttribute(
      'title',
      'Folders you have not opened lately. Anything that just received mail is above this line.'
      + ' 6 of them hold unread mail (200 messages).',
    )
    // Both clauses count FOLDERS (6 of the 58 hold unread), and the unread MAIL rides along on the row for
    // a test to check against the hidden set, with its unit named in the hover text. The row printed the
    // mail count once: two clauses in one comma-separated sentence are read in the unit of the first word,
    // so "58 folders, 200 unread" said 200 folders while the element's own title said 6.
    await expect(tail).toHaveAttribute('data-hidden-unread', '200')
    await expect(tail).toHaveAttribute('data-hidden-unread-folders', '6')
    // Never a badge on this row: the number it prints counts FOLDERS.
    await expect(tail.locator('.mail-unread-badge')).toHaveCount(0)
    // And the sentence is READABLE, not merely present in the DOM: ONE line, both clauses whole, and a
    // real gap between them. A trailing space inside the label is dropped in layout, so the row used to
    // render "58 more folders,6 with unread" at every width where it fitted, with `textContent` still
    // holding the space so no DOM assertion could see it.
    const clauses = await tail.evaluate((el) => {
      const style = getComputedStyle(el)
      const box = el.getBoundingClientRect()
      const right = box.right - Number.parseFloat(style.paddingRight)
      const spans = Array.from(el.querySelectorAll('.mail-tail-label, .mail-tail-unread'))
      return spans.map((span, at) => ({
        text: span.textContent?.trim() ?? '',
        cut: span.scrollWidth - span.clientWidth,
        overflows: span.getBoundingClientRect().right > right + 0.5,
        gap: at === 0 ? 0 : Math.round(
          span.getBoundingClientRect().left - spans[at - 1]!.getBoundingClientRect().right,
        ),
      }))
    })
    expect(clauses.map((one) => one.text)).toEqual(['58 more folders,', '6 with unread'])
    expect(clauses.every((one) => one.cut <= 1 && !one.overflows), 'both clauses are fully on screen')
      .toBe(true)
    expect(clauses[1]!.gap, 'a real gap after the comma, at this width').toBeGreaterThanOrEqual(2)
    // The six labels holding months-old unread stay down there rather than moving in permanently.
    await expect(page.locator(`${PANE} [data-promoted="true"]`)).toHaveCount(0)

    // The 6-folder account: the same rows IN THE SAME ORDER, no tail at all. Its provider names them so
    // that the server's own order (inbox first, then by name) hands them over as inbox, archive, trash,
    // drafts, spam, sent, and two adjacent six row lists in two orders cost a re-read on every scan.
    expect(await rowNames(page, MARINA)).toEqual(ROLE_ROWS_MARINA)
    await expect(tailToggle(page, MARINA)).toHaveCount(0)

    const rows = await page.locator(`${PANE} .mail-mailbox, ${PANE} .mail-tail-toggle`).count()
    expect(rows, 'the whole collapsed pane').toBeLessThanOrEqual(22)
    expect(await section(page, HARBOUR).locator('.mail-mailbox, .mail-tail-toggle').count())
      .toBeLessThanOrEqual(10)

    // BOTH INBOXES on screen without scrolling, at the pane's everyday width. That is the claim worth
    // holding: what sits below the second account's inbox (its Spam, its Trash) may well need a scroll,
    // and demanding the whole list fit would be a stricter promise than the pane can keep in 800px.
    const reach = await page.evaluate(() => {
      const scroll = document.querySelector('.mail-accounts-scroll') as HTMLElement
      const box = scroll.getBoundingClientRect()
      const inboxes = Array.from(document.querySelectorAll(
        '.mail-accounts-pane .mail-account .mail-mailbox[data-mailbox-id="INBOX"],'
        + ' .mail-accounts-pane .mail-account .mail-mailbox[data-mailbox-id="inbox"]',
      )) as HTMLElement[]
      return {
        scrolled: scroll.scrollTop,
        overflow: scroll.scrollHeight - scroll.clientHeight,
        visible: inboxes.length > 0 && inboxes.every((row) => {
          const rect = row.getBoundingClientRect()
          return rect.top >= box.top - 0.5 && rect.bottom <= box.bottom + 0.5
        }),
        count: inboxes.length,
      }
    })
    expect(reach.count, 'one inbox row per account').toBe(2)
    expect(reach.scrolled, 'nothing has been scrolled').toBe(0)
    expect(reach.visible, 'both inboxes are on screen at 1280x800 without scrolling').toBe(true)
    console.log(`collapsed pane overflow at 1280x800: ${reach.overflow}px`)

    const shots: string[] = []
    const measured: string[] = []
    for (const theme of ['light', 'dark'] as const) {
      await pickTheme(page, theme === 'light' ? 'Light' : 'Dark')
      for (const [label, size] of [['204px', NARROW_COLUMN], ['232px', WIDE_COLUMN]] as const) {
        await page.setViewportSize(size)
        await expect(smartRow(page, 'inbox')).toBeVisible()
        const paneWidth = Math.round((await page.locator(PANE).boundingBox())!.width)
        expect(String(paneWidth), 'the column width this measurement belongs to').toBe(label.replace('px', ''))
        await twist(page, 'inbox').click()
        const child = page.locator(`${PANE} [data-testid="mail-smart-child"][data-account-id="${MARINA}"]`)
        await expect(child).toBeVisible()
        // The child names an account, and its full address is the only thing that tells two similar
        // display names apart once 124px has cut them.
        await expect(child).toHaveAttribute('title', 'marina@example.invalid')
        const edges = {
          parent: await textLeft(smartRow(page, 'inbox')),
          child: await textLeft(child),
          folder: await textLeft(folderRow(page, HARBOUR, 'INBOX')),
          tail: await textLeft(tailToggle(page, HARBOUR)),
        }
        // The box model IS the hierarchy: the group entry is leftmost (a 20px chevron and nothing else),
        // an ordinary folder sits 3px right of it (a 15px glyph and a 4px gap), a child is 18px inside its
        // parent, and the collapse row belongs to the whole list so it shares the parent's column. All
        // four used to be 35px, which read as three folders of one list, one of them missing its icon.
        expect(edges, `text left edges at ${label} in ${theme}`)
          .toEqual({ parent: 28, child: 46, folder: 31, tail: 28 })
        measured.push(`${theme} ${label}: ${JSON.stringify(edges)}`)
        shots.push(await shoot(page.locator(PANE), theme, `dense-${label}`))
        await twist(page, 'inbox').click()
        await expect(page.getByTestId('mail-smart-children')).toHaveCount(0)
      }
    }
    await page.setViewportSize(NARROW_COLUMN)
    await pickTheme(page, 'Light')

    expect(pageErrors, 'the pane must not throw in the browser').toEqual([])
    console.log(`sidebar measurements:\n${measured.join('\n')}\nscreenshots:\n${shots.join('\n')}`)
  })

  test('the chevron opens the group and changes nothing else', async ({ page }) => {
    const calls: string[] = []
    page.on('request', (request) => {
      if (request.url().includes('/api/plugins/mail/')) calls.push(request.url())
    })
    await openMail(page, port)
    await expect(smartRow(page, 'inbox')).toHaveAttribute('aria-current', 'true', { timeout: 90_000 })

    // A real folder first, so the mutual exclusion has something to give up.
    await folderRow(page, MARINA, 'inbox').click()
    await expect(folderRow(page, MARINA, 'inbox')).toHaveAttribute('aria-current', 'true')
    await expect(smartRow(page, 'inbox')).not.toHaveAttribute('aria-current', 'true')

    // Only the group opens: no selection change, and not one request.
    await page.waitForTimeout(1_500)
    calls.length = 0
    await twist(page, 'sent').click()
    await expect(page.getByTestId('mail-smart-children')).toHaveCount(1)
    await expect(folderRow(page, MARINA, 'inbox')).toHaveAttribute('aria-current', 'true')
    await page.waitForTimeout(1_000)
    expect(calls, 'a chevron asks the server for nothing').toEqual([])

    // The row itself selects, and exactly one row in the pane is current.
    await smartRow(page, 'inbox').click()
    await expect(smartRow(page, 'inbox')).toHaveAttribute('aria-current', 'true')
    await expect(page.locator(`${PANE} [aria-current="true"]`)).toHaveCount(1)

    // Keyboard: ArrowRight opens, ArrowLeft closes, a second ArrowRight does nothing, Enter selects.
    await twist(page, 'sent').click()
    await expect(page.getByTestId('mail-smart-children')).toHaveCount(0)
    await smartRow(page, 'drafts').focus()
    await page.keyboard.press('ArrowRight')
    await expect(twist(page, 'drafts')).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('ArrowRight')
    await expect(twist(page, 'drafts')).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('ArrowLeft')
    await expect(twist(page, 'drafts')).toHaveAttribute('aria-expanded', 'false')
    await expect(smartRow(page, 'drafts')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(smartRow(page, 'drafts')).toHaveAttribute('aria-current', 'true')
    // The chevron is its own tab stop, and Tab reaches it before its row.
    await tailToggle(page, HARBOUR).focus()
    await page.keyboard.press('ArrowRight')
    await expect(tailToggle(page, HARBOUR)).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('ArrowLeft')
    await expect(tailToggle(page, HARBOUR)).toHaveAttribute('aria-expanded', 'false')
  })

  test('on a narrow viewport the chevron does not drill, the row does', async ({ page }) => {
    // Opened wide and then narrowed, which is also how a person meets this: the app shell hides its
    // own rail below 1000px, so the rail row has to be clicked before the window shrinks.
    await openMail(page, port)
    await expect(page.locator(PANE)).toBeVisible({ timeout: 90_000 })
    await page.setViewportSize({ width: 980, height: 800 })
    // A narrow window shows ONE pane, and something is always selected, so the folder list is reached
    // through the list's own control.
    await expect(page.getByTestId('mail-message-list')).toBeVisible({ timeout: 90_000 })
    await page.getByTestId('mail-show-mailboxes').click()
    await expect(smartRow(page, 'inbox')).toBeVisible({ timeout: 30_000 })

    await twist(page, 'inbox').click()
    await expect(page.getByTestId('mail-smart-children')).toHaveCount(1)
    await expect(smartRow(page, 'inbox'), 'a chevron never drills into the list').toBeVisible()

    await smartRow(page, 'inbox').click()
    await expect(page.getByTestId('mail-message-list')).toBeVisible({ timeout: 30_000 })
    await expect(smartRow(page, 'inbox')).toBeHidden()
  })

  test('the 58 row tail opens as one list, filters by name, and forgets the filter', async ({ page }) => {
    await openMail(page, port)
    const tail = tailToggle(page, HARBOUR)
    await expect(tail).toBeVisible({ timeout: 90_000 })

    // Expanding is navigation, so it has to be immediate: no height animation anywhere, and the rows
    // are interactive in the frame after the click. Measured in the page, so no driver latency is in it.
    const openedIn = await page.evaluate(async (accountId) => {
      const button = document.querySelector(`.mail-tail-toggle[data-account-id="${accountId}"]`)
      if (!(button instanceof HTMLElement)) throw new Error('the collapse row must be on screen')
      const list = button.closest('ul')!
      const started = performance.now()
      button.click()
      for (let tick = 0; tick < 60; tick += 1) {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
        const rows = list.querySelectorAll('.mail-mailbox').length
        if (rows >= 60) return performance.now() - started
      }
      throw new Error('the tail never opened')
    }, HARBOUR)
    expect(openedIn, 'expanding 58 rows is immediate').toBeLessThan(200)

    await expect(tail).toHaveText('Show fewer folders')
    await expect(tail).toHaveAttribute('aria-expanded', 'true')
    await expect(tail).toHaveAttribute('title', 'Hide the folders you have not opened lately.')
    await expect(tail.locator('.mail-unread-badge')).toHaveCount(0)

    // ONE list: the role rows, a repeat of the collapse control (the way back from a 58 row tail, whose
    // end is 1,860px below its start), the filter, then every ordinary label exactly once in server order
    // with no promoted block punching holes, and the collapse row ITSELF as the last li.
    const shape = await section(page, HARBOUR).locator('ul.mail-mailboxes').evaluate((list) => (
      Array.from(list.children).map((li) => {
        if (li.querySelector('.mail-tail-toggle')) return 'tail'
        if (li.querySelector('.mail-tail-head')) return 'head'
        if (li.querySelector('.mail-tail-filter')) return 'filter'
        if (li.classList.contains('mail-tail-empty')) return 'empty'
        const row = li.querySelector('.mail-mailbox')
        return `row:${row?.querySelector('.mail-mailbox-name')?.textContent ?? ''}:${row?.getAttribute('data-promoted') ?? ''}`
      })
    ))
    expect(shape.slice(0, 8)).toEqual([
      ...ROLE_ROWS.map((name) => `row:${name}:`), 'head', 'filter',
    ])
    expect(shape[shape.length - 1], 'the collapse row is the last li').toBe('tail')
    const labels = shape.slice(8, -1)
    expect(labels, 'every ordinary label, once').toHaveLength(58)
    expect(labels.every((one) => one.endsWith(':')), 'no promotion inside the expanded list').toBe(true)
    const names = labels.map((one) => one.slice(4, -1))
    expect(new Set(names).size, 'no repeated row').toBe(58)
    expect([...names].sort((a, b) => a.localeCompare(b)), 'server order, no gaps').toEqual(names)

    // The filter is how a person reaches one of 58 labels without scanning for it. It filters the ORDINARY
    // LABELS and nothing else: applied to the whole section it deleted this account's Inbox, Drafts, Sent,
    // Junk and Trash on the second keystroke, and took the selected row's highlight with them.
    const filter = page.getByTestId('mail-tail-filter')
    await filter.fill('recei')
    await expect(section(page, HARBOUR).locator(`.mail-mailbox[data-mailbox-id="${TAIL_FOLDER}"]`)).toHaveCount(1)
    expect(await rowNames(page, HARBOUR), 'the role rows stay pinned').toEqual([...ROLE_ROWS, 'Receipts'])
    await filter.fill('nothing matches this')
    await expect(page.getByTestId('mail-tail-empty')).toHaveText('No folder matches that.')
    // The sentence describes the TAIL, which is what the box filters: the role rows are still there.
    expect(await rowNames(page, HARBOUR), 'and a zero hit hides no mailbox').toEqual(ROLE_ROWS)
    await expect(filter, 'a zero hit keeps what was typed').toHaveValue('nothing matches this')

    // Collapsing forgets it: a filter is a way through a list, not a preference.
    await tail.click()
    await expect(page.getByTestId('mail-tail-filter')).toHaveCount(0)
    await tail.click()
    await expect(page.getByTestId('mail-tail-filter')).toHaveValue('')
  })

  test('a tail with no unread in it says nothing about unread', async ({ page }) => {
    // The second clause is driven by the LIVE folder counts, so zeroing them at the transport is the
    // honest way to reach the case this fixture has no folder for: 58 quiet labels.
    await page.route((url) => (
      url.pathname.endsWith('/mailboxes') && url.searchParams.get('account') === HARBOUR
    ), async (route) => {
      const answer = await route.fetch()
      const body = await answer.json() as { mailboxes: Array<{ role: string, unread: number }> }
      for (const row of body.mailboxes) if (row.role === 'other') row.unread = 0
      await route.fulfill({ response: answer, json: body })
    })
    await openMail(page, port)
    const tail = tailToggle(page, HARBOUR)
    await expect(tail).toBeVisible({ timeout: 90_000 })
    await expect(tail, 'no unread hidden means no second clause').toHaveText('58 more folders')
    await expect(tail).toHaveAttribute('data-hidden-unread', '0')
    await expect(tail.locator('.mail-unread-badge')).toHaveCount(0)
  })

  test('a promotion never moves a row under the pointer, and lands when it leaves', async ({ page }) => {
    // The arrival rides the real client path (a `sync-completed` frame, then the mailbox read that
    // carries the counts), injected at the socket so the fixture does not have to grow new mail.
    let inject: ((frame: string) => void) | null = null
    await page.routeWebSocket(/\/ws/, (ws) => {
      const server = ws.connectToServer()
      ws.onMessage((message) => server.send(message))
      server.onMessage((message) => ws.send(message))
      inject = (frame) => ws.send(frame)
    })
    await openMail(page, port)
    const tail = tailToggle(page, HARBOUR)
    await expect(tail).toHaveText('58 more folders, 6 with unread', { timeout: 90_000 })
    const promoted = section(page, HARBOUR).locator(`.mail-mailbox[data-mailbox-id="${TAIL_FOLDER}"]`)
    await expect(promoted).toHaveCount(0)

    // Park the pointer on the collapse row, which with the Drafts row above it is the most aimed-at
    // spot in this pane.
    const box = (await tail.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    const before = await tail.boundingBox()

    expect(inject, 'the socket route is installed').not.toBeNull()
    inject!(JSON.stringify({
      type: 'event',
      name: 'plugin:mail:sync-completed',
      data: { accountId: HARBOUR, mailboxId: TAIL_FOLDER, added: 3, updated: 0 },
      seq: 1,
    }))

    // Held: under 2.5s of a still pointer, nothing is inserted and the row has not moved a pixel.
    await page.waitForTimeout(1_200)
    await expect(promoted, 'the insertion waits').toHaveCount(0)
    const during = await tail.boundingBox()
    expect(Math.round(during!.y), 'the collapse row does not move under the pointer')
      .toBe(Math.round(before!.y))

    // Leaving lands it: the folder is above the collapse row, marked as promoted, and the number of
    // folders the row stands for drops by one in the same landing.
    await page.mouse.move(box.x + box.width + 420, box.y + 200)
    await expect(promoted).toHaveCount(1, { timeout: 15_000 })
    await expect(promoted).toHaveAttribute('data-promoted', 'true')
    await expect(tail).toHaveText('57 more folders, 5 with unread')
    // Above the collapse row, never below it.
    const order = await section(page, HARBOUR).locator('ul.mail-mailboxes').evaluate((list, id) => {
      const items = Array.from(list.children)
      return {
        row: items.findIndex((li) => li.querySelector(`.mail-mailbox[data-mailbox-id="${id}"]`)),
        tail: items.findIndex((li) => li.querySelector('.mail-tail-toggle')),
      }
    }, TAIL_FOLDER)
    expect(order.row).toBeGreaterThan(0)
    expect(order.row).toBeLessThan(order.tail)
  })

  test('the group waits for the mailbox rows, and landing does not throw the list up the pane', async ({ page }) => {
    // EVERY read of that account's folders waits, not just the first: an event or a reconnect fires a
    // second forced read, and letting that one through would land the rows the test is holding back.
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => { release = resolve })
    await page.route((url) => (
      url.pathname.endsWith('/mailboxes') && url.searchParams.get('account') === MARINA
    ), async (route) => {
      await gate
      await route.continue()
    })
    await openMail(page, port)
    // One account's folders are still on the wire, so no role has two holders: the group cannot be
    // drawn honestly yet, so it is not drawn at all.
    await expect(folderRow(page, HARBOUR, 'INBOX')).toBeVisible({ timeout: 90_000 })
    await expect(page.getByTestId('mail-smart')).toHaveCount(0)
    await expect(page.getByTestId('mail-smart-head')).toHaveCount(0)

    // Scroll into the middle of a long list, THEN let the rows land.
    await tailToggle(page, HARBOUR).click()
    const scroll = page.locator('.mail-accounts-scroll')
    await scroll.evaluate((el) => { el.scrollTop = 300 })
    const reference = folderRow(page, HARBOUR, 'harbour/label/newsletters')
    const anchoredAt = (await reference.boundingBox())!.y
    const scrollTopBefore = await scroll.evaluate((el) => el.scrollTop)

    expect(release, 'the mailbox read is gated').not.toBeNull()
    release!()
    await expect(folderRow(page, MARINA, 'inbox')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('mail-smart')).toHaveCount(1)

    const scrollTopAfter = await scroll.evaluate((el) => el.scrollTop)
    const anchoredNow = (await reference.boundingBox())!.y
    // The row a person was looking at stays where it was. The number itself may be corrected by the
    // engine's scroll anchoring, which is the same visual outcome; what is banned is us calling
    // `scrollIntoView` and throwing the list somewhere else.
    expect(Math.abs(anchoredNow - anchoredAt), 'the list does not jump when the group appears')
      .toBeLessThanOrEqual(2)
    console.log(`scrollTop before ${scrollTopBefore}, after ${scrollTopAfter}`)
  })

  test('what was open and what was selected survive a reload', async ({ page }) => {
    await openMail(page, port)
    await expect(smartRow(page, 'sent')).toBeVisible({ timeout: 90_000 })
    await twist(page, 'sent').click()
    await tailToggle(page, HARBOUR).click()
    await smartRow(page, 'sent').click()
    await expect(smartRow(page, 'sent')).toHaveAttribute('aria-current', 'true')

    await page.reload()
    await expect(twist(page, 'sent')).toHaveAttribute('aria-expanded', 'true', { timeout: 90_000 })
    await expect(tailToggle(page, HARBOUR)).toHaveAttribute('aria-expanded', 'true')
    await expect(smartRow(page, 'sent')).toHaveAttribute('aria-current', 'true')

    // A remembered row inside the collapsed tail is never hidden by its own collapse row.
    await page.evaluate((pair) => {
      window.localStorage.setItem('walnut.mail.sidebar.v1', JSON.stringify({
        smart: {}, tail: {}, recent: {}, selected: pair,
      }))
    }, { accountId: HARBOUR, mailboxId: TAIL_FOLDER })
    await page.reload()
    const seeded = section(page, HARBOUR).locator(`.mail-mailbox[data-mailbox-id="${TAIL_FOLDER}"]`)
    await expect(seeded).toBeVisible({ timeout: 90_000 })
    await expect(seeded).toHaveAttribute('aria-current', 'true')
    await expect(seeded).toHaveAttribute('data-promoted', 'true')
    await expect(tailToggle(page, HARBOUR)).toHaveText('57 more folders, 5 with unread')

    // A remembered row that no longer exists is discarded, and the pane falls back rather than
    // opening on nothing.
    await page.evaluate(() => {
      window.localStorage.setItem('walnut.mail.sidebar.v1', JSON.stringify({
        smart: {}, tail: {}, recent: {}, selected: { accountId: 'dense:gone', mailboxId: 'nowhere' },
      }))
    })
    await page.reload()
    await expect(page.locator(`${PANE} [aria-current="true"]`)).toHaveCount(1, { timeout: 90_000 })
    await expect(page.getByTestId('mail-row').first()).toBeVisible({ timeout: 60_000 })
  })

  test('a storage that refuses to remember still expands', async ({ browser }) => {
    const context = await browser.newContext({ viewport: NARROW_COLUMN })
    // Only the sidebar's own key throws, which is what a full quota or a locked-down window does to
    // it: the rest of the app keeps its storage so the failure under test is the one being measured.
    await context.addInitScript(() => {
      const real = window.localStorage
      const guard = {
        getItem(key: string) {
          if (key.startsWith('walnut.mail.sidebar')) throw new Error('storage denied')
          return real.getItem(key)
        },
        setItem(key: string, value: string) {
          if (key.startsWith('walnut.mail.sidebar')) throw new Error('storage denied')
          real.setItem(key, value)
        },
        removeItem: (key: string) => real.removeItem(key),
        clear: () => real.clear(),
        key: (index: number) => real.key(index),
        get length() { return real.length },
      }
      Object.defineProperty(window, 'localStorage', { configurable: true, get: () => guard })
    })
    const page = await context.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    try {
      await openMail(page, port)
      await expect(tailToggle(page, HARBOUR)).toBeVisible({ timeout: 90_000 })
      await twist(page, 'inbox').click()
      await expect(page.getByTestId('mail-smart-children')).toHaveCount(1)
      await tailToggle(page, HARBOUR).click()
      await expect(page.getByTestId('mail-tail-filter')).toHaveCount(1)
      await expect(tailToggle(page, HARBOUR)).toHaveText('Show fewer folders')
      expect(pageErrors, 'a refused preference is not an exception').toEqual([])
    } finally {
      await context.close()
    }
  })

  test('New message names the account it will send as', async ({ page }) => {
    await openMail(page, port)
    const compose = page.getByTestId('mail-compose-new')
    await expect(smartRow(page, 'inbox')).toHaveAttribute('aria-current', 'true', { timeout: 90_000 })
    for (const role of ['inbox', 'sent', 'drafts']) {
      await smartRow(page, role).click()
      await expect(smartRow(page, role)).toHaveAttribute('aria-current', 'true')
      await expect(compose).toBeEnabled()
      await expect(compose).toHaveAttribute('title', 'Write a new message as Harbour mail')
    }
    // A real folder keeps today's wording: the identity is the account whose row is selected.
    await folderRow(page, MARINA, 'inbox').click()
    await expect(compose).toHaveAttribute('title', 'Write a new message')

    // And a compose started from a merged list opens on a real, sendable account.
    await smartRow(page, 'inbox').click()
    await compose.click()
    const composer = page.getByTestId('mail-composer')
    await expect(composer).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('mail-composer-close').click()
    await expect(composer).toHaveCount(0, { timeout: 30_000 })
  })
})

test.describe('the installs that must not change', () => {
  const server = new FixtureServer()
  let port = 0

  test.beforeAll(async () => {
    test.setTimeout(300_000)
    await fs.mkdir(SHOT_DIR, { recursive: true })
    const fixture = await server.start({ PW_MAIL_PROVIDER: '1', MAIL_FIXTURE_DENSE: '1' })
    port = fixture.port
  })

  test.afterAll(async () => { await server.stop() })

  test('no account draws no pane, and one account draws the pane it has always had', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await openMail(page, port)

    // Zero accounts is the empty screen, not a three column console with an empty sidebar.
    await expect(page.getByTestId('mail-app-empty')).toBeVisible({ timeout: 90_000 })
    await expect(page.locator(PANE)).toHaveCount(0)
    await expect(page.getByTestId('mail-smart')).toHaveCount(0)
    await expect(page.getByTestId('mail-smart-head')).toHaveCount(0)

    await page.getByTestId('mail-add-account').click()
    const dialog = page.getByTestId('mail-add-dialog')
    await expect(dialog).toBeVisible()
    await page.locator('[data-testid="mail-provider-option"][data-provider-id="fixture"]').click()
    await page.getByTestId('mail-setup-address').fill('one@example.invalid')
    await page.getByTestId('mail-setup-token').fill('ok')
    await page.getByTestId('mail-add-submit').click()
    await expect(dialog).toHaveCount(0, { timeout: 30_000 })
    await expect(page.locator(`${PANE} .mail-mailbox`).first()).toBeVisible({ timeout: 90_000 })

    // One account: no smart list, no group title, no hairline, no collapse row, and the rows in the
    // order they have always been in. This is the whole backward compatibility promise of the slice.
    await expect(page.getByTestId('mail-smart')).toHaveCount(0)
    await expect(page.getByTestId('mail-smart-head')).toHaveCount(0)
    await expect(page.locator(`${PANE} .mail-tail-toggle`)).toHaveCount(0)
    await expect(page.locator(`${PANE} .mail-twist`)).toHaveCount(0)
    const order = await page.locator(`${PANE} .mail-mailbox-name`).allInnerTexts()
    expect(order, "one account's folder list is untouched").toEqual(['Inbox', 'Archive', 'Drafts', 'Junk'])
    // The scroll container's padding is the one thing the focus ring was NOT allowed to buy: two
    // pixels here would move every folder row of every install.
    const padding = await page.locator('.mail-accounts-scroll').evaluate((el) => getComputedStyle(el).padding)
    expect(padding, 'the scroll container keeps its padding').toBe('8px 0px')

    // The ring is drawn inside the row instead, so it survives the clip. Reached with the KEYBOARD,
    // because `:focus-visible` is exactly the state a programmatic focus does not enter.
    await page.getByTestId('mail-pane-menu').focus()
    await page.keyboard.press('Tab')
    const focused = page.locator(`${PANE} .mail-mailbox:focus-visible`)
    await expect(focused, 'Tab reaches the folder rows').toHaveCount(1)
    const ring = await focused.evaluate((el) => {
      const style = getComputedStyle(el)
      const row = el.getBoundingClientRect()
      const scroll = el.closest('.mail-accounts-scroll')!.getBoundingClientRect()
      return {
        width: style.outlineWidth,
        offset: style.outlineOffset,
        insideLeft: row.left >= scroll.left - 0.5,
        insideRight: row.right <= scroll.right + 0.5,
      }
    })
    expect(ring.offset, 'the focus ring is drawn inside the clip').toBe('-2px')
    expect(ring.width).toBe('2px')
    expect({ left: ring.insideLeft, right: ring.insideRight }).toEqual({ left: true, right: true })

    expect(pageErrors).toEqual([])
    console.log(`single account screenshot: ${await shoot(page.locator(PANE), 'light', 'single-account')}`)
  })
})

test.describe('one folder in the tail, and an account that stopped syncing', () => {
  const server = new FixtureServer()
  let port = 0

  test.beforeAll(async () => {
    test.setTimeout(300_000)
    const fixture = await server.start({ PW_MAIL_DENSE: '1', PW_MAIL_DENSE_TAIL_ONE: '1' })
    port = fixture.port
  })

  test.afterAll(async () => { await server.stop() })

  test('a tail of one reads in the singular', async ({ page }) => {
    await openMail(page, port)
    const tail = tailToggle(page, MARINA)
    await expect(tail).toBeVisible({ timeout: 90_000 })
    await expect(tail).toHaveText('1 more folder, 1 with unread')
    await expect(tail.locator('.mail-unread-badge')).toHaveCount(0)
    await tail.click()
    await expect(tail).toHaveText('Show fewer folders')
  })
})

test.describe('an account that stopped syncing', () => {
  const server = new FixtureServer()
  let port = 0

  test.beforeAll(async () => {
    test.setTimeout(300_000)
    const fixture = await server.start({ PW_MAIL_DENSE: '1' })
    port = fixture.port
  })

  test.afterAll(async () => { await server.stop() })

  test('the smart row marks the degradation and still lists the cached mail', async ({ page }) => {
    // The degraded ACCOUNT is stubbed at the transport, and it has to be: this fixture's provider
    // reports `auth-required` and then polls successfully, and one good poll is exactly what the base
    // treats as proof that the account syncs again (it writes the row back to `active`). So the state
    // the pane has to draw cannot be produced by the fixture, and the pane's own rule is what is under
    // test here: an account that is not syncing is marked on every merged row that covers it.
    await page.route((url) => url.pathname.endsWith('/api/plugins/mail/accounts'), async (route) => {
      const answer = await route.fetch()
      const body = await answer.json() as {
        accounts: Array<{ accountId: string, state: string, health?: unknown }>
      }
      for (const account of body.accounts) {
        if (account.accountId !== MARINA) continue
        account.state = 'auth-required'
        account.health = { state: 'auth-required', checkedAt: Date.now(), detail: 'the stub parked it' }
      }
      await route.fulfill({ response: answer, json: body })
    })
    await openMail(page, port)
    await expect(smartRow(page, 'inbox')).toBeVisible({ timeout: 90_000 })
    const warn = smartRow(page, 'inbox').getByTestId('mail-smart-warn')
    await expect(warn).toBeVisible()
    await expect(warn).toHaveAttribute('title', '1 of 2 accounts is not syncing')
    // Six pixels, before the badge, in the existing warning colour.
    const dot = await warn.evaluate((el) => {
      const box = el.getBoundingClientRect()
      return { width: Math.round(box.width), height: Math.round(box.height) }
    })
    expect(dot).toEqual({ width: 6, height: 6 })
    // The dot sits before the badge, and the row still opens a list holding that account's cached mail:
    // "not syncing" is not "not readable".
    const orderInRow = await smartRow(page, 'inbox').evaluate((el) => (
      Array.from(el.children).map((child) => child.className)
    ))
    expect(orderInRow).toEqual(['mail-mailbox-name', 'mail-smart-warn', 'mail-unread-badge'])
    // The account section keeps its own badge and its repair sentence, untouched by this slice.
    await expect(section(page, MARINA).getByTestId('mail-account-state')).toHaveText('Sign-in needed')
    await smartRow(page, 'inbox').click()
    await expect(page.getByTestId('mail-row').first()).toBeVisible({ timeout: 60_000 })
    // And the LINE under the list header, on screen (C35). A dot with a title attribute is not a
    // sentence: the title never renders, so the merged list said nothing at all about being out of date.
    await expect(page.getByTestId('mail-degraded-line')).toHaveText('1 account is not syncing.')
    // The cached mail of the account that stopped is still in the list under it.
    await expect(page.locator(`[data-testid="mail-row"][data-account-id="${MARINA}"]`).first())
      .toBeVisible({ timeout: 60_000 })
    console.log(`degraded list screenshot: ${await shoot(page.locator('.mail-list-pane'), 'light', 'degraded-line')}`)
    console.log(`degraded pane screenshot: ${await shoot(page.locator(PANE), 'light', 'auth-required')}`)
  })

  test('when no account can send, the button is grey and keeps its old sentence', async ({ page }) => {
    // Stubbed for the same reason as above: this provider can send, and the honest grey state is the
    // one case where the merged view must NOT invent an identity.
    await page.route((url) => url.pathname.endsWith('/api/plugins/mail/accounts'), async (route) => {
      const answer = await route.fetch()
      const body = await answer.json() as {
        accounts: Array<{ capabilities?: { send: boolean } }>
      }
      for (const account of body.accounts) account.capabilities = { send: false }
      await route.fulfill({ response: answer, json: body })
    })
    await openMail(page, port)
    await expect(smartRow(page, 'inbox')).toBeVisible({ timeout: 90_000 })
    await smartRow(page, 'inbox').click()
    const compose = page.getByTestId('mail-compose-new')
    await expect(compose).toBeDisabled()
    await expect(compose).toHaveAttribute('title', 'This account cannot send; add SMTP settings')
  })
})
