/**
 * The fire budget, end to end against the fixture's REAL local daemon:
 *
 *   - a trigger whose budget is spent HOLDS its next fire: the card says so, the
 *     user gets one notice, and the script's cursor is kept;
 *   - raising "Fires per day" in the Routines form delivers the held item on the
 *     next check, so nothing was lost (2026-10-01: a chat monitor lost every
 *     message behind its spent cap, because the held run saved the moved cursor);
 *   - 0 ("no limit") is accepted by the daemon and the trigger keeps checking;
 *     clearing the field goes back to the default.
 *
 * Needs a daemon with the budget (bash scripts/build-daemon.sh).
 * Run in WebKit too (PW_WEBKIT=1 … --project webkit): the Mac app is a WKWebView.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './shortcut-test-fixture'
import type { Locator, Page } from '@playwright/test'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const SHOTS = '/tmp/trigger-ratelimit'

// Real 10s cadences and a cold fixture.
test.describe.configure({ timeout: 420_000 })

async function shot(target: Page | Locator, name: string): Promise<void> {
  await fs.mkdir(SHOTS, { recursive: true })
  await target.screenshot({ path: `${SHOTS}/${name}-${test.info().project.name}.png`, animations: 'disabled' })
}

async function getRoutine(id: string): Promise<any | null> {
  const res = await fetch(`${API}/api/routines/${id}`)
  return res.ok ? ((await res.json()) as { job: any }).job : null
}

async function notices(id: string): Promise<Array<{ title: string; body?: string; dedupKey: string }>> {
  const { feed } = (await (await fetch(`${API}/api/v1/notifications`)).json()) as { feed: any[] }
  return feed.filter((n) => typeof n.dedupKey === 'string' && n.dedupKey.startsWith(`trigger-budget-held:${id}:`))
}

/** A cursor script: reports the feed lines after its cursor and moves the cursor to the newest. */
function cursorScript(feed: string): string {
  return [
    'read -r IN',
    `C=$(printf '%s' "$IN" | sed -n 's/.*"state":{"c":\\([0-9]*\\)}.*/\\1/p')`,
    'C=${C:-0}; MAX=$C; ITEMS=""',
    `while read -r ID TS; do if [ "$TS" -gt "$C" ]; then ITEMS="$ITEMS\${ITEMS:+,}{\\"id\\":\\"$ID\\"}"; MAX=$TS; fi; done < ${feed}`,
    'if [ -n "$ITEMS" ]; then echo "{\\"fire\\":true,\\"items\\":[$ITEMS],\\"state\\":{\\"c\\":$MAX}}"; else echo "{\\"fire\\":false,\\"state\\":{\\"c\\":$MAX}}"; fi',
  ].join('\n') + '\n'
}

async function openRoutines(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.getByTestId('sidebar-core-app-routines').click()
  await expect(page.locator('.page-title')).toContainText('Routines')
}

async function openEdit(page: Page, card: Locator): Promise<Locator> {
  await card.locator('.cron-menu-btn').click()
  await card.getByRole('button', { name: 'Edit' }).click()
  const form = page.locator('.routine-modal')
  await expect(form).toBeVisible()
  return form
}

async function saveForm(page: Page, form: Locator, id: string): Promise<void> {
  const saved = page.waitForResponse((r) => r.url().endsWith(`/api/routines/${id}`) && r.request().method() === 'PATCH')
  await form.getByRole('button', { name: /^(Save|Update)/ }).click()
  expect((await saved).status()).toBe(200)
  await expect(form).toBeHidden()
}

