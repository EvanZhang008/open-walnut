/**
 * REAL-PIPELINE Playwright spec for the composer's "@" palette listing TASKS
 * only (MentionPalette), one level: no Sessions group, no Projects group. A
 * row is a task with its run state (a dot and "waiting on you" / "running" in
 * the meta line), and the `<task-ref/>` the pick inserts reaches the agent as a
 * reference card that carries that state.
 *
 * Nothing is route-mocked: two tasks really run (session:start WS RPC →
 * MockDaemon → the mock Claude CLI), one parked on a permission prompt so its
 * live state is stable, one idle; a third task never ran. The palette opens in
 * the idle task's column, so that task itself must be absent.
 *
 * The second test opens the same palette in a DRAFT column (a session that does
 * not exist yet): the Tasks group is there too, the pick lands in the box as its
 * `@[title]` token, and the LAUNCH message reaches the agent with the reference
 * card (quick-start appends it, as session:send does for a later message) while
 * the session's own title reads the task's words, never the markup.
 *
 * The third test opens a draft BEFORE any folder is picked: the palette still
 * has both groups, with the Files group rooted at the host's home.
 */
import { discoverFixtureRoot, draftComposer, loadHome, openDraft, openDraftOnCwd, REAL_PANEL } from './draft-helpers'
import { test, expect, type Page, type APIRequestContext, type Locator } from '@playwright/test'
import fs from 'node:fs/promises'
import { presetPanelView } from './todo-panel-helpers'

const COLUMNS_KEY = 'open-walnut-home-session-columns'
let rpcSeq = 0

async function startRealSession(page: Page, message: string, taskId: string, mode?: string): Promise<void> {
  const reqId = `pw-mention-start-${++rpcSeq}`
  await page.evaluate(
    async ({ message, taskId, reqId, mode }) => {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = new WebSocket(`${proto}://${window.location.host}/ws`)
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve()
        ws.onerror = () => reject(new Error('ws failed'))
      })
      ws.send(JSON.stringify({
        type: 'req', id: reqId, method: 'session:start',
        payload: { taskId, message, project: 'Walnut', ...(mode ? { mode } : {}) },
      }))
      await new Promise<void>((resolve) => {
        ws.onmessage = (ev) => {
          try {
            const parsed = JSON.parse(ev.data as string)
            if (parsed.type === 'res' && parsed.id === reqId) resolve()
          } catch { /* ignore */ }
        }
        setTimeout(resolve, 5000)
      })
      ws.close()
    },
    { message, taskId, reqId, mode },
  )
}

async function pendingPermissionTool(request: APIRequestContext, sid: string): Promise<string | null> {
  const res = await request.get(`/api/sessions/${sid}`)
  if (!res.ok()) return null
  const body = await res.json() as { session?: { pendingPermission?: { toolName?: string } } }
  return body.session?.pendingPermission?.toolName ?? null
}

async function newTask(request: APIRequestContext, title: string): Promise<string> {
  const res = await request.post('/api/tasks', {
    data: { title: `${title} (${test.info().project.name})`, source: 'local', project: 'Walnut' },
  })
  expect(res.ok(), `create task: ${res.status()}`).toBe(true)
  const body = await res.json() as { task?: { id: string }; id?: string }
  return body.task?.id ?? body.id!
}

async function sessionIdsFor(request: APIRequestContext, taskId: string): Promise<Set<string>> {
  const res = await request.get(`/api/sessions/task/${taskId}`)
  if (!res.ok()) return new Set()
  const body = await res.json() as { sessions?: Array<{ claudeSessionId: string }> }
  return new Set((body.sessions ?? []).map((s) => s.claudeSessionId))
}

async function waitForNewSessionId(request: APIRequestContext, taskId: string, before: Set<string>): Promise<string> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const ids = await sessionIdsFor(request, taskId)
    for (const id of ids) if (!before.has(id)) return id
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`no new mock session appeared for task ${taskId}`)
}

function columnFor(page: Page, sid: string): Locator {
  return page.locator('.main-page-sessions-area > .main-page-session-column')
    .filter({ has: page.locator(`.session-panel[data-session-id="${sid}"]`) })
}

