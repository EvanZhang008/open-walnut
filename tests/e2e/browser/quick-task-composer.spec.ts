import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

interface ApiTask {
  id: string
  title: string
  priority: string
  project: string
  due_date?: string
  starred?: boolean
}

async function openComposer(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.locator('.quick-access-pill').first().click()
  await expect(page.locator('.quick-task-composer')).toBeVisible()
}

async function listTasks(request: APIRequestContext): Promise<ApiTask[]> {
  const response = await request.get('/api/tasks')
  expect(response.ok()).toBe(true)
  const body = await response.json() as { tasks: ApiTask[] }
  return body.tasks
}

async function waitForNewTask(
  request: APIRequestContext,
  title: string,
  existingIds: Set<string>,
): Promise<ApiTask> {
  let created: ApiTask | undefined
  await expect.poll(async () => {
    created = (await listTasks(request)).find((task) => task.title === title && !existingIds.has(task.id))
    return created?.id ?? null
  }, { timeout: 10_000 }).not.toBeNull()
  return created!
}

async function createProject(request: APIRequestContext, name: string): Promise<void> {
  // ensureProject is idempotent: 201 on first create, 200 when the row already
  // exists (a repeat caller never steals the existing claim).
  const response = await request.post('/api/projects', { data: { name, source: 'local' } })
  expect([200, 201]).toContain(response.status())
}

function unique(prefix: string): string {
  return `${prefix} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function tomorrowAtTwoIso(): string {
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(2, 0, 0, 0)
  const year = tomorrow.getFullYear()
  const month = String(tomorrow.getMonth() + 1).padStart(2, '0')
  const day = String(tomorrow.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}T02:00:00`
}

test('sentence auto-fills the form and Create persists the parsed fields', async ({ page, request }) => {
  const project = unique('Taxes')
  const title = unique('File annual return')
  const dueDate = tomorrowAtTwoIso()
  await createProject(request, project)
  await page.route('**/api/tasks/quick-parse', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ title, due_date: dueDate, pinTier: 'satellite', project }),
  }))
  const existingIds = new Set((await listTasks(request)).map((task) => task.id))

  await openComposer(page)
  const parseRequestPromise = page.waitForRequest('**/api/tasks/quick-parse')
  await page.locator('.qtc-input').fill('file the annual return tomorrow at 2am')
  const parseRequest = await parseRequestPromise
  const parseBody = parseRequest.postDataJSON() as { text?: string; timeZone?: string }
  expect(parseBody.text).toBe('file the annual return tomorrow at 2am')
  expect(typeof parseBody.timeZone).toBe('string')
  expect(() => new Intl.DateTimeFormat('en-US', { timeZone: parseBody.timeZone })).not.toThrow()

  // The form is visible the whole time; the parse back-fills it in place.
  const panel = page.locator('.qtc-confirm-panel')
  await expect(panel).toBeVisible()
  await expect(panel.locator('.qtc-confirm-title')).toHaveValue(title)
  await expect(panel.locator('.qtc-chip').nth(1)).toContainText('Tomorrow 2:00')
  // The pinned area shows the AI's tier as a pressed button — no click needed to read it,
  // and the ✦ on the PINNED label marks the tier as AI-suggested (same as the other fields).
  const pinnedField = panel.locator('.qtc-confirm-field', { hasText: 'Pinned' })
  await expect(pinnedField.locator('.qtc-confirm-ai')).toBeVisible()
  const tiers = panel.getByRole('group', { name: 'Pin new task to tier' })
  await expect(tiers.getByRole('button', { name: 'Satellite' })).toHaveAttribute('aria-pressed', 'true')
  await expect(tiers.getByRole('button', { name: 'Focus' })).toHaveAttribute('aria-pressed', 'false')
  await expect(panel.locator('.qtc-confirm-project')).toHaveValue(project)
  // The project already exists, so no "new" badge.
  await expect(panel.locator('.qtc-confirm-new')).toHaveCount(0)
  await panel.locator('.qtc-confirm-title').press('Enter')

  const created = await waitForNewTask(request, title, existingIds)
  expect(created.project).toBe(project)
  expect(created.due_date).toBe(dueDate)
})

