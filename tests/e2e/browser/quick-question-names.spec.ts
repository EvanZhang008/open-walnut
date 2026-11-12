import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { openChatOnLoad } from './draft-helpers'
import { mockControlsSession } from './composer-controls-overflow-helpers'

const SHOTS = process.env.QUICK_QUESTION_SHOT_DIR ?? '/tmp/quick-question-names'
const STAMP = Date.now().toString(36)

test.use({
  viewport: { width: 1312, height: 822 },
  video: 'on',
})
test.setTimeout(180_000)

const pageErrors = new WeakMap<Page, string[]>()
test.beforeAll(async () => { await fs.mkdir(SHOTS, { recursive: true }) })
test.beforeEach(async ({ page }) => {
  const errors: string[] = []
  pageErrors.set(page, errors)
  page.on('pageerror', error => errors.push(error.message))
  await openChatOnLoad(page)
})
test.afterEach(async ({ page }) => { expect(pageErrors.get(page) ?? [], 'browser errors').toEqual([]) })

const slot = (page: Page): Locator => page.getByTestId('ask-walnut-slot')
const drawer = (page: Page): Locator => page.getByTestId('ask-walnut-drawer')
const menuButton = (page: Page): Locator => slot(page).getByTestId('ask-walnut-menu').first()
const slotDraft = (page: Page): Locator => page.getByTestId('ask-walnut-draft')
const slotMainDraft = (page: Page): Locator => page.getByTestId('ask-walnut-main-draft')
const slotSession = (page: Page): Locator => page.getByTestId('ask-walnut-session')
const sidebarToggle = (page: Page): Locator =>
  page.getByRole('group', { name: 'Home panels' }).getByRole('button', { name: 'Quick question', exact: true })

async function pointAt(_page: Page, target: Locator): Promise<void> {
  await target.click({ timeout: 30_000 })
}

/** Type as a person does: one key at a time into whatever has focus. */
async function typeKeys(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text, { delay: 12 })
}

async function openDrawer(page: Page): Promise<void> {
  if (await drawer(page).count()) return
  await pointAt(page, menuButton(page))
  await expect(drawer(page)).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(250)
}

async function loadHome(page: Page): Promise<void> {
  const url = test.info().project.use.baseURL
  if (!url) throw new Error('The fixture server URL is missing')
  await page.setContent(`<a href="${url}">Open Walnut</a>`)
  await pointAt(page, page.getByRole('link', { name: 'Open Walnut', exact: true }))
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 60_000 })
}

