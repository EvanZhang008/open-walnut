/**
 * The phone's bell and notification center (spec 4.7 "Notification center";
 * C55, C56, C23, C90, C18, C19). The bell sits in the top bar's right slot on
 * every page, counts what the drawer's bell counts (attentionCount), and opens
 * the center as a full-screen layer that Back closes; cards answer in place.
 *
 * The feed is a route stub and the WebSocket lane is a fake the test drives
 * (the fixture's real feed is shared global state, see notification-bell-badge
 * .spec.ts): the test pushes `session:permission-resolved` itself after an
 * answer, as the server would. Answers go to a stubbed route; nothing reaches a
 * session.
 */
import fs from 'node:fs/promises'
import { expect, test, type Page, type WebSocketRoute } from '@playwright/test'
import type { FeedRecord } from '../../../web/src/contexts/notifications/NotificationProvider'
import { isolateUiPrefs } from './todo-panel-helpers'
import {
  PHONE, backButton, expectNoHorizontalOverflow, findSmallTargets, findSmallText, menuButton, openDrawer,
} from './phone-helpers'

const SHOTS = '/tmp/mobile-web/phone-notifications'

test.use({
  viewport: PHONE.viewport,
  screen: PHONE.screen,
  deviceScaleFactor: PHONE.deviceScaleFactor,
  isMobile: true,
  hasTouch: true,
  userAgent: PHONE.userAgent,
})

test.beforeAll(async () => { await fs.mkdir(SHOTS, { recursive: true }) })

function ask(n: number, tool: string): FeedRecord {
  return {
    id: `pwn-perm-${n}`, kind: 'permission', severity: 'warning',
    title: tool, body: `Phone fixture ask ${n}`,
    timestamp: Date.now() - n * 10_000, read: false, dedupKey: `perm:pwn-r${n}`,
    // One session per ask: two asks of one session fold into one card.
    requestId: `pwn-r${n}`, toolName: tool, sessionId: `pwn-s${n}`,
  } as FeedRecord
}

interface Lane { sockets: WebSocketRoute[]; answers: string[]; frames: string[] }

/** A server event to every socket the page opened (a reconnect opens a new one). */
function pushEvent(lane: Lane, name: string, data: Record<string, unknown>): void {
  for (const ws of lane.sockets) {
    try { ws.send(JSON.stringify({ type: 'event', name, data, seq: Date.now() })) } catch { /* closed */ }
  }
}

async function bootWithFeed(page: Page, feed: FeedRecord[]): Promise<{ lane: Lane; errors: string[] }> {
  const lane: Lane = { sockets: [], answers: [], frames: [] }
  await page.routeWebSocket('**/ws*', (ws) => {
    lane.sockets.push(ws)
    ws.onMessage((m) => { lane.frames.push(String(m)) })
  })
  await page.route('**/api/notifications', (route) => route.fulfill({ json: { feed, unreadCount: feed.filter((f) => !f.read).length } }))
  await page.route('**/api/notifications/mark-read', (route) => route.fulfill({ json: { unreadCount: 0 } }))
  await page.route('**/api/sessions/*/permission', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    lane.answers.push(route.request().postData() ?? '')
    await route.fulfill({ json: { ok: true } })
  })
  await isolateUiPrefs(page)
  await page.addInitScript(() => {
    try { localStorage.setItem('open-walnut-home-chat-visible', 'false') } catch { /* storage off */ }
  })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await expect(menuButton(page)).toBeVisible({ timeout: 30_000 })
  return { lane, errors }
}

const bell = (page: Page) => page.locator('.phone-topbar').getByTestId('phone-bell')
const center = (page: Page) => page.locator('.notification-panel')

async function openCenter(page: Page): Promise<void> {
  await bell(page).tap()
  await expect(center(page)).toBeVisible()
  await expect(page.locator('.phone-topbar-title-text')).toHaveText('Notifications')
}

const markerId = (page: Page) => page.evaluate(() => (history.state as { walnutOverlay?: { id: string } } | null)?.walnutOverlay?.id ?? null)

