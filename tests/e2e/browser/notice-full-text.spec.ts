/**
 * Every notice in the corner shows its whole message (2026-11-05, the Mac app: a daemon error
 * read as one ellipsized line, the command it named cut off, its x outside the toast). A toast's
 * title wraps to two lines and its body to three, then Details opens the rest in place and keeps
 * the toast up; a `backticked` command reads as code with its own Copy; the x stays inside the
 * toast in every form (Home, beside an approval card, a narrow window, the phone).
 */
import { expect, test, type Locator, type Page, type WebSocketRoute } from '@playwright/test'
import { holdApprovalsLock } from './approvals-lock'
import { pausePageClock } from './page-clock'
import { PHONE } from './phone-helpers'
import { openKebabGroup } from './kebab-group-helpers'

const SHOTS = '/tmp/notice-full-text'
const COMMAND = 'walnut daemon install --yes --executable <daemon binary>'
const LINE = `DaemonConnection: managed daemon update was deferred; use \`${COMMAND}\` on that host.`
// As the server writes it: the title is the line's first 120 characters, the whole line leads Details.
const TITLE = `${LINE.slice(0, 119).trimEnd()}…`
const META = '[session] {"host":"devbox","expected":"2.3.0","remoteVersion":"2.2.9"}'
const DETAIL = `${LINE}\n${META}`
const BODY = 'The host keeps its older daemon until it is installed again.'
// What the server now makes of that line (humanize.ts managed-daemon-update-deferred).
const HUMAN_TITLE = 'The daemon on devbox needs an update'
const HUMAN_BODY = `Set <daemon binary> to the new daemon file's path, then run on devbox: \`${COMMAND}\`. It runs 2.2.9, Walnut 2.3.0.`

async function routeSocket(page: Page): Promise<() => WebSocketRoute | null> {
  let socket: WebSocketRoute | null = null
  await page.routeWebSocket(/\/ws(?:\?|$)/, (route) => { socket = route; route.connectToServer() })
  return () => socket
}

function noticeEvent(key: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'event', name: 'notification:new', seq: -1,
    data: { dedupKey: `notice-full-text:${key}:${Date.now()}`, kind: 'operation-error', severity: 'error', title: TITLE, detail: DETAIL, timestamp: Date.now(), ...extra },
  })
}

test.describe.configure({ timeout: 90_000 })
// Each test starts and ends with no approval waiting, cleared under the approvals lock.
holdApprovalsLock('test', { clear: true })

async function boot(page: Page, sock: () => WebSocketRoute | null) {
  await page.route('**/api/quiet*', (r) => r.fulfill({ json: { quiet: false } }))
  await page.goto('/')
  await expect(page.locator('.app-shell').first()).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => sock() !== null, { timeout: 30_000 }).toBe(true)
  // The toasts' own timers stand still while they are measured; the spec moves them on purpose.
  await page.clock.install()
  await pausePageClock(page)
}

/** The x, the title and every line of the toast lie inside it; nothing is cut sideways. */
async function expectInside(toast: Locator) {
  await expect.poll(() => toast.evaluate((el) => el.getAnimations().length)).toBe(0)
  const box = (await toast.boundingBox())!
  for (const part of [toast.locator('.notification-toast-close'), toast.locator('.notification-toast-title')]) {
    const b = (await part.boundingBox())!
    expect(b.x).toBeGreaterThanOrEqual(box.x - 0.5)
    expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width + 0.5)
  }
  // Wrapped, never cut sideways.
  const sideways = await toast.locator('.notification-toast-title').evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(sideways).toBeLessThanOrEqual(1)
}

