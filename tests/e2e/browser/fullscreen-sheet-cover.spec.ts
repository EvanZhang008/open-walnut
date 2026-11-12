/**
 * Every full-screen sheet covers its window (styles/fullscreen-tab.css): the pop-up sheet sits
 * over the whole page area with its margin on every side, above the dim, and nothing of the page
 * cuts it. 2026-11-10, the user: "btw, funciton full screen is broken please fix". In the Mac app
 * (WebKit) the Side threads sheet of Home's second column showed only from that column's left
 * edge on: the composer row held the sheet in a stacking context of its own (raised to z 9001
 * over the dim), inside the column that clips at its edges, and WebKit cut the sheet there.
 *
 * Each sheet the user opens is checked three ways:
 *   - its box is the shared sheet's (12px top and bottom, the side margin from the page area,
 *     moved right only past a notice in the corner);
 *   - no stacking context paints it from inside a box that clips smaller than the sheet (the
 *     cause above; a hit test cannot see it, WebKit only cut the paint);
 *   - its corners and its middle answer a hit test with the sheet (over the dim).
 * The sheets: a session panel and its Side threads in both of Home's columns, Side threads over a
 * full-screen panel; on the Org page the Org chat's Side threads (the chat itself has no full
 * screen), the Org side bar, and a task opened beside the page with its Side threads.
 */
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome, seedColumns } from './draft-helpers'
import { directControl } from './composer-controls-overflow-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { openTaskFromRail } from './org-view-helpers'
import { holdApprovalsLock } from './approvals-lock'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const PROJECT = `Sheet cover ${STAMP}`
const made: string[] = []

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)
// The Home test puts an approval in the corner; none waits before or after a test.
holdApprovalsLock('file', { clear: true })

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(url, { data })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

test.afterAll(async ({ request }) => {
  for (const id of made.splice(0)) {
    const task = (await (await request.get(`/api/tasks/${id}`)).json()).task as { session_id?: string } | undefined
    if (task?.session_id) await request.post(`/api/v1/sessions/${task.session_id}/terminate`, { data: { force: true } })
    for (let i = 0; i < 10; i++) {
      const res = await request.delete(`/api/tasks/${id}?force=true`)
      if (res.ok() || res.status() === 404) break
      await new Promise((r) => setTimeout(r, 500))
    }
  }
})

/** Side threads answer from a stub: this file is about where the sheet lands, not the threads. */
async function stubSideThreads(page: Page): Promise<void> {
  await page.route('**/api/sessions/*/side-threads**', async (route) => {
    const rest = new URL(route.request().url()).pathname.split('/side-threads')[1] ?? ''
    if (route.request().method() === 'GET' && rest === '') return route.fulfill({ json: { threads: [], legacy: [] } })
    return route.fulfill({ json: { ok: true } })
  })
}

interface Cover {
  sheet: string
  box: [number, number, number, number]
  want: [number, number, number, number]
  inset: number
  /** A stacking context that paints the sheet from inside a box clipping smaller than it. */
  cutBy: string | null
  /** Hit-test points that did not land on the sheet. */
  missed: string[]
}

