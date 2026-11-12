// Agent words on Home rows, the wait card, the taskbar card, the extension pop-out and triage must open what they name, never the row.
import { test, expect, type APIRequestContext, type APIResponse, type BrowserContext, type Locator, type Page } from '@playwright/test'
import {
  AGENT_TEXT_BASE as base, click, closeFile, closeLinkedLetter, dragSelect, expectImage, expectText, expectViewerFillsPanel, openApp, openTaskSession,
  seedAgentFiles, sessionColumn, setReport, showPointer, tabTo, taskWithReply, type AgentFiles,
} from './agent-text-entry-helpers'
import { discoverBrowserFixture } from './codex-test-audit'
import { LS_PANEL_DESIGN_KEY } from './status-section-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const stamp = Date.now().toString(36)
const project = `Agent entries ${stamp}`
const titles = { needs: `Needs entry ${stamp}`, wait: `Wait entry ${stamp}`, bar: `Taskbar entry ${stamp}` }
const ids = { needs: '', wait: '', bar: '' }
const sids = { needs: '', wait: '', bar: '' }
const made: string[] = []
const letters: string[] = []
let files: AgentFiles
let letter = '', worker = '', taskRef = ''
const site = 'https://example.com/design'
const BAR_TAIL = 'End of the taskbar report.'

test.describe.configure({ mode: 'default' })
test.setTimeout(240_000)
test.use({ baseURL: base, viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, video: 'on' })

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000)
  if (new URL(base).port === '3456') throw new Error('These checks write tasks: run them on a test server, never production')
  files = await seedAgentFiles(`agent-entry-${stamp}`)
  const w = await request.post('/api/tasks', { data: { title: `Entry worker ${stamp}`, project, source: 'local' } })
  expect(w.ok(), await w.text()).toBe(true)
  worker = (await w.json()).task.id
  made.push(worker)
  taskRef = `<task-ref id="${worker}" label="Entry worker"/>`
  const l = await request.post('/api/v1/human-inbox', { data: { subject: project, type: 'info', text: `Design: ${files.picture}`, markdown: `Design: ${files.picture}` } })
  expect(l.ok(), await l.text()).toBe(true)
  letter = (await l.json()).id
  letters.push(letter)
  // Early in the reply, the words the small cards must still reach; the rest after them.
  const reply = `${files.picture} ${letter} ${site} ${taskRef} ${files.document}:2-3`
  // The taskbar card shows four lines of the reply: the letter, the task and the picture come
  // first there (the long path wraps after them), and the rest runs on past the clamp.
  const barReply = `${letter} ${taskRef} ${files.picture} ${site} ${files.document}:2-3. ${'The rest of the report stays in the conversation. '.repeat(6)}${BAR_TAIL}`
  for (const key of ['needs', 'wait'] as const) {
    const t = await taskWithReply(request, titles[key], project, `Report: ${reply}`)
    ids[key] = t.id
    sids[key] = t.sid
    made.push(t.id)
  }
  // The taskbar's reply is the session's words alone (the mock CLI's clean-turn mode answers
  // with exactly the text after its prefix), so no echo wrapper takes the card's four lines.
  const bar = await taskWithCleanReply(request, titles.bar, project, barReply)
  ids.bar = bar.id
  sids.bar = bar.sid
  made.push(bar.id)
  await setReport(request, ids.needs, { state: 'needs', ask: `Pick the design in ${files.picture} as ${letter} says` },
    (s) => s.state === 'needs' && String(s.ask ?? '').includes(files.picture))
  await setReport(request, ids.bar, { state: 'needs', ask: `Read ${files.document}:2-3 first` },
    (s) => s.state === 'needs' && String(s.ask ?? '').includes(files.document))
  await setReport(request, ids.wait, {
    state: 'waiting', waiting_kind: 'outside',
    waiting_on: `${files.document}:2-3 from the design review, ${letter}`,
    next: `Check ${site} with ${taskRef}`,
  }, (s) => s.state === 'waiting' && String(s.waitingOn ?? '').includes(files.document))
  // The wait card belongs to a parked task: park it as a person would if the report did not.
  const phase = async () => ((await (await request.get(`/api/tasks/${ids.wait}`)).json()) as { task: { phase: string } }).task.phase
  if (await phase() !== 'WAITING') {
    const parked = await request.patch(`/api/tasks/${ids.wait}`, { data: { phase: 'WAITING' } })
    expect(parked.ok(), await parked.text()).toBe(true)
  }
  await expect.poll(phase, { timeout: 20_000 }).toBe('WAITING')
})