test('a spent budget holds the fire with the cursor kept, and raising Fires per day delivers it', async ({ page }) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pw-fire-budget-'))
  const feed = path.join(dir, 'feed.txt')
  const script = path.join(dir, 'check.sh')
  await fs.writeFile(script, cursorScript(feed))
  await fs.writeFile(feed, 'm1 1\n')
  const title = `PW budget task ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const taskRes = await fetch(`${API}/api/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, source: 'local', project: 'Work' }),
  })
  expect(taskRes.ok).toBe(true)
  const task = ((await taskRes.json()) as { task: { id: string } }).task
  const name = `PW budget ${Date.now()}`
  const created = await fetch(`${API}/api/v1/routines/trigger`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name, run: `sh ${script}`, every: '10s', prompt: 'Read the new messages.', session: task.id,
      description: 'Fire budget test trigger.', maxFiresPerDay: 1,
    }),
  })
  expect(created.status).toBe(201)
  const id = ((await created.json()) as { job: { id: string } }).job.id
  try {
    // m1 spends the whole budget of 1.
    await expect.poll(async () => (await getRoutine(id))?.state?.fireCount ?? 0, { timeout: 60_000 }).toBe(1)
    expect((await getRoutine(id)).check.maxFiresPerDay).toBe(1)

    // m2 arrives: the next check is held, not delivered.
    await fs.writeFile(feed, 'm1 1\nm2 2\n')
    await expect.poll(async () => (await getRoutine(id))?.state?.lastCheck?.reason ?? '', { timeout: 45_000 })
      .toBe('rate-limited')
    const held = await getRoutine(id)
    expect(held.state.fireCount).toBe(1)
    expect(held.state.lastCheck.outcome).toBe('quiet')

    // One notice, however many checks it holds.
    await expect.poll(async () => (await notices(id)).length, { timeout: 15_000 }).toBe(1)
    const [note] = await notices(id)
    expect(note.title).toBe(`Trigger "${name}" is holding fires back`)
    expect(note.body).toContain('fires at most once every 24 hours')
    expect(note.body).toContain('Nothing is dropped')
    const markAt = held.state.lastCheck.atMs
    await expect.poll(async () => (await getRoutine(id))?.state?.lastCheck?.atMs ?? 0, { timeout: 30_000 })
      .toBeGreaterThan(markAt)
    expect((await getRoutine(id)).state.lastCheck.reason).toBe('rate-limited')
    expect(await notices(id)).toHaveLength(1)

    // The card says it is held, and the audit row says it fires later.
    await openRoutines(page)
    const card = page.locator('.routine-list .routine-card', { hasText: name }).first()
    await expect(card).toContainText(/last check: held by the fire budget, (just now|\ds ago|\d+s ago|\dm ago)/, { timeout: 15_000 })
    await shot(card, 'held-card')

    // The bell shows the notice.
    await page.getByRole('button', { name: 'Notifications' }).click()
    const panel = page.locator('.notification-panel')
    await expect(panel).toBeVisible()
    await expect(panel.getByText(`Trigger "${name}" is holding fires back`).first()).toBeVisible({ timeout: 15_000 })
    await shot(panel, 'held-notice')
    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()

    // Raise the budget in the form: the field shows the stored cap.
    const form = await openEdit(page, card)
    const fires = form.locator('#routine-check-fires')
    await expect(fires).toHaveValue('1')
    await shot(form.locator('.routine-check-box'), 'form-fires-per-day')
    await fires.fill('288')
    await saveForm(page, form, id)
    await expect.poll(async () => (await getRoutine(id))?.check?.maxFiresPerDay).toBe(288)
    // The form counts whole minutes; an edit that never touched the interval keeps 10s.
    expect((await getRoutine(id)).schedule).toMatchObject({ kind: 'every', everyMs: 10_000 })

    // The next check delivers m2: the held run had kept the cursor at m1.
    await expect.poll(async () => (await getRoutine(id))?.state?.fireCount ?? 0, { timeout: 45_000 }).toBe(2)
    const after = await getRoutine(id)
    expect(after.state.fireLog[0]).toMatchObject({ items: 1 })
    expect(after.state.fireLog[0].injected?.preview ?? '').toContain('m2')
    await expect(card).toContainText(/last check: fired, 1 item/, { timeout: 20_000 })
    // And no storm: m2 is seen and the cursor moved, so later checks are quiet.
    const firedAt = after.state.lastCheck.atMs
    await expect.poll(async () => (await getRoutine(id))?.state?.lastCheck?.atMs ?? 0, { timeout: 45_000 })
      .toBeGreaterThan(firedAt)
    const quiet = await getRoutine(id)
    expect(quiet.state.lastCheck).toMatchObject({ outcome: 'quiet', reason: 'fire-false' })
    expect(quiet.state.fireCount).toBe(2)
    await shot(card, 'delivered-card')

    // 0 = no limit: stored as 0, and the daemon (which refuses a cap below 1)
    // still accepts the push and keeps checking.
    const form0 = await openEdit(page, card)
    await expect(form0.locator('#routine-check-fires')).toHaveValue('288')
    await form0.locator('#routine-check-fires').fill('0')
    await saveForm(page, form0, id)
    await expect.poll(async () => (await getRoutine(id))?.check?.maxFiresPerDay).toBe(0)
    const zeroMark = (await getRoutine(id)).state.lastCheck.atMs
    await fs.writeFile(feed, 'm1 1\nm2 2\nm3 3\n')
    await expect.poll(async () => (await getRoutine(id))?.state?.fireCount ?? 0, { timeout: 45_000 }).toBe(3)
    expect((await getRoutine(id)).state.lastCheck.atMs).toBeGreaterThan(zeroMark)

    // An emptied field is the default again.
    const formD = await openEdit(page, card)
    await expect(formD.locator('#routine-check-fires')).toHaveValue('0')
    await formD.locator('#routine-check-fires').fill('')
    await saveForm(page, formD, id)
    await expect.poll(async () => 'maxFiresPerDay' in ((await getRoutine(id))?.check ?? {})).toBe(false)
  } finally {
    await fetch(`${API}/api/routines/${id}`, { method: 'DELETE' }).catch(() => {})
    await fetch(`${API}/api/tasks/${task.id}`, { method: 'DELETE' }).catch(() => {})
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})