test('the "@" palette lists tasks only, a task carries its session, and the pick reaches the agent with that session', async ({ page, request }) => {
  test.setTimeout(240_000)
  const tag = `pw-mention-${Date.now().toString(36)}`
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // Three tasks: one whose session parks on a permission prompt (a stable live
  // "waiting" state), one whose session answers and goes idle (the column the
  // palette opens in), one with no session at all.
  const waitingTask = await newTask(request, `${tag} waiting`)
  const selfTask = await newTask(request, `${tag} self`)
  const plainTask = await newTask(request, `${tag} plain`)

  // `default` mode: the fixture's default would auto-approve the prompt and the
  // session would settle idle instead of parking on it.
  const beforeWaiting = await sessionIdsFor(request, waitingTask)
  await startRealSession(page, 'status-permission-test:Bash', waitingTask, 'default')
  const waitingSid = await waitForNewSessionId(request, waitingTask, beforeWaiting)
  await expect.poll(() => pendingPermissionTool(request, waitingSid), { timeout: 30_000 }).toBe('Bash')
  const beforeSelf = await sessionIdsFor(request, selfTask)
  await startRealSession(page, 'hello from the palette spec', selfTask)
  const selfSid = await waitForNewSessionId(request, selfTask, beforeSelf)

  await page.addInitScript(({ key, ids }) => {
    try { sessionStorage.setItem(key, JSON.stringify(ids.map((id: string) => ({ id, locked: false })))) } catch { /* ignore */ }
  }, { key: COLUMNS_KEY, ids: [selfSid] })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const col = columnFor(page, selfSid)
  await expect(col).toBeVisible({ timeout: 30_000 })
  // The idle session's turn has to be over before the palette opens, so that
  // sending the reference below is a fresh turn the mock echoes whole.
  await expect(col.locator('.session-panel')).toContainText('hello from the palette spec', { timeout: 60_000 })

  const textarea = col.locator('.session-panel-input textarea')
  await textarea.click()
  await page.keyboard.type(`@${tag}`)
  const palette = col.locator('.mention-palette')
  await expect(palette).toBeVisible({ timeout: 10_000 })

  // Tasks and Files: nothing else. No Sessions group, no Projects group, and no
  // row for a session or a project.
  await expect(palette.locator('.mention-row-task').filter({ hasText: `${tag} waiting` })).toBeVisible({ timeout: 15_000 })
  const groupNames = await palette.locator('.mention-group-name').allTextContents()
  expect(groupNames.every((n) => n === 'Tasks' || n === 'Files'), `groups: ${groupNames.join(',')}`).toBe(true)
  expect(groupNames).toContain('Tasks')
  await expect(palette.locator('.mention-row-session, .mention-row-project, [data-group="session"], [data-group="project"]')).toHaveCount(0)

  // The task parked on a permission: a waiting dot and "waiting on you" in its
  // meta. The task that never ran: the same row shape, an idle dot. The
  // column's own task is never offered.
  const waitingRow = palette.locator('.mention-row-task').filter({ hasText: `${tag} waiting` })
  await expect(waitingRow).toHaveAttribute('data-state', 'waiting')
  await expect(waitingRow.locator('.mention-dot.waiting')).toBeVisible()
  await expect(waitingRow.locator('.mention-meta')).toContainText('waiting on you')
  const plainRow = palette.locator('.mention-row-task').filter({ hasText: `${tag} plain` })
  await expect(plainRow).toHaveAttribute('data-state', 'idle')
  await expect(plainRow.locator('.mention-dot.idle')).toBeVisible()
  await expect(plainRow.locator('.mention-meta')).toHaveText('TODO · Walnut')
  await expect(palette.locator('.mention-row-task').filter({ hasText: `${tag} self` })).toHaveCount(0)
  // The live-first ordering: the waiting task sits above the idle one.
  const titles = await palette.locator('.mention-row-task .mention-title').allTextContents()
  expect(titles.findIndex((t) => t.includes(`${tag} waiting`))).toBeLessThan(titles.findIndex((t) => t.includes(`${tag} plain`)))

  // Pick the waiting task: the "@query" becomes the reference's `@[title]`
  // token IN the box, where the "@" was, and the sentence continues after it.
  await waitingRow.click()
  await expect(palette).toHaveCount(0)
  const token = `@[${tag} waiting (${test.info().project.name})]`
  await expect(textarea).toHaveValue(`${token} `)
  // `echo-input`: the mock CLI quotes its whole input back, reference card
  // included, where a plain echo reads like a model and leaves the card out.
  await page.keyboard.type('look at this one echo-input')
  await expect(textarea).toHaveValue(`${token} look at this one echo-input`)
  await fs.mkdir(`/tmp/wn-inline-ref/${test.info().project.name}`, { recursive: true })
  await col.locator('.session-panel-input').screenshot({ path: `/tmp/wn-inline-ref/${test.info().project.name}/00-session-inline-token.png` })
  await page.keyboard.press('Enter')

  // The sent message shows the task as a pill, and the agent's copy carried the
  // reference card: the mock CLI echoes its whole input, so the reply shows the
  // task line with its run state, one id, no second one to address.
  const panel = col.locator('.session-panel')
  await expect(panel.locator(`a.task-link[data-task-id="${waitingTask}"]`).first()).toBeVisible({ timeout: 30_000 })
  await expect(panel).toContainText(`task ${waitingTask}`, { timeout: 60_000 })
  await expect(panel).toContainText('project Walnut · waiting on you')
  await expect(panel).toContainText('use task_get / task_send for more')
  await expect(panel).not.toContainText(`session ${waitingSid}`)
  await expect(panel).not.toContainText('session-ref id=')
})