async function okJson(res: APIResponse, what: string): Promise<any> {
  const text = await res.text()
  expect(res.ok(), `${what}: ${res.status()} ${text}`).toBe(true)
  return text ? JSON.parse(text) : null
}

// A clean mock turn keeps the reply's first words inside the card's four-line clamp.
async function taskWithCleanReply(request: APIRequestContext, title: string, project: string, reply: string): Promise<{ id: string; sid: string }> {
  const id = (await okJson(await request.post('/api/tasks', { data: { title, project, source: 'local' } }), 'create task')).task.id as string
  const dirs = (await okJson(await request.get('/api/sessions/working-dirs'), 'working dirs')) as { dirs: Array<{ cwd: string }> }
  const cwd = dirs.dirs.find((d) => /\/ps-fixture\/projects\/walnut$/.test(d.cwd))?.cwd
  expect(cwd, 'ps-fixture/projects/walnut seed').toBeTruthy()
  const sid = (await okJson(await request.post('/api/sessions/quick-start', { data: { cwd, message: `snapshot-clean-turn:${reply}`, taskId: id } }), 'quick-start')).sessionId as string
  await expect.poll(async () => {
    const res = await request.get(`/api/sessions/${sid}/history`)
    if (!res.ok()) return ''
    const body = (await res.json()) as { messages?: Array<{ role: string; text?: string }> }
    return (body.messages ?? []).filter((m) => m.role === 'assistant').map((m) => m.text ?? '').join('\n')
  }, { timeout: 90_000 }).toContain(BAR_TAIL)
  await request.post(`/api/sessions/${sid}/interrupt`).catch(() => {})
  await request.post(`/api/sessions/${sid}/terminate`).catch(() => {})
  await expect.poll(async () => ((await (await request.get(`/api/sessions/${sid}`)).json().catch(() => ({}))) as { session?: { process_status?: string } }).session?.process_status, { timeout: 30_000 })
    .not.toBe('running')
  return { id, sid }
}

test.afterAll(async ({ request }) => {
  for (const sid of Object.values(sids)) if (sid) await request.post(`/api/sessions/${sid}/terminate`).catch(() => {})
  for (const id of letters) await request.delete(`/api/v1/human-inbox/${id}`).catch(() => {})
  for (const id of made.reverse()) await request.delete(`/api/tasks/${id}?force=true`).catch(() => {})
})

let pageErrors: string[] = []
test.beforeEach(async ({ page }) => {
  pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await showPointer(page)
  await isolateUiPrefs(page)
})
test.afterEach(() => { expect(pageErrors, 'no page error').toEqual([]) })

/** Home in Flat (the status sections), with each row's status sentence shown. */
async function homeWithStatusLines(page: Page): Promise<Locator> {
  await page.addInitScript(([key]) => {
    localStorage.setItem(key, 'status')
    localStorage.setItem('open-walnut-view:tasks.statusLines', 'true')
  }, [LS_PANEL_DESIGN_KEY])
  await openApp(page)
  const all = page.locator('.todo-section-tabs [role="tab"]', { hasText: 'All' }).first()
  if (await all.isVisible() && (await all.getAttribute('aria-selected')) !== 'true') {
    await click(page, all)
    await expect(all).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 })
  }
  return page.locator('.todo-panel').first()
}

/**
 * Bring `target` into sight the way a person does: the mouse wheel over the list that scrolls it,
 * until the topmost element at the target's middle is the target. Bounded; reads geometry only.
 */