function letter(n: number): FeedRecord {
  return {
    id: `pwn-letter-${n}`, kind: 'letter', severity: 'info', title: `Phone fixture letter ${n}`, body: 'A report',
    timestamp: Date.now() - n * 20_000, read: false, dedupKey: `letter:pwn-l${n}`, letterId: `pwn-l${n}`,
  } as FeedRecord
}

test('C55: the bell is in the bar, says the drawer row\'s number, and opens the center as a layer', async ({ page }) => {
  // N2-05: one count rule. Two asks and an unread letter: the bar's bell and the
  // drawer's Notifications row both say 3 (attentionCount), never 2 beside 3.
  const { errors } = await bootWithFeed(page, [ask(1, 'Bash'), ask(2, 'Edit'), letter(1)])
  const b = bell(page)
  await expect(b).toHaveAttribute('aria-label', 'Notifications, 3 new', { timeout: 15_000 })
  await expect(page.locator('.sidebar-notification-btn .notification-badge-count')).toHaveText('3')
  const box = (await b.boundingBox())!
  expect(box.width).toBeGreaterThanOrEqual(44)
  expect(box.height).toBeGreaterThanOrEqual(44)
  await expect(b.locator('.phone-bell-count')).toHaveText('3')
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-bell.png` })

  await openCenter(page)
  expect(await markerId(page)).toBe('notifications')
  // The two asks answer right here; the letter waits on the Inbox tab.
  const answerable = page.locator('.notification-panel .nfc-perm-card')
  await expect(answerable).toHaveCount(2)
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-center.png` })

  // C23: back closes the center only.
  await page.goBack()
  await expect(center(page)).toHaveCount(0)
  await expect(bell(page)).toBeVisible()
  expect(new URL(page.url()).pathname).toBe('/')
  await expect(page.locator('.sidebar.open')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('N1, N2-05: letters alone count on both bells alike, and Needs Action says so in the middle', async ({ page }) => {
  const { errors } = await bootWithFeed(page, [letter(1), letter(2), letter(3)])
  await expect(page.locator('.sidebar-notification-btn .notification-badge-count')).toHaveText('3', { timeout: 15_000 })
  await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications, 3 new')
  await expect(bell(page).locator('.phone-bell-count')).toHaveText('3')
  await openCenter(page)
  await page.locator('.notification-panel .nfc-rail-btn', { hasText: 'Needs Action' }).first().tap()
  const empty = page.locator('.notification-panel .notification-feed-empty').first()
  await expect(empty).toBeVisible()
  const e = (await empty.boundingBox())!
  const vw = page.viewportSize()!.width
  // Centered across the screen, readable size.
  expect(Math.abs(e.x + e.width / 2 - vw / 2)).toBeLessThan(24)
  expect(await empty.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(15)
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-n1-empty.png` })
  expect(errors).toEqual([])
})

test('C55: the bell is on the Notes page too, and shows no number at zero', async ({ page }) => {
  const { errors } = await bootWithFeed(page, [])
  await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications, 0 new', { timeout: 15_000 })
  await expect(bell(page).locator('.phone-bell-count')).toHaveCount(0)
  await openDrawer(page)
  await page.locator('#primary-sidebar').getByRole('link', { name: 'Notes' }).click()
  await expect(page).toHaveURL(/\/notes/)
  await expect(bell(page)).toBeVisible()
  await expect(bell(page).locator('.phone-bell-count')).toHaveCount(0)
  // A layer with a bar owns the slot: Back, its title, its own action.
  await openCenter(page)
  await expect(bell(page)).toHaveCount(0)
  await backButton(page).click()
  await expect(center(page)).toHaveCount(0)
  await expect(bell(page)).toBeVisible()
  expect(errors).toEqual([])
})

test('C56: a card answers in place, quiet mode leads the center, and the bell counts down', async ({ page }) => {
  const { lane, errors } = await bootWithFeed(page, [ask(1, 'Bash'), ask(2, 'Edit')])
  await expect(bell(page).locator('.phone-bell-count')).toHaveText('2', { timeout: 15_000 })
  await openCenter(page)
  const quiet = page.getByTestId('nfc-quiet-toggle')
  const q = (await quiet.boundingBox())!
  expect(q.width).toBeGreaterThanOrEqual(44)
  expect(q.height).toBeGreaterThanOrEqual(44)
  const firstCard = (await page.locator('.notification-panel .nfc-perm-card').first().boundingBox())!
  expect(q.y).toBeLessThan(firstCard.y)

  const card = page.locator('.notification-panel .nfc-perm-card', { hasText: 'Phone fixture ask 1' })
  const approve = card.getByRole('button', { name: /^(Approve|Allow)/ }).first()
  await expect(approve).toBeVisible()
  const a = (await approve.boundingBox())!
  expect(a.height).toBeGreaterThanOrEqual(44)
  await page.waitForTimeout(700) // past the buttons' arm-after-appear window
  await approve.tap()
  await expect.poll(() => lane.answers.length).toBe(1)
  expect(JSON.parse(lane.answers[0])).toMatchObject({ requestId: 'pwn-r1', allow: true })
  // Answered in place: the card says so at once, in the center.
  await expect(card.locator('.notification-feed-item-resolved')).toBeVisible({ timeout: 10_000 })
  await expect(center(page)).toBeVisible()
  // The server's word that it settled (what the real lane sends after an
  // answer): the card leaves Needs Action.
  pushEvent(lane, 'session:permission-resolved', { sessionId: 'pwn-s1', requestId: 'pwn-r1', allowed: true })
  await expect(card).toHaveCount(0, { timeout: 10_000 })
  await backButton(page).click()
  await expect(bell(page).locator('.phone-bell-count')).toHaveText('1', { timeout: 10_000 })
  await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications, 1 new')
  expect(errors).toEqual([])
})

for (const size of [{ width: 390, height: 844 }, { width: 375, height: 667 }, { width: 320, height: 568 }]) {
  test(`C18, C19: the center at ${size.width}x${size.height}: no small target, no small text, no sideways scroll`, async ({ page }) => {
    await page.setViewportSize(size)
    const { errors } = await bootWithFeed(page, [ask(1, 'Bash'), ask(2, 'Edit')])
    await openCenter(page)
    await expect(page.locator('.notification-panel .nfc-perm-card').first()).toBeVisible()
    await page.waitForTimeout(700)
    await expectNoHorizontalOverflow(page)
    const small = await findSmallTargets(page, '.notification-panel')
    const text = await findSmallText(page, 12, '.notification-panel')
    console.log(`[C18/C19 center ${size.width}] small targets: ${JSON.stringify(small)} small text: ${JSON.stringify(text)}`)
    await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-center-${size.width}.png` })
    expect(small).toEqual([])
    expect(text).toEqual([])
    expect(errors).toEqual([])
  })
}

