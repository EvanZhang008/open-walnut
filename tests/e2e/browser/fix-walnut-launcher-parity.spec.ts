/**
 * "Fix Walnut" → the launch must follow the SAME launcher settings as a regular
 * quick session.
 *
 * Reported bug (2026-07-30): the entry point hardcoded pinTier:'focus' and always
 * reset the model to Auto, ignoring the launcher default and the checkout dir's
 * remembered model — unlike every other quick-session launch. It skips the path
 * picker, so it must seed the launcher defaults itself (freshLauncherMeta +
 * per-dir launch memory). This REPLACES the earlier contract that pinned repairs
 * to Focus unconditionally — user direction.
 *
 * The SURFACE moved (P1 of "remove the main agent"): the chat spot is now the Ask
 * Walnut slot, so "Fix Walnut" is a row in that slot's ≡ drawer and it opens a
 * pre-armed DRAFT COLUMN instead of the old chat-anchored `.quick-start-bar`.
 * Everything this spec pins is unchanged — the payload (intent + launcher tier)
 * and where the task lands — so only the two chrome locators moved.
 *
 * Drives the real UI (≡ → row click → type → Enter) and asserts on the
 * quick-start payload + the focus API (the same source the tiers render from).
 */

import { test, expect } from '@playwright/test'
import { openAskWalnutDrawer } from './draft-helpers'
import { expectTaskInTier } from './draft-outcome-helpers'

const API = 'http://localhost:3457'

test('fix walnut inherits the launcher tier instead of carrying its own', async ({ page }) => {
  // Nothing to seed: the launcher tier is no longer sticky, so the value the
  // repair must inherit is the plain default (DEFAULT_META.pinTier). Since
  // 2026-09-15 that default IS Focus (the draft column lost its tier row and every
  // new task lands there), so this assertion can no longer tell "inherited" from
  // "hardcoded to focus" by value alone — what it still pins is that the repair
  // sends the launcher's meta at all (a real `pinTier`, not an omitted field the
  // server would fill with ITS default) and that the task lands where the
  // launcher's default says. The model half of the parity (folder launch memory,
  // not a forced Auto) is covered by the draft launch-memory specs.
  await page.goto('/')

  const drawer = await openAskWalnutDrawer(page)
  const chip = drawer.getByRole('button', { name: /fix walnut/i })
  await expect(chip).toBeVisible({ timeout: 15_000 })
  await chip.click()

  // The pre-armed draft column confirms the repair compose opened (and that no
  // path picker did). Scoped to the session strip: the slot can hold a
  // `.draft-session-panel` of its own and sits earlier in the DOM.
  const draft = page.locator('.main-page-session-column .draft-session-panel').first()
  await expect(draft).toBeVisible({ timeout: 10_000 })

  // Capture the launch payload: the repair skips the picker, so the frontend must
  // still send the launcher defaults with the remembered tier applied.
  const launchRequest = page.waitForRequest(req =>
    req.url().includes('/api/sessions/quick-start') && req.method() === 'POST')

  const report = `sticky tier parity probe ${Date.now()}`
  const input = draft.locator('.chat-input-textarea')
  await input.click()
  await input.fill(report)
  await input.press('Enter')

  const payload = (await launchRequest).postDataJSON() as {
    intent?: string
    taskMeta?: { pinTier?: string | null }
  }
  expect(payload.intent).toBe('fix-walnut')
  expect('pinTier' in (payload.taskMeta ?? {}), 'the launcher meta rides the repair launch').toBe(true)
  expect(payload.taskMeta?.pinTier).toBe('focus')

  // Find the task the launch created. Title is server-built as "Fix Walnut: <report>".
  const titleNeedle = report.slice(0, 40)
  const findTask = async (): Promise<{ id: string } | null> => {
    const res = await fetch(`${API}/api/tasks?limit=200`)
    if (!res.ok) return null
    const body = (await res.json()) as { tasks?: Array<{ id: string; title?: string; project?: string }> }
    return body.tasks?.find(t => t.project === 'Walnut' && t.title?.includes(titleNeedle)) ?? null
  }
  await expect.poll(findTask, { timeout: 20_000, message: 'fix-walnut task was never created' })
    .not.toBeNull()
  const taskId = (await findTask())!.id

  // The focus API is exactly what the tier UI renders from: the task must land in
  // the launcher's default tier (Focus).
  await expectTaskInTier(page, taskId, 'focus')

  await page.screenshot({ path: '/tmp/fix-walnut-parity/default-tier.png', fullPage: true })
})