test('typing straight into the form needs no sentence and no AI call', async ({ page, request }) => {
  // The manual path: skip the NL input entirely, fill the form fields by hand.
  const title = unique('Hand-typed task')
  let parseCalls = 0
  await page.route('**/api/tasks/quick-parse', async (route) => {
    parseCalls += 1
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ title: 'UNUSED' }) })
  })
  const existingIds = new Set((await listTasks(request)).map((task) => task.id))

  await openComposer(page)
  const panel = page.locator('.qtc-confirm-panel')
  await expect(panel).toBeVisible()
  await panel.locator('.qtc-confirm-title').fill(title)
  await panel.locator('.qtc-confirm-primary').click()

  const created = await waitForNewTask(request, title, existingIds)
  expect(created.priority).toBe('none')
  expect(created.project).toBe('')
  expect(parseCalls).toBe(0) // empty sentence → the parse never fires
})

test('Enter before the parse lands creates the sentence verbatim', async ({ page, request }) => {
  // "buy milk" needs no AI round-trip: the form mirrors the sentence live, so
  // an immediate Enter creates exactly what was typed. The slow parse landing
  // afterwards must not resurrect anything.
  const title = unique('buy milk')
  await page.route('**/api/tasks/quick-parse', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ title: 'WRONG AI TITLE', priority: 'immediate' }),
    })
  })
  const existingIds = new Set((await listTasks(request)).map((task) => task.id))

  await openComposer(page)
  await page.locator('.qtc-input').fill(title)
  await page.locator('.qtc-input').press('Enter')

  const created = await waitForNewTask(request, title, existingIds)
  expect(created.title).toBe(title) // verbatim, not the AI title
  expect(created.priority).toBe('none')

  // After the late parse lands: no second task from THIS flow (other parallel
  // specs create their own tasks — scope by title), and the reset form is empty.
  await page.waitForTimeout(2_000)
  const matches = (await listTasks(request)).filter(
    (t) => t.id !== created.id && (t.title === title || t.title === 'WRONG AI TITLE'),
  )
  expect(matches).toHaveLength(0)
  await expect(page.locator('.qtc-confirm-title')).toHaveValue('')
})

test('hand-edited fields survive a late parse; untouched fields still fill', async ({ page, request }) => {
  const userTitle = unique('My own words')
  const dueDate = tomorrowAtTwoIso()
  await page.route('**/api/tasks/quick-parse', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800))
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ title: 'AI REWRITE', due_date: dueDate }),
    })
  })
  const existingIds = new Set((await listTasks(request)).map((task) => task.id))

  await openComposer(page)
  await page.locator('.qtc-input').fill('remind me about the thing tomorrow 2am')
  const panel = page.locator('.qtc-confirm-panel')
  await panel.locator('.qtc-confirm-title').fill(userTitle)

  // Parse lands: the due chip fills (✦-badged), the user's title is untouched.
  await expect(panel.locator('.qtc-chip').nth(1)).toContainText('Tomorrow 2:00', { timeout: 5000 })
  await expect(panel.locator('.qtc-confirm-title')).toHaveValue(userTitle)

  await panel.locator('.qtc-confirm-primary').click()
  const created = await waitForNewTask(request, userTitle, existingIds)
  expect(created.due_date).toBe(dueDate)
})

test('editing the sentence reverts stale AI suggestions', async ({ page }) => {
  const dueDate = tomorrowAtTwoIso()
  await page.route('**/api/tasks/quick-parse', async (route) => {
    const text = (route.request().postDataJSON() as { text?: string }).text ?? ''
    // Only the FIRST sentence yields suggestions; the edited one echoes back.
    const body = text.includes('dentist')
      ? { title: 'Book dentist appointment', due_date: dueDate, priority: 'important' }
      : { title: text }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })

  await openComposer(page)
  const panel = page.locator('.qtc-confirm-panel')
  await page.locator('.qtc-input').fill('book the dentist tomorrow 2am')
  await expect(panel.locator('.qtc-confirm-title')).toHaveValue('Book dentist appointment')
  await expect(panel.locator('.qtc-chip').nth(1)).toContainText('Tomorrow 2:00')

  // New sentence → the old parse's suggestions no longer apply.
  await page.locator('.qtc-input').fill('water the plants')
  await expect(panel.locator('.qtc-confirm-title')).toHaveValue('water the plants')
  await expect(panel.locator('.qtc-chip').nth(1)).toContainText('+ Due')
})

