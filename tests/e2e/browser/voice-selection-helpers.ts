/**
 * Shared by session-voice-selection.spec.ts (Chromium, real dictation over a fake
 * microphone) and session-voice-selection.webkit.spec.ts (the Mac app's engine, the
 * pill's HOLD lifecycle without a microphone). A WebKit pin (`test.use({ browserName })`)
 * is only legal at a spec file's top level, so the two files share their fixtures
 * through this module instead of one file carrying both.
 */
import { expect, type Page, type Locator } from '@playwright/test'
import fs from 'node:fs/promises'
import { dragPhrase, selectionAnchorNodeType } from './selection-helpers'

/** Own fixture record (test-server.ts): these specs WRITE thread anchors to the
 *  session, and an anchor left on a session another spec reads makes a thread rail
 *  exist where that spec expects none (they run in parallel workers). */
export const SESSION_ID = 'pw-voicesel1-session'
export const TASK_ID = 'pw-task-voicesel1'
/** The tail paragraph of the seeded transcript, inside the first render window. */
export const PARAGRAPH = 'The migration runs in three phases'
/** Dragged out of the middle of that paragraph: a PASSAGE, not a whole message. */
export const PHRASE = 'rewrites the index in place'
/** A SECOND passage in the same paragraph, for the tests that dictate twice. */
export const PHRASE2 = 'only verifies checksums'
/** ONE word out of PHRASE — the 2026-09-16 report was a 7-character selection the
 *  reader did not remember making. */
export const WORD = 'rewrites'

export const SHOTS = '/tmp/voice-select/shots'

export async function shot(page: Page, name: string): Promise<void> {
  await fs.mkdir(SHOTS, { recursive: true })
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

/** A configured, available engine — otherwise the mic is a link to Settings and a
 *  click NAVIGATES AWAY from the panel instead of recording. */
export async function stubSttStatus(page: Page): Promise<void> {
  await page.route('**/api/stt/status', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ engine: 'whisper-cpp', available: true }),
  }))
}

export async function openSession(page: Page, sid = SESSION_ID, taskId = TASK_ID): Promise<Locator> {
  const panel = page.locator(`.session-panel[data-session-id="${sid}"]`)
  // Open columns are persisted, so after a reload the panel is already there —
  // clicking the kebab row again would TOGGLE it shut.
  if (await panel.count() === 0) {
    const search = page.locator('.todo-search-input')
    const task = page.locator(`.todo-panel-item[data-task-id="${taskId}"]`)
    // A query typed right after mount can be wiped by a late state load (seen
    // once under a two-worker co-run: empty box, Focus lane, no row). Type it
    // again until the row is there rather than trusting the first fill.
    await expect(async () => {
      if (await search.inputValue() !== sid) await search.fill(sid)
      await expect(task).toBeVisible({ timeout: 2000 })
    }).toPass({ timeout: 15000 })
    // Click the row's title: the task menu has no open-session row.
    await task.locator('.todo-item-title').click()
  }
  await expect(panel).toBeVisible()
  await expect(panel.locator('.session-history')).toContainText(PARAGRAPH, { timeout: 20000 })
  return panel
}

/** Scroll with a REAL wheel gesture: the timeline follows the bottom, and a
 *  programmatic scrollTop write is snapped straight back to the end. */
export async function wheel(page: Page, panel: Locator, dy: number): Promise<void> {
  const box = (await panel.locator('.session-history').boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, dy)
  await page.waitForTimeout(140)
}

/** Park a row mid-timeline: under the sticky header or behind the composer its words
 *  can be neither dragged over nor pointed at. */
export async function centreRow(page: Page, panel: Locator, needle = PARAGRAPH): Promise<void> {
  const history = panel.locator('.session-history')
  const row = panel.locator('.session-msg-content', { hasText: needle }).last()
  let lastTop = -1
  for (let i = 0; i < 30; i++) {
    const delta = await row.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const h = (el.closest('.session-history') as HTMLElement).getBoundingClientRect()
      return (r.y + r.height / 2) - (h.y + h.height / 2)
    })
    if (Math.abs(delta) < 40) break
    await wheel(page, panel, Math.max(-500, Math.min(500, Math.round(delta))))
    const top = await history.evaluate((el) => el.scrollTop)
    if (top === lastTop) break
    lastTop = top
  }
  // A wheel scroll is animated; the rects a drag is measured from must be read
  // after the timeline has come to rest, or the words move under the mouse.
  let settled = await history.evaluate((el) => el.scrollTop)
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(100)
    const now = await history.evaluate((el) => el.scrollTop)
    if (now === settled) return
    settled = now
  }
}

export function selectedText(page: Page): Promise<string> {
  return page.evaluate(() => window.getSelection()?.toString() ?? '')
}

/** Does this engine paint highlights at all? The app's own rule (utils/pin-highlights.ts
 *  `highlightsSupported`): the registry AND the `Highlight` constructor. */
export function highlightsSupported(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const w = window as unknown as { CSS?: { highlights?: unknown }; Highlight?: unknown }
    return !!w.CSS?.highlights && typeof w.Highlight === 'function'
  })
}

/**
 * Is the pill's HELD passage actually DRAWN right now? Not "is the registry entry
 * there": a Range whose text node a re-render replaced stays registered, collapsed,
 * with no client rects and no paint (useQuotePinPaint's documented false signal, and
 * reproduced in both engines while writing this). So the rule is the app's own
 * `isPainting`: some registered Range has a box.
 */
export function heldPainted(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const reg = (CSS as unknown as { highlights?: Map<string, Iterable<Range>> }).highlights
    const entry = reg?.get('walnut-held-quote')
    if (!entry) return false
    return [...entry].some((r) => r.getClientRects().length > 0)
  })
}

/** The session record's thread anchors — what a send under a chip writes. */
export async function threadAnchorsOf(page: Page, sid: string): Promise<unknown[]> {
  const res = await page.request.get(`/api/sessions/${sid}`)
  expect(res.ok()).toBe(true)
  const body = await res.json() as { threadAnchors?: unknown[]; session?: { threadAnchors?: unknown[] } }
  return body.threadAnchors ?? body.session?.threadAnchors ?? []
}

/** Select a passage and prove the selection is real (anchored in a TEXT node, the
 *  thing every clear in this story destroys). */
export async function selectPassage(
  page: Page,
  panel: Locator,
  phrase = PHRASE,
  sid = SESSION_ID,
): Promise<Locator> {
  await centreRow(page, panel)
  await dragPhrase(page, `.session-panel[data-session-id="${sid}"] .session-history`, phrase)
  expect(await selectedText(page)).toBe(phrase)
  expect(await selectionAnchorNodeType(page)).toBe(3)
  const pill = page.locator('[data-testid="quote-pin-pill"]')
  await expect(pill).toBeVisible()
  return pill
}

/**
 * The composer's request to the pill, sent from the page the way the composer sends
 * it (utils/selection-hold.ts: a bubbling CustomEvent on the PANEL ROOT whose detail
 * the pill answers). For the engine with no fake microphone this is how the landing's
 * one relevant act — "hold, I am about to take focus" — is reproduced.
 */
export function requestHoldFromPage(page: Page, sid: string): Promise<boolean> {
  return page.evaluate((id) => {
    const el = document.querySelector(`.session-panel[data-session-id="${id}"]`)
    if (!el) return false
    const detail = { held: false }
    el.dispatchEvent(new CustomEvent('walnut:selection-hold', { detail, bubbles: true }))
    return detail.held
  }, sid)
}