/** Where the open sheet lands, what paints it, and what a hit test finds on it. */
async function cover(page: Page): Promise<Cover> {
  return page.evaluate(() => {
    const name = (el: Element) => `${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).slice(0, 3).join('.')}`
    const sheets = [...document.querySelectorAll<HTMLElement>('.open-walnut-fullscreen')]
      .filter((el) => getComputedStyle(el).visibility === 'visible' && el.getBoundingClientRect().width > 0)
    const sheet = sheets[sheets.length - 1]
    if (!sheet) throw new Error('no full-screen sheet on screen')
    const s = sheet.getBoundingClientRect()
    const css = getComputedStyle(sheet)
    // The shared sheet's box (fullscreen-tab.css), from the same inputs the stylesheet reads.
    const left = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fullscreen-left')) || 0
    const area = innerWidth - left
    const side = Math.max(12, Math.min(area * 0.1, (area - 960) / 2))
    const inset = parseFloat(css.getPropertyValue('--corner-sheet-inset')) || 0
    const want: [number, number, number, number] = [left + side + inset, 12, innerWidth - side, innerHeight - 12]

    const stacks = (el: HTMLElement) => {
      const c = getComputedStyle(el)
      if (c.display === 'contents') return false
      return (c.position !== 'static' && c.zIndex !== 'auto') || Number(c.opacity) < 1 || c.transform !== 'none'
        || c.filter !== 'none' || (c.backdropFilter ?? 'none') !== 'none' || ((c as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter ?? 'none') !== 'none'
        || c.isolation === 'isolate' || c.clipPath !== 'none' || (c.maskImage ?? 'none') !== 'none' || c.mixBlendMode !== 'normal'
        || /paint|layout|strict|content/.test(c.contain) || /transform|opacity|filter|perspective/.test(c.willChange) || c.perspective !== 'none'
    }
    const clips = (el: HTMLElement) => {
      const c = getComputedStyle(el)
      return c.display !== 'contents' && (c.overflowX !== 'visible' || c.overflowY !== 'visible' || c.clipPath !== 'none')
    }
    const holds = (el: HTMLElement) => {
      const r = el.getBoundingClientRect()
      return r.left <= s.left + 0.5 && r.top <= s.top + 0.5 && r.right >= s.right - 0.5 && r.bottom >= s.bottom - 0.5
    }
    let cutBy: string | null = null
    for (let a = sheet.parentElement; a && a !== document.body && !cutBy; a = a.parentElement) {
      if (!stacks(a)) continue
      for (let c: HTMLElement | null = a; c && c !== document.body; c = c.parentElement) {
        if (clips(c) && !holds(c)) { cutBy = `${name(a)} paints it, ${name(c)} clips at ${JSON.stringify([c.getBoundingClientRect().left, c.getBoundingClientRect().right].map(Math.round))}`; break }
      }
    }
    const points: Array<[string, number, number]> = [
      ['top left', s.left + 16, s.top + 16], ['top right', s.right - 16, s.top + 16],
      ['bottom left', s.left + 16, s.bottom - 16], ['bottom right', s.right - 16, s.bottom - 16],
      ['middle', (s.left + s.right) / 2, (s.top + s.bottom) / 2],
    ]
    const missed = points.filter(([, x, y]) => { const hit = document.elementFromPoint(x, y); return !hit || !sheet.contains(hit) })
      .map(([where, x, y]) => `${where} (${Math.round(x)}, ${Math.round(y)}): ${document.elementFromPoint(x, y) ? name(document.elementFromPoint(x, y)!) : 'nothing'}`)
    return { sheet: name(sheet), box: [s.left, s.top, s.right, s.bottom].map((v) => Math.round(v)) as Cover['box'], want: want.map((v) => Math.round(v)) as Cover['want'], inset, cutBy, missed }
  })
}

async function expectCovers(page: Page, where: string): Promise<void> {
  // The sheet fades in (opacity only) and the corner settles its inset after a frame.
  await page.waitForTimeout(400)
  const c = await cover(page)
  for (let i = 0; i < 4; i++) expect(Math.abs(c.box[i] - c.want[i]), `${where}: ${c.sheet} at ${JSON.stringify(c.box)}, the sheet's box is ${JSON.stringify(c.want)}`).toBeLessThanOrEqual(1)
  expect(c.cutBy, `${where}: ${c.sheet} is cut`).toBeNull()
  expect(c.missed, `${where}: ${c.sheet} does not answer there`).toEqual([])
}

async function openThreads(panel: Locator): Promise<Locator> {
  await directControl(panel, 'btw').click()
  const pop = panel.locator('.side-question-popover').first()
  await expect(pop).toBeVisible()
  return pop
}

/** Side threads in full screen and back; `close` closes the pop-up too (Escape would also leave a
 *  full-screen panel under it, so over one the caller leaves the panel first). */
async function threadsFullScreen(page: Page, panel: Locator, where: string, close = true): Promise<void> {
  const pop = await openThreads(panel)
  await pop.locator('.side-question-fullscreen').click()
  await expect(pop).toHaveClass(/open-walnut-fullscreen/)
  await expectCovers(page, where)
  await pop.locator('.side-question-fullscreen').click()
  await expect(pop).not.toHaveClass(/open-walnut-fullscreen/)
  if (close) await closeThreads(page, panel)
}

async function closeThreads(page: Page, panel: Locator): Promise<void> {
  if (await panel.locator('.side-question-popover').count()) await page.keyboard.press('Escape')
  await expect(panel.locator('.side-question-popover')).toHaveCount(0)
}

/** The panel's own button: a click beside the open pop-up first only closes the pop-up. */
async function leavePanelFullScreen(panel: Locator): Promise<void> {
  const button = panel.locator('.session-panel-expand').first()
  if (await panel.locator('.side-question-popover').count()) {
    await button.click()
    await expect(panel.locator('.side-question-popover')).toHaveCount(0)
  }
  if (await panel.evaluate((el) => el.classList.contains('open-walnut-fullscreen'))) await button.click()
  await expect(panel).not.toHaveClass(/open-walnut-fullscreen/)
}

test('Home: a session panel and its Side threads cover the window from either column, a notice in the corner or not', async ({ page, request }) => {
  await page.setViewportSize({ width: 1568, height: 861 })
  await stubSideThreads(page)
  await seedColumns(page, ['pw-normal-session', 'pw-vscode-session'])
  await loadHome(page)
  const first = page.locator('.main-page-session-column .session-panel[data-session-id="pw-normal-session"]')
  const second = page.locator('.main-page-session-column .session-panel[data-session-id="pw-vscode-session"]')
  await expect(second).toBeVisible({ timeout: 20_000 })
  await expect(first).toBeVisible()

  for (const corner of ['no notice', 'an approval in the corner']) {
    if (corner !== 'no notice') {
      await post(request, '/api/v1/approvals', { what: `[sheet-cover] Push the prompt ${STAMP}`, cwd: '/work/site', command: 'release.sh' })
      await expect(page.locator('.corner-stack [data-testid="approval-card"]')).toBeVisible({ timeout: 15_000 })
    }
    for (const [label, panel] of [['second column', second], ['first column', first]] as const) {
      await threadsFullScreen(page, panel, `${corner}, Side threads of the ${label}`)
      await panel.locator('.session-panel-expand').click()
      await expect(panel).toHaveClass(/open-walnut-fullscreen/)
      await expectCovers(page, `${corner}, session panel of the ${label}`)
      // Side threads over the full-screen panel: its own sheet, the panel under it hidden.
      await threadsFullScreen(page, panel, `${corner}, Side threads over the full-screen ${label}`, false)
      await leavePanelFullScreen(panel)
    }
  }
})

test('Org: the Org chat\'s Side threads, the Org side bar and a task beside the page cover the window', async ({ page, request }) => {
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  const cwd = `${fixtureRoot}/projects/walnut`
  // Two tasks, so the project gets a lead of its own (with one, the task itself answers).
  const tasks: string[] = []
  for (const title of [`Cover work ${STAMP}`, `Cover review ${STAMP}`]) {
    tasks.push((await post<{ task: { id: string } }>(request, '/api/tasks', { title, project: PROJECT, source: 'local' })).task.id)
  }
  made.push(...tasks)
  const lead = (await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: PROJECT })).task.id
  made.push(lead)
  const leadSid = (await post<{ sessionId: string }>(request, '/api/sessions/quick-start', { cwd, message: `Cover lead ready ${STAMP}`, taskId: lead })).sessionId
  const workSid = (await post<{ sessionId: string }>(request, '/api/sessions/quick-start', { cwd, message: `Cover work ready ${STAMP}`, taskId: tasks[0] })).sessionId

  await page.setViewportSize({ width: 1568, height: 861 })
  await stubSideThreads(page)
  await isolateUiPrefs(page)
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  await page.locator(`[data-testid="org-channel"][data-key="project:${PROJECT.toLowerCase()}"]`).click()
  const detail = page.getByTestId('org-detail')
  // The Org chat has no full screen of its own (its header hides the button); its Side threads do.
  const chat = detail.locator(`[data-testid="org-chat"] .session-panel[data-session-id="${leadSid}"]`)
  await expect(chat).toBeVisible({ timeout: 30_000 })
  await threadsFullScreen(page, chat, 'Side threads of the Org chat')

  const rail = page.getByTestId('org-rail')
  await expect(rail).toBeVisible()
  await rail.getByTestId('org-rail-fullscreen').click()
  await expect(rail).toHaveAttribute('data-fullscreen', '1')
  await expectCovers(page, 'the Org side bar')
  await rail.getByTestId('org-rail-fullscreen').click()
  await expect(rail).not.toHaveAttribute('data-fullscreen', '1')

  // A task opened beside the page: its panel and its Side threads.
  const side = page.getByTestId('org-side')
  await openTaskFromRail(page, tasks[0]!, () => expect(side).toHaveAttribute('data-session-id', workSid, { timeout: 5_000 }))
  const panel = side.locator(`.session-panel[data-session-id="${workSid}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await threadsFullScreen(page, panel, 'Side threads of the task beside the Org page')
  await panel.locator('.session-panel-expand').first().click()
  await expect(panel).toHaveClass(/open-walnut-fullscreen/)
  await expectCovers(page, 'the task beside the Org page')
  await threadsFullScreen(page, panel, 'Side threads over the full-screen task beside the Org page', false)
  await leavePanelFullScreen(panel)
})
