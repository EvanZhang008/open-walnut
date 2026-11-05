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
