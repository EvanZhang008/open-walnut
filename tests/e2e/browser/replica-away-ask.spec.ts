/**
 * A new Ask Walnut in the console while the Mac sleeps (docs/plan/walnut-replica-servers-impl.md,
 * WP12, in a real browser). Fixture: replica-server.ts (a real Mac, a host daemon twin, the
 * replica it supervises, a fake tunnel in front of the replica, the cluster's mock CLI as
 * `claude` on the host); config replica.config.ts, all four projects, WebKit first.
 *
 *   1. through the tunnel: sign in with a code the Mac made; the Mac's personas copy and its
 *      spawn template are on the host
 *   2. the Mac sleeps: the away line comes
 *   3. away, with real clicks: open Ask Walnut, send a question; the host starts the ask's
 *      session from the Mac's template, the mock's answer streams into the slot, and the
 *      session shows Idle once its turn is over
 *   4. the Mac wakes and drains the journal: the ask is still there (the slot, the drawer),
 *      and the Mac holds its task and its session on the host
 *
 * The first load of the tunnel address is a `goto`: opening a link is what the person does.
 * Everything after it is a click. The browser has used Ask Walnut before (its sidebar toggle
 * is there), the one premise set before the load. Screenshots:
 * /tmp/replica-plan/replica-away-ask/<project>-<step>.png (1280 px wide at most).
 */
import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Locator, type Page } from '@playwright/test'

test.setTimeout(300_000)

const PORT = Number(process.env.PW_TEST_PORT ?? 3472)
const CONTROL = `http://127.0.0.1:${PORT + 1}`
const SHOTS = path.join('/tmp/replica-plan', path.basename(import.meta.filename, '.spec.ts'))
/** WALNUT_LEADER_QUIET_MS of the fixture (tests/helpers/replica-cluster.ts WINDOWS). */
const QUIET_MS = 6_000
/** The chat spot's visibility key (draft-helpers.ts CHAT_VISIBLE_KEY): set, so its toggle shows. */
const CHAT_VISIBLE_KEY = 'open-walnut-home-chat-visible'

