/**
 * Phone review fixes (nitpicks N3, N5, N14, N17, N21, N22, N24 and others):
 * each test pins one thing a reviewer found on a phone that the earlier specs
 * let through. WebKit with devices['iPhone 15'] first, chromium too.
 */
import fs from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { PHONE, findSmallTargets, findSmallText, injectSafeArea, menuButton, openDrawer, openHomeRow } from './phone-helpers'
void openHomeRow

const SHOTS = '/tmp/mobile-web/phone-fixes'

test.use({
  viewport: PHONE.viewport,
  screen: PHONE.screen,
  deviceScaleFactor: PHONE.deviceScaleFactor,
  isMobile: true,
  hasTouch: true,
  userAgent: PHONE.userAgent,
})

test.beforeAll(async () => { await fs.mkdir(SHOTS, { recursive: true }) })

async function bootHome(page: Page): Promise<string[]> {
  await isolateUiPrefs(page)
  await page.addInitScript(() => {
    try {
      if (sessionStorage.getItem('phone-fixes-seeded')) return
      sessionStorage.setItem('phone-fixes-seeded', '1')
      localStorage.setItem('open-walnut-home-chat-visible', 'false')
      // The tier tab bar, as a real profile shows it (the fixture's default hides it).
      localStorage.setItem('walnut-todo-quick-views-visible', 'true')
    } catch { /* storage off */ }
  })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await expect(menuButton(page)).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 30_000 })
  return errors
}