test('a draft column offers the same Tasks group, and a Start carrying a reference hands the agent its card', async ({ page, request }) => {
  test.setTimeout(240_000)
  const tag = `pw-draftref-${Date.now().toString(36)}`
  const referenced = await newTask(request, `${tag} target`)
  const fixtureRoot = await discoverFixtureRoot()
  await loadHome(page)
  await openDraftOnCwd(page, `${fixtureRoot}/projects/walnut`)

  const input = draftComposer(page)
  await input.click()
  await page.keyboard.type(`please read @${tag}`)
  const palette = page.locator('.draft-session-panel .mention-palette')
  await expect(palette).toBeVisible({ timeout: 10_000 })
  const groupNames = await palette.locator('.mention-group-name').allTextContents()
  expect(groupNames, `groups: ${groupNames.join(',')}`).toContain('Tasks')
  const row = palette.locator('.mention-row-task').filter({ hasText: `${tag} target` })
  await expect(row).toBeVisible({ timeout: 15_000 })
  const shots = `/tmp/wn-inline-ref/${test.info().project.name}`
  await fs.mkdir(shots, { recursive: true })
  await page.locator('.draft-session-panel').screenshot({ path: `${shots}/01-draft-palette-tasks.png` })
  await row.click()
  await expect(palette).toHaveCount(0)
  const token = `@[${tag} target (${test.info().project.name})]`
  await expect(input).toHaveValue(`please read ${token} `)
  await page.keyboard.type('first echo-input')
  await expect(input).toHaveValue(`please read ${token} first echo-input`)
  await page.locator('.draft-session-panel').screenshot({ path: `${shots}/02-draft-inline-token.png` })

  const quickStartResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/sessions/quick-start')
  await page.keyboard.press('Enter')
  const quickStart = await quickStartResponse
  expect(quickStart.status()).toBe(200)
  const { taskId } = await quickStart.json() as { taskId: string }
  const sid = await waitForNewSessionId(request, taskId, new Set())
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${sid}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })

  // The launch bubble shows the task as a pill; the mock CLI echoes its whole
  // input, so the reply carries the reference card quick-start appended, and the
  // card block itself never shows as the human's words.
  await expect(panel.locator(`a.task-link[data-task-id="${referenced}"]`).first()).toBeVisible({ timeout: 30_000 })
  await expect(panel).toContainText(`task ${referenced}`, { timeout: 60_000 })
  await expect(panel).toContainText('use task_get / task_send for more')
  const humanBubble = panel.locator('.session-msg-user').filter({ hasText: 'please read' })
  await expect(humanBubble).toContainText('first')
  await expect(humanBubble).not.toContainText('walnut-refs')
  await panel.screenshot({ path: `${shots}/03-launched-session-pill-and-card.png` })

  // The new task's title and the session's title read the words, not the markup.
  const task = await (await request.get(`/api/tasks/${taskId}`)).json() as { task: { title: string; description?: string } }
  expect(task.task.title).not.toContain('<task-ref')
  const session = await (await request.get(`/api/sessions/${sid}`)).json() as { session: { title?: string } }
  expect(session.session.title ?? '').not.toContain('<task-ref')
  expect(session.session.title ?? '').not.toContain('walnut-refs')
})