async function shotSlot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(250)
  await slot(page).screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png`, scale: 'css' })
}

test('the sidebar entry is Quick question, and it hides and shows the slot', async ({ page }) => {
  await loadHome(page)
  await expect(slot(page)).toBeVisible({ timeout: 30_000 })
  const toggle = sidebarToggle(page)
  await expect(toggle).toHaveText('Quick question')
  await expect(toggle).toHaveClass(/active/)
  await shotSlot(page, '1-slot-open')

  // Width, not visibility: a yielded chat spot may be collapsed or unmounted.
  const chatWidth = async () => {
    const chat = page.locator('.main-page-chat')
    return (await chat.count()) ? (await chat.first().boundingBox())?.width ?? 0 : 0
  }
  await pointAt(page, toggle)
  await expect(toggle).not.toHaveClass(/active/)
  await expect.poll(chatWidth, { timeout: 10_000 }).toBeLessThanOrEqual(1)

  await pointAt(page, toggle)
  await expect(toggle).toHaveClass(/active/)
  await expect.poll(chatWidth, { timeout: 10_000 }).toBeGreaterThan(1)
  await expect(slot(page)).toBeVisible()
})

test('New quick question: the drawer and composer read Quick question, and the send still files under Ask Walnut', async ({ page }) => {
  await loadHome(page)
  await openDrawer(page)
  await expect(drawer(page).locator('.ask-walnut-drawer-title')).toHaveText(/^Quick question$/)
  await expect(drawer(page).getByTestId('ask-walnut-search')).toHaveAttribute('placeholder', 'Search quick questions')
  const newButton = drawer(page).getByTestId('ask-walnut-new')
  await expect(newButton).toHaveText('+ New quick question')
  await shotSlot(page, '2-drawer')

  await pointAt(page, newButton)
  await expect(drawer(page)).toHaveCount(0)
  await expect(slotDraft(page)).toBeVisible({ timeout: 15_000 })
  await expect(slotDraft(page).locator('.session-panel-title')).toHaveText('Quick question')
  const composer = slotDraft(page).locator('.chat-input-textarea')
  await expect(composer).toHaveAttribute('placeholder', 'Ask a quick question…')
  await expect(composer).toBeFocused()
  await shotSlot(page, '3-new-quick-question')

  const prompt = `quick question names ${STAMP}`
  const launched = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
  const answered = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
  await typeKeys(page, prompt)
  await page.keyboard.press('Enter')
  const sent = (await launched).postDataJSON() as { project?: string; walnutAgent?: boolean; agentId?: string }
  expect(sent.project, 'the stored project key is unchanged').toBe('Ask Walnut')
  expect(sent.walnutAgent).toBe(true)
  expect(sent.agentId).toBeUndefined()
  const res = await answered
  expect(res.status(), await res.text()).toBe(200)
  const { taskId, sessionId, task } = (await res.json()) as { taskId: string; sessionId: string; task?: { project?: string } }
  expect(task?.project).toBe('Ask Walnut')
  await expect(slotSession(page)).toHaveAttribute('data-session-id', sessionId, { timeout: 60_000 })
  await expect(slotSession(page).getByText(`I processed your message: ${prompt}`).first()).toBeVisible({ timeout: 60_000 })

  await openDrawer(page)
  await expect(drawer(page).getByTestId('ask-walnut-search')).toBeFocused()
  const historyRow = drawer(page).locator(`[data-testid="ask-walnut-drawer-item"][data-task-id="${taskId}"]`)
  await expect(historyRow).toBeVisible({ timeout: 20_000 })
  const historyTitle = await historyRow.locator('.ask-walnut-drawer-item-title').innerText()
  expect(historyTitle).not.toBe('Ask Walnut')
  await typeKeys(page, historyTitle)
  await expect(historyRow).toBeVisible()
  await shotSlot(page, '4-found')
  await pointAt(page, historyRow)
  await expect(drawer(page)).toHaveCount(0)
  await expect(slotSession(page)).toHaveAttribute('data-session-id', sessionId)
  await expect(slotSession(page).getByText(`I processed your message: ${prompt}`).first()).toBeVisible()
})

test('the agent switch reads Quick question · Mentor, and Mentor\'s send still files under Ask Mentor', async ({ page }) => {
  await loadHome(page)
  await openDrawer(page)
  const agentSwitch = drawer(page).getByTestId('ask-walnut-agent-switch')
  await expect(agentSwitch).toHaveText(/^Quick question$/)
  await pointAt(page, agentSwitch)
  await pointAt(page, drawer(page).locator('[data-testid="ask-walnut-agent-item"][data-agent-id="mentor"]'))
  await expect(agentSwitch).toHaveText(/^Quick question · Mentor$/)
  await expect(drawer(page).getByTestId('ask-walnut-new')).toHaveAttribute('title', 'Start a new quick question for Mentor')
  await shotSlot(page, '5-mentor-drawer')

  await pointAt(page, drawer(page).getByTestId('ask-walnut-new'))
  await expect(slotDraft(page).locator('.session-panel-title')).toHaveText('Quick question · Mentor', { timeout: 15_000 })
  const composer = slotDraft(page).locator('.chat-input-textarea')
  await expect(composer).toHaveAttribute('placeholder', 'Ask Mentor a quick question…')
  await shotSlot(page, '6-mentor-composer')

  const launched = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
  await pointAt(page, composer)
  await typeKeys(page, `mentor quick question ${STAMP}`)
  await page.keyboard.press('Enter')
  const sent = (await launched).postDataJSON() as { project?: string; agentId?: string }
  expect(sent.project).toBe('Ask Mentor')
  expect(sent.agentId).toBe('mentor')
  await expect(slotSession(page)).toBeVisible({ timeout: 60_000 })

  // Back to Walnut's list for whoever opens this browser next.
  await openDrawer(page)
  await pointAt(page, agentSwitch)
  await pointAt(page, drawer(page).locator('[data-testid="ask-walnut-agent-item"][data-agent-id="general"]'))
  await expect(agentSwitch).toHaveText(/^Quick question$/)
})

test('an old placeholder title shows Quick question and inline edit exits never rename it', async ({ page, request }) => {
  const made = await request.post('/api/tasks', { data: { title: 'Ask Walnut', project: 'Ask Walnut', source: 'local', pinned: true } })
  expect(made.ok()).toBe(true)
  const task = (await made.json()).task as { id: string }
  await loadHome(page)
  const title = page.locator(`.todo-panel [data-task-id="${task.id}"] .todo-pinned-title`).first()
  await expect(title).toHaveText('Quick question', { timeout: 30_000 })
  for (const exit of ['Enter', 'Escape', 'outside']) {
    await pointAt(page, title)
    await page.mouse.down({ clickCount: 2 })
    await page.mouse.up({ clickCount: 2 })
    await expect(title).toHaveAttribute('contenteditable', 'true')
    await expect(title).toHaveText('Ask Walnut')
    if (exit === 'outside') await pointAt(page, page.locator('.todo-search-input'))
    else await page.keyboard.press(exit)
    await expect(title).toHaveText('Quick question')
    const saved = await request.get(`/api/tasks/${task.id}`)
    expect((await saved.json()).task.title).toBe('Ask Walnut')
  }
})

test('task dependency references show current display names and preserve real titles', async ({ page, request }) => {
  const make = async (title: string, project: string) => {
    const response = await request.post('/api/tasks', { data: { title, project, source: 'local', pinned: true } })
    expect(response.ok()).toBe(true)
    return (await response.json()).task as { id: string }
  }
  const placeholder = await make('Ask Walnut', 'Ask Walnut')
  const real = await make('Ask Bob about the lease', 'Ask Walnut')
  const parent = await make(`Dependency display ${STAMP}`, 'Garden')
  const linked = await request.patch(`/api/tasks/${parent.id}`, { data: { add_depends_on: [real.id] } })
  expect(linked.ok()).toBe(true)
  await loadHome(page)
  const search = page.locator('.todo-search-input')
  await pointAt(page, search)
  await typeKeys(page, `Dependency display ${STAMP}`)
  const row = page.locator(`.todo-panel [data-task-id="${parent.id}"]`).first()
  await expect(row).toBeVisible()
  await pointAt(page, row.getByRole('button', { name: 'More actions' }))
  await pointAt(page, page.locator('.task-kebab-menu').getByText('Details', { exact: true }))
  const modal = page.locator('.task-detail-modal')
  await expect(modal).toBeVisible()
  await pointAt(page, modal.getByTestId('task-detail-add-dependency'))
  const pickerSearch = modal.getByPlaceholder('Search tasks to depend on...')
  await typeKeys(page, 'Quick question')
  await expect(modal.locator('.tdp-dep-result').filter({ hasText: /^Quick question$/ }).first()).toBeVisible()
  await pickerSearch.fill('Ask Walnut')
  await expect(modal.locator('.tdp-dep-result').filter({ hasText: /^Quick question$/ }).first()).toBeVisible()
  await pointAt(page, modal.locator('.tdp-dep-result').filter({ hasText: /^Quick question$/ }).first())
  await expect.poll(async () => (await (await request.get(`/api/tasks/${parent.id}`)).json()).task.depends_on.length).toBe(2)
  const savedParent = (await (await request.get(`/api/tasks/${parent.id}`)).json()).task
  const pickedID = savedParent.depends_on.find((id: string) => id !== real.id)
  const stored = await request.get(`/api/tasks/${pickedID}`)
  expect((await stored.json()).task.title).toBe('Ask Walnut')
  const dependencies = modal.getByTestId('task-detail-dependency')
  await expect(dependencies).toHaveCount(2)
  await expect(dependencies.filter({ hasText: 'Quick question' })).toHaveCount(1)
  await expect(dependencies.filter({ hasText: 'Ask Bob about the lease' })).toHaveCount(1)
  await pointAt(page, dependencies.getByRole('button', { name: 'Quick question', exact: true }))
  await expect(modal.locator('.todo-detail-title')).toHaveText('Quick question')
})

test('a mouse-selected note task reference finds display and stored names without saving a renamed task', async ({ page, request }) => {
  const name = `quick-question-ref-${Date.now()}`;
  const made = await request.post('/api/tasks', { data: { title: 'Ask Walnut', project: 'Ask Walnut', source: 'local' } });
  expect(made.ok()).toBe(true);
  const task = (await made.json()).task;
  await loadHome(page);
  await pointAt(page, page.getByTestId('sidebar-core-app-notes'));
  await pointAt(page, page.getByTitle('New Note', { exact: true }));
  await pointAt(page, page.getByPlaceholder('note name', { exact: true }));
  await typeKeys(page, name);
  await page.keyboard.press('Enter');
  const editor = page.locator('.notes-editor .tiptap').first();
  try {
    await expect(editor).toBeFocused();
    await typeKeys(page, '/task');
    await pointAt(page, page.getByText('Insert a task reference', { exact: true }));
    const search = page.locator('.notes-task-search-input');
    await expect(search).toBeVisible();
    await pointAt(page, page.getByTitle('Back to commands', { exact: true }));
    await expect(page.getByText('Insert a task reference', { exact: true })).toBeVisible();
    await pointAt(page, page.locator('.notes-format-toolbar'));
    await expect(page.locator('.notes-slash-portal')).toHaveCount(0);
    await pointAt(page, editor);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await typeKeys(page, '/task');
    await pointAt(page, page.getByText('Insert a task reference', { exact: true }));
    await expect(search).toBeVisible();
    await pointAt(page, search);
    await typeKeys(page, 'Quick question');
    const result = page.locator('.notes-task-search-item').filter({ hasText: /^Quick question/ }).first();
    await expect(result).toBeVisible();
    await search.fill('Ask Walnut');
    await expect(result).toBeVisible();
    await pointAt(page, result);
    await expect(editor.locator('a')).toContainText('Quick question');
    await expect(editor.locator('a')).not.toContainText('Ask Walnut');
    await expect.poll(async () => {
      const response = await request.get(`/api/notes-v2/content/${name}.md`);
      return response.ok() ? (await response.json()).content : '';
    }).toContain('Quick question');
    const pickedHref = await editor.locator('a').getAttribute('href');
    expect(pickedHref).toMatch(/^\/tasks\/[^/]+$/);
    const picked = (await (await request.get(`/api/tasks/${pickedHref!.split('/').pop()}`)).json()).task;
    expect({ title: picked.title, project: picked.project }).toEqual({ title: 'Ask Walnut', project: 'Ask Walnut' });
    expect((await (await request.get(`/api/tasks/${task.id}`)).json()).task.title).toBe('Ask Walnut');
  } finally {
    await request.delete(`/api/notes-v2/content/${name}.md`);
    await request.delete(`/api/tasks/${task.id}?force=true`);
  }
});

test('Home task search finds the CEO by its stored title and legacy name', async ({ page, request }) => {
  const made = await request.post('/api/v1/org/main')
  expect(made.ok()).toBe(true)
  const main = (await made.json()).task as { id: string; title: string }
  expect(main.title).toBe('CEO')
  for (let n = 0; n < 8; n++) {
    const response = await request.post('/api/tasks', { data: { title: `ceo main notes ${n}`, project: 'Garden', source: 'local' } })
    expect(response.ok()).toBe(true)
    if (n % 2 === 0) await request.post(`/api/tasks/${(await response.json()).task.id}/complete`)
  }
  await loadHome(page)
  const input = page.locator('.todo-search-input')
  const row = page.locator(`.todo-panel [data-task-id="${main.id}"]`).first()
  for (const query of ['ceo', 'main']) {
    await pointAt(page, input)
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await typeKeys(page, query)
    await expect(input).toHaveValue(query)
    await expect(page.locator('.todo-search-results [data-task-id]').first()).toHaveAttribute('data-task-id', main.id)
    await expect(row).toContainText('CEO')
    await expect(row).toContainText('Org')
    await expect(row).not.toContainText('Quick question')
    await pointAt(page, row)
    await expect(row).toHaveClass(/selected|focused/)
  }
  await input.screenshot({ path: `${SHOTS}/${test.info().project.name}-9-task-search.png` })
  await pointAt(page, page.getByTestId('sidebar-org'))
  await pointAt(page, page.getByTestId('org-channel-main'))
  await expect(page.getByTestId('org-detail-title')).toHaveText('CEO')
})

test('header fitting preserves a live plan composer through repeated column resizing', async ({ page }) => {
  const id = 'pw-rename-plan';
  await mockControlsSession(page, id);
  await page.route(`**/api/sessions/${id}`, route => route.fulfill({ json: { session: {
    claudeSessionId: id, taskId: 'pw-task-vscode', title: 'Rename plan', project: 'Garden',
    process_status: 'idle', mode: 'plan', engine: 'claude', model: 'claude-fable-5-1',
    startedAt: '2026-01-01T00:00:00.000Z', lastActiveAt: new Date().toISOString(),
    messageCount: 6, cwd: '/tmp',
  } } }));
  await page.route(`**/api/sessions/${id}/plan`, route => route.fulfill({ json: {
    content: '# Rename plan\nKeep stored identities unchanged.', planFile: 'rename-plan.md',
  } }));
  await page.addInitScript(sessionId => {
    sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify([{ id: sessionId, locked: false }]));
  }, id);
  await loadHome(page);
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${id}"]`);
  await expect(panel).toBeVisible();
  await panel.getByTitle('Plan & Execute', { exact: true }).click();
  const composer = panel.locator('.plan-popup-input .chat-input-textarea');
  await expect(composer).toBeVisible();
  await composer.click();
  await typeKeys(page, 'Keep this unsent plan question');
  for (const width of [960, 1280, 880, 1280]) {
    await page.setViewportSize({ width, height: 822 });
    await expect(composer).toHaveValue('Keep this unsent plan question');
    await expect(panel.locator('.session-meta-row-2 [data-header-id="close"]')).toBeVisible();
  }
  await composer.click();
  await typeKeys(page, ' and continue typing');
  await expect(composer).toHaveValue('Keep this unsent plan question and continue typing');
  await panel.locator('.plan-popup-close').click();
  await expect(panel.locator('.plan-popup-container')).toHaveCount(0);
});

