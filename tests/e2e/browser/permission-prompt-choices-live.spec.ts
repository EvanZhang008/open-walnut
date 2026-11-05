/**
 * A Claude prompt's choices end to end: the fixture's mock CLI asks for a Bash
 * command with a suggested rule (`status-permission-test:BashRule`), the server
 * builds the choices (claude-permission-options.ts), the card answers with keys,
 * and the CLI's reply names what it got back: the rule with destination
 * `session`, or the deny with the person's note as its message.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { isolateUiPrefs } from './todo-panel-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const NONCE = `${Date.now().toString(36)}${process.pid.toString(36)}`
const made: string[] = []
let fixtureRoot = ''

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)
test.use({ viewport: { width: 1280, height: 860 } })

test.beforeAll(async () => {
  ;({ fixtureRoot } = await discoverBrowserFixture(TEST_PORT))
})

test.afterAll(async ({ request }) => {
  for (const id of made) {
    const task = (await (await request.get(`/api/tasks/${id}`)).json()).task as { session_id?: string } | undefined
    if (task?.session_id) await request.post(`/api/v1/sessions/${task.session_id}/terminate`, { data: { force: true } })
    await request.delete(`/api/tasks/${id}?force=true`)
  }
})

async function askingSession(request: APIRequestContext, label: string): Promise<string> {
  const task = await request.post('/api/tasks', { data: { title: `PW prompt choices ${label} ${NONCE}`, project: 'Walnut', source: 'local' } })
  expect(task.ok(), await task.text()).toBe(true)
  const taskId = ((await task.json()) as { task: { id: string } }).task.id
  made.push(taskId)
  const started = await request.post('/api/sessions/quick-start', {
    data: { cwd: `${fixtureRoot}/projects/walnut`, message: 'status-permission-test:BashRule', taskId, mode: 'default' },
  })
  expect(started.ok(), await started.text()).toBe(true)
  const sid = ((await started.json()) as { sessionId: string }).sessionId
  await expect.poll(async () => ((await (await request.get(`/api/sessions/${sid}`)).json()).session?.pendingPermission?.toolName ?? ''),
    { timeout: 90_000 }).toBe('Bash')
  return sid
}

async function openCard(page: Page, sid: string) {
  await isolateUiPrefs(page)
  await page.goto(`/sessions?id=${sid}`)
  const card = page.locator('.permission-request-card[data-prompt-pending="true"]').first()
  await expect(card).toBeVisible({ timeout: 30_000 })
  return card
}

test('the server offers the rule; 2 then Enter tells the CLI to allow it for the session', async ({ page, request }) => {
  const sid = await askingSession(request, 'session')
  // The pending list a phone reads carries the same choices.
  const detail = (await (await request.get(`/api/sessions/${sid}`)).json()) as { pendingPermissions: Array<{ acpOptions?: Array<{ optionId: string; detail?: string }> }> }
  expect(detail.pendingPermissions[0].acpOptions?.map((o) => o.optionId)).toEqual(['allow_once', 'allow_session', 'allow_always', 'reject_once'])
  // The rule is exactly the command shown above it, so it says so.
  expect(detail.pendingPermissions[0].acpOptions?.[1].detail).toBe('Bash: this exact command')

  const card = await openCard(page, sid)
  await expect(card.locator('.permission-request-choice').nth(1)).toContainText('Bash: this exact command')
  await expect(card.getByTestId('permission-request-command')).toHaveText('pwd')
  await page.locator('body').click({ position: { x: 5, y: 5 } })
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('2')
  await expect(card.locator('.is-picked')).toContainText('Allow for this session')
  await page.keyboard.press('Enter')
  await expect(page.getByText('Bash decision received: allow rules=session:Bash(pwd)')).toBeVisible({ timeout: 30_000 })
  // The answer is kept on the record, by the call it gated, for the timeline's rows.
  await expect.poll(async () => ((await (await request.get(`/api/sessions/${sid}/permission-decisions`)).json()) as { decisions: Array<{ line: string }> }).decisions.map((d) => d.line),
    { timeout: 15_000 }).toEqual(['Allowed for this session: pwd'])
})

test('a deny with a note reaches the CLI as the tool result, word for word', async ({ page, request }) => {
  const sid = await askingSession(request, 'note')
  const card = await openCard(page, sid)
  const note = card.getByTestId('permission-note-input')
  await note.fill('Run pnpm test instead')
  await note.press('Enter')
  // The CLI is sent the note in its own rejection words (cliDenyMessage), over two lines.
  await expect.poll(async () => {
    const h = (await (await request.get(`/api/sessions/${sid}/history`)).json()) as { messages: Array<{ text?: string }> }
    return h.messages.map((m) => m.text ?? '').join('\n')
  }, { timeout: 30_000 }).toMatch(/Bash decision received: deny message=The user doesn't want to proceed with this tool use\. The tool use was rejected \(eg\. if it was a file edit, the new_string was NOT written to the file\)\. To tell you how to proceed, the user said:\s+Run pnpm test instead/)
})

test('an option the request never offered is refused and the prompt stays', async ({ request }) => {
  const sid = await askingSession(request, 'refused')
  const requestId = ((await (await request.get(`/api/sessions/${sid}`)).json()).session?.pendingPermission?.requestId) as string
  const res = await request.post(`/api/sessions/${sid}/permission`, { data: { requestId, allow: true, optionId: 'approved-for-session' } })
  expect(res.status()).toBe(400)
  const after = (await (await request.get(`/api/sessions/${sid}`)).json()) as { pendingPermissions: Array<{ requestId: string }> }
  expect(after.pendingPermissions.map((p) => p.requestId)).toEqual([requestId])
  // Allow still answers it.
  const ok = await request.post(`/api/sessions/${sid}/permission`, { data: { requestId, allow: true, optionId: 'allow_once' } })
  expect(ok.ok(), await ok.text()).toBe(true)
})

test('the toast names the rule beside each remembering choice, and answering there sends it', async ({ page, request }) => {
  await isolateUiPrefs(page)
  await page.goto('/')
  await expect(page.locator('#root > *').first()).toBeVisible({ timeout: 30_000 })
  const sid = await askingSession(request, 'toast')
  // Scoped to this test's toast: asks other specs left on the shared server toast too.
  const toastCard = page.locator('.notification-toaster .nfc-perm-toast').filter({ hasText: `PW prompt choices toast ${NONCE}` })
  const toast = toastCard.locator('.nfc-perm-actions.perm-options-stack')
  await expect(toast).toBeVisible({ timeout: 30_000 })
  await expect(toast.locator('.perm-option-detail').first()).toHaveText('Bash: this exact command')
  await expect(toast.locator('.perm-option-saved')).toHaveText('Saves to .claude/settings.local.json')
  await toast.screenshot({ path: `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots/permission-prompt-keys/toast-${test.info().project.name}.png` })
  await toast.locator('[data-choice="allow_session"]').click()
  await expect.poll(async () => {
    const h = (await (await request.get(`/api/sessions/${sid}/history`)).json()) as { messages: Array<{ role: string; text?: string }> }
    return h.messages.map((m) => m.text ?? '').join('\n')
  }, { timeout: 30_000 }).toContain('Bash decision received: allow rules=session:Bash(pwd)')
})
