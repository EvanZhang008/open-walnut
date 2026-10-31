/**
 * The phone's home list (spec 4.2, 4.5, 4.7 Home): rows that open under the
 * thumb and never complete or rename by accident (C57, C59), an order that
 * holds still while touched or covered (C61), the words a row says instead of
 * a color or a tooltip (C66, C67, C68), no hover-only control (C37, C86), the
 * 44 px / 12 px / no-overflow scans (C18, C19), the home indicator inset (C20),
 * 16 px fields (C28) and pull to refresh (C90).
 *
 * iPhone 15 emulation; WebKit first (`PW_WEBKIT=1 --project webkit`), chromium
 * too. First load is a `goto`; the rest are taps. Seeded rows are created over
 * the fixture's REST API in a project of their own and deleted after.
 */
import fs from 'node:fs/promises'
import { expect, test, type Page, type Request } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { presetPanelDesign } from './status-section-helpers'
import {
  PHONE, backButton, expectNoHorizontalOverflow, findSmallTargets, findSmallText, injectSafeArea, menuButton,
} from './phone-helpers'

const SHOTS = '/tmp/mobile-web/phone-home'
const SESSION_TASK_TITLE = 'Quarterly invoice reconciliation'
const SESSION_ID = 'pw-idref-target-session'

test.use({
  viewport: PHONE.viewport,
  screen: PHONE.screen,
  deviceScaleFactor: PHONE.deviceScaleFactor,
  isMobile: true,
  hasTouch: true,
  userAgent: PHONE.userAgent,
})

test.beforeAll(async () => { await fs.mkdir(SHOTS, { recursive: true }) })

const created: string[] = []
test.afterEach(async ({ page }) => {
  for (const id of created.splice(0)) await page.request.delete(`/api/tasks/${id}?force=true`).catch(() => {})
})

/** The fixture session reads as running, or blocked on a prompt when `tool` is given. */
async function patchSessionStatus(page: Page, status: { process_status: string; pendingPermissionTool?: string }): Promise<void> {
  await page.route('**/api/sessions/status**', async (route) => {
    const res = await route.fetch()
    const body = await res.json().catch(() => ({})) as { statuses?: Record<string, Record<string, unknown>> }
    const statuses = body.statuses ?? {}
    for (const [key, snap] of Object.entries(statuses)) {
      if (key === SESSION_ID || snap.claudeSessionId === SESSION_ID || snap.sessionId === SESSION_ID) {
        Object.assign(snap, status, { version: Number(snap.version ?? 0) + 1000 })
      }
    }
    await route.fulfill({ response: res, json: { ...body, statuses } })
  })
}

async function bootHome(page: Page): Promise<string[]> {
  await isolateUiPrefs(page)
  // The rows that need you (C67, C68) are checked in their project tree; By project
  // keeps them there (Flat, the default, draws them in the Needs you section).
  await presetPanelDesign(page, 'project')
  await page.addInitScript(() => {
    try {
      if (sessionStorage.getItem('phone-home-seeded')) return
      sessionStorage.setItem('phone-home-seeded', '1')
      localStorage.setItem('open-walnut-home-chat-visible', 'false')
    } catch { /* storage off */ }
  })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await expect(menuButton(page)).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 30_000 })
  return errors
}

/**
 * Every write to a task the page sends, except the read mark: opening a row
 * whose agent output is unread marks it read, which is what opening is for.
 */
function recordTaskWrites(page: Page): Request[] {
  const writes: Request[] = []
  page.on('request', (r) => {
    if (r.method() === 'GET' || r.method() === 'HEAD' || !/\/api\/(v1\/)?tasks/.test(r.url())) return
    let body: Record<string, unknown> = {}
    try { body = JSON.parse(r.postData() || '{}') as Record<string, unknown> } catch { /* not JSON */ }
    const keys = Object.keys(body)
    if (r.method() === 'PATCH' && keys.length === 1 && keys[0] === 'unread' && body.unread === false) return
    writes.push(r)
  })
  return writes
}

async function createTask(page: Page, data: Record<string, unknown>): Promise<string> {
  // pinned:false keeps a new task in its project's list (a new task lands in Focus otherwise).
  const res = await page.request.post('/api/tasks', { data: { source: 'local', pinned: false, ...data } })
  if (!res.ok()) throw new Error(`seed create failed: ${res.status()} ${await res.text()}`)
  const id = ((await res.json()) as { task: { id: string } }).task.id
  created.push(id)
  return id
}

