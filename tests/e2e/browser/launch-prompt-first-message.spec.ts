/**
 * A new session shows the user's first message at once (real UI, real launch).
 *
 * The report (2026-09-28): Start from a draft, and the new column showed only
 * "Claude Code is working… 6s" for ~13s before the first message appeared. The
 * launch prompt had no bubble, so the panel waited for the CLI to boot and write
 * the line to its transcript. Now the pending column shows the message from the
 * click, the tab that pressed Start seeds the real panel with it, and the server
 * keeps it for every other opener until the first turn ends (session:get-queue →
 * launchPrompt, src/core/sessions/launch-prompts.ts).
 *
 * The CLI's delay is reproduced by holding the transcript: every history read
 * answers EMPTY until the test releases it. The mock CLI never writes a
 * transcript, so after release the route adds the user row the real CLI writes
 * before calling the model. The mock's reply quotes the prompt, so every text
 * assertion is scoped to USER rows.
 *
 * Scenarios, one launch each:
 *   1. Start Task: the message is in the pending column within ~1s of Start,
 *      never blinks out when the real panel takes over, comes back on a reload
 *      mid-turn, and settles to ONE user row once the transcript lands.
 *   2. Ask Walnut (the reported surface): the same, through the send arrow.
 *   3. A transcript that never yields the row: the message still heads the
 *      conversation, above the answer, and is never duplicated.
 */
import { test, expect, type Page, type Locator } from '@playwright/test'
import { discoverFixtureRoot, draftComposer, draftPanel, loadHome, openDraft, openDraftOnCwd, draftSend } from './draft-helpers'

const SHOTS = process.env.LAUNCH_PROMPT_SHOT_DIR ?? '/tmp/launch-prompt-first-message'

test.setTimeout(180_000)
test.describe.configure({ mode: 'serial' })

let fixtureRoot = ''
test.beforeAll(async () => { fixtureRoot = await discoverFixtureRoot() })

type Row = { role: string; text?: string; [k: string]: unknown }

/**
 * Hold the transcript empty (the CLI has not written the prompt yet). After
 * release, serve the real history with the launch's user row at its head, as the
 * real CLI's transcript has it.
 */
async function holdTranscript(page: Page, stamp: string, launchText: string): Promise<() => void> {
  let held = true
  await page.route('**/api/sessions/*/history**', async (route) => {
    const url = new URL(route.request().url())
    if (held) {
      return route.fulfill({ json: { messages: [], cursor: 0, total: 0, delta: url.searchParams.has('since') } })
    }
    url.searchParams.delete('since')
    const res = await route.fetch({ url: url.toString() })
    const body = await res.json() as { messages?: Row[] }
    const rows = [...(body.messages ?? [])]
    if (!rows.some((m) => m.role === 'user' && (m.text ?? '').includes(stamp))) {
      rows.unshift({ role: 'user', text: launchText, timestamp: new Date().toISOString(), msgId: `pw-launch-row-${stamp}` })
    }
    return route.fulfill({ json: { ...body, messages: rows, cursor: rows.length, total: rows.length, delta: false } })
  })
  return () => { held = false }
}

const userRows = (panel: Locator, stamp: string) =>
  panel.locator('.session-msg-user').filter({ hasText: stamp })

type Sampled = { frames: number; firstSeen: number; gaps: number; minTop: number; maxTop: number; layouts: string[] }

/**
 * Sample every frame from Start on: is the message on screen in the strip (the
 * pending column, then the real panel)? A frame without it after it first
 * appeared is the blink this change must not have at promotion.
 */