async function wheelTo(page: Page, target: Locator, max = 40): Promise<void> {
  for (let i = 0; i < max; i++) {
    const at = await target.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const view = { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth }
      // The nearest ancestor that scrolls vertically; its part on screen is where the wheel goes.
      let box = view
      for (let a = el.parentElement; a; a = a.parentElement) {
        const oy = getComputedStyle(a).overflowY
        if ((oy === 'auto' || oy === 'scroll') && a.scrollHeight > a.clientHeight) {
          const s = a.getBoundingClientRect()
          box = { top: Math.max(s.top, 0), bottom: Math.min(s.bottom, view.bottom), left: Math.max(s.left, 0), right: Math.min(s.right, view.right) }
          break
        }
      }
      const x = r.left + r.width / 2
      const y = r.top + r.height / 2
      const inBox = y >= box.top && y <= box.bottom && x >= box.left && x <= box.right
      const hit = inBox ? el.ownerDocument.elementFromPoint(x, y) : null
      const mid = (box.top + box.bottom) / 2
      return {
        shown: !!hit && (hit === el || el.contains(hit)),
        // Off the list's shown part: a full step toward it. On it but covered (a sticky
        // heading): a small step toward the middle of the list.
        dy: y > box.bottom ? 240 : y < box.top ? -240 : y > mid ? 80 : -80,
        wx: (box.left + box.right) / 2,
        wy: mid,
      }
    })
    if (at.shown) return
    await page.mouse.move(at.wx, at.wy)
    await page.mouse.wheel(0, at.dy)
    await page.waitForTimeout(120)
  }
  throw new Error('the wheel never brought the target into sight')
}

/** One task's card in a status section: the section opened, then "Show more" until it is drawn. */
async function sectionCard(page: Page, panel: Locator, key: 'needs' | 'waiting', id: string): Promise<Locator> {
  const toggle = panel.getByTestId(`status-section-${key}`).first().locator('button[aria-expanded]')
  await expect(toggle).toHaveCount(1, { timeout: 20_000 })
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await wheelTo(page, toggle)
    await click(page, toggle)
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  }
  const card = panel.getByTestId(`status-section-${key}-rows`).first().locator(`[data-task-id="${id}"]`)
  const more = panel.getByTestId(`status-section-${key}-more`).first()
  for (let i = 0; i < 40 && (await card.count()) === 0 && (await more.count()) > 0; i++) {
    if (await more.isEnabled()) {
      await wheelTo(page, more)
      await click(page, more)
    }
    await card.waitFor({ state: 'attached', timeout: 1_500 }).catch(() => undefined)
  }
  await expect(card).toHaveCount(1, { timeout: 20_000 })
  await wheelTo(page, card)
  await expect(card).toBeVisible()
  return card
}

/** The row did nothing of its own: no conversation column opened, not the selected row, still Home. */
async function rowUntouched(page: Page, card: Locator, sid: string): Promise<void> {
  await page.waitForTimeout(400)
  await expect(sessionColumn(page, sid)).toHaveCount(0)
  await expect(card).not.toHaveClass(/todo-pinned-card-active/)
  expect(new URL(page.url()).pathname).toBe('/')
}

/** A person's pointer reaches the middle of `target`: the topmost element there is it or inside it. */
async function expectReachable(target: Locator): Promise<void> {
  await expect.poll(() => target.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const hit = el.ownerDocument.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return !!hit && (hit === el || el.contains(hit))
  }), { timeout: 10_000 }).toBe(true)
}

async function expectPopup(context: BrowserContext, page: Page, link: Locator, url = site): Promise<void> {
  await context.route(url, (route) => route.fulfill({ contentType: 'text/html', body: '<h1>External design</h1>' }))
  await expect(link).toHaveAttribute('target', '_blank')
  const popup = context.waitForEvent('page', { timeout: 15_000 })
  await click(page, link)
  const external = await popup
  await expect(external.getByRole('heading', { name: 'External design' })).toBeVisible()
  await external.close()
}