/** Details opens the whole line with its copyable command, and the toast stays up while read. */
async function expectDetailsOpens(page: Page, toast: Locator, shot?: string, whole = 'on that host.') {
  const details = toast.getByTestId('notice-details')
  await expect(details).toBeVisible()
  // Words cut: Details opens them; words whole: only the log is behind it.
  const closedName = (await details.textContent())!.trim()
  expect(['Details', 'Show log']).toContain(closedName)
  const copy = toast.getByTestId('notice-copy-command')
  const copyX = await copy.isVisible() ? (await copy.boundingBox())!.x : null
  await details.click()
  await expect(details).toHaveText(closedName === 'Details' ? 'Less' : 'Hide log')
  // The server cut the title; opened, it reads whole, and the raw rest is under it.
  await expect(toast).toContainText(whole)
  await expect(toast.getByTestId('notification-toast-detail')).toContainText('"host": "devbox"')
  await expect(toast.getByTestId('notification-toast-detail')).not.toContainText('managed daemon update')
  // Opened, its one "Copy command" stays where it was, and the words carry no second copy.
  await expect(copy).toBeVisible()
  if (copyX !== null) expect(Math.abs((await copy.boundingBox())!.x - copyX)).toBeLessThanOrEqual(2)
  await expect(toast.locator('.notification-toast-title').getByTestId('notice-cmd-copy')).toHaveCount(0)
  // A command never splits at its own hyphens: "--yes" stays on one line.
  const yes = toast.locator('.notice-cmd-word', { hasText: /^--yes$/ })
  expect((await yes.boundingBox())!.height).toBeLessThanOrEqual(22)
  if (shot) await page.screenshot({ path: shot })
  await page.clock.runFor(30_000)
  await expect(toast).toBeVisible()
  await details.click()
  await expect(toast.getByTestId('notification-toast-detail')).toHaveCount(0)
}

test('a long error toast wraps, keeps its x inside, copies its command and opens the rest', async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const sock = await routeSocket(page)
  await boot(page, sock)
  sock()!.send(noticeEvent('home'))
  const toast = page.locator('.corner-stack .notification-toast', { hasText: 'managed daemon update' })
  await expect(toast).toBeVisible()
  await expectInside(toast)
  // Two lines, never one ellipsized line.
  const title = toast.locator('.notification-toast-title')
  const h = (await title.boundingBox())!.height
  expect(h).toBeGreaterThan(20)
  expect(h).toBeLessThanOrEqual(34)
  // The command reads as code with its own Copy, which neither opens nor closes the toast.
  await expect(toast.locator('.notice-cmd-code').first()).toContainText('walnut daemon install')
  // Cut or not, the command it names is one click from the clipboard.
  const copy = toast.getByTestId('notice-copy-command')
  await expect(copy).toHaveText('Copy command')
  await copy.click()
  await expect(copy).toHaveText('Copied')
  await expect(toast).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-home.png`, clip: { x: 0, y: 500, width: 900, height: 300 } })
  await expectDetailsOpens(page, toast, `${SHOTS}/${info.project.name}-home-details.png`)
})

test('beside an approval card and in a narrow window the toast keeps its words and its x', async ({ page, request }, info) => {
  await page.setViewportSize({ width: 700, height: 600 })
  const sock = await routeSocket(page)
  await boot(page, sock)
  const res = await request.post('/api/v1/approvals', { data: { what: '[notice-full-text] Deploy the site', cwd: '/work/site', command: 'release.sh' } })
  expect(res.ok()).toBe(true)
  await expect(page.locator('.corner-stack [data-testid="approval-card"]')).toBeVisible({ timeout: 15_000 })
  sock()!.send(noticeEvent('narrow', { body: BODY }))
  const toast = page.locator('.corner-stack .notification-toast', { hasText: 'managed daemon update' })
  await expect(toast).toBeVisible()
  await expect(page.locator('.corner-stack')).toHaveClass(/has-approval/)
  await expectInside(toast)
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-narrow.png` })
  await expectDetailsOpens(page, toast, `${SHOTS}/${info.project.name}-narrow-details.png`)
})