test('a parsed project the AI just invented gets the "new" badge and is created', async ({ page, request }) => {
  const project = unique('BrandNewStream')
  const title = unique('Kick off new stream')
  await page.route('**/api/tasks/quick-parse', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    // project_is_new is the explicit signal from quick-task-parse: this name is
    // NOT one of the existing projects, so the panel must warn before creating it.
    body: JSON.stringify({ title, project, project_is_new: true }),
  }))
  const existingIds = new Set((await listTasks(request)).map((task) => task.id))

  await openComposer(page)
  await page.locator('.qtc-input').fill('kick off a new stream of work')
  const panel = page.locator('.qtc-confirm-panel')
  await expect(panel.locator('.qtc-confirm-project')).toHaveValue(project)
  await expect(panel.locator('.qtc-confirm-new')).toBeVisible()
  await panel.locator('.qtc-confirm-title').press('Enter')

  const created = await waitForNewTask(request, title, existingIds)
  expect(created.project).toBe(project)
})

test('plain note keeps Inbox defaults (no project, nothing pinned)', async ({ page, request }) => {
  const rawTitle = unique('Buy milk')
  await page.route('**/api/tasks/quick-parse', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ title: rawTitle }),
  }))
  const existingIds = new Set((await listTasks(request)).map((task) => task.id))

  await openComposer(page)
  await page.locator('.qtc-input').fill(rawTitle)
  const panel = page.locator('.qtc-confirm-panel')
  await expect(panel.locator('.qtc-confirm-title')).toHaveValue(rawTitle)
  // No project parsed → empty field, placeholder reads "Inbox".
  await expect(panel.locator('.qtc-confirm-project')).toHaveValue('')
  // Pinned area is always present, with nothing pressed when the AI suggested no tier.
  const tiers = panel.getByRole('group', { name: 'Pin new task to tier' })
  await expect(tiers).toBeVisible()
  for (const label of ['Focus', 'Satellite', 'Wait']) {
    await expect(tiers.getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'false')
  }
  await panel.locator('.qtc-confirm-title').press('Enter')

  const created = await waitForNewTask(request, rawTitle, existingIds)
  // '' = Inbox. Never the literal string "Inbox" — that would be a real project.
  expect(created.project).toBe('')
})

test('panel overrides pin, project, priority, and star before create', async ({ page, request }) => {
  const parsedProject = unique('Personal')
  const selectedProject = unique('Groceries')
  const title = unique('Plan shopping trip')
  await createProject(request, parsedProject)
  await createProject(request, selectedProject)
  await page.route('**/api/tasks/quick-parse', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ title, pinTier: 'focus', project: parsedProject }),
  }))
  const existingIds = new Set((await listTasks(request)).map((task) => task.id))

  await openComposer(page)
  await page.locator('.qtc-input').fill('plan shopping trip')
  const panel = page.locator('.qtc-confirm-panel')
  await expect(panel.locator('.qtc-confirm-title')).toHaveValue(title)
  // Override the AI's Focus with Satellite in ONE click (the old cycling chip
  // needed two, and you couldn't see which tier was next).
  const tiers = panel.getByRole('group', { name: 'Pin new task to tier' })
  const pinnedField = panel.locator('.qtc-confirm-field', { hasText: 'Pinned' })
  await expect(tiers.getByRole('button', { name: 'Focus' })).toHaveAttribute('aria-pressed', 'true')
  await expect(pinnedField.locator('.qtc-confirm-ai')).toBeVisible()
  await tiers.getByRole('button', { name: 'Satellite' }).click()
  await expect(tiers.getByRole('button', { name: 'Satellite' })).toHaveAttribute('aria-pressed', 'true')
  await expect(tiers.getByRole('button', { name: 'Focus' })).toHaveAttribute('aria-pressed', 'false')
  // The tier is now the USER's pick, so the ✦ must go — otherwise the panel keeps
  // crediting the AI for a value the user just overrode.
  await expect(pinnedField.locator('.qtc-confirm-ai')).toHaveCount(0)
  // Chips: 0=start, 1=due, 2=priority, 3=star (Start leads; empty Due is a '+ Due' ghost).
  await panel.locator('.qtc-chip').nth(2).click()
  await expect(panel.locator('.qtc-chip').nth(2)).toContainText('Immediate')
  await panel.locator('.qtc-chip').nth(3).click()
  await expect(panel.locator('.qtc-chip').nth(3)).toContainText('Starred')
  await expect(panel.locator('.qtc-confirm-project')).toHaveValue(parsedProject)
  await panel.locator('.qtc-confirm-project').fill(selectedProject)
  await panel.locator('.qtc-confirm-primary').click()

  const created = await waitForNewTask(request, title, existingIds)
  expect(created.project).toBe(selectedProject)
  expect(created.priority).toBe('immediate')
  await expect.poll(async () => (await listTasks(request)).find((task) => task.id === created.id)?.starred).toBe(true)
  await expect.poll(async () => {
    const response = await request.get('/api/focus/tasks')
    const body = await response.json() as { satellite_tasks?: string[] }
    return body.satellite_tasks?.includes(created.id) ?? false
  }).toBe(true)
})

