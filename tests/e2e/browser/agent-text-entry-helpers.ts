// Real pointer and keyboard steps, and backend seeds, shared by the agent-text entry specs.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { TINY_SILENT_MP4_BASE64 } from './fixtures/tiny-video'
import { dragAcrossWords, press as click } from './real-press'
import { DRAFT_PANEL } from './draft-helpers'
import { PHONE_QUERY } from './board-view-helpers'

export const AGENT_TEXT_BASE = process.env.AGENT_TEXT_URL ?? 'http://localhost:3457'
/** A neutral picture of the repo's own (192px) when the run names no real screenshot. */
const STAND_IN_PICTURE = fileURLToPath(new URL('../../../web/public/icon-192.png', import.meta.url))

/** A dot that follows the mouse, so a recording shows where each press lands. */
export async function showPointer(page: Page): Promise<void> {
  await page.addInitScript(() => document.addEventListener('mousemove', (e) => {
    let pointer = document.getElementById('acceptance-pointer')
    if (!pointer) {
      pointer = document.createElement('div'); pointer.id = 'acceptance-pointer'
      pointer.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;width:12px;height:12px;border:2px solid white;border-radius:50%;background:#0a84ff'
      document.documentElement.appendChild(pointer)
    }
    pointer.style.left = `${e.clientX - 6}px`; pointer.style.top = `${e.clientY - 6}px`
  }))
}

export { click }

/**
 * A real press and drag across a visible line of `target`'s own words (a text selection, never
 * a button's label, an icon or the box's padding); returns what got selected.
 */
export async function dragSelect(page: Page, target: Locator, width = 60): Promise<string> {
  return dragAcrossWords(page, target, width)
}

/**
 * A draft column pointed at `cwd` by native input only, the route `openDraftOnCwd` in
 * draft-helpers.ts takes: the toolbar "+", the draft's folder pill, the picker's Local tab
 * when it has host tabs, the path typed into its search and Shift+Enter, then `engine` on the
 * composer's model pill. Every press is `real-press`, every key the keyboard's.
 */
export async function openDraftOnCwd(page: Page, cwd: string, opts: { engine?: 'Codex' | 'Claude' } = {}): Promise<Locator> {
  await click(page, page.locator('.new-launcher-btn'))
  const panel = page.locator(DRAFT_PANEL).first()
  await expect(panel).toBeVisible({ timeout: 10_000 })
  const pill = panel.locator('.draft-composer-bar .session-action-chip').first()
  await click(page, pill)
  // Portalled to <body>; only one picker is open at a time.
  const picker = page.locator('.session-path-selector')
  await expect(picker).toBeVisible({ timeout: 10_000 })
  // The host tabs render with the history rows: wait for a row before looking for them.
  await expect(picker.locator('.sps-path-item').first()).toBeVisible({ timeout: 20_000 })
  const localTab = picker.locator('.sps-host-tab', { hasText: 'Local' })
  if (await localTab.isVisible()) await click(page, localTab)
  await expect(picker.locator('.pin-tier-options, .provider-rail-item')).toHaveCount(0)
  const search = picker.locator('.sps-search-input')
  await click(page, search)
  await expect(search).toBeFocused()
  // Whatever the search held goes, as a person clears a field: select all, delete, then type.
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  await page.keyboard.type(cwd, { delay: 5 })
  await expect(search).toHaveValue(cwd)
  await page.keyboard.press('Shift+Enter')
  await expect(picker).toBeHidden()
  await expect(pill).toContainText(cwd.replace(/\/+$/, '').split('/').pop() || '/')
  if (opts.engine) {
    const engineId = opts.engine === 'Codex' ? 'codex' : 'claude'
    const models = page.locator('.model-picker')
    if (!(await models.isVisible())) await click(page, panel.locator('.draft-actions-bar .draft-model-select'))
    await expect(models).toBeVisible({ timeout: 10_000 })
    const button = models.locator(`.provider-rail-item[data-provider="${engineId}"]`)
    await expect(button).toBeVisible({ timeout: 15_000 })
    await expect(button, `${engineId} is locked on this draft`).not.toHaveClass(/provider-rail-item-locked/)
    if ((await button.getAttribute('aria-selected')) !== 'true') await click(page, button)
    await expect(button).toHaveAttribute('aria-selected', 'true')
    await click(page, models.locator('.model-picker-close'))
    await expect(models).toHaveCount(0)
  }
  return panel
}