test('the CEO row: search finds it by ceo and by main, and it opens the CEO', async ({ page, request }) => {
  // Main is made on first use; the list's pinned row reads CEO either way.
  const made = await request.post('/api/v1/org/main')
  expect(made.status(), await made.text()).toBe(200)
  const main = ((await made.json()) as {
    task: { id: string; session_id?: string; exec_session_id?: string; plan_session_id?: string; session_ids?: string[] }
  }).task
  await loadHome(page)
  await openDrawer(page)
  const ceoRow = drawer(page).getByTestId('ask-walnut-drawer-main')
  await expect(ceoRow.locator('.ask-walnut-drawer-item-title')).toHaveText('CEO')

  const search = drawer(page).getByTestId('ask-walnut-search')
  await expect(search).toBeFocused()
  await typeKeys(page, 'ceo')
  await expect(ceoRow).toBeVisible()
  await expect(drawer(page).getByTestId('ask-walnut-search-empty')).toHaveCount(0)
  await shotSlot(page, '7-search-ceo')
  await page.keyboard.press('Escape')
  await expect(search).toHaveValue('')
  await typeKeys(page, 'MAIN')
  await expect(ceoRow).toBeVisible()
  await page.keyboard.press('Escape')
  await typeKeys(page, `zz-no-such-${STAMP}`)
  await expect(ceoRow).toHaveCount(0)
  await expect(drawer(page).getByTestId('ask-walnut-search-empty')).toContainText('No quick questions match')
  await page.keyboard.press('Escape')
  await expect(ceoRow).toBeVisible()

  await pointAt(page, ceoRow)
  await expect(drawer(page)).toHaveCount(0)
  const hasSession = !!(main.session_id || main.exec_session_id || main.plan_session_id || main.session_ids?.length)
  if (hasSession) {
    // Another spec on the shared fixture already talked to Main: its conversation opens.
    await expect(slotSession(page)).toBeVisible({ timeout: 30_000 })
  } else {
    await expect(slotMainDraft(page)).toBeVisible({ timeout: 30_000 })
    await expect(slotMainDraft(page).locator('.session-panel-title')).toHaveText('CEO')
    await expect(slotMainDraft(page).locator('.chat-input-textarea')).toHaveAttribute('placeholder', 'Ask CEO anything…')
  }
  await shotSlot(page, '8-ceo')
})