async function control<T = Record<string, any>>(method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(CONTROL + p, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
  const json = await res.json() as T
  if (!res.ok) throw new Error(`control ${method} ${p}: ${res.status} ${JSON.stringify(json)}`)
  return json
}

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png` })
}

const isPhone = () => test.info().project.name.endsWith('-phone')
const slot = (page: Page): Locator => page.getByTestId('ask-walnut-slot')
const slotDraft = (page: Page): Locator => page.getByTestId('ask-walnut-draft')
const slotSession = (page: Page): Locator => page.getByTestId('ask-walnut-session')

/** Signs in through the tunnel with a code the Mac made. */
async function signIn(page: Page): Promise<void> {
  await page.goto('/')
  const notice = page.getByTestId('unpaired-notice')
  await expect(notice).toBeVisible({ timeout: 120_000 })
  const before = (await control<{ count: number }>('GET', '/control/devices')).count
  const { code } = await control<{ code: string }>('GET', '/control/code')
  await page.getByTestId('unpaired-code-input').fill(code)
  await page.getByTestId('unpaired-code-submit').click()
  await expect(notice).toBeHidden({ timeout: 60_000 })
  // The device round reaches the replica before the Mac sleeps (it checks this browser's token then).
  await expect.poll(async () => (await control<{ count: number }>('GET', '/control/devices')).count, { timeout: 60_000 }).toBeGreaterThan(before)
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 120_000 })
}

/** Ask Walnut from the sidebar (on a phone, the drawer the Menu button opens). */
async function openAskWalnut(page: Page): Promise<void> {
  const sidebar = page.locator('#primary-sidebar')
  if (isPhone()) {
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
    await expect(sidebar).toHaveClass(/\bopen\b/)
  }
  await sidebar.getByRole('button', { name: 'Ask Walnut', exact: true }).click()
  await expect(slot(page)).toBeVisible({ timeout: 15_000 })
}

/** The slot's asks button (on a phone it rides in the top bar). */
const asksMenu = (page: Page): Locator => (isPhone()
  ? page.locator('.phone-topbar [data-testid="ask-walnut-menu"]')
  : slot(page).locator('[data-testid="ask-walnut-menu"]').first())

/** A new chat from the asks drawer (the slot opens on the newest ask when there is one). */
async function newChat(page: Page): Promise<void> {
  await asksMenu(page).click()
  const drawer = page.getByTestId('ask-walnut-drawer')
  await expect(drawer).toBeVisible({ timeout: 10_000 })
  await drawer.getByTestId('ask-walnut-new').click()
  await expect(drawer).toHaveCount(0, { timeout: 10_000 })
  await expect(slotDraft(page)).toBeVisible({ timeout: 15_000 })
}

// A test that fails while the Mac sleeps must not hand the next one a sleeping Mac.
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    const logs = await control<{ mac: string; replica: string }>('GET', '/control/logs').catch(() => null)
    if (logs) for (const [name, text] of Object.entries(logs)) await testInfo.attach(`${name}.log`, { body: text, contentType: 'text/plain' })
  }
  const { asleep } = await control<{ asleep: boolean }>('GET', '/control/ready')
  if (asleep) await control('POST', '/control/wake')
  await control('POST', '/control/drain')
})

test('a new Ask Walnut while the Mac sleeps runs on the host, its answer streams in, and the ask is still there once the Mac is back', async ({ page }) => {
  const project = test.info().project.name
  const question = `Why is the marina build red (${project})?`
  const answer = `echo: ${question}`
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  // The premise: this browser opened Ask Walnut once before (so its sidebar toggle shows).
  await page.addInitScript((key) => {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, 'false') } catch { /* storage off */ }
  }, CHAT_VISIBLE_KEY)
  let taskId = ''
  let sessionId = ''

  await test.step('1. sign in through the tunnel; the Mac answers and has given the host what an ask needs', async () => {
    await signIn(page)
    await expect.poll(async () => control<{ personas: boolean; template: boolean }>('GET', '/control/ask-ready'), { timeout: 180_000 })
      .toEqual({ personas: true, template: true })
  })

  await test.step('2. the Mac sleeps: the away line comes', async () => {
    const slept = control('POST', '/control/sleep')
    await expect(page.getByTestId('away-line')).toBeVisible({ timeout: QUIET_MS + 5_000 })
    await slept
  })

  await test.step('3. away: open Ask Walnut, send a question; the answer streams into the slot', async () => {
    await openAskWalnut(page)
    await newChat(page)
    const composer = slotDraft(page).locator('.chat-input-textarea')
    await expect(composer).toBeVisible({ timeout: 30_000 })
    await expect(composer).toHaveAttribute('placeholder', /Ask Walnut anything/)
    await shot(page, '1-ask-open')
    const started = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
    await composer.click()
    await composer.fill(question)
    await composer.press('Enter')
    const res = await started
    expect(res.status(), await res.text()).toBe(200)
    const body = await res.json() as { taskId?: string; sessionId?: string }
    taskId = body.taskId ?? ''
    sessionId = body.sessionId ?? ''
    expect(taskId).not.toBe('')
    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    await expect(slotSession(page)).toHaveAttribute('data-session-id', sessionId, { timeout: 60_000 })
    await expect(slotSession(page).getByText(answer).first()).toBeVisible({ timeout: 90_000 })
    await expect(slotSession(page).getByText(question).first()).toBeVisible()
    // The turn's end reaches the console as well (the replica watches the host's sessions): Idle, no reload.
    const status = isPhone() ? page.locator('.phone-topbar') : slotSession(page)
    await expect(status.getByText('Idle', { exact: true }).first()).toBeVisible({ timeout: 30_000 })
    await shot(page, '2-answer')
    // Kept on the host for the Mac: the ask's task and its session.
    const { records } = await control<{ records: Array<{ kind: string; taskId?: string; acked: boolean }> }>('GET', '/control/journal')
    const mine = records.filter((r) => !r.acked && r.taskId === taskId).map((r) => r.kind)
    expect(mine).toEqual(expect.arrayContaining(['task-create', 'session']))
  })

  await test.step('4. the Mac wakes and drains: the ask is still there, and the Mac holds it on the host', async () => {
    await control('POST', '/control/wake')
    await expect(page.getByTestId('away-line')).toHaveCount(0, { timeout: 60_000 })
    await control('POST', '/control/drain')
    await expect(slotSession(page)).toHaveAttribute('data-session-id', sessionId)
    await expect(slotSession(page).getByText(answer).first()).toBeVisible({ timeout: 30_000 })
    // The "Syncs when your Mac is back" mark of its task goes with no reload (the Mac's copy has it).
    await expect(page.getByTestId('away-sync-mark')).toHaveCount(0, { timeout: 60_000 })
    // The asks drawer lists it.
    await asksMenu(page).click()
    const drawer = page.getByTestId('ask-walnut-drawer')
    await expect(drawer).toBeVisible({ timeout: 10_000 })
    await expect(drawer.locator(`[data-testid="ask-walnut-drawer-item"][data-task-id="${taskId}"]`)).toBeVisible({ timeout: 30_000 })
    await shot(page, '3-back')
    await page.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)
    // The Mac's own stores: the task, and the session on the host.
    const { tasks } = await control<{ tasks: Array<{ id: string }> }>('GET', '/control/mac-tasks')
    expect(tasks.some((t) => t.id === taskId)).toBe(true)
    const mac = await control<{ status: number; session: unknown }>('GET', `/control/mac-session?sid=${sessionId}`)
    expect(mac.status).toBe(200)
    expect(JSON.stringify(mac.session)).toContain('devbox')
  })

  expect(pageErrors).toEqual([])
})