async function startFrameSampler(page: Page, stamp: string): Promise<() => Promise<Sampled>> {
  await page.evaluate((s) => {
    const w = window as unknown as { __lp: Sampled & { stop: boolean } }
    w.__lp = { frames: 0, firstSeen: -1, gaps: 0, minTop: Infinity, maxTop: -Infinity, layouts: [], stop: false }
    let lastTop = NaN
    const tick = () => {
      if (w.__lp.stop) return
      w.__lp.frames++
      const hits = [...document.querySelectorAll('.main-page-session-column .session-msg-user')]
        .filter((el) => (el.textContent ?? '').includes(s))
      if (hits.length > 0 && w.__lp.firstSeen < 0) w.__lp.firstSeen = w.__lp.frames
      if (hits.length === 0 && w.__lp.firstSeen >= 0) w.__lp.gaps++
      // Where the message sits in the REAL panel, relative to its scroller: it
      // must not be pushed down by a loading spinner and jump back up.
      const real = hits.find((el) => el.closest('.session-panel[data-session-id]'))
      const scroller = real?.closest('.session-history')
      if (real && scroller) {
        const top = real.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
        w.__lp.minTop = Math.min(w.__lp.minTop, top)
        w.__lp.maxTop = Math.max(w.__lp.maxTop, top)
        // On a move, record what sits above it, so a failure names the culprit.
        if (Math.abs(top - lastTop) >= 1 || Number.isNaN(lastTop)) {
          const above: string[] = []
          for (const el of scroller.children) {
            if (el.contains(real)) break
            above.push(`${el.className || el.tagName}:${(el as HTMLElement).offsetHeight}`)
          }
          w.__lp.layouts.push(`top=${Math.round(top)} frame=${w.__lp.frames} above=[${above.join(', ')}]`)
          lastTop = top
        }
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, stamp)
  return () => page.evaluate(() => {
    const w = window as unknown as { __lp: Sampled & { stop: boolean } }
    w.__lp.stop = true
    const { frames, firstSeen, gaps, minTop, maxTop, layouts } = w.__lp
    return { frames, firstSeen, gaps, minTop, maxTop, layouts }
  })
}

async function launch(page: Page, click: () => Promise<void>): Promise<Locator> {
  const req = page.waitForRequest((r) =>
    r.method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
  await click()
  const payload = (await req).postDataJSON() as { sessionId?: string }
  expect(payload.sessionId, 'native launches carry a client session id').toBeTruthy()
  return page.locator(`.main-page-session-column .session-panel[data-session-id="${payload.sessionId}"]`)
}

/** The message is the conversation's first row, and there is exactly one of it. */
async function expectPromptHeads(panel: Locator, stamp: string): Promise<void> {
  await expect(userRows(panel, stamp)).toHaveCount(1, { timeout: 5_000 })
  const firstRow = panel.locator('.session-history .session-msg').first()
  await expect(firstRow).toHaveClass(/session-msg-user/)
  await expect(firstRow).toContainText(stamp)
}

async function expectSettledOnce(page: Page, panel: Locator, stamp: string): Promise<void> {
  // The turn ends; its refetch reads the transcript and the row replaces the bubble.
  await expect(panel.locator('.session-msg-assistant').filter({ hasText: stamp }).first()).toBeVisible({ timeout: 60_000 })
  await expect(panel.getByText('Claude Code is working')).toHaveCount(0, { timeout: 60_000 })
  await expectPromptHeads(panel, stamp)
  await expect(panel.locator('[data-launch-prompt]')).toHaveCount(0, { timeout: 15_000 })
  // After the turn the server has forgotten the prompt: a reload shows the row, once.
  await page.reload()
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await expectPromptHeads(panel, stamp)
  await page.waitForTimeout(1_500)
  await expect(userRows(panel, stamp)).toHaveCount(1)
}

test('Start Task: the first message shows from the click, survives a reload mid-turn, and settles to one copy', async ({ page }) => {
  const stamp = `launch-probe-${Date.now()}`
  // slow: keeps the mock turn running long enough to reload inside it.
  const text = `slow:20000 ${stamp} who owns the build?`
  await loadHome(page)
  const release = await holdTranscript(page, stamp, text)
  const draft = await openDraftOnCwd(page, `${fixtureRoot}/projects/walnut`)
  await draftComposer(page).fill(text)

  // A slow launch request (a loaded Mac took 3.7s) keeps the PENDING column up:
  // it shows the message too, from the click on.
  let releaseLaunch: () => void = () => {}
  const launchHeld = new Promise<void>((r) => { releaseLaunch = r })
  await page.route('**/api/sessions/quick-start', async (route) => { await launchHeld; await route.continue() })
  const frames = await startFrameSampler(page, stamp)

  const t0 = Date.now()
  const launched = launch(page, () => draftSend(draft).click())
  const pending = page.locator('.main-page-session-column .pending-session-panel')
  await expect(pending.locator('.session-msg-user')).toContainText(stamp, { timeout: 5_000 })
  const pendingMs = Date.now() - t0
  console.log(`[launch-prompt] pending column shows the message ${pendingMs}ms after Start`)
  expect(pendingMs).toBeLessThan(1_500)
  await page.screenshot({ path: `${SHOTS}/0-start-task-pending.png` })
  releaseLaunch()

  const panel = await launched
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await expectPromptHeads(panel, stamp)
  // Let history's first answer land, then read the samples.
  await page.waitForTimeout(1_500)
  const sampled = await frames()
  console.log(`[launch-prompt] frames sampled=${sampled.frames} firstSeen=${sampled.firstSeen} gaps=${sampled.gaps} top=${sampled.minTop}..${sampled.maxTop}`)
  console.log(`[launch-prompt] layouts:\n  ${sampled.layouts.join('\n  ')}`)
  expect(sampled.gaps, 'the message must not blink out when the pending column becomes the real panel').toBe(0)
  expect(sampled.maxTop - sampled.minTop, `the message must not jump inside the real panel: ${sampled.layouts.join(' | ')}`).toBeLessThan(8)
  await page.screenshot({ path: `${SHOTS}/1-start-task-real-panel.png` })

  // Reload while the transcript still has nothing: the server still holds it.
  await page.reload()
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await expectPromptHeads(panel, stamp)
  await page.screenshot({ path: `${SHOTS}/2-start-task-after-reload.png` })

  // The real CLI writes the prompt before calling the model: release mid-turn.
  release()
  await expectSettledOnce(page, panel, stamp)
  await page.screenshot({ path: `${SHOTS}/3-start-task-settled.png` })
})

test('Ask Walnut: the first message shows at once and settles to one copy', async ({ page }) => {
  const stamp = `ask-probe-${Date.now()}`
  const text = `slow:10000 ${stamp} who owns the fire cracker vm?`
  await loadHome(page)
  const release = await holdTranscript(page, stamp, text)
  await openDraft(page)
  await page.locator('.draft-intent-card-walnut').click()
  await expect(page.locator('.draft-intent-card-walnut')).toHaveAttribute('aria-pressed', 'true')
  await draftComposer(page).fill(text)
  const frames = await startFrameSampler(page, stamp)

  const t0 = Date.now()
  const panel = await launch(page, () => draftPanel(page).locator('.chat-send-btn-icon').click())
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await expectPromptHeads(panel, stamp)
  const ms = Date.now() - t0
  await page.waitForTimeout(1_500)
  const sampled = await frames()
  console.log(`[launch-prompt] ask-walnut message in the real panel ${ms}ms after send; frames=${sampled.frames} gaps=${sampled.gaps} top=${sampled.minTop}..${sampled.maxTop}`)
  console.log(`[launch-prompt] layouts:\n  ${sampled.layouts.join('\n  ')}`)
  expect(sampled.gaps).toBe(0)
  expect(sampled.maxTop - sampled.minTop, `the message must not jump: ${sampled.layouts.join(' | ')}`).toBeLessThan(8)
  await page.screenshot({ path: `${SHOTS}/4-ask-walnut-at-once.png` })

  release()
  await expectSettledOnce(page, panel, stamp)
  await page.screenshot({ path: `${SHOTS}/5-ask-walnut-settled.png` })
})

test('a transcript that never yields the row: the message still heads the conversation, once', async ({ page }) => {
  // No route: the mock CLI writes no transcript, so history ends with the answer
  // and no user row, the degraded read this guards.
  const stamp = `no-row-probe-${Date.now()}`
  await loadHome(page)
  const draft = await openDraftOnCwd(page, `${fixtureRoot}/projects/walnut`)
  await draftComposer(page).fill(`${stamp} quick question`)
  const panel = await launch(page, () => draftSend(draft).click())
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await expectPromptHeads(panel, stamp)

  const answer = panel.locator('.session-msg-assistant').filter({ hasText: stamp }).first()
  await expect(answer).toBeVisible({ timeout: 60_000 })
  await expect(panel.getByText('Claude Code is working')).toHaveCount(0, { timeout: 60_000 })
  await page.waitForTimeout(1_500)
  // Above the answer, not pinned under it, and not doubled.
  await expectPromptHeads(panel, stamp)
  const order = await panel.evaluate((root, s) => {
    const rows = [...root.querySelectorAll('.session-history .session-msg')]
    const u = rows.findIndex((el) => el.classList.contains('session-msg-user') && (el.textContent ?? '').includes(s))
    const a = rows.findIndex((el) => el.classList.contains('session-msg-assistant') && (el.textContent ?? '').includes(s))
    return { u, a }
  }, stamp)
  expect(order.u).toBeGreaterThanOrEqual(0)
  expect(order.u).toBeLessThan(order.a)
  await expect(panel.locator('.session-msg-delivered-badge')).toHaveCount(0)
  await page.screenshot({ path: `${SHOTS}/6-no-row-heads.png` })
})