/**
 * The Board of the session in `panel`, opened by native input the way its layout offers it
 * (the route of `openSessionBoard` in board-view-helpers.ts): the header chip when it is live
 * on the row, else the phone top bar's More actions, else the header's "..." menu.
 */
export async function openSessionBoard(page: Page, panel: Locator): Promise<Locator> {
  const chip = panel.getByTestId('session-board-chip')
  await expect(chip).toHaveCount(1, { timeout: 30_000 })
  const phone = await page.evaluate((q) => window.matchMedia(q).matches, PHONE_QUERY)
  // A chip that turns live on the row is the click. A phone whose header folds the chip away goes
  // to the top bar at once: waiting out the poll for a chip it keeps hidden alone outlasted a test.
  const place = async (): Promise<'row' | 'folded' | 'wait'> => {
    const hidden = (await chip.getAttribute('data-hidden')) === 'true'
    if (!hidden && await chip.isEnabled() && await chip.isVisible()) return 'row'
    return phone && hidden ? 'folded' : 'wait'
  }
  let where = await place()
  for (const deadline = Date.now() + 30_000; where === 'wait' && Date.now() < deadline;) {
    await page.waitForTimeout(250)
    where = await place()
  }
  if (where === 'row') {
    await click(page, chip)
  } else if (phone) {
    await click(page, page.locator('.phone-topbar').getByRole('button', { name: 'More actions' }))
    const row = page.getByTestId('phone-row-board')
    await expect(row).toBeEnabled({ timeout: 30_000 })
    await click(page, row)
  } else if ((await chip.getAttribute('data-hidden')) === 'true') {
    await click(page, panel.getByTestId('session-header-more-btn'))
    const row = page.getByTestId('session-header-more-item-board')
    await expect(row).toBeEnabled({ timeout: 30_000 })
    await click(page, row)
  } else {
    await click(page, chip)
  }
  const pane = page.getByTestId('task-board-pane')
  await expect(pane).toBeVisible({ timeout: 30_000 })
  return pane
}

/** The leader's page in the Board `pane`: its Page segment, pressed when it is not the view yet. */
export async function showCustomBoard(pane: Locator): Promise<void> {
  const custom = pane.getByTestId('board-view-custom')
  await expect(custom).toBeVisible({ timeout: 15_000 })
  await expect(custom).not.toHaveAttribute('aria-disabled', 'true', { timeout: 15_000 })
  if ((await custom.getAttribute('aria-pressed')) !== 'true') await click(pane.page(), custom)
  await expect(custom).toHaveAttribute('aria-pressed', 'true')
}

/** Keyboard focus by real input: a press on a harmless start, then Tab (Option-Tab in WebKit) until the target holds it. */
export async function tabTo(page: Page, start: Locator, target: Locator, max = 300): Promise<void> {
  await click(page, start)
  const engine = page.context().browser()?.browserType().name()
  for (const key of engine === 'webkit' ? ['Tab', 'Alt+Tab'] : ['Tab']) {
    if (key !== 'Tab') await click(page, start)
    for (let i = 0; i < max; i++) {
      if (await target.evaluate((el) => el === document.activeElement)) return
      await page.keyboard.press(key)
    }
  }
  await expect(target, 'Tab never reached the link').toBeFocused()
}

/** Into the app the way a person comes in: a link to it, pressed. `url` defaults to the app's root. */
export async function openApp(page: Page, url = `${AGENT_TEXT_BASE}/`, ready: Locator = page.getByTestId('sidebar-org')): Promise<void> {
  await page.setContent(`<a href="${url}">Open Walnut</a>`)
  await click(page, page.getByRole('link', { name: 'Open Walnut', exact: true }))
  await expect(ready).toBeVisible({ timeout: 60_000 })
}

