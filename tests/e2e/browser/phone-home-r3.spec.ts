/**
 * Phone home, review round 3 (N2-14, N2-15, N2-01): the host problem rows (in
 * the notification panel, the only place they live) and the task rows take a
 * finger and read at 12 px or more at every phone size; a needs-you row opens
 * its task and Back gives the list back. (N2-13, the first screen under a host
 * card, went with the card on 2026-11-16.)
 * WebKit with devices['iPhone 15'] first, chromium too.
 */
import fs from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { PHONE, PHONE_LANDSCAPE, findSmallTargets, findSmallText } from './phone-helpers'
import { failed } from './host-problems-helpers'
import { bpSetup, problemRow, railButton } from './host-attention-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { presetPanelDesign } from './status-section-helpers'

const SHOTS = '/tmp/mobile-web/phone-home-r3'
test.beforeAll(async () => { await fs.mkdir(SHOTS, { recursive: true }) })

const SIZES = [
  { name: '390', device: PHONE, viewport: PHONE.viewport },
  { name: '320', device: PHONE, viewport: { width: 320, height: 568 } },
  { name: 'landscape', device: PHONE_LANDSCAPE, viewport: PHONE_LANDSCAPE.viewport },
] as const

/**
 * The problem hosts: one to Retry, one to fix in Settings. Both are the person's (audience.ts):
 * a host Walnut reconnects by itself is listed in Walnut Health, not in the bell.
 */
const problemHostList = () => [failed('certbox', 'Cert box', 'cert_expired'), failed('keybox', 'Key box', 'auth')]

for (const size of SIZES) {
  test.describe(`at ${size.name}`, () => {
    test.use({
      viewport: size.viewport,
      screen: size.device.screen,
      deviceScaleFactor: size.device.deviceScaleFactor,
      isMobile: true,
      hasTouch: true,
      userAgent: size.device.userAgent,
    })

    test(`N2-15: the host problem rows in the notification panel take a finger and read at 12 px, folded and with details open (${size.name})`, async ({ page }, info) => {
      await bpSetup(page, { hosts: problemHostList() })
      // A finger on the phone's own bell (the top bar's), as a person opens the panel there.
      await page.locator('.phone-topbar').getByTestId('phone-bell').tap()
      await expect(railButton(page, 'All')).toHaveAttribute('aria-current', 'true')
      await expect(problemRow(page, 'certbox')).toBeVisible({ timeout: 20_000 })
      await expect(problemRow(page, 'keybox')).toBeVisible()
      await page.waitForTimeout(400)
      const root = '.notification-panel [data-testid="nfc-problem-hosts"]'
      await page.screenshot({ path: `${SHOTS}/${info.project.name}-${size.name}-host-rows.png` })
      expect(await findSmallTargets(page, root), 'host row targets').toEqual([])
      expect(await findSmallText(page, 12, root), 'host row text').toEqual([])
      // Open a row's details: its own controls take a finger too.
      await problemRow(page, 'keybox').getByRole('button', { name: 'Show details' }).tap()
      await expect(problemRow(page, 'keybox')).toHaveClass(/hpb-open/)
      await page.waitForTimeout(300)
      expect(await findSmallTargets(page, root), 'host row targets, details open').toEqual([])
      expect(await findSmallText(page, 12, root), 'host row text, details open').toEqual([])
    })
  })
}