test('C90: pulling the center down 64 px runs the resync in place and says Updated', async ({ page }) => {
  const { lane, errors } = await bootWithFeed(page, [ask(1, 'Bash')])
  await openCenter(page)
  const framesBefore = lane.frames.length
  // WebKit has no Touch constructor: plain Events carrying their touch lists.
  await page.evaluate(async () => {
    const el = document.querySelector('.notification-panel .nfc-detail .nfc-perm-card') ?? document.querySelector('.notification-panel .nfc-detail')
    if (!el) throw new Error('no center body')
    const at = (y: number) => ({ identifier: 1, target: el, clientX: 200, clientY: y, pageX: 200, pageY: y })
    const fire = (type: string, y: number | null, end: number) => {
      const ev = new Event(type, { bubbles: true, cancelable: true })
      const list = y === null ? [] : [at(y)]
      Object.defineProperty(ev, 'touches', { value: list })
      Object.defineProperty(ev, 'targetTouches', { value: list })
      Object.defineProperty(ev, 'changedTouches', { value: [at(y ?? end)] })
      el.dispatchEvent(ev)
    }
    fire('touchstart', 220, 0)
    for (let i = 1; i <= 8; i++) { fire('touchmove', 220 + i * 12, 0); await new Promise((r) => setTimeout(r, 16)) }
    fire('touchend', null, 316)
  })
  await expect(page.getByTestId('phone-pull-notifications')).toHaveText('Updated', { timeout: 10_000 })
  await expect(center(page)).toBeVisible()
  expect(new URL(page.url()).pathname).toBe('/')
  // The same resync as coming back to the foreground: this lane never answers,
  // so the client pings it (and then reconnects).
  expect(lane.frames.slice(framesBefore).some((f) => /"method":"ping"/.test(f))).toBe(true)
  await expect(page.getByTestId('phone-pull-notifications')).toHaveCount(0, { timeout: 3_000 })
  expect(errors).toEqual([])
})