export async function expectImage(page: Page): Promise<void> {
  const image = page.locator('.file-viewer-overlay img').first()
  await expect(image).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), { timeout: 30_000 }).toBe(true)
}

/** The open file fills the viewer's panel (tree on the left, file on the right), and a note above it is a row of its own, never a column beside it. */
export async function expectViewerFillsPanel(page: Page): Promise<void> {
  const panel = page.locator('.file-viewer-panel')
  const explorer = panel.locator('.session-file-explorer')
  const tree = explorer.locator('.session-file-explorer-tree')
  await expect(explorer).toBeVisible({ timeout: 30_000 })
  await expect.poll(async () => {
    const [p, e, t] = [await panel.boundingBox(), await explorer.boundingBox(), await tree.first().boundingBox()]
    if (!p || !e || !t) return false
    return e.width >= p.width - 4 && e.x <= p.x + 4 && t.x - p.x < p.width * 0.35
  }, { timeout: 10_000, message: 'the file, its tree and its preview use the whole panel' }).toBe(true)
  const note = page.getByTestId('file-viewer-remembered')
  if (await note.count()) {
    const [n, e] = [await note.boundingBox(), await explorer.boundingBox()]
    expect(n!.y + n!.height, 'the remembered-machine line is a row above the file, not a column beside it').toBeLessThanOrEqual(e!.y + 1)
  }
}

export async function expectText(page: Page, words = 'Line two'): Promise<void> {
  await expect(page.locator('.file-viewer-overlay .cm-content')).toContainText(words, { timeout: 30_000 })
}

/** Close the viewer with its own × and see it go. */
export async function closeFile(page: Page): Promise<void> {
  if (process.env.AGENT_TEXT_SHOTS) {
    await fs.mkdir(process.env.AGENT_TEXT_SHOTS, { recursive: true })
    const slug = test.info().title.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 100)
    await page.screenshot({ path: `${process.env.AGENT_TEXT_SHOTS}/${slug}-viewer.png` }).catch(() => {})
  }
  await click(page, page.locator('.file-viewer-close'))
  await expect(page.locator('.file-viewer-overlay')).toHaveCount(0)
}

/** Close a letter opened from the Notifications list: the reader, then the panel under it, so its backdrop takes no click. */
export async function closeLetter(page: Page): Promise<void> {
  await click(page, page.getByRole('button', { name: 'Close letter', exact: true }))
  const panelClose = page.locator('.notification-panel .notification-panel-close')
  if (await panelClose.count()) await click(page, panelClose)
  await expect(page.locator('.notification-panel-backdrop')).toHaveCount(0)
}

/** A letter a link in text opened onto a closed center: one press on Close letter returns to the link, the panel it opened goes with it. */
export async function closeLinkedLetter(page: Page): Promise<void> {
  await click(page, page.getByRole('button', { name: 'Close letter', exact: true }))
  await expect(page.locator('.notification-panel-backdrop')).toHaveCount(0)
  await expect(page.locator('.notification-panel')).toHaveCount(0)
}

export interface AgentFiles { picture: string; document: string; movie: string }

/** The files the agent words name, written where the fixture's sessions work (or into `dir`). */
export async function seedAgentFiles(name: string, dir?: string): Promise<AgentFiles> {
  const root = dir ?? `${(await discoverBrowserFixture(Number(new URL(AGENT_TEXT_BASE).port))).fixtureRoot}/projects/walnut`
  await fs.mkdir(root, { recursive: true })
  const files = {
    picture: path.join(root, `${name}.png`),
    document: path.join(root, `${name}.txt`),
    movie: path.join(root, `${name}.mp4`),
  }
  await fs.copyFile(process.env.AGENT_TEXT_PATH || STAND_IN_PICTURE, files.picture)
  await fs.writeFile(files.document, 'Agent link file\nLine two\nLine three\nLine four\n')
  // A silent clip: no test here ever plays sound.
  await fs.writeFile(files.movie, Buffer.from(TINY_SILENT_MP4_BASE64, 'base64'))
  return files
}