test('the daemon card reads plainly, its command one click away, and a log alone says Show log', async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const sock = await routeSocket(page)
  await boot(page, sock)
  sock()!.send(noticeEvent('human', { title: HUMAN_TITLE, body: HUMAN_BODY, detail: META }))
  const toast = page.locator('.corner-stack .notification-toast', { hasText: HUMAN_TITLE })
  await expect(toast).toBeVisible()
  await expectInside(toast)
  await expect(toast.locator('.notification-toast-body .notice-cmd-code')).toContainText('walnut daemon install')
  await expect(toast.getByTestId('notice-copy-command')).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-human.png`, clip: { x: 0, y: 450, width: 900, height: 350 } })
  await expectDetailsOpens(page, toast, `${SHOTS}/${info.project.name}-human-log.png`, 'It runs 2.2.9, Walnut 2.3.0.')
  await toast.locator('.notification-toast-close').click()
  // A notice whose words fit and that keeps a log: what opens is the log, and the toggle says so.
  sock()!.send(noticeEvent('short', { title: 'Sync paused', body: 'It resumes on its own.', detail: META }))
  const short = page.locator('.corner-stack .notification-toast', { hasText: 'Sync paused' })
  await expect(short).toBeVisible()
  const toggle = short.getByTestId('notice-details')
  await expect(toggle).toHaveText('Show log')
  await toggle.click()
  await expect(toggle).toHaveText('Hide log')
  await expect(short.locator('.notification-toast-log-label')).toHaveText('Log')
})

test('a permission prompt with a long command offers Details and Copy', async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const sock = await routeSocket(page)
  await boot(page, sock)
  const command = `rsync -av --delete ${'/very/long/path/segment'.repeat(12)} devbox:/srv/site && echo done`
  sock()!.send(noticeEvent('perm', { kind: 'permission', severity: 'warning', title: 'Bash', toolName: 'Bash', input: { command }, detail: undefined, sessionId: 'notice-full-text-session', requestId: 'notice-full-text-req', sessionTitle: 'Publish the site', host: 'devbox' }))
  const toast = page.locator('.corner-stack .nfc-perm-toast')
  await expect(toast).toBeVisible()
  await expectInside(toast)
  const cmd = toast.locator('.nfc-perm-cmd')
  const closed = (await cmd.boundingBox())!.height
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-permission-closed.png`, clip: { x: 0, y: 300, width: 900, height: 500 } })
  await toast.getByTestId('notice-details').click()
  expect((await cmd.boundingBox())!.height).toBeGreaterThan(closed + 10)
  await expect(toast.getByTestId('notice-copy-command')).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-permission.png`, clip: { x: 0, y: 300, width: 900, height: 500 } })
})

test.describe('on a phone', () => {
  test.use({ viewport: PHONE.viewport, screen: PHONE.screen, deviceScaleFactor: PHONE.deviceScaleFactor, isMobile: true, hasTouch: true, userAgent: PHONE.userAgent })

  test('the title wraps, the x stays inside, and Details opens the words', async ({ page }, info) => {
    const sock = await routeSocket(page)
    await boot(page, sock)
    sock()!.send(noticeEvent('phone', { body: BODY }))
    const toast = page.locator('.corner-stack .notification-toast', { hasText: 'managed daemon update' })
    await expect(toast).toBeVisible()
    await expectInside(toast)
    await expect(toast.locator('.notification-toast-body')).toBeHidden()
    // One row: the title, Details and the x share a center line.
    const mid = async (l: Locator) => { const b = (await l.boundingBox())!; return b.y + b.height / 2 }
    const row = await mid(toast.locator('.notification-toast-title'))
    const words = await toast.getByTestId('notice-details').evaluate((el) => { const r = document.createRange(); r.selectNodeContents(el); const b = r.getClientRects()[0]; return b.y + b.height / 2 })
    expect(Math.abs(words - row)).toBeLessThanOrEqual(3)
    expect(Math.abs(await mid(toast.locator('.notification-toast-close')) - row)).toBeLessThanOrEqual(3)
    await page.screenshot({ path: `${SHOTS}/${info.project.name}-phone-closed.png` })
    await toast.getByTestId('notice-details').click()
    await expect(toast.locator('.notification-toast-body')).toBeVisible()
    await expect(toast.locator('.notification-toast-title')).toContainText('on that host.')
    await expect(toast.getByTestId('notification-toast-detail')).toContainText('"host": "devbox"')
    // Opened, the Copy comes before the log, so it is found without reading the log.
    const copyY = (await toast.getByTestId('notice-copy-command').boundingBox())!.y
    expect(copyY).toBeLessThan((await toast.locator('.notification-toast-log').boundingBox())!.y)
    await page.screenshot({ path: `${SHOTS}/${info.project.name}-phone.png` })
  })
})

// 2026-11-05, the user (a screenshot circling the empty bottom of the left column beside the bell):
// "the notification should be here not on the big right". Home's task panel and the Org list.
test('the corner sits next to the sidebar, over the page left column, never out over the big pane', async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const sock = await routeSocket(page)
  await boot(page, sock)
  const sidebar = page.locator('.app-shell > .sidebar')
  const check = async (column: Locator, pane: Locator, shot: string) => {
    sock()!.send(noticeEvent(`left-${shot}`, { body: BODY }))
    const toast = page.locator('.corner-stack .notification-toast', { hasText: 'managed daemon update' }).last()
    await expect(toast).toBeVisible()
    await expect.poll(() => toast.evaluate((el) => el.getAnimations().length)).toBe(0)
    const s = (await sidebar.boundingBox())!
    const c = (await column.boundingBox())!
    const p = (await pane.boundingBox())!
    // Polled as its numbers, so a failure says where the toast and the column really were.
    await expect.poll(async () => {
      const t = (await toast.boundingBox())!
      const ok = Math.round(t.x) === Math.round(s.x + s.width) + 16 && t.x + t.width <= c.x + c.width - 15 && t.x + t.width <= p.x + 1
      return ok ? 'inside' : `toast x${Math.round(t.x)} w${Math.round(t.width)}; sidebar r${Math.round(s.x + s.width)}; column r${Math.round(c.x + c.width)}; pane x${Math.round(p.x)}`
    }).toBe('inside')
    // The column's foot row (Home's System attention, when there is something to show) stays in sight above nothing: the corner stands on it.
    await expect.poll(() => page.evaluate(() => {
      const foot = [...document.querySelectorAll('.main-content .ab-mount')].map((el) => el.getBoundingClientRect()).find((r) => r.height > 0 && r.bottom > window.innerHeight - 80)
      const stack = document.querySelector('.corner-stack')!.getBoundingClientRect()
      return !foot || stack.right <= foot.left || stack.bottom <= foot.top + 1 ? 'clear' : `stack bottom ${Math.round(stack.bottom)} over the foot row at ${Math.round(foot.top)}`
    })).toBe('clear')
    // No row of the column is under the corner, also before the list is scrolled (2026-11-06
    // review: Home's bottom Focus rows sat under the card): the list ends above it.
    await expect.poll(() => page.evaluate(() => {
      const stack = document.querySelector('.corner-stack')!
      const r = stack.getBoundingClientRect()
      for (let x = r.left + 4; x < r.right; x += 24) {
        for (let y = r.top + 2; y < r.bottom; y += 12) {
          const hit = document.elementsFromPoint(x, y).find((el) => !stack.contains(el))
          const row = hit?.closest('[data-task-id], .org-channel, .todo-panel-item')
          if (row) return `a row is under the corner at ${Math.round(x)},${Math.round(y)}: ${row.className}`
        }
      }
      return 'clear'
    })).toBe('clear')
    await expectInside(toast)
    await page.screenshot({ path: `${SHOTS}/${info.project.name}-left-${shot}.png` })
    await toast.locator('.notification-toast-close').click()
    await expect(toast).toBeHidden()
  }
  const todo = page.locator('.main-page-todo')
  await expect(todo).toBeVisible()
  await check(todo, page.locator('.main-page-right'), 'home')
  await page.getByTestId('sidebar-org').click()
  const list = page.locator('.org-list')
  await expect(list).toBeVisible({ timeout: 30_000 })
  // The Org page: its list on the left, the node's page beside it.
  await check(list, page.locator('.org-list + *').first(), 'org')
})

/** The fixture's session, opened in a column and then full screen from its menu, as the user does. */
async function openFullScreen(page: Page): Promise<Locator> {
  await page.locator('.todo-search-input').fill('pw-vscode-session')
  await page.locator('.todo-panel-item[data-task-id="pw-task-vscode"] .todo-item-title').click()
  const panel = page.locator('.main-page-session-column .session-panel[data-session-id="pw-vscode-session"]')
  await expect(panel).toBeVisible()
  await page.locator('.todo-search-input').fill('')
  await panel.locator('.session-panel-header .task-kebab-btn').click()
  const menu = page.locator('.task-kebab-menu')
  await (await openKebabGroup(menu, 'session-kebab-window')).getByTestId('session-menu-fullscreen').click()
  await expect(panel).toHaveClass(/open-walnut-fullscreen/)
  return panel
}

// 2026-11-06, the user (a full-screen session, the approval card crossed out over its composer, an
// arrow at the window's bottom left beside System attention): "I said no matter if its full screen
// or this, fix just here at left". The corner keeps its place over the sheet's backdrop and above
// the sheet, never over the sheet's composer.
for (const size of [{ width: 1512, height: 900 }, { width: 2200, height: 1100 }]) {
  test(`a full-screen session keeps the corner at the bottom left beside the sidebar (${size.width}px)`, async ({ page, request }, info) => {
    await page.setViewportSize(size)
    const sock = await routeSocket(page)
    await boot(page, sock)
    await openFullScreen(page)
    const res = await request.post('/api/v1/approvals', { data: { what: '[notice-full-text] Push the prompt to the shared store', cwd: '/work/site', command: 'release.sh' } })
    expect(res.ok()).toBe(true)
    const card = page.locator('.corner-stack [data-testid="approval-card"]')
    await expect(card).toBeVisible({ timeout: 15_000 })
    sock()!.send(noticeEvent(`sheet-${size.width}`, { body: BODY }))
    const toast = page.locator('.corner-stack .notification-toast', { hasText: 'managed daemon update' }).last()
    await expect(toast).toBeVisible()
    await expect.poll(() => toast.evaluate((el) => el.getAnimations().length)).toBe(0)
    // Measured in one evaluate, polled, so a failure says where everything really was.
    await expect.poll(() => page.evaluate(() => {
      const side = document.querySelector('.app-shell > .sidebar')!.getBoundingClientRect().right
      const stack = document.querySelector('.corner-stack')!.getBoundingClientRect()
      const sheet = document.querySelector('.open-walnut-fullscreen')!.getBoundingClientRect()
      // What one types in and clicks on the sheet's composer stays clear of the corner.
      const controls = [...document.querySelectorAll('.open-walnut-fullscreen .chat-input-container :is(textarea, button, [contenteditable="true"])')]
        .filter((el) => el.getBoundingClientRect().width > 0)
      const cardEl = document.querySelector('.corner-stack [data-testid="approval-card"]')!
      const c = cardEl.getBoundingClientRect()
      const hit = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2)
      const fails: string[] = []
      if (Math.round(stack.left) !== Math.round(side) + 16) fails.push(`stack x${Math.round(stack.left)} not sidebar r${Math.round(side)} + 16`)
      if (Math.abs(window.innerHeight - stack.bottom - 16) > 1) fails.push(`stack bottom ${Math.round(window.innerHeight - stack.bottom)} from the window bottom`)
      if (!hit || !cardEl.contains(hit)) fails.push(`card covered by ${hit?.className}`)
      for (const el of controls) {
        const r = el.getBoundingClientRect()
        const over = r.left < stack.right && r.right > stack.left && r.top < stack.bottom && r.bottom > stack.top
        if (over) fails.push(`stack r${Math.round(stack.right)} over the composer's ${el.tagName.toLowerCase()} at x${Math.round(r.left)}`)
      }
      if (stack.right - sheet.left > 16 && sheet.left - side - 32 >= 220) fails.push(`stack r${Math.round(stack.right)} past the sheet x${Math.round(sheet.left)} with room beside it`)
      // The sheet itself moves past the corner, so it is never under it, and its header, chat and
      // composer keep one left line (2026-11-06 review: the header stayed put while the chat moved).
      if (stack.right > sheet.left) fails.push(`stack r${Math.round(stack.right)} over the sheet x${Math.round(sheet.left)}`)
      const chat = document.querySelector('.open-walnut-fullscreen .session-history')?.getBoundingClientRect()
      if (chat && chat.left < stack.right && chat.bottom > stack.top) fails.push(`the sheet's chat at x${Math.round(chat.left)} under the stack r${Math.round(stack.right)}`)
      const head = document.querySelector('.open-walnut-fullscreen .session-panel-header')?.getBoundingClientRect()
      if (head && Math.abs(head.left - sheet.left) > 1) fails.push(`the sheet's header at x${Math.round(head.left)}, the sheet at x${Math.round(sheet.left)}`)
      if (stack.width < 219) fails.push(`stack only ${Math.round(stack.width)}px wide`)
      return fails.join('; ') || 'beside the sidebar'
    })).toBe('beside the sidebar')
    // The card's buttons take a click 700ms after it shows (ARM_MS): moved on, as the person sees it.
    await page.clock.runFor(1_000)
    await page.screenshot({ path: `${SHOTS}/${info.project.name}-sheet-${size.width}.png` })
  })
}