const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png` })

test('N3: the drawer lists no Home panel a phone does not mount (Agenda, Scratchpad)', async ({ page }) => {
  const errors = await bootHome(page)
  await openDrawer(page)
  const drawer = page.locator('#primary-sidebar')
  await expect(drawer.getByText('Ask Walnut').first()).toBeVisible()
  await expect(drawer.getByTestId('sidebar-toggle-calendar')).toHaveCount(0)
  await expect(drawer.getByTestId('sidebar-toggle-scratchpad')).toHaveCount(0)
  await shot(page, 'n3-drawer')
  expect(errors).toEqual([])
})

test('N24: a tapped drawer draws no keyboard focus ring, before or after it closes', async ({ page }) => {
  const errors = await bootHome(page)
  await menuButton(page).tap()
  await expect(page.locator('.sidebar.open')).toBeVisible()
  await page.waitForTimeout(400)
  const ring = (sel: string) => page.locator(sel).first().evaluate((el) => {
    const cs = getComputedStyle(el)
    return cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 ? `${cs.outlineStyle} ${cs.outlineWidth}` : ''
  })
  const focused = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.className ?? '')
  expect(focused).not.toBe('')
  expect(await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    if (!el) return ''
    const cs = getComputedStyle(el)
    return cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 ? cs.outlineStyle : ''
  })).toBe('')
  await menuButton(page).tap()
  await expect(page.locator('.sidebar.open')).toHaveCount(0)
  await page.waitForTimeout(400)
  expect(await ring('.phone-topbar button[aria-label="Menu"]')).toBe('')
  await shot(page, 'n24-closed')
  expect(errors).toEqual([])
})

const created: string[] = []
test.afterEach(async ({ request }) => {
  for (const id of created.splice(0)) await request.delete(`/api/tasks/${id}`).catch(() => {})
})

async function createTask(page: Page, data: Record<string, unknown>): Promise<string> {
  const res = await page.request.post('/api/tasks', { data: { source: 'local', ...data } })
  if (!res.ok()) throw new Error(`seed create failed: ${res.status()} ${await res.text()}`)
  const id = ((await res.json()) as { task: { id: string } }).task.id
  created.push(id)
  return id
}

test('N5: a tier card row that needs the user says Needs you in words, not only a dot', async ({ page }) => {
  const title = `Tier needs you ${test.info().project.name}`
  // A new task lands in Focus: a tier card row, not a project tree row.
  const id = await createTask(page, { title, project: 'Phone probe' })
  await page.request.patch(`/api/tasks/${id}`, { data: { phase: 'NEED_ACTION' } })
  const errors = await bootHome(page)
  const card = page.locator(':is(.todo-pinned-card, .todo-focus-card)', { hasText: title }).first()
  await expect(card).toBeVisible({ timeout: 15_000 })
  const words = card.locator('.phone-row-needs-you')
  await expect(words).toHaveText('Needs you', { timeout: 15_000 })
  await expect(card.locator('.task-attention-dot')).toBeHidden()
  const fit = await words.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, right: el.getBoundingClientRect().right, fs: parseFloat(getComputedStyle(el).fontSize) }))
  expect(fit.sw).toBeLessThanOrEqual(fit.cw + 1)
  expect(fit.right).toBeLessThanOrEqual(page.viewportSize()!.width)
  expect(fit.fs).toBeGreaterThanOrEqual(12)
  await shot(page, 'n5-tier-needs-you')
  expect(errors).toEqual([])
})

test('N14: a stuck project header sits below the stuck section heading, never under it', async ({ page }) => {
  const errors = await bootHome(page)
  const all = page.locator('.todo-section-tab', { hasText: /^All/ }).first()
  if (await all.count()) await all.tap()
  const header = page.locator('.todo-panel .todo-group-project-header', { has: page.locator('.todo-group-project-name', { hasText: /^Walnut$/ }) }).first()
  await expect(header).toBeVisible({ timeout: 15_000 })
  await header.scrollIntoViewIfNeeded()
  if (/to expand/.test((await header.getAttribute('title')) ?? '')) await header.tap({ position: { x: 48, y: 22 } })
  await expect(header).not.toHaveAttribute('title', /to expand/)
  const scrolled = await page.evaluate(() => {
    const h = Array.from(document.querySelectorAll<HTMLElement>('.todo-panel .todo-group-project-header')).find((el) => /Walnut/.test(el.textContent ?? ''))
    let box: HTMLElement | null = h?.parentElement ?? null
    while (box && !(box.scrollHeight > box.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) box = box.parentElement
    if (!box || !h) return -1
    box.scrollTop = h.offsetTop + 680
    return box.scrollTop
  })
  expect(scrolled).toBeGreaterThan(0)
  await page.waitForTimeout(400)
  const boxes = await page.evaluate(() => {
    const r = (el: Element | null) => el ? el.getBoundingClientRect() : null
    const section = r(document.querySelector('.todo-panel .todo-tasks-section > .todo-tasks-header'))
    const project = Array.from(document.querySelectorAll('.todo-panel .todo-group-project-header')).map((el) => el.getBoundingClientRect())
      .filter((b) => b.height > 0 && b.bottom > 0).sort((a, b) => a.top - b.top)[0] ?? null
    return { section: section && { top: section.top, bottom: section.bottom }, project: project && { top: project.top, bottom: project.bottom } }
  })
  expect(boxes.section && boxes.project).toBeTruthy()
  // The project header begins where the section heading ends (1 px rounding).
  expect(boxes.project!.top).toBeGreaterThanOrEqual(boxes.section!.bottom - 1)
  await shot(page, 'n14-sticky')
  expect(errors).toEqual([])
})

test('N17: the task panel footer keeps its words above the home indicator', async ({ page }) => {
  const errors = await bootHome(page)
  await injectSafeArea(page, { top: 47, bottom: 34 })
  const footer = page.getByTestId('todo-filter-footer').first()
  await expect(footer).toBeVisible({ timeout: 15_000 })
  // R3-03: the footer is the list's last line on a phone; scroll to the end of the list.
  await page.locator('.main-page-todo .home-navigation-scroll').evaluate((el) => { el.scrollTop = el.scrollHeight })
  await page.waitForTimeout(300)
  const vh = page.viewportSize()!.height
  const words = await footer.evaluate((el) => {
    let bottom = 0
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!(n.textContent ?? '').trim()) continue
      const range = document.createRange(); range.selectNodeContents(n)
      for (const r of Array.from(range.getClientRects())) bottom = Math.max(bottom, r.bottom)
    }
    return bottom
  })
  expect(words).toBeGreaterThan(0)
  expect(words).toBeLessThanOrEqual(vh - 34 + 0.5)
  await shot(page, 'n17-footer-safe')
  expect(errors).toEqual([])
})

test('N21: the tier tabs stay the same set in the same places whichever one is picked, names whole', async ({ page }) => {
  const errors = await bootHome(page)
  const tabs = page.locator('.todo-section-tabs .todo-section-tab')
  await expect(tabs.first()).toBeVisible()
  const names = () => tabs.evaluateAll((els) => els.map((el) => (el.querySelector('.todo-section-tab-label')?.textContent ?? '').trim()))
  const first = await names()
  expect(first.length).toBeGreaterThan(1)
  for (let i = 0; i < first.length; i++) {
    await tabs.nth(i).tap()
    await expect(tabs.nth(i)).toHaveAttribute('aria-selected', 'true')
    expect(await names()).toEqual(first)
  }
  const cut = await tabs.evaluateAll((els) => els.map((el) => {
    const l = el.querySelector<HTMLElement>('.todo-section-tab-label')!
    return { name: l.textContent, cut: l.scrollWidth > l.clientWidth + 1 || parseFloat(getComputedStyle(l).opacity) < 1 }
  }).filter((x) => x.cut))
  expect(cut).toEqual([])
  expect(await findSmallTargets(page, '.todo-section-tabs')).toEqual([])
  expect(await findSmallText(page, 12, '.todo-section-tabs')).toEqual([])
  await shot(page, 'n21-tabs')
  expect(errors).toEqual([])
})

test('N22: an empty tier says it is empty and offers a way to the recent tasks', async ({ page }) => {
  // One tier the user made and has put nothing in yet (the fixture's own tiers all hold tasks).
  await page.route((url) => url.pathname === '/api/focus/tiers', (route) => route.request().method() === 'GET'
    ? route.fulfill({ contentType: 'application/json', body: JSON.stringify({ tiers: [{ id: 'later-shelf', label: 'Later' }] }) })
    : route.continue())
  const errors = await bootHome(page)
  const tabs = page.locator('.todo-section-tabs .todo-section-tab')
  await expect(tabs.first()).toBeVisible()
  await tabs.filter({ hasText: 'Later' }).first().tap()
  await expect(page.getByTestId('phone-tier-empty').first()).toBeVisible()
  const empty = page.getByTestId('phone-tier-empty').first()
  await expect(empty).toContainText('Nothing here yet.')
  await shot(page, 'n22-empty-tier')
  const btn = empty.getByRole('button', { name: 'Show recent tasks' })
  expect((await btn.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await btn.tap()
  await expect(page.locator('.todo-section-tab.todo-section-tab-recent')).toHaveAttribute('aria-selected', 'true')
  expect(errors).toEqual([])
})

test('C19: every tier tab of the home takes a finger and reads at 12 px or more, team pills included', async ({ page }) => {
  // A leader and its worker: the rows carry the Leader and Worker pills.
  const lead = await createTask(page, { title: `Team lead ${test.info().project.name}`, project: 'Phone probe' })
  await createTask(page, { title: `Team worker ${test.info().project.name}`, project: 'Phone probe', parent_task_id: lead })
  const errors = await bootHome(page)
  const tabs = page.locator('.todo-section-tabs .todo-section-tab')
  await expect(tabs.first()).toBeVisible()
  let pills = 0
  for (let i = 0; i < await tabs.count(); i++) {
    await tabs.nth(i).tap()
    await page.waitForTimeout(400)
    const label = (await tabs.nth(i).innerText()).trim().replace(/\s+/g, ' ')
    pills += await page.locator('.todo-panel .task-team-pill:visible').count()
    expect(await findSmallTargets(page, '.todo-panel'), `targets in ${label}`).toEqual([])
    expect(await findSmallText(page, 12, '.todo-panel'), `text in ${label}`).toEqual([])
  }
  // The fixture's team rows (Worker / Leader pills) were on screen in at least one tab.
  expect(pills).toBeGreaterThan(0)
  expect(errors).toEqual([])
})

/** C73 on screen: rendered text holds no emoji-prone glyph without U+FE0E. */
async function emojiProneText(page: Page, root = 'body'): Promise<string[]> {
  return page.evaluate((rootSel) => {
    const ios = [0x25b6, 0x2753, 0x26a0, 0x23f8, 0x2934]
    const prone = (cp: number) => ios.includes(cp) || (cp >= 0x1f300 && cp <= 0x1faff) || cp === 0x23f3 || cp === 0x2705 || cp === 0x274c
    const out: string[] = []
    const scope = document.querySelector(rootSel) ?? document.body
    const w = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const el = n.parentElement
      if (!el || el.closest('script, style, .markdown, .note-body') || el.getClientRects().length === 0) continue
      const chars = Array.from(n.textContent ?? '')
      chars.forEach((c, i) => {
        const cp = c.codePointAt(0) ?? 0
        if (prone(cp) && chars[i + 1] !== '\uFE0E') out.push(`${el.className || el.tagName}: U+${cp.toString(16)}`)
      })
    }
    return out
  }, root)
}

test('C73, N13: home rows, the session menu and the center draw no emoji-prone glyph', async ({ page }) => {
  const errors = await bootHome(page)
  await openHomeRow(page, 'Walnut', 'Quarterly invoice reconciliation')
  await expect(page.locator('.phone-topbar').getByRole('button', { name: 'Back' })).toBeVisible({ timeout: 15_000 })
  const more = page.locator('.phone-topbar').getByRole('button', { name: /more|actions/i }).first()
  await more.tap()
  await page.waitForTimeout(500)
  expect(await emojiProneText(page)).toEqual([])
  await shot(page, 'c73-session-menu')
  await page.keyboard.press('Escape')
  await page.locator('.phone-topbar').getByRole('button', { name: 'Back' }).tap()
  await expect(page.locator('.phone-topbar').getByRole('button', { name: 'Menu' })).toBeVisible()
  expect(await emojiProneText(page, '.todo-panel')).toEqual([])
  await page.locator('.phone-topbar').getByTestId('phone-bell').tap()
  await expect(page.locator('.notification-panel')).toBeVisible()
  for (const name of ['Needs Action', 'Inbox', 'Errors', 'All']) {
    await page.locator('.notification-panel .nfc-rail-btn', { hasText: name }).first().tap()
    await page.waitForTimeout(300)
    for (const t of await page.locator('.notification-panel .nfc-card-toggle').all()) await t.tap().catch(() => {})
    expect(await emojiProneText(page, '.notification-panel'), name).toEqual([])
  }
  expect(errors).toEqual([])
})

test('N6: the session bar status matches the process: no stale Needs you, no tool identifier', async ({ page }) => {
  const sid = 'pw-question-recovery-session'
  await isolateUiPrefs(page)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`/?s1=${sid}`)
  const sub = page.locator('.phone-topbar .phone-topbar-subtitle')
  await expect(sub).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(1500)
  const text = (await sub.innerText()).trim()
  expect(text).not.toContain('AskUserQuestion')
  expect(text).toMatch(/^(Running|Idle|Stopped|Not available|Needs you|Needs your answer|Needs you: .+)$/)
  // One status source: the same record the desktop badge reads (WorkStatusPicker
  // deriveDisplayStatus): a prompt counts only on a live process.
  const rec = await page.request.get(`/api/sessions/${sid}`).then((r) => r.ok() ? r.json() : null).catch(() => null) as
    { session?: { process_status?: string; pendingPermission?: { toolName?: string } } } | null
  const ps = rec?.session?.process_status
  const live = ps === 'running' || ps === 'idle'
  // N2-10: a card the timeline draws unanswered names the bar; a task handed
  // back reads Needs you like its home row. Otherwise a dead process is Stopped.
  const cardDrawn = await page.locator('.main-page-session-column.is-mobile-active [data-prompt-pending="true"]').count() > 0
  if (ps && !live && !cardDrawn) expect(text).toMatch(/^(Stopped|Needs you)$/)
  if (live && rec?.session?.pendingPermission?.toolName === 'AskUserQuestion') expect(text).toBe('Needs your answer')
  await shot(page, 'n6-subtitle')
  expect(errors).toEqual([])
})

async function openFixtureSession(page: Page, sid: string): Promise<string[]> {
  await isolateUiPrefs(page)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`/?s1=${sid}`)
  await expect(page.locator('.main-page-session-column.is-mobile-active')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.session-history .session-msg').first()).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(800)
  return errors
}

test('N7: session message text is 16 px on a phone, line height 1.4 or more', async ({ page }) => {
  const errors = await openFixtureSession(page, 'pw-history-turns-session')
  const sizes = await page.locator('.session-history :is(.session-msg-assistant, .session-msg-user)').evaluateAll((els) =>
    els.slice(-6).map((el) => {
      const t = (el.querySelector('.markdown-body p, .markdown-body, .session-msg-content') ?? el) as HTMLElement
      const cs = getComputedStyle(t)
      return { fs: parseFloat(cs.fontSize), lh: parseFloat(cs.lineHeight) / parseFloat(cs.fontSize) }
    }))
  expect(sizes.length).toBeGreaterThan(0)
  for (const s of sizes) {
    expect(s.fs).toBeGreaterThanOrEqual(16)
    expect(s.lh).toBeGreaterThanOrEqual(1.4)
  }
  expect(errors).toEqual([])
})

test('N8: no MD / Rich / pin / time strip under a bubble; one Message actions button opens copy and pin', async ({ page }) => {
  const errors = await openFixtureSession(page, 'pw-history-turns-session')
  const history = page.locator('.session-history')
  await expect(history.locator('.session-msg-actions')).toHaveCount(0)
  await expect(history.getByText('Rich', { exact: true })).toHaveCount(0)
  await expect(history.getByText('MD', { exact: true })).toHaveCount(0)
  // A one-line message stays one line: the bubble is no taller than its text.
  const user = history.locator('.session-msg-user').last()
  await user.scrollIntoViewIfNeeded()
  const h = await user.evaluate((el) => {
    const p = el.querySelector<HTMLElement>('.markdown-body') ?? el
    return { box: el.getBoundingClientRect().height, line: parseFloat(getComputedStyle(p).lineHeight) }
  })
  expect(h.box).toBeLessThan(h.line * 2 + 24)
  const btn = user.getByRole('button', { name: 'Message actions' })
  await expect(btn).toBeVisible()
  expect(await findSmallTargets(page, '.session-history')).toEqual([])
  await btn.tap()
  const menu = page.locator('.wn-context-menu, [role="menu"]').last()
  await expect(menu).toBeVisible()
  await expect(menu.getByText('Copy message', { exact: true })).toBeVisible()
  await expect(menu.getByText(/Pin to outline|Unpin from outline/)).toBeVisible()
  const m = (await menu.boundingBox())!
  expect(m.x).toBeGreaterThanOrEqual(0)
  expect(m.x + m.width).toBeLessThanOrEqual(page.viewportSize()!.width)
  await shot(page, 'n8-message-menu')
  await page.keyboard.press('Escape')
  expect(errors).toEqual([])
})

test('N28: the session composer placeholder is one short line on a phone', async ({ page }) => {
  const errors = await openFixtureSession(page, 'pw-history-turns-session')
  const input = page.locator('.main-page-session-column.is-mobile-active textarea').first()
  await expect(input).toBeVisible()
  expect(await input.getAttribute('placeholder')).toBe('Message')
  const h = await input.evaluate((el) => ({ h: el.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(el).lineHeight) || 22 }))
  expect(h.h).toBeLessThan(h.lh * 2)
  expect(errors).toEqual([])
})

test('N29, N2-34: a row whose session record is gone opens under the task title, with one plain sentence and no composer', async ({ page }) => {
  // The record and its history answer 404, as for a session deleted on the computer.
  await page.route('**/api/sessions/pw-history-turns-session**', (route) => route.request().method() === 'GET'
    ? route.fulfill({ status: 404, json: { error: 'Session not found' } })
    : route.fallback())
  const errors = await bootHome(page)
  await openHomeRow(page, 'Walnut', 'History turn window fixture')
  const title = page.locator('.phone-topbar .phone-topbar-title-text')
  await expect(title).toHaveText('History turn window fixture', { timeout: 15_000 })
  const column = page.locator('.main-page-session-column.is-mobile-active')
  await page.waitForTimeout(1500)
  await expect(column.locator('.session-supervision')).toHaveCount(0)
  await expect(column.getByText(/Failed to load history/)).toHaveCount(0)
  // N2-34: it says what to do, the bar says so, and no composer waits for words that go nowhere.
  await expect(column.getByText('This session is no longer available. Open its task from Home to start a new one.')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.phone-topbar .phone-topbar-subtitle')).toHaveText('Not available')
  await expect(column.locator('.session-panel-input')).toBeHidden()
  await shot(page, 'n29-missing-session')
  expect(errors).toEqual([])
})

async function openAskWalnut(page: Page): Promise<void> {
  await openDrawer(page)
  await page.locator('#primary-sidebar').getByRole('button', { name: 'Ask Walnut', exact: true }).tap()
  await expect(page.getByTestId('ask-walnut-slot')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.phone-topbar').getByRole('button', { name: 'Back' })).toBeVisible()
}

test('N10: Ask Walnut has one bar, a model name (not an id), and finger-sized chips', async ({ page }) => {
  const errors = await bootHome(page)
  await openAskWalnut(page)
  const slot = page.getByTestId('ask-walnut-slot')
  const draft = slot.getByTestId('ask-walnut-draft')
  if (await draft.count()) {
    await expect(draft.locator('.session-panel-header')).toBeHidden()
    await expect(draft.getByText('Draft', { exact: true })).toBeHidden()
    const chips = draft.locator('.session-action-chip')
    for (const c of await chips.all()) expect((await c.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  }
  const model = slot.locator('.composer-model-pill, .session-detail-model-pill').first()
  if (await model.count()) expect((await model.innerText()).trim()).not.toMatch(/^(global\.|us\.|anthropic\.)/)
  await shot(page, 'n10-ask-walnut')
  expect(errors).toEqual([])
})

test('N11: the asks list is a full-screen layer: New chat first, 48 px rows, no keyboard on open', async ({ page }) => {
  const errors = await bootHome(page)
  await openAskWalnut(page)
  await page.locator('.phone-topbar').getByTestId('ask-walnut-menu').tap()
  const list = page.getByTestId('ask-walnut-drawer')
  await expect(list).toBeVisible()
  await page.waitForTimeout(300)
  const box = (await list.boundingBox())!
  const bar = (await page.locator('.phone-topbar').boundingBox())!
  const vw = page.viewportSize()!.width
  expect(Math.round(box.x)).toBe(0)
  expect(Math.round(box.width)).toBe(vw)
  expect(box.y).toBeGreaterThanOrEqual(bar.y + bar.height - 1)
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('INPUT')
  await expect(list.locator('.ask-walnut-drawer-close')).toBeHidden()
  const newChat = list.locator('.ask-walnut-drawer-new')
  const nb = (await newChat.boundingBox())!
  expect(nb.height).toBeGreaterThanOrEqual(44)
  const firstRow = list.locator('.ask-walnut-drawer-item').first()
  if (await firstRow.count()) {
    const rb = (await firstRow.boundingBox())!
    expect(rb.height).toBeGreaterThanOrEqual(48)
    expect(nb.y).toBeLessThan(rb.y)
  }
  expect(await findSmallTargets(page, '[data-testid="ask-walnut-drawer"]')).toEqual([])
  await shot(page, 'n11-asks-list')
  await page.goBack()
  await expect(list).toHaveCount(0)
  await expect(page.getByTestId('ask-walnut-slot')).toBeVisible()
  expect(errors).toEqual([])
})