const row = (page: Page, title: string) => page.locator('.todo-panel .todo-panel-item', { has: page.locator('.todo-item-title', { hasText: title }) }).first()

/** A project lists its first rows and a `Show more`: press it until `title`'s row is in. */
async function revealRow(page: Page, title: string): Promise<void> {
  for (let i = 0; i < 8; i++) {
    if (await row(page, title).count() > 0) break
    const more = page.locator('.todo-panel').getByRole('button', { name: 'Show more' }).first()
    if (await more.count() === 0) break
    await more.scrollIntoViewIfNeeded()
    await more.tap()
  }
  await row(page, title).scrollIntoViewIfNeeded()
}
const sessionOverlay = (page: Page) => page.locator('.main-page-session-column.is-mobile-active')

/** A fresh profile shows every project folded: open one by its header. */
async function expandProject(page: Page, name: string): Promise<void> {
  const header = page.locator('.todo-panel .todo-group-project-header', {
    has: page.locator('.todo-group-project-name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }),
  }).first()
  await expect(header).toBeVisible({ timeout: 15_000 })
  await header.scrollIntoViewIfNeeded()
  // The whole row folds on a phone (its name and chevron are pictures there).
  if (/to expand/.test((await header.getAttribute('title')) ?? '')) await header.tap({ position: { x: 48, y: 22 } })
  await expect(header).not.toHaveAttribute('title', /to expand/)
}

async function closeOverlay(page: Page): Promise<void> {
  await backButton(page).click()
  await expect(sessionOverlay(page)).toHaveCount(0)
  await expect(menuButton(page)).toBeVisible()
}

/** Row ids in DOM order, for the rows whose task id is in `ids`. */
async function orderOf(page: Page, ids: string[]): Promise<string[]> {
  return page.evaluate((want) => Array.from(document.querySelectorAll<HTMLElement>('.todo-panel .todo-panel-item[data-task-id]'))
    .map((el) => el.dataset.taskId ?? '').filter((id) => want.includes(id)), ids)
}

test('C57: a tap anywhere on the left of a session row opens it, never completes it', async ({ page }) => {
  await patchSessionStatus(page, { process_status: 'running' })
  const errors = await bootHome(page)
  await expandProject(page, 'Walnut')
  await revealRow(page, SESSION_TASK_TITLE)
  const writes = recordTaskWrites(page)
  const target = row(page, SESSION_TASK_TITLE)
  await target.scrollIntoViewIfNeeded()
  await expect(target).toBeVisible({ timeout: 15_000 })
  const circle = target.locator('.task-phase-icon-btn')
  await expect(circle).toHaveAttribute('aria-hidden', 'true')
  await expect(circle).toHaveAttribute('tabindex', '-1')
  const phaseBefore = await page.request.get('/api/tasks').then((r) => r.json())
    .then((b: { tasks: { title: string; phase: string }[] }) => b.tasks.find((t) => t.title === SESSION_TASK_TITLE)?.phase)
  for (const x of [8, 19, 30, 41, 52]) {
    await target.scrollIntoViewIfNeeded()
    const box = (await target.boundingBox())!
    await page.touchscreen.tap(x, box.y + box.height / 2)
    await expect(sessionOverlay(page)).toBeVisible({ timeout: 15_000 })
    await closeOverlay(page)
  }
  expect(writes.map((r) => `${r.method()} ${r.url()} ${r.postData() ?? ''}`)).toEqual([])
  const phaseAfter = await page.request.get('/api/tasks').then((r) => r.json())
    .then((b: { tasks: { title: string; phase: string }[] }) => b.tasks.find((t) => t.title === SESSION_TASK_TITLE)?.phase)
  expect(phaseAfter).toBe(phaseBefore)
  expect(errors).toEqual([])
})

test('C59: open a row, Back, tap the same title: it opens again, nothing turns editable', async ({ page }) => {
  const errors = await bootHome(page)
  await expandProject(page, 'Walnut')
  await revealRow(page, SESSION_TASK_TITLE)
  const title = row(page, SESSION_TASK_TITLE).locator('.todo-item-title')
  await title.scrollIntoViewIfNeeded()
  await title.tap()
  await expect(sessionOverlay(page)).toBeVisible({ timeout: 15_000 })
  await closeOverlay(page)
  const vvBefore = await page.evaluate(() => window.visualViewport?.height ?? window.innerHeight)
  await title.scrollIntoViewIfNeeded()
  await title.tap()
  await expect(sessionOverlay(page)).toBeVisible({ timeout: 15_000 })
  expect(await page.locator('[contenteditable="true"]:not(.ProseMirror)').count()).toBe(0)
  await expect(page.locator('.todo-item-title.editing')).toHaveCount(0)
  expect(await page.evaluate(() => window.visualViewport?.height ?? window.innerHeight)).toBe(vvBefore)
  await closeOverlay(page)
  expect(errors).toEqual([])
})

test('C59: a row with no session opens its task detail; renaming lives there', async ({ page }) => {
  const errors = await bootHome(page)
  await expandProject(page, 'Walnut')
  await revealRow(page, SESSION_TASK_TITLE)
  const title = `Phone rename probe ${test.info().project.name}`
  await createTask(page, { title, project: 'Phone probe' })
  await expandProject(page, 'Phone probe')
  const r = row(page, title)
  await expect(r).toBeVisible({ timeout: 15_000 })
  await r.scrollIntoViewIfNeeded()
  await r.locator('.todo-item-title').tap()
  await expect(page.locator('.task-detail-modal-overlay.is-phone-layer')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.phone-topbar-title-text')).toHaveText(title)
  expect(await page.locator('.todo-panel [contenteditable="true"]').count()).toBe(0)
  const field = page.locator('.phone-detail-title')
  expect(parseFloat(await field.evaluate((el) => getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16)
  await page.goBack()
  await expect(page.locator('.task-detail-modal-overlay')).toHaveCount(0)
  expect(errors).toEqual([])
})

/** Two rows of one fresh project: B (newer) above A under the default newest-first sort. */
async function seedPair(page: Page, tag: string): Promise<{ a: string; b: string }> {
  const project = `Phone order ${tag} ${test.info().project.name}`
  const a = await createTask(page, { title: `Order probe A ${tag}`, project })
  await page.waitForTimeout(1100) // distinct updated_at
  const b = await createTask(page, { title: `Order probe B ${tag}`, project })
  await expandProject(page, project)
  await expect.poll(() => orderOf(page, [a, b]), { timeout: 15_000 }).toEqual([b, a])
  return { a, b }
}

test('C61: a reorder pushed while a session layer is open waits behind a pill', async ({ page }) => {
  const errors = await bootHome(page)
  await expandProject(page, 'Walnut')
  await revealRow(page, SESSION_TASK_TITLE)
  const { a, b } = await seedPair(page, 'layer')
  const title = row(page, SESSION_TASK_TITLE).locator('.todo-item-title')
  await title.scrollIntoViewIfNeeded()
  await title.tap()
  await expect(sessionOverlay(page)).toBeVisible({ timeout: 15_000 })
  // The fixture pushes a change that moves A to the top (newest activity first).
  const patch = await page.request.patch(`/api/tasks/${a}`, { data: { phase: 'IN_PROGRESS' } })
  expect(patch.ok()).toBe(true)
  await page.waitForTimeout(4500) // past the list's own 3 s re-sort debounce
  expect(await orderOf(page, [a, b])).toEqual([b, a])
  const pill = page.getByTestId('phone-updates-pill')
  await expect(pill).toHaveText(/^(1 update|\d+ updates)$/)
  // Back by a tap: the touch keeps the list still for 2 s more.
  await backButton(page).tap()
  await expect(sessionOverlay(page)).toHaveCount(0)
  // Still held right after the Back tap (a touch), then the pill applies it.
  expect(await orderOf(page, [a, b])).toEqual([b, a])
  const box = (await pill.boundingBox())!
  expect(box.height).toBeGreaterThanOrEqual(44)
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-c61-pill.png` })
  await pill.tap()
  await expect.poll(() => orderOf(page, [a, b])).toEqual([a, b])
  await expect(pill).toHaveCount(0)
  expect(errors).toEqual([])
})

test('C61: a reorder pushed while the list is being touched is held, then applies at rest at the top', async ({ page }) => {
  const errors = await bootHome(page)
  await expandProject(page, 'Walnut')
  await revealRow(page, SESSION_TASK_TITLE)
  const { a, b } = await seedPair(page, 'touch')
  // A thumb resting on and nudging the list: touch events every 400 ms.
  await page.evaluate(() => {
    const list = document.querySelector('.todo-panel .home-navigation-scroll') ?? document.querySelector('.todo-panel .todo-panel-list')
    const w = window as unknown as { __touching?: ReturnType<typeof setInterval> }
    w.__touching = setInterval(() => {
      list?.dispatchEvent(new Event('touchstart', { bubbles: true }))
      list?.dispatchEvent(new Event('touchend', { bubbles: true }))
    }, 400)
  })
  await page.request.patch(`/api/tasks/${a}`, { data: { phase: 'IN_PROGRESS' } })
  await page.waitForTimeout(4500)
  expect(await orderOf(page, [a, b])).toEqual([b, a])
  await expect(page.getByTestId('phone-updates-pill')).toBeVisible()
  // Hands off, list at its top: the queue applies by itself after 2 s.
  await page.evaluate(() => {
    const w = window as unknown as { __touching?: ReturnType<typeof setInterval> }
    clearInterval(w.__touching)
    const box = document.querySelector<HTMLElement>('.todo-panel .home-navigation-scroll.is-stacked') ?? document.querySelector<HTMLElement>('.todo-panel .todo-panel-list')
    if (box) box.scrollTop = 0
  })
  await expect.poll(() => orderOf(page, [a, b]), { timeout: 8_000 }).toEqual([a, b])
  await expect(page.getByTestId('phone-updates-pill')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('C66, C67: a row says Needs you in words, a prompt names its tool, attention beats unread', async ({ page }) => {
  await patchSessionStatus(page, { process_status: 'running', pendingPermissionTool: 'Bash' })
  const errors = await bootHome(page)
  await expandProject(page, 'Walnut')
  await revealRow(page, SESSION_TASK_TITLE)
  const title = `Needs you probe ${test.info().project.name}`
  const id = await createTask(page, { title, project: 'Phone probe' })
  await expandProject(page, 'Phone probe')
  await page.request.patch(`/api/tasks/${id}`, { data: { phase: 'NEED_ACTION', unread: true } })
  const handed = row(page, title)
  await handed.scrollIntoViewIfNeeded()
  await expect(handed.locator('.phone-row-needs-you')).toHaveText('Needs you', { timeout: 15_000 })
  // The unread dot (a color only) steps aside for the words.
  await expect(handed.locator('.task-unread-dot')).toBeHidden()
  const prompted = row(page, SESSION_TASK_TITLE)
  await prompted.scrollIntoViewIfNeeded()
  const words = prompted.locator('.phone-row-needs-you')
  await expect(words).toHaveText('Needs you: Bash', { timeout: 15_000 })
  // Whole words in a 390 px row: one line, not clipped.
  const fit = await words.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, h: el.getBoundingClientRect().height, right: el.getBoundingClientRect().right }))
  expect(fit.sw).toBeLessThanOrEqual(fit.cw + 1)
  expect(fit.h).toBeLessThan(30)
  expect(fit.right).toBeLessThanOrEqual(390)
  // Anything that says "Waiting for your answer" in a tooltip says it on screen too.
  const tooltipOnly = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('[title*="Waiting for your answer"]'))
    .filter((el) => el.getClientRects().length > 0 && !/Needs you: /.test(el.innerText)).length)
  expect(tooltipOnly).toBe(0)
  expect(await page.locator('.todo-panel').innerText()).not.toContain('Bypass')
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-c67-needs-you.png` })
  expect(errors).toEqual([])
})

test('C68: a collapsed leader says 1 need you, and the tap shows the worker', async ({ page }) => {
  const errors = await bootHome(page)
  await expandProject(page, 'Walnut')
  await revealRow(page, SESSION_TASK_TITLE)
  const tag = test.info().project.name
  const leader = await createTask(page, { title: `Leader probe ${tag}`, project: 'Phone probe' })
  const worker = await createTask(page, { title: `Worker probe ${tag}`, project: 'Phone probe' })
  const linked = await page.request.patch(`/api/tasks/${worker}`, { data: { parent_task_id: leader } })
  expect(linked.ok(), await linked.text()).toBe(true)
  await page.request.patch(`/api/tasks/${worker}`, { data: { phase: 'NEED_ACTION' } })
  await expandProject(page, 'Phone probe')
  const parent = page.locator(`.todo-panel .todo-panel-item[data-task-id="${leader}"]`)
  await expect(parent).toBeVisible({ timeout: 15_000 })
  await parent.scrollIntoViewIfNeeded()
  const chevron = parent.locator('.collapse-chevron')
  if (await chevron.evaluate((el) => el.classList.contains('expanded'))) await chevron.tap()
  await expect(page.locator(`.todo-panel .todo-panel-item[data-task-id="${worker}"]`)).toHaveCount(0)
  const pill = parent.locator('.phone-row-need-you-parent')
  await expect(pill).toHaveText('1 need you')
  const box = (await pill.boundingBox())!
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  await pill.tap()
  const child = page.locator(`.todo-panel .todo-panel-item[data-task-id="${worker}"]`)
  await expect(child).toBeInViewport({ timeout: 5_000 })
  await expect(child).toHaveClass(/phone-row-highlight/)
  await expect(child).not.toHaveClass(/phone-row-highlight/, { timeout: 3_000 })
  expect(errors).toEqual([])
})

test('C37: with no hover the row kebab shows and opens on a tap', async ({ page }) => {
  const errors = await bootHome(page)
  await expandProject(page, 'Walnut')
  await revealRow(page, SESSION_TASK_TITLE)
  const r = row(page, SESSION_TASK_TITLE)
  await r.scrollIntoViewIfNeeded()
  const kebab = r.locator('.task-kebab-btn')
  expect(Number(await kebab.evaluate((el) => getComputedStyle(el).opacity))).toBeGreaterThan(0.3)
  await kebab.tap()
  await expect(page.locator('.task-kebab-menu').first()).toBeVisible()
  await page.keyboard.press('Escape')
  expect(errors).toEqual([])
})

/**
 * Rows use `content-visibility: auto`, so a row a script just scrolled to is
 * laid out but not yet painted or hit-testable. Wait for it, as a finger would.
 */
async function settlePaint(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 400)))))
  await expect.poll(() => page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.todo-panel .todo-panel-item, .todo-panel .todo-pinned-card'))
      .filter((el) => { const r = el.getBoundingClientRect(); return r.top > 120 && r.bottom < innerHeight - 60 })
    // No row on screen (only folded project headers): nothing to wait for.
    // Else any visible row whose own content answers a hit test (a sticky
    // header may cover the first one).
    return rows.length === 0 || rows.some((el) => {
      const r = el.getBoundingClientRect()
      const hit = document.elementFromPoint(Math.min(innerWidth - 60, r.left + 120), r.top + r.height / 2)
      return !!hit && hit !== el && el.contains(hit)
    })
  }), { timeout: 5_000 }).toBe(true)
}