// 2026-11-06, the user: "Love the approval pop up, however, It doesn't make me able to click and jump
// to that task". The asking task's name, a link on the card and in its dialog, opens that task on
// Home, its row in sight and its session column on top, from a full-screen sheet and from another
// page. The title still opens the whole request, so it is read before it is approved.
/** The task status dot keeps its size where the link is a flex row (2026-11-07 review: a sliver),
 *  the ↗ stays on the line of the name's last word, and nothing reaches past the box. */
async function expectAskerLinkReads(link: Locator, box: Locator) {
  const boxHandle = await box.elementHandle()
  await expect.poll(() => link.evaluate((el, boxEl) => {
    const dot = getComputedStyle(el, '::before')
    const dotOk = dot.content === 'none' || dot.content === 'normal' || parseFloat(dot.width) >= 6
    const rects = el.querySelector('.approval-task-link-label')!.getClientRects()
    const lastLine = rects[rects.length - 1]!
    const go = el.querySelector('.approval-task-link-go')!.getBoundingClientRect()
    const b = (boxEl as Element).getBoundingClientRect()
    const inside = el.getBoundingClientRect().right <= b.right + 0.5
    return dotOk && inside && Math.abs(go.top - lastLine.top) <= 4 ? 'ok' : `dot ${dot.width}, go top ${go.top} vs last line ${lastLine.top}, inside ${inside}`
  }, boxHandle)).toBe('ok')
}