/**
 * Clicking the tier the AI already picked means "don't pin this one" — the task
 * must land UNPINNED, not fall through to some other tier. The old cycling chip
 * could only reach "not pinned" by clicking through the remaining tiers.
 */
test('clicking the pressed tier unpins, and the task is created unpinned', async ({ page, request }) => {
  const title = unique('Unpin before create')
  await page.route('**/api/tasks/quick-parse', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ title, pinTier: 'focus' }),
  }))
  const existingIds = new Set((await listTasks(request)).map((task) => task.id))

  await openComposer(page)
  await page.locator('.qtc-input').fill('unpin before create')
  const panel = page.locator('.qtc-confirm-panel')
  const tiers = panel.getByRole('group', { name: 'Pin new task to tier' })
  await expect(tiers.getByRole('button', { name: 'Focus' })).toHaveAttribute('aria-pressed', 'true')
  await tiers.getByRole('button', { name: 'Focus' }).click()
  for (const label of ['Focus', 'Satellite', 'Wait']) {
    await expect(tiers.getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'false')
  }
  await panel.locator('.qtc-confirm-primary').click()

  const created = await waitForNewTask(request, title, existingIds)
  const response = await request.get('/api/focus/tasks')
  const body = await response.json() as {
    focus_tasks?: string[]; satellite_tasks?: string[]; wait_tasks?: string[]
  }
  const pinned = [
    ...(body.focus_tasks ?? []),
    ...(body.satellite_tasks ?? []),
    ...(body.wait_tasks ?? []),
  ]
  expect(pinned).not.toContain(created.id)
})

test('due chip displays absolute wall-clock time', async ({ page }) => {
  const dueDate = tomorrowAtTwoIso()
  await page.route('**/api/tasks/quick-parse', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ title: 'Absolute due check', due_date: dueDate }),
  }))

  await openComposer(page)
  await page.locator('.qtc-input').fill('absolute due check tomorrow 2am')
  const dueChip = page.locator('.qtc-confirm-panel .qtc-chip').nth(1)
  await expect(dueChip).toContainText('Tomorrow 2:00')
  await expect(dueChip).not.toContainText(/\b\d+h\b/)
})

test('same-tick double create fires exactly one task', async ({ page, request }) => {
  const title = unique('Single create')
  await page.route('**/api/tasks/quick-parse', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ title }),
  }))
  const existingIds = new Set((await listTasks(request)).map((task) => task.id))

  await openComposer(page)
  await page.locator('.qtc-input').fill('single create race check')
  await expect(page.locator('.qtc-confirm-title')).toHaveValue(title)
  // Two synchronous clicks in one tick — the submit guard must be synchronous
  // (ref set before onCreate), otherwise both pass and two tasks persist.
  await page.locator('.qtc-confirm-primary').evaluate((button: HTMLButtonElement) => {
    button.click()
    button.click()
  })

  await waitForNewTask(request, title, existingIds)
  // Give a straggler create time to land, then assert exactly one.
  await page.waitForTimeout(1_000)
  const matches = (await listTasks(request)).filter((task) => task.title === title && !existingIds.has(task.id))
  expect(matches).toHaveLength(1)
})

test('Escape closes the composer', async ({ page }) => {
  await page.route('**/api/tasks/quick-parse', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ title: 'whatever' }),
  }))
  await openComposer(page)
  await page.locator('.qtc-input').fill('some half-typed thought')
  await page.locator('.qtc-input').press('Escape')
  await expect(page.locator('.quick-task-composer')).toBeHidden()
})