for (const size of [{ width: 390, height: 844 }, { width: 375, height: 667 }, { width: 320, height: 568 }]) {
  test(`C18, C19: home at ${size.width}x${size.height} has no small target, no small text, no sideways scroll`, async ({ page }) => {
    await page.setViewportSize(size)
    const errors = await bootHome(page)
    await expandProject(page, 'Walnut')
    await revealRow(page, SESSION_TASK_TITLE)
    await expect(page.locator('.todo-panel .todo-panel-item').first()).toBeVisible({ timeout: 15_000 })
    await expectNoHorizontalOverflow(page)
    const small: unknown[] = []
    const text: unknown[] = []
    // Twice: at the session row, then at the top of the list.
    for (const where of ['row', 'top'] as const) {
      if (where === 'top') {
        await page.evaluate(() => {
          const box = document.querySelector<HTMLElement>('.todo-panel .home-navigation-scroll.is-stacked') ?? document.querySelector<HTMLElement>('.todo-panel .todo-panel-list')
          if (box) box.scrollTop = 0
        })
      }
      await settlePaint(page)
      small.push(...await findSmallTargets(page, '.todo-panel'))
      text.push(...await findSmallText(page, 12, '.todo-panel'))
      await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-home-${size.width}-${where}.png` })
    }
    console.log(`[C18/C19 home ${size.width}] small targets: ${JSON.stringify(small)} small text: ${JSON.stringify(text)}`)
    expect(small).toEqual([])
    expect(text).toEqual([])
    expect(errors).toEqual([])
  })
}

test('C20: with a home indicator inset the last row scrolls clear of it', async ({ page }) => {
  const errors = await bootHome(page)
  await expandProject(page, 'Walnut')
  await revealRow(page, SESSION_TASK_TITLE)
  await injectSafeArea(page, { bottom: 34 })
  const bottom = await page.evaluate(async () => {
    const box = document.querySelector<HTMLElement>('.todo-panel .home-navigation-scroll.is-stacked')
      ?? document.querySelector<HTMLElement>('.todo-panel .todo-panel-list')
    if (!box) return null
    box.scrollTop = box.scrollHeight
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const rows = box.querySelectorAll<HTMLElement>('.todo-panel-item')
    const last = rows[rows.length - 1]
    return last ? last.getBoundingClientRect().bottom : null
  })
  expect(bottom).not.toBeNull()
  expect(bottom!).toBeLessThanOrEqual(844 - 34)
  expect(errors).toEqual([])
})

test('C28: the home search field is 16 px and focusing it never zooms', async ({ page }) => {
  const errors = await bootHome(page)
  await expandProject(page, 'Walnut')
  await revealRow(page, SESSION_TASK_TITLE)
  const home = page.locator('.todo-search-input')
  expect(parseFloat(await home.evaluate((el) => getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16)
  await home.tap()
  const field = page.locator('.phone-search-input')
  await expect(field).toBeFocused()
  expect(parseFloat(await field.evaluate((el) => getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16)
  expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1)
  await page.goBack()
  await expect(page.getByTestId('phone-search-layer')).toHaveCount(0)
  expect(errors).toEqual([])
})

/**
 * A one-finger drag on `selector` from y0 to y1, as touch events. WebKit has no
 * Touch constructor, so each event is a plain Event carrying its touch lists,
 * which is all a native touch listener reads.
 */
async function touchDrag(page: Page, selector: string, y0: number, y1: number): Promise<boolean> {
  return page.evaluate(async ({ sel, from, to }) => {
    const el = document.querySelector(sel)
    if (!el) return false
    const at = (y: number) => ({ identifier: 1, target: el, clientX: 200, clientY: y, pageX: 200, pageY: y })
    const fire = (type: string, y: number | null) => {
      const ev = new Event(type, { bubbles: true, cancelable: true })
      const list = y === null ? [] : [at(y)]
      Object.defineProperty(ev, 'touches', { value: list })
      Object.defineProperty(ev, 'targetTouches', { value: list })
      Object.defineProperty(ev, 'changedTouches', { value: [at(y ?? to)] })
      el.dispatchEvent(ev)
    }
    fire('touchstart', from)
    for (let i = 1; i <= 8; i++) { fire('touchmove', from + ((to - from) * i) / 8); await new Promise((r) => setTimeout(r, 16)) }
    fire('touchend', null)
    return true
  }, { sel: selector, from: y0, to: y1 })
}

test('C90: pulling the home list down 64 px refetches in place and says Updated', async ({ page }) => {
  const errors = await bootHome(page)
  await expandProject(page, 'Walnut')
  await revealRow(page, SESSION_TASK_TITLE)
  const url = page.url()
  let refetched = 0
  page.on('request', (r) => { if (r.method() === 'GET' && /\/api\/(tasks|sessions\/status)/.test(r.url())) refetched++ })
  const scroller = '.todo-panel .home-navigation-scroll'
  await page.evaluate((sel) => { const b = document.querySelector<HTMLElement>(sel); if (b) b.scrollTop = 0 }, scroller)
  expect(await touchDrag(page, `${scroller} .todo-panel-item`, 200, 300)).toBe(true)
  await expect(page.getByTestId('phone-pull-home')).toHaveText('Updated', { timeout: 10_000 })
  await expect.poll(() => refetched).toBeGreaterThan(0)
  await expect(page.getByTestId('phone-pull-home')).toHaveCount(0, { timeout: 3_000 })
  expect(page.url()).toBe(url)
  expect(errors).toEqual([])
})

test.describe('C86: a touch iPad (820x1180) keeps the desktop columns, no hover-only control', () => {
  test.use({ viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true })
  test('the row kebab shows and opens without hover', async ({ page }) => {
    await isolateUiPrefs(page)
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto('/')
    await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.phone-topbar')).toBeHidden()
    await expandProject(page, 'Walnut')
    await revealRow(page, SESSION_TASK_TITLE)
    const r = row(page, SESSION_TASK_TITLE)
    await r.scrollIntoViewIfNeeded()
    const kebab = r.locator('.task-kebab-btn')
    expect(Number(await kebab.evaluate((el) => getComputedStyle(el).opacity))).toBeGreaterThan(0.3)
    await kebab.tap()
    await expect(page.locator('.task-kebab-menu').first()).toBeVisible()
    expect(errors).toEqual([])
  })
})