test('a draft with no folder yet shows the same two groups, Files rooted at home', async ({ page, request }) => {
  test.setTimeout(180_000)
  const tag = `pw-homeref-${Date.now().toString(36)}`
  await newTask(request, `${tag} target`)
  await loadHome(page)
  // A fresh draft: no folder picked, so the composer has no cwd of its own.
  await openDraft(page)
  const input = draftComposer(page)
  await input.click()
  await page.keyboard.type('@')
  const palette = page.locator('.draft-session-panel .mention-palette')
  await expect(palette).toBeVisible({ timeout: 10_000 })

  // Both groups, as in a running session (2026-10-03: a draft without a folder
  // showed Tasks alone, and the user read it as a different picker).
  await expect(palette.locator('[data-group="task"]')).toBeVisible()
  await expect(palette.locator('[data-group="files"]')).toBeVisible()
  const groupNames = await palette.locator('.mention-group-name').allTextContents()
  expect(groupNames, `groups: ${groupNames.join(',')}`).toEqual(['Tasks', 'Files'])
  await expect(palette.locator('.mention-row-task').filter({ hasText: `${tag} target` })).toBeVisible({ timeout: 15_000 })
  // The fixture's HOME is its temp root, so `~` lists that root's folders.
  const fileRows = palette.locator('[data-group="files"] .mention-row')
  await expect(fileRows.first()).toBeVisible({ timeout: 15_000 })
  const fixtureRoot = await discoverFixtureRoot()
  const homeDir = fixtureRoot.replace(/\/ps-fixture$/, '')
  expect(await fileRows.first().getAttribute('title')).toMatch(new RegExp(`^${homeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`))
  // The file hints a session's palette shows (group / parent / recents).
  const hints = await palette.locator('.mention-hintbar').textContent()
  for (const hint of ['group', 'parent', 'recents']) expect(hints, `hintbar: ${hints}`).toContain(hint)
  const shots = `/tmp/wn-inline-ref/${test.info().project.name}`
  await fs.mkdir(shots, { recursive: true })
  await page.locator('.draft-session-panel').screenshot({ path: `${shots}/04-draft-no-folder-tasks-and-files.png` })

  // Descending from home browses the tree (the query filters each level, as the
  // row budget shows a handful per group), and a pick lands in the box as an
  // absolute path: the draft has no root to shorten it against.
  for (const [typed, dir] of [['ps-fix', 'ps-fixture'], ['proj', 'projects'], ['waln', 'walnut']] as const) {
    await page.keyboard.type(typed)
    const row = fileRows.filter({ hasText: dir }).first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    await row.click()
    await expect(palette.locator('[data-group="files"] .mention-group-verb')).toContainText(`in `, { timeout: 15_000 })
  }
  const webRow = fileRows.filter({ hasText: 'web' })
  await expect(webRow).toBeVisible({ timeout: 15_000 })
  await webRow.locator('.mention-pick-btn').click()
  await expect(palette).toHaveCount(0)
  await expect(input).toHaveValue(`@${fixtureRoot}/projects/walnut/web `)
})

test('a bound draft never offers the task it will attach to', async ({ page, request }) => {
  test.setTimeout(180_000)
  const tag = `pw-boundref-${Date.now().toString(36)}`
  const fixtureRoot = await discoverFixtureRoot()
  const cwd = `${fixtureRoot}/projects/walnut`
  const own = await request.post('/api/tasks', { data: { title: `${tag} self`, source: 'local', project: 'Walnut', cwd } })
  expect(own.ok(), await own.text()).toBe(true)
  const ownId = ((await own.json()) as { task: { id: string } }).task.id
  await newTask(request, `${tag} other`)

  await page.setViewportSize({ width: 2400, height: 1000 })
  await presetPanelView(page, { section: 'all', project: '' })
  await loadHome(page)
  // The task row's ▶ on a title-only task opens a draft BOUND to it.
  const row = page.locator(`#home-task-navigation [data-task-id="${ownId}"]`).first()
  await expect(row).toBeVisible({ timeout: 25_000 })
  await row.hover()
  await row.locator('.task-start-btn').click()
  const panel = page.locator('.draft-session-panel')
  await expect(panel).toBeVisible({ timeout: 10_000 })
  await expect(panel.locator('.draft-bound-task')).toContainText(`${tag} self`)

  const input = draftComposer(page)
  await input.click()
  await page.keyboard.type(`@${tag}`)
  const palette = panel.locator('.mention-palette')
  await expect(palette).toBeVisible({ timeout: 10_000 })
  await expect(palette.locator('.mention-row-task').filter({ hasText: `${tag} other` })).toBeVisible({ timeout: 15_000 })
  await expect(palette.locator('.mention-row-task').filter({ hasText: `${tag} self` })).toHaveCount(0)
})