test('the approval card opens the task that asked, from a full-screen sheet and from another page', async ({ page, request }, info) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const sock = await routeSocket(page)
  await boot(page, sock)
  // Real time here: the task panel's scroll to the task runs on timers and frames.
  await page.clock.resume()
  await openFullScreen(page)
  const res = await request.post('/api/v1/approvals', {
    headers: { 'x-walnut-caller-sid': 'pw-provenance-session' },
    data: { what: '[notice-full-text] Push the prompt from its task', cwd: '/work/site', command: 'release.sh' },
  })
  expect(res.ok()).toBe(true)
  const made = await res.json() as { approval: { id: string; requester: { taskId?: string; taskTitle?: string } } }
  expect(made.approval.requester.taskId).toBe('pw-task-provenance')
  const card = page.locator(`.corner-stack [data-testid="approval-card"][data-approval-id="${made.approval.id}"]`)
  await expect(card).toBeVisible({ timeout: 15_000 })
  const link = card.getByTestId('approval-task-link')
  await expect(link).toContainText(made.approval.requester.taskTitle!)
  // A long name is cut inside the link: its ↗ stays in sight (2026-11-06 review: "fixture task ↗…").
  expect(await link.evaluate((el) => {
    const go = el.querySelector('.approval-task-link-go')!.getBoundingClientRect()
    const card = el.closest('[data-testid="approval-card"]')!.getBoundingClientRect()
    return go.width > 0 && go.right <= card.right - 8
  })).toBe(true)
  await expectAskerLinkReads(link, card)
  await page.waitForTimeout(1_000) // its buttons take a click 700ms after it shows
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-jump-before.png` })
  const asker = page.locator('.main-page-session-column .session-panel[data-session-id="pw-provenance-session"]')
  const row = page.locator('.todo-panel-item[data-task-id="pw-task-provenance"]')
  const landed = async () => {
    await expect(asker).toBeVisible({ timeout: 15_000 })
    await expect.poll(() => asker.evaluate((n) => {
      const b = n.getBoundingClientRect()
      const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)
      return !!hit && n.contains(hit)
    }), { timeout: 10_000 }).toBe(true)
    await expect(row).toHaveClass(/task-focused/)
    // Its row is in sight in the task panel, not only marked somewhere off screen.
    await expect.poll(() => row.evaluate((n) => {
      const r = n.getBoundingClientRect()
      const list = n.closest('.main-page-todo')!.getBoundingClientRect()
      return r.height > 0 && r.top >= list.top && r.bottom <= list.bottom
    }), { timeout: 10_000 }).toBe(true)
    // ...and not behind the corner's card (2026-11-06 review: the focused row sat under it).
    await expect.poll(() => row.evaluate((n) => {
      const r = n.getBoundingClientRect()
      const c = document.querySelector('.corner-stack')!.getBoundingClientRect()
      return c.height === 0 || r.bottom <= c.top || r.left >= c.right || r.right <= c.left
    }), { timeout: 10_000 }).toBe(true)
  }
  // The title opens the whole request; its task name there is a link too.
  await card.getByTestId('approval-what').click()
  const dialog = page.getByTestId('approval-dialog')
  await expect(dialog).toBeVisible()
  // The whole request: the command it runs too (2026-11-07 review: only the folder showed).
  await expect(dialog.getByTestId('approval-command')).toHaveText('release.sh')
  await expectAskerLinkReads(dialog.getByTestId('approval-task-link'), dialog.locator('.approval-dialog'))
  await dialog.locator('.approval-dialog-close').click()
  // The task name on the card, over the full-screen sheet: the asking task's column opens on top.
  await link.click()
  await landed()
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-jump-from-sheet.png` })
  // From the Org page, the task's name on the card goes back to it.
  await page.getByTestId('sidebar-org').click()
  await expect.poll(() => new URL(page.url()).pathname).toBe('/org')
  await expect(card).toBeVisible()
  await page.waitForTimeout(1_000)
  // In the Org list's narrow column the time and the task name keep their room: the buttons wrap
  // under them (2026-11-06: "9:56 le" cut under Deny).
  expect(await card.evaluate((el) => {
    const box = el.getBoundingClientRect()
    const clock = el.querySelector('.approval-line-meta .approval-clock') ?? el.querySelector('.approval-clock')!
    const c = clock.getBoundingClientRect()
    const btns = [...el.querySelectorAll('.approval-actions .approval-btn')].map((b) => b.getBoundingClientRect())
    const fails: string[] = []
    if (c.right > box.right - 4) fails.push(`clock r${Math.round(c.right)} past the card r${Math.round(box.right)}`)
    for (const b of btns) if (b.left < c.right && b.right > c.left && b.top < c.bottom && b.bottom > c.top) fails.push('a button over the clock')
    const go = el.querySelector('.approval-task-link-go')?.getBoundingClientRect()
    if (go && (go.width === 0 || go.right > box.right - 4)) fails.push('the task link arrow out of sight')
    return fails.join('; ') || 'fits'
  })).toBe('fits')
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-jump-org.png` })
  await card.getByTestId('approval-task-link').click()
  await expect.poll(() => new URL(page.url()).pathname).toBe('/')
  await landed()
  // From the request's dialog: the link closes it on the way.
  await card.getByTestId('approval-what').click()
  await expect(dialog).toBeVisible()
  await dialog.getByTestId('approval-task-link').click()
  await expect(dialog).toHaveCount(0)
  await landed()
})

// 2026-11-06: the title passed at 1280 with the sidebar shut and was cut 4px sideways with it
// open (the corner 228px wide): the command's code box was cloned at each line break, and line
// breaking left out the clone's end padding. Every corner width, the words shut and opened.
test('at every corner width the words and the command are never cut sideways', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const sock = await routeSocket(page)
  await boot(page, sock)
  sock()!.send(noticeEvent('widths', { body: BODY }))
  const toast = page.locator('.corner-stack .notification-toast', { hasText: 'managed daemon update' })
  await expect(toast).toBeVisible()
  await expect.poll(() => toast.evaluate((el) => el.getAnimations().length)).toBe(0)
  const cutAt = () => page.evaluate(() => {
    const out: string[] = []
    const style = document.createElement('style')
    document.head.append(style)
    for (let w = 200; w <= 420; w++) {
      style.textContent = `.corner-stack { width: ${w}px !important; }`
      for (const part of ['.notification-toast-title', '.notification-toast-body', '.notification-toast-detail']) {
        const el = document.querySelector<HTMLElement>(`.corner-stack .notification-toast ${part}`)
        if (el && el.scrollWidth - el.clientWidth > 1) out.push(`${w}px ${part} +${el.scrollWidth - el.clientWidth}`)
      }
    }
    style.remove()
    return out
  })
  expect(await cutAt(), 'shut').toEqual([])
  await toast.getByTestId('notice-details').click()
  await expect(toast.getByTestId('notification-toast-detail')).toBeVisible()
  expect(await cutAt(), 'opened').toEqual([])
})