test('Needs you row: its ask opens the file by pointer and Enter, and the row never opens with it', async ({ page }) => {
  const panel = await homeWithStatusLines(page)
  const card = await sectionCard(page, panel, 'needs', ids.needs)
  const line = card.getByTestId('status-card-needs-line')
  const link = line.locator(`a.file-link[data-file-path="${files.picture}"]`)
  await expect(link).toBeVisible()
  // The source as written reaches the row; only its CSS cuts it to one line.
  await expect(line.locator('.needs-line-text')).toHaveAttribute('data-agent-text', 'true')
  expect((await line.boundingBox())!.height).toBeLessThan(24)
  for (let i = 0; i < 2; i++) {
    await click(page, link)
    await expectImage(page)
    await closeFile(page)
    await rowUntouched(page, card, sids.needs)
  }
  await tabTo(page, page.locator('.todo-search-input'), link)
  await page.keyboard.press('Enter')
  await expectImage(page)
  await page.keyboard.press('Escape')
  await expect(page.locator('.file-viewer-overlay')).toHaveCount(0)
  await rowUntouched(page, card, sids.needs)
  await page.setViewportSize({ width: 1024, height: 720 })
  expect(await line.locator('.needs-line-text').textContent()).toContain(files.picture)
  await expect(page.locator('.file-viewer-overlay')).toHaveCount(0)
  await rowUntouched(page, card, sids.needs)
  await page.setViewportSize({ width: 1280, height: 900 })
  await click(page, link)
  await expectImage(page)
  await closeFile(page)
  await rowUntouched(page, card, sids.needs)
  // Selecting the sentence must not activate its row.
  expect((await dragSelect(page, line.locator('.needs-line-text'), 50)).length).toBeGreaterThan(0)
  await expect(page.locator('.file-viewer-overlay')).toHaveCount(0)
  await rowUntouched(page, card, sids.needs)
  await click(page, link)
  await expectImage(page)
  await closeFile(page)
  const acrossLink = await line.locator('.needs-line-text').evaluate((el) => {
    const words = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()!
    const range = el.ownerDocument.createRange()
    range.setStart(words, 1); range.setEnd(words, 3)
    const from = range.getBoundingClientRect()
    const anchor = el.querySelector('a.file-link')!
    const to = anchor.getBoundingClientRect()
    const end = { x: to.left + 12, y: to.top + to.height / 2 }
    if (!anchor.contains(el.ownerDocument.elementFromPoint(end.x, end.y))) throw new Error('The selection endpoint is not on the visible path')
    return { x: from.left + from.width / 2, y: from.top + from.height / 2, end }
  })
  await page.mouse.move(acrossLink.x, acrossLink.y)
  await page.mouse.down()
  await page.mouse.move(acrossLink.end.x, acrossLink.end.y, { steps: 20 })
  await page.mouse.up()
  expect(await line.evaluate((el) => {
    const selection = el.ownerDocument.getSelection()
    return !!selection?.toString() && selection.containsNode(el.querySelector('a.file-link')!, true)
  })).toBe(true)
  await page.waitForTimeout(300)
  await expect(page.locator('.file-viewer-overlay')).toHaveCount(0)
  await rowUntouched(page, card, sids.needs)
  await click(page, link)
  await expectImage(page)
  await closeFile(page)
  await rowUntouched(page, card, sids.needs)
  expect((await dragSelect(page, line.locator('.needs-line-text'), 40)).length).toBeGreaterThan(0)
  const extend = await line.locator('.needs-line-text').evaluate((el) => {
    const text = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()!
    const range = el.ownerDocument.createRange()
    range.setStart(text, Math.max(0, text.textContent!.length - 3))
    range.setEnd(text, text.textContent!.length - 1)
    const r = range.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  await page.keyboard.down('Shift')
  try {
    await page.mouse.move(extend.x, extend.y)
    await page.mouse.down()
    await page.mouse.up()
  } finally { await page.keyboard.up('Shift') }
  expect((await line.evaluate((el) => el.ownerDocument.getSelection()?.toString() ?? '')).length).toBeGreaterThan(0)
  await expect(page.locator('.file-viewer-overlay')).toHaveCount(0)
  await expect(page.locator('.task-selection-bar')).toHaveCount(0)
  await rowUntouched(page, card, sids.needs)
  // A press beside the links still opens the row, as before.
  await click(page, card.locator('.todo-pinned-title'))
  await expect(sessionColumn(page, sids.needs)).toBeVisible({ timeout: 20_000 })
})

test('Waiting row and the parked session\'s wait card open the file, the letter, the URL and the task', async ({ page, context }) => {
  const panel = await homeWithStatusLines(page)
  const row = await sectionCard(page, panel, 'waiting', ids.wait)
  const reason = row.getByTestId('status-card-reason')
  await expect(reason).toContainText('Waiting on')
  await click(page, reason.locator(`a.file-link[data-file-path="${files.document}"]`))
  await expectText(page)
  await closeFile(page)
  await rowUntouched(page, row, sids.wait)

  const session = await openTaskSession(page, titles.wait, ids.wait, sids.wait)
  const chip = session.getByTestId('session-waiting-chip')
  const openCard = async () => {
    const card = page.getByTestId('session-waiting-card')
    if (!(await card.isVisible())) await click(page, chip)
    await expect(card).toBeVisible()
    return card
  }
  let card = await openCard()
  await expect(card.locator('.task-waiting-card-line[data-agent-text]').filter({ hasText: 'Waiting on' })).toHaveCount(1)
  await click(page, card.locator(`a.file-link[data-file-path="${files.document}"]`))
  await expectText(page)
  // The viewer took over: the floating card is gone, so nothing of it lies over the viewer.
  await expect(page.getByTestId('session-waiting-card')).toHaveCount(0)
  await closeFile(page)
  await expect(session).toBeVisible()
  card = await openCard()
  await click(page, card.locator('a.letter-link'))
  await expect(page.locator('.hib-reader')).toContainText(project)
  await expect(page.getByTestId('session-waiting-card')).toHaveCount(0)
  await expectReachable(page.getByRole('button', { name: 'Close letter', exact: true }))
  await closeLinkedLetter(page)
  card = await openCard()
  await expectPopup(context, page, card.locator(`a[href="${site}"]`))
  card = await openCard()
  await click(page, card.locator(`a.task-link[data-task-id="${worker}"]`))
  // Home finds the task (its row, not the link that named it).
  await expect(page.locator(`.todo-panel [data-task-id="${worker}"]:not(a)`).first()).toBeVisible({ timeout: 20_000 })
  const search = page.locator('.todo-search-input')
  await expect(search).toHaveValue('')
  await expect(page.getByTestId('session-waiting-card')).toHaveCount(0)
  await click(page, search)
  await page.keyboard.type('Entry worker again', { delay: 1 })
  await expect(search).toHaveValue('Entry worker again')
  await expect(search).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(search).toHaveValue('')
})

test('a minimized session\'s taskbar card links its status line and last reply; the chip stays a chip', async ({ page }) => {
  await openApp(page)
  const session = await openTaskSession(page, titles.bar, ids.bar, sids.bar)
  await click(page, session.getByRole('button', { name: 'Minimize session to the taskbar' }))
  await expect(session).toHaveCount(0)
  const chip = page.locator(`.session-taskbar-chip[data-session-id="${sids.bar}"]`)
  await expect(chip).toBeVisible()
  const peek = async () => {
    const card = page.getByTestId('session-taskbar-card')
    if (!(await card.isVisible())) await click(page, chip.getByRole('button', { name: /Peek at/ }))
    await expect(card).toBeVisible()
    await expect(card.getByTestId('session-taskbar-card-reply')).not.toHaveText(/Loading/, { timeout: 20_000 })
    return card
  }
  const stillAChip = async () => {
    await expect(chip).toBeVisible()
    await expect(sessionColumn(page, sids.bar)).toHaveCount(0)
    await expect(page.locator('.session-taskbar-chip.is-dragging')).toHaveCount(0)
  }
  /** A viewer took over: the card is gone and the viewer is open; one real Escape closes the viewer. */
  const viewerTookOver = async () => {
    await expect(page.getByTestId('session-taskbar-card')).toHaveCount(0)
    await expect(page.locator('.file-viewer-overlay')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(page.locator('.file-viewer-overlay')).toHaveCount(0)
  }
  let card = await peek()
  const reply = card.getByTestId('session-taskbar-card-reply')
  // The reply reaches the card as the session wrote it: nothing stripped, its end included; the CSS keeps it to four lines.
  const words = reply.locator('[data-agent-text]')
  await expect(words).toContainText(files.picture)
  await expect(words).toContainText(`${files.document}:2-3`)
  await expect(words).toContainText(BAR_TAIL)
  expect(await reply.evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-line-clamp'))).toBe('4')
  await expect.poll(() => reply.evaluate((el) => Math.abs(el.getBoundingClientRect().height - parseFloat(getComputedStyle(el).lineHeight) * 4)), { timeout: 10_000 }).toBeLessThanOrEqual(1)
  // The letter, the task and the picture start inside the four shown lines; the end lies past the clamp.
  // Read one layout: placement may move the card after its last reply arrives.
  await expect.poll(() => reply.evaluate((el, selectors) => {
    const clip = el.getBoundingClientRect()
    return selectors.every((selector) => {
      const link = el.querySelector(selector)
      const first = link?.getClientRects()[0]
      return !!first && first.top >= clip.top - 1 && first.bottom <= clip.bottom + 1
    })
  }, ['a.letter-link', `a.task-link[data-task-id="${worker}"]`, `a.file-link[data-file-path="${files.picture}"]`]), { timeout: 10_000 }).toBe(true)
  const tailClamped = await reply.evaluate((el, tail) => {
    const walk = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const at = n.textContent?.indexOf(tail) ?? -1
      if (at < 0) continue
      const range = el.ownerDocument.createRange()
      range.setStart(n, at)
      range.setEnd(n, at + tail.length)
      return (range.getClientRects()[0]?.top ?? Number.NaN) >= el.getBoundingClientRect().bottom
    }
    return false
  }, BAR_TAIL)
  expect(tailClamped, 'the end of the reply is clamped out of sight').toBe(true)
  await click(page, card.getByTestId('session-taskbar-card-line').locator(`a.file-link[data-file-path="${files.document}"]`))
  await expectText(page)
  await viewerTookOver()
  await stillAChip()
  card = await peek()
  const draft = card.getByRole('textbox', { name: `Message ${titles.bar}` })
  await click(page, draft)
  await page.keyboard.type('Keep this unsent reply', { delay: 20 })
  const chooser = page.waitForEvent('filechooser')
  await click(page, card.getByRole('button', { name: 'Attach image', exact: true }))
  await (await chooser).setFiles(files.picture)
  await expect(card.getByTestId('session-taskbar-card-input-pictures').locator('img')).toHaveCount(1)
  await tabTo(page, card.getByRole('textbox', { name: `Message ${titles.bar}` }), card.getByTestId('session-taskbar-card-line').locator(`a.file-link[data-file-path="${files.document}"]`))
  await page.keyboard.press('Enter')
  await expectText(page)
  await viewerTookOver()
  await stillAChip()
  card = await peek()
  await expect(card.getByRole('textbox', { name: `Message ${titles.bar}` })).toHaveValue('Keep this unsent reply')
  await expect(card.getByTestId('session-taskbar-card-input-pictures').locator('img')).toHaveCount(1)
  const picture = card.getByTestId('session-taskbar-card-reply').locator(`a.file-link[data-file-path="${files.picture}"]`)
  await click(page, picture)
  await expectImage(page)
  await viewerTookOver()
  await stillAChip()
  card = await peek()
  await click(page, card.getByTestId('session-taskbar-card-reply').locator('a.letter-link'))
  await expect(page.locator('.hib-reader')).toContainText(project)
  await expect(page.getByTestId('session-taskbar-card')).toHaveCount(0)
  await expectReachable(page.getByRole('button', { name: 'Close letter', exact: true }))
  await closeLinkedLetter(page)
  await stillAChip()
  // A link dragged inside the card is not a chip being moved.
  card = await peek()
  await expect(card.getByRole('textbox', { name: `Message ${titles.bar}` })).toHaveValue('Keep this unsent reply')
  await expect(card.getByTestId('session-taskbar-card-input-pictures').locator('img')).toHaveCount(1)
  const box = (await card.getByTestId('session-taskbar-card-reply').locator(`a.file-link[data-file-path="${files.picture}"]`).boundingBox())!
  await page.mouse.move(box.x + 8, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 80, box.y - 40, { steps: 10 })
  await page.mouse.up()
  await stillAChip()
  await expect(page.locator('.session-taskbar-chip')).toHaveCount(1)
  await page.setViewportSize({ width: 1280, height: 360 })
  await click(page, card.getByRole('textbox', { name: `Message ${titles.bar}` }))
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End')
  await page.keyboard.type(' after resizing', { delay: 15 })
  await expect(card.getByRole('textbox', { name: `Message ${titles.bar}` })).toHaveValue('Keep this unsent reply after resizing')
  const scroll = await card.evaluate((el) => {
    const rect = el.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, distance: el.scrollHeight - el.clientHeight }
  })
  if (scroll.distance > 0) {
    await page.mouse.move(scroll.x, scroll.y)
    await page.mouse.wheel(0, scroll.distance)
  }
  await expectReachable(card.getByTestId('session-taskbar-card-send'))
  const shortBox = (await card.boundingBox())!
  expect(shortBox.y).toBeGreaterThanOrEqual(0)
  expect(shortBox.y + shortBox.height).toBeLessThanOrEqual(360)
  await page.setViewportSize({ width: 1280, height: 900 })
  await expect(card.getByTestId('session-taskbar-card-input-pictures').locator('img')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await click(page, chip.getByRole('button', { name: /Close .* to the background/ }))
})

test('the extension\'s Tasks pop-out opens a path in its own viewer, a letter in the app window, a task and a URL in new tabs', async ({ page, context }) => {
  await openApp(page)
  const popout = await context.newPage()
  await showPointer(popout)
  await isolateUiPrefs(popout)
  await openApp(popout, `${base}/popout?view=ext-tasks`, popout.getByTestId('ext-tasks'))
  await expect(popout.getByTestId('ext-tasks')).toHaveAttribute('data-lists', 'fresh', { timeout: 30_000 })
  const row = popout.getByTestId('ext-tasks-needs').locator(`[data-testid="ext-task"][data-task-id="${ids.needs}"]`)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await click(popout, row.locator('.ext-task-head'))
  await expect(row).toHaveClass(/is-open/)
  const said = row.getByTestId('ext-task-asked')
  // The ask and the whole last message, neither cut: the end of the reply is there too.
  await expect(said).toContainText(`${files.document}:2-3`, { timeout: 30_000 })
  await expect(said.locator('p')).not.toHaveCount(0)
  expect(await said.locator('p p, p div').count()).toBe(0)
  const asked = said.locator('[data-agent-text]').first()
  await click(popout, asked.locator(`a.file-link[data-file-path="${files.picture}"]`))
  await expectImage(popout)
  await closeFile(popout)
  await expect(row).toHaveClass(/is-open/)
  // The pop-out has no notification center: the app's window opens the letter.
  await click(popout, asked.locator('a.letter-link'))
  await expect(page.locator('.hib-reader')).toContainText(project, { timeout: 20_000 })
  await expect(popout.locator('.hib-reader')).toHaveCount(0)
  await expect(row).toHaveClass(/is-open/)
  const last = said.locator('.ext-task-last')
  await click(popout, last.locator(`a.file-link[data-file-path="${files.document}"]`))
  await expectText(popout)
  await closeFile(popout)
  const opened = context.waitForEvent('page', { timeout: 15_000 })
  await click(popout, last.locator(`a.task-link[data-task-id="${worker}"]`))
  const tab = await opened
  await expect.poll(() => new URL(tab.url()).pathname, { timeout: 15_000 }).toBe(`/tasks/${encodeURIComponent(worker)}`)
  await tab.close()
  await expect(popout.locator('.file-viewer-overlay')).toHaveCount(0)
  await expectPopup(context, popout, last.locator(`a[href="${site}"]`))
  await expect(row).toHaveClass(/is-open/)
  await popout.setViewportSize({ width: 380, height: 640 })
  await click(popout, asked.locator(`a.file-link[data-file-path="${files.picture}"]`))
  await expectImage(popout)
  await closeFile(popout)
  await popout.close()
})

test('triage history: the stored analysis links its file past the old preview cut, a letter, a task and a URL; only the header folds it', async ({ page, context }) => {
  test.skip(process.env.PW_AGENT_TEXT_ENTRIES !== '1', 'the triage record is seeded only with PW_AGENT_TEXT_ENTRIES=1')
  const { walnutHome } = await discoverBrowserFixture(Number(new URL(base).port))
  const root = `${walnutHome}/projects/triage-fixture`
  const picture = `${root}/triage-design.png`
  const notes = `${root}/triage-notes.txt`
  const report = 'https://example.com/triage-report'
  await openApp(page)
  await click(page, page.locator('.todo-search-input'))
  await page.keyboard.type('Triage links fixture', { delay: 15 })
  const row = page.locator('.todo-panel-item[data-task-id="pw-task-triage"]')
  await expect(row).toBeVisible({ timeout: 20_000 })
  // A press on the row only selects it; its details open from the row's menu, as a person opens them.
  await click(page, row.getByRole('button', { name: 'More actions' }))
  // The menu portals to <body>, outside the row.
  await click(page, page.locator('.task-kebab-menu').getByRole('button', { name: 'Details', exact: true }))
  const detail = page.locator('.task-detail-modal')
  await expect(detail).toBeVisible({ timeout: 20_000 })
  await click(page, detail.getByRole('button', { name: /Triage history \(1\)/ }))
  const panel = page.locator('.triage-panel[data-task-id="pw-task-triage"]')
  await expect(panel).toBeVisible({ timeout: 20_000 })
  // The detail popup stays over Home until it is closed: Escape, as a person closes it.
  const popup = page.locator('.task-detail-modal-overlay')
  if (await popup.count()) {
    await page.keyboard.press('Escape')
    await expect(popup).toHaveCount(0)
  }
  await expect(panel).toBeVisible()
  const section = panel.locator('.triage-session-section').first()
  const header = section.locator('.triage-session-header')
  const folded = (open: boolean) => expect(header).toHaveAttribute('aria-expanded', String(open))
  // The newest record opens first; with no session behind it the stored analysis is its body.
  await folded(true)
  const full = section.locator('.triage-session-summary-full')
  const reads: string[] = []
  page.on('request', (r) => {
    const url = new URL(r.url())
    if (/^\/api\/(?:files\/|file-content|file-raw\/|local-image)/.test(url.pathname)) reads.push(r.url())
  })
  const chooseLocal = async (count: number) => {
    const choice = page.getByTestId('file-source-choice')
    await expect(page.getByTestId('file-viewer-source-error')).toContainText('No file was read')
    await expect(choice).toBeVisible()
    await page.waitForTimeout(300)
    expect(reads, 'an older analysis reads no file before choosing its machine').toHaveLength(count)
    await click(page, choice.getByTestId('file-source-local'))
  }
  await click(page, full.locator(`a.file-link[data-file-path="${picture}"]`))
  expect(reads, 'the first click did not guess a machine').toHaveLength(0)
  await chooseLocal(0)
  await expectImage(page)
  await closeFile(page)
  await folded(true)
  const beforeNotes = reads.length
  await click(page, full.locator(`a.file-link[data-file-path="${notes}"]`))
  await chooseLocal(beforeNotes)
  await expectText(page)
  await closeFile(page)
  await click(page, full.locator('a.letter-link'))
  await expect(page.locator('.hib-reader')).toContainText('Triage fixture letter')
  await closeLinkedLetter(page)
  await expectPopup(context, page, full.locator(`a[href="${report}"]`), report)
  await folded(true)
  // The task named in the analysis: Home finds its row; the record stays open.
  await click(page, full.locator('a.task-link[data-task-id="pw-task-codepath"]'))
  await folded(true)
  await expect(page.locator('[data-task-id="pw-task-codepath"]:not(a)').first()).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.todo-search-input')).toHaveValue('')
  await expect(panel).toBeVisible()
  // Folding keeps the whole analysis linked, but only the first lines are visible.
  await click(page, header)
  await folded(false)
  const preview = section.locator('.triage-session-summary')
  await expect(preview).toContainText('for the rest.')
  await expect(preview.locator('a.letter-link')).toHaveCount(1)
  await expect(preview.locator('a.task-link[data-task-id="pw-task-codepath"]')).toHaveCount(1)
  await expect(preview.locator(`a[href="${report}"]`)).toHaveCount(1)
  // The path lies below the preview's clamp, so open the record before pressing it again.
  await click(page, header)
  await folded(true)
  // The same path in the same tab opens on the machine the person chose for it before, and says so.
  await click(page, full.locator(`a.file-link[data-file-path="${picture}"]`))
  await expectImage(page)
  await expect(page.getByTestId('file-viewer-remembered')).toContainText('the machine you chose for this path before')
  await expectViewerFillsPanel(page)
  await expect(page.getByTestId('file-viewer-source-error')).toHaveCount(0)
  await closeFile(page)
  await click(page, header)
  await folded(false)
  // A press on the words, not a link, still opens it, and the header folds it again.
  await click(page, preview.locator('[data-agent-text]'))
  await folded(true)
  await click(page, header)
  await folded(false)
  // Selecting the preview must not unfold it.
  expect((await dragSelect(page, preview.locator('[data-agent-text]'), 60)).length).toBeGreaterThan(0)
  await folded(false)
})