async function ok(res: { ok(): boolean; text(): Promise<string>; json(): Promise<any> }, what: string): Promise<any> {
  expect(res.ok(), `${what}: ${await res.text()}`).toBe(true)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

/** A task whose last reply is the mock CLI's echo of `message`, then stopped so no later turn rewrites its line. */
export async function taskWithReply(request: APIRequestContext, title: string, project: string, message: string, opts: { keepSession?: boolean } = {}): Promise<{ id: string; sid: string }> {
  const id = (await ok(await request.post('/api/tasks', { data: { title, project, source: 'local' } }), 'create task')).task.id as string
  const dirs = (await ok(await request.get('/api/sessions/working-dirs'), 'working dirs')) as { dirs: Array<{ cwd: string }> }
  const cwd = dirs.dirs.find((d) => /\/ps-fixture\/projects\/walnut$/.test(d.cwd))?.cwd
  expect(cwd, 'ps-fixture/projects/walnut seed').toBeTruthy()
  const sid = (await ok(await request.post('/api/sessions/quick-start', { data: { cwd, message, taskId: id } }), 'quick-start')).sessionId as string
  await expect.poll(async () => {
    const res = await request.get(`/api/sessions/${sid}/history`)
    if (!res.ok()) return ''
    const body = (await res.json()) as { messages?: Array<{ role: string; text?: string }> }
    return (body.messages ?? []).filter((m) => m.role === 'assistant').map((m) => m.text ?? '').join('\n')
  }, { timeout: 90_000 }).toContain('Hello! I processed your message')
  if (!opts.keepSession) {
    await request.post(`/api/sessions/${sid}/interrupt`).catch(() => {})
    await request.post(`/api/sessions/${sid}/terminate`).catch(() => {})
    await expect.poll(async () => ((await (await request.get(`/api/sessions/${sid}`)).json().catch(() => ({}))) as { session?: { process_status?: string } }).session?.process_status, { timeout: 30_000 })
      .not.toBe('running')
  }
  return { id, sid }
}

/** Set the task's line as a person does (PUT /report) and wait until its user status carries it.
 *  `headers`: the same write from a session instead (`x-walnut-caller-sid`), which Walnut records
 *  as the line's writer; none is a person's write, as before. */
export async function setReport(request: APIRequestContext, id: string, body: Record<string, unknown>, carried: (status: any) => boolean, headers?: Record<string, string>): Promise<any> {
  const data = body.state === 'needs'
    ? { user_kind: 'user_info', user_kind_why: 'Only the user knows which fixture design is current', ...body }
    : body
  await ok(await request.put(`/api/v1/tasks/${id}/report`, { data, ...(headers ? { headers } : {}) }), 'report')
  let last: any = null
  await expect.poll(async () => {
    const b = (await (await request.get(`/api/tasks/${id}`)).json()) as { task?: { user_status?: unknown }; user_status?: unknown }
    last = (b.task ?? b).user_status ?? null
    return Boolean(last && carried(last))
  }, { timeout: 30_000, message: `user_status of ${id}` }).toBe(true)
  return last
}

/** A Home session column of `sid`, if one is open. */
export const sessionColumn = (page: Page, sid: string): Locator =>
  page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"]`)

/** Open a task's conversation on Home the way a person finds it: the search box, then its title. */
export async function openTaskSession(page: Page, title: string, id: string, sid: string): Promise<Locator> {
  const search = page.locator('.todo-search-input')
  await click(page, search)
  const results = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname === '/api/search' && url.searchParams.get('q') === title.trim()
  })
  await page.keyboard.type(title, { delay: 15 })
  await (await results).finished()
  await expect(page.getByTestId('agent-search-panel').filter({ has: page.locator('[aria-busy="true"]') })).toHaveCount(0)
  const row = page.locator(`.todo-panel-item[data-task-id="${id}"]`)
  await expect(row).toBeVisible({ timeout: 20_000 })
  await click(page, row.locator('.todo-item-title'))
  const panel = sessionColumn(page, sid)
  await expect(panel).toBeVisible({ timeout: 20_000 })
  return panel
}