function failure(n: number): FeedRecord {
  return {
    id: `pwn-err-${n}`, kind: 'operation-error', severity: 'error',
    title: `Task sync cannot import the reading list number ${n} from the remote service`,
    body: 'The remote service answered 503.', timestamp: Date.now() - n * 30_000, read: false,
    dedupKey: `err:pwn-${n}`, count: 140, resolved: n === 1 ? 'recovered' : undefined,
  } as FeedRecord
}

test('N9: a card title has its own line, and the section the center opens on is in view', async ({ page }) => {
  const { errors } = await bootWithFeed(page, [failure(1), failure(2), letter(1)])
  await openCenter(page)
  // No asks: the center lands on All, the strip's last entry. It must be on screen.
  const active = page.locator('.notification-panel .nfc-rail-btn.nfc-active')
  await expect(active).toBeVisible()
  const vw = page.viewportSize()!.width
  await expect.poll(async () => {
    const b = await active.boundingBox()
    return !!b && b.x >= 0 && b.x + b.width <= vw
  }, { message: JSON.stringify(await active.evaluate((el) => {
    const rail = el.closest('.nfc-rail') as HTMLElement
    const cs = getComputedStyle(rail)
    return { a: el.getBoundingClientRect().toJSON(), r: rail.getBoundingClientRect().toJSON(), sl: rail.scrollLeft, sw: rail.scrollWidth, cw: rail.clientWidth, ox: cs.overflowX, disp: cs.display, text: el.textContent }
  })) }).toBe(true)
  const card = page.locator('.notification-panel .notification-feed-item').first()
  await expect(card).toBeVisible()
  const geo = await card.evaluate((el) => {
    const title = el.querySelector('.notification-feed-item-title')!.getBoundingClientRect()
    const time = el.querySelector('.notification-feed-item-time')!.getBoundingClientRect()
    return { title: title.width, card: el.getBoundingClientRect().width, titleBottom: title.bottom, timeTop: time.top }
  })
  expect(geo.title).toBeGreaterThan(geo.card * 0.6)
  expect(geo.timeTop).toBeGreaterThanOrEqual(geo.titleBottom - 2)
  expect(await findSmallText(page, 12, '.notification-panel')).toEqual([])
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-n9-cards.png` })
  expect(errors).toEqual([])
})

for (const width of [390, 375, 320]) {
  test(`C19: the permission toast at ${width} px: 44 px answers, 12 px text`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 812 })
    const { lane, errors } = await bootWithFeed(page, [])
    await expect.poll(() => lane.sockets.length, { timeout: 15_000 }).toBeGreaterThan(0)
    pushEvent(lane, 'notification:new', { ...ask(7, 'Bash'), timestamp: Date.now() } as unknown as Record<string, unknown>)
    const toast = page.locator('.nfc-perm-toast').first()
    await expect(toast).toBeVisible({ timeout: 15_000 })
    await expect(toast.locator('.nfc-perm-btn').first()).toBeVisible()
    const small = await findSmallTargets(page, '.nfc-perm-toast')
    expect(small, JSON.stringify(small)).toEqual([])
    const tiny = await findSmallText(page, 12, '.nfc-perm-toast')
    expect(tiny, JSON.stringify(tiny)).toEqual([])
    await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-c19-perm-toast-${width}.png` })
    expect(errors).toEqual([])
  })
}