test.describe('task rows', () => {
  test.use({
    viewport: PHONE.viewport,
    screen: PHONE.screen,
    deviceScaleFactor: PHONE.deviceScaleFactor,
    isMobile: true,
    hasTouch: true,
    userAgent: PHONE.userAgent,
  })

  const created: string[] = []
  test.afterEach(async ({ request }) => {
    for (const id of created.splice(0)) await request.delete(`/api/tasks/${id}?force=true`).catch(() => {})
  })

  async function createTask(page: Page, data: Record<string, unknown>): Promise<string> {
    const res = await page.request.post('/api/tasks', { data: { source: 'local', pinned: false, ...data } })
    if (!res.ok()) throw new Error(`seed create failed: ${res.status()} ${await res.text()}`)
    const id = ((await res.json()) as { task: { id: string } }).task.id
    created.push(id)
    return id
  }

  /** Every pill of a row: its words show whole (no letter, no cut), it is a label or a 44 px target. */
  const rowPills = (page: Page, id: string) => page.evaluate((taskId) => {
    const row = document.querySelector<HTMLElement>(`.todo-panel .todo-panel-item[data-task-id="${taskId}"]`)
    if (!row) return null
    const title = row.querySelector<HTMLElement>('.todo-item-title')!.getBoundingClientRect()
    const pills = Array.from(row.querySelectorAll<HTMLElement>('.task-row-pill, .todo-item-due-pill, .tag-chip'))
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => {
        const long = el.querySelector<HTMLElement>('.task-pill-long')
        const after = getComputedStyle(el, '::after').content
        const r = el.getBoundingClientRect()
        return {
          text: (el.innerText || '').trim(),
          cut: el.scrollWidth > el.clientWidth + 1,
          letter: (!!long && long.getClientRects().length === 0) || (after !== 'none' && after !== 'normal' && after !== '""'),
          inRow: r.right <= row.getBoundingClientRect().right + 0.5,
        }
      })
    return { rowW: Math.round(row.getBoundingClientRect().width), titleW: Math.round(title.width), pills }
  }, id)

  test('N2-14: a leader and its worker show whole words, a readable title, and no small targets', async ({ page }, info) => {
    await isolateUiPrefs(page)
    // The worker that needs you is checked under its leader in the project tree;
    // By project keeps it there (Flat, the default, draws it in the Needs you section).
    await presetPanelDesign(page, 'project')
    await page.addInitScript(() => { try { localStorage.setItem('open-walnut-home-chat-visible', 'false') } catch { /* storage off */ } })
    const tag = info.project.name
    const project = `Phone pills ${tag}`
    const leader = await createTask(page, { title: `Weekly garden inventory review for the north beds ${tag}`, project, tags: ['ticket-48201937', 'north-beds'], due_date: '2030-01-15' })
    const worker = await createTask(page, { title: `Water the north beds before noon ${tag}`, project, parent_task_id: leader })
    // A worker's bare NEED_ACTION reads Waiting on its lead (src/core/user-status.ts): its own line
    // names an ask, which moves it to NEED_ACTION and reads Needs you.
    const asked = await page.request.put(`/api/v1/tasks/${worker}/report`, { data: { state: 'needs', ask: 'Pick the watering time' } })
    expect(asked.ok(), await asked.text()).toBe(true)
    await page.goto('/')
    await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 30_000 })
    const header = page.locator('.todo-panel .todo-group-project-header', { has: page.locator('.todo-group-project-name', { hasText: project }) }).first()
    await expect(header).toBeVisible({ timeout: 15_000 })
    await header.scrollIntoViewIfNeeded()
    if (/to expand/.test((await header.getAttribute('title')) ?? '')) await header.tap({ position: { x: 48, y: 22 } })
    const leaderRow = page.locator(`.todo-panel .todo-panel-item[data-task-id="${leader}"]`)
    await expect(leaderRow).toBeVisible({ timeout: 15_000 })
    const chevron = leaderRow.locator('.collapse-chevron')
    if (await chevron.count() && !(await chevron.evaluate((el) => el.classList.contains('expanded')))) await chevron.tap()
    const workerRow = page.locator(`.todo-panel .todo-panel-item[data-task-id="${worker}"]`)
    await expect(workerRow).toBeVisible({ timeout: 15_000 })
    await workerRow.scrollIntoViewIfNeeded()
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${SHOTS}/${info.project.name}-n2-14-rows.png` })
    for (const id of [leader, worker]) {
      const r = (await rowPills(page, id))!
      info.annotations.push({ type: `row ${id}`, description: JSON.stringify(r) })
      expect(r.pills.length, 'the row has pills').toBeGreaterThan(0)
      for (const p of r.pills) {
        expect(p.cut, `pill "${p.text}" is not cut`).toBe(false)
        expect(p.letter, `pill "${p.text}" shows its words, not a letter`).toBe(false)
        expect(p.inRow, `pill "${p.text}" stays in the row`).toBe(true)
      }
      // The title owns line one beside the row's two 44 px buttons (it was squeezed to ~90 px by the pills).
      expect(r.titleW, 'the title keeps line one').toBeGreaterThanOrEqual(Math.max(180, r.rowW * 0.45))
      const sel = `.todo-panel .todo-panel-item[data-task-id="${id}"]`
      expect(await findSmallTargets(page, sel), `row ${id} targets`).toEqual([])
      expect(await findSmallText(page, 12, sel), `row ${id} text`).toEqual([])
    }
    // A tap on the worker's pill opens the worker, the same as a tap on its title.
    const pill = workerRow.locator('.todo-item-subtask-pill')
    await expect(pill).toBeVisible()
    // A finger, not a locator tap: the pill is a label, the row under it takes the tap.
    const pb = (await pill.boundingBox())!
    await page.touchscreen.tap(pb.x + pb.width / 2, pb.y + pb.height / 2)
    await expect(page.locator('.phone-topbar .phone-topbar-back')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.phone-topbar-title-text')).toContainText('Water the north beds')
  })
})

test.describe('opening from the needs-you rows', () => {
  test.use({
    viewport: PHONE.viewport,
    screen: PHONE.screen,
    deviceScaleFactor: PHONE.deviceScaleFactor,
    isMobile: true,
    hasTouch: true,
    userAgent: PHONE.userAgent,
  })

  /** What Back must give back: every scroller's position and which projects are open. */
  const listState = (page: Page) => page.evaluate(() => ({
    scrollers: Array.from(document.querySelectorAll<HTMLElement>('.todo-panel *'))
      .filter((el) => el.scrollHeight > el.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))
      .map((el) => `${String(el.className).split(' ')[0]}:${Math.round(el.scrollTop)}`),
    openProjects: Array.from(document.querySelectorAll<HTMLElement>('.todo-panel .todo-group-project-header'))
      .filter((h) => !/to expand/.test(h.getAttribute('title') ?? '')).length,
    rows: document.querySelectorAll('.todo-panel .todo-panel-item[data-task-id]').length,
  }))

  /** Whether a task is one the strip lists: its phase or its stored status asks for the user. */
  const asksUser = (t: { phase?: string; user_status?: { state?: string } }) =>
    t.phase === 'NEED_ACTION' || t.user_status?.state === 'needs' || t.user_status?.state === 'read'

  /**
   * The strip shows only `own` of the work that needs the user. The fixture server is shared:
   * other tests (N2-14 in this file, the phone specs' probes) make a task that needs the user
   * and delete it seconds later, and the strip lists it newest first, at once, live. On
   * 2026-11-03 (CI run 41604915386) N2-14's worker was the row this test tapped and was gone
   * after Back, and on the retry a probe's row arrived over the row as it was tapped.
   */
  async function stripShowsOnly(page: Page, own: string): Promise<void> {
    await page.route('**/api/tasks*', async (route) => {
      const req = route.request()
      if (req.method() !== 'GET' || new URL(req.url()).pathname !== '/api/tasks') return route.fallback()
      const response = await route.fetch()
      const body = await response.json() as { tasks?: Array<{ id: string; phase?: string; user_status?: { state?: string } }> }
      if (Array.isArray(body.tasks)) body.tasks = body.tasks.filter((t) => t.id === own || !asksUser(t))
      await route.fulfill({ response, json: body })
    })
    await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
      const server = ws.connectToServer()
      ws.onMessage((message) => server.send(message))
      server.onMessage((message) => {
        const text = typeof message === 'string' ? message : message.toString('utf8')
        let frame: { type?: string; data?: { task?: { id?: string; phase?: string; user_status?: { state?: string } } } } = {}
        try { frame = JSON.parse(text) } catch { /* not JSON: pass it on */ }
        const task = frame.type === 'event' ? frame.data?.task : undefined
        if (task && typeof task === 'object' && task.id !== own && asksUser(task)) return
        ws.send(message)
      })
    })
  }

  test('N2-01: a needs-you row opens its task, and Back finds the list as the thumb left it', async ({ page }) => {
    const made = await page.request.post('/api/tasks', { data: { title: `Sign the north beds watering plan ${Date.now().toString(36)}`, source: 'local', pinned: false } })
    expect(made.ok(), await made.text()).toBe(true)
    const own = ((await made.json()) as { task: { id: string } }).task.id
    try {
      // A person's NEED_ACTION on a task with no session reads Needs you (src/core/user-status.ts).
      const marked = await page.request.patch(`/api/tasks/${own}`, { data: { phase: 'NEED_ACTION' } })
      expect(marked.ok(), await marked.text()).toBe(true)
      await stripShowsOnly(page, own)
      await isolateUiPrefs(page)
      // The needs-you strip is a By project part (Flat has its Needs you rows instead).
      await presetPanelDesign(page, 'project')
      await page.addInitScript(() => { try { localStorage.setItem('open-walnut-home-chat-visible', 'false') } catch { /* storage off */ } })
      const tabWrites: string[] = []
      page.on('request', (r) => {
        if (r.method() !== 'GET' && r.url().includes('/api/ui-prefs') && (r.postData() ?? '').includes('todo-active-section')) tabWrites.push(r.postData() ?? '')
      })
      await page.goto('/')
      const first = page.locator(`.phone-needs-you-row[data-needs-you-id="${own}"]`)
      await expect(first).toBeVisible({ timeout: 30_000 })
      await expect(page.locator('.phone-needs-you-row')).toHaveCount(1)
      await page.waitForTimeout(800)
      const before = await listState(page)
      const id = await first.getAttribute('data-needs-you-id')
      const box = (await first.boundingBox())!
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
      const back = page.locator('.phone-topbar .phone-topbar-back')
      await expect(back).toBeVisible({ timeout: 15_000 })
      await page.waitForTimeout(800)
      await back.tap()
      await expect(back).toBeHidden({ timeout: 15_000 })
      await page.waitForTimeout(400)
      expect(await listState(page), 'no project opened, nothing scrolled under the overlay').toEqual(before)
      const again = (await page.locator(`.phone-needs-you-row[data-needs-you-id="${id}"]`).boundingBox())!
      expect(Math.abs(again.y - box.y)).toBeLessThanOrEqual(1)
      expect(tabWrites).toEqual([])
    } finally {
      await page.request.delete(`/api/tasks/${own}?force=true`).catch(() => {})
    }
  })
})