test('N2-12: a question in the center has full-width 48 px rows, a 44 px Other at 16 px, a reason under Submit, and a human title', async ({ page }) => {
  const q: FeedRecord = {
    id: 'pwn-question', kind: 'permission', severity: 'warning', title: 'AskUserQuestion', body: 'Which bed first?',
    timestamp: Date.now() - 5_000, read: false, dedupKey: 'perm:pwn-q1', requestId: 'pwn-q1', toolName: 'AskUserQuestion', sessionId: 'pwn-sq',
    input: { questions: [{ header: 'Beds', question: 'Which bed first?', multiSelect: false, options: [
      { label: 'Fix and continue (Recommended)', description: 'Water the north bed first' }, { label: 'Keep it as is', description: 'Leave the order' },
    ] }] },
  } as unknown as FeedRecord
  const { errors } = await bootWithFeed(page, [q])
  await openCenter(page)
  const card = page.locator('.notification-panel .nfc-perm-card', { hasText: 'Which bed first?' }).first()
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card.locator('.notification-feed-item-title')).toHaveText('Question')
  const cardBox = (await card.boundingBox())!
  const opts = card.locator('.nfc-answer-opt')
  await expect(opts).toHaveCount(2)
  for (const o of await opts.all()) {
    const b = (await o.boundingBox())!
    expect(b.height).toBeGreaterThanOrEqual(48)
    expect(b.width).toBeGreaterThanOrEqual(cardBox.width * 0.8)
  }
  const other = card.locator('.nfc-answer-input')
  expect((await other.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  expect(await other.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16)
  await expect(card.getByTestId('nfc-answer-hint')).toBeVisible()
  await opts.first().tap()
  await expect(card.getByTestId('nfc-answer-hint')).toHaveCount(0)
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-n2-12-question.png` })
  expect(errors).toEqual([])
})

test('C19: a decision letter in the center takes a finger (Pin, Mark read, Archive) and reads 12 px', async ({ page }) => {
  // What the live center leads with: a letter that waits on a decision.
  const letterRow = {
    id: 'pwn-decision-1', subject: 'Pick the bed order', type: 'action_required', bodyFormat: 'markdown',
    textPreview: 'Two options for the spring beds.', createdAt: Date.now() - 30 * 60_000, read: false, pinned: false, archived: false,
    sender: { sessionId: 'pwn-letter-session', sessionTitle: 'Bed planning', taskTitle: 'Plan the spring beds', project: 'Garden', host: 'local' },
    actions: [{ id: 'a', label: 'North first' }, { id: 'b', label: 'South first' }],
  }
  await page.route('**/api/v1/human-inbox**', (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: [letterRow] })
    : route.fulfill({ json: { ok: true } }))
  const { errors } = await bootWithFeed(page, [])
  await openCenter(page)
  // A decision letter sits in Needs Action (the center opens on All with no feed).
  await center(page).getByRole('button', { name: /^Needs Action/ }).tap()
  const row = center(page).locator('.hib-list').first()
  await expect(row).toBeVisible({ timeout: 15_000 })
  await expect(row.getByText('Pick the bed order')).toBeVisible()
  for (const width of [390, 375, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 844 })
    await page.waitForTimeout(300)
    await row.scrollIntoViewIfNeeded()
    const small = await findSmallTargets(page, '.notification-panel .hib-list')
    expect(small, `${width}: ${JSON.stringify(small)}`).toEqual([])
    const tiny = await findSmallText(page, 12, '.notification-panel .hib-list')
    expect(tiny, `${width}: ${JSON.stringify(tiny)}`).toEqual([])
  }
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-c19-letter-row.png` })
  expect(errors).toEqual([])
})
