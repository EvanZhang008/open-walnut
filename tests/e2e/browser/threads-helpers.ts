/**
 * Shared Playwright helpers for the question stack + tree drawer specs.
 * Panels are always scoped to the home session columns (REAL_PANEL): the Ask
 * slot's embedded panel sits earlier in the DOM and an unscoped locator grabs it.
 */
import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { REAL_PANEL } from './draft-helpers'
import { seededThreadState } from './threads-fixture'

export { DENSE_SESSION, AI_SESSION, FAILED_SESSION, REWRITTEN_SESSION, NO_THREAD_SESSION } from './threads-fixture'

/** The session panel of `sessionId` inside the home session columns. */
export function sessionPanel(page: Page, sessionId: string): Locator {
  return page.locator(`${REAL_PANEL}[data-session-id="${sessionId}"]`)
}

/** The localStorage key the panel falls back to when a session has no saved view. */
export const VIEW_MODE_DEFAULT_KEY = 'walnut:session-view.default'

export interface OpenThreadsOpts {
  /** The view the column opens in. Conversation Mode (`linear`) is the product
   *  default; these specs mostly exercise the question pages, so the helper
   *  defaults to `stack` (Tree Mode) unless a spec says otherwise. */
  view?: 'stack' | 'linear'
}

/** Open a fixture session's column through the task board (idempotent: an
 *  already open column is reused, since clicking its task again would close it). */
export async function openThreadsSession(
  page: Page, sessionId: string, taskId: string, readyText?: string, opts: OpenThreadsOpts = {},
): Promise<Locator> {
  const panel = sessionPanel(page, sessionId)
  if (await panel.count() === 0) {
    // A view the session already saved (a spec's own switch, kept across its
    // reload) still wins over this default.
    await page.evaluate(([key, view]) => localStorage.setItem(key, view), [VIEW_MODE_DEFAULT_KEY, opts.view ?? 'stack'] as const)
    await page.locator('.todo-search-input').fill(sessionId)
    const task = page.locator(`.todo-panel-item[data-task-id="${taskId}"]`)
    // The board search answers in well under a second on an idle machine, but a
    // 5s default missed it repeatedly in WebKit at load 70 (a readiness wait, not
    // an assertion about speed).
    await expect(task).toBeVisible({ timeout: 20_000 })
    await task.locator('.todo-item-title').click()
  }
  await expect(panel).toBeVisible({ timeout: 20_000 })
  if (readyText) await expect(panel.locator('.session-history')).toContainText(readyText, { timeout: 30_000 })
  return panel
}

/** The header pill: says the view a click switches TO. */
export function modePill(panel: Locator): Locator {
  return panel.locator('.session-panel-header .thread-mode-pill')
}

/** Switch the panel to Tree Mode (`stack`) or Conversation Mode (`linear`) through the pill. */
export async function switchView(panel: Locator, view: 'stack' | 'linear'): Promise<void> {
  const pill = modePill(panel)
  await expect(pill).toBeVisible()
  if (await pill.getAttribute('data-view-mode') === view) return
  await pill.click()
  await expect(pill).toHaveAttribute('data-view-mode', view)
}

/** Open the question drawer from the map (its list button; the rail shape shows
 *  the button in the hover list). */
export async function openQuestionList(page: Page, panel: Locator): Promise<Locator> {
  const map = panel.locator('.thread-map')
  // The nav itself is a 0px-tall sticky anchor; its body is what shows.
  await expect(map.locator('.thread-map-body')).toBeVisible()
  if (await map.getAttribute('data-shape') === 'rail') {
    // Hovering opens the list (and a click would land on the card that then
    // covers the rail); a pointer that cannot hover falls back to a synthetic tap.
    const overlay = map.locator('.thread-map-overlay')
    if (await overlay.count() === 0) {
      await map.locator('.thread-map-rail').hover()
      if (await overlay.count() === 0) await map.locator('.thread-map-rail').dispatchEvent('click')
    }
    await expect(overlay).toBeVisible()
  }
  await map.locator('.thread-map-icon[aria-label="Open the question list"]').click()
  const drawer = page.locator('.thread-drawer')
  await expect(drawer).toBeVisible()
  return drawer
}

/** Viewport rects of `phrase` inside the panel's rendered messages. */
export async function passageRects(panel: Locator, phrase: string) {
  const rects = await panel.evaluate((root, needle) => {
    const bodies = Array.from(root.querySelectorAll('.session-history [data-message-id] .session-msg-content'))
    for (const body of bodies) {
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n as Text
        const at = text.data.indexOf(needle)
        if (at === -1) continue
        const range = document.createRange()
        range.setStart(text, at)
        range.setEnd(text, at + needle.length)
        return Array.from(range.getClientRects()).map((r) => ({ left: r.left, right: r.right, top: r.top, height: r.height }))
      }
    }
    return null
  }, phrase)
  expect(rects, `passage "${phrase}" is not rendered`).not.toBeNull()
  expect(rects!.length).toBeGreaterThan(0)
  return rects!
}

export interface CentreOpts {
  /** Where the target should sit, as a fraction of the timeline's height. */
  at?: number
  /** Close enough, in px. */
  tolerance?: number
  /** Largest single wheel step, in px. */
  maxStep?: number
  /** Measure a row by its first 200px (a tall row's top stays in view). */
  capRow?: boolean
}

/**
 * Scroll the timeline until `target` (a row, or a phrase inside one) sits at
 * `at` of its height. REAL wheel steps: a programmatic scrollTop write before the
 * first wheel can be snapped back by bottom follow. Headless WebKit sometimes
 * drops every synthetic wheel after the first one (measured 2 in 10 opens; async
 * scrolling once the timeline's own wheel listeners detach), so a step that did
 * not move the box goes in again as a direct scroll: the first wheel already
 * released the bottom pin, so it stays put. A box that moves by neither is at
 * its edge, and the loop stops there.
 *
 * Under load a wheel can also land LATE (Chromium's animated wheel scroll), so a
 * still box is looked at again before it counts as a dropped wheel, and the
 * helper returns only once scrollTop has stopped moving: a late wheel landing
 * after the caller measured the passage reads as a landing drift.
 */
export async function centreInHistory(page: Page, panel: Locator, target: Locator | string, opts: CentreOpts = {}): Promise<void> {
  const { at = 0.45, tolerance = 50, maxStep = 700, capRow = false } = opts
  const history = panel.locator('.session-history')
  const scrollTop = () => history.evaluate((el) => el.scrollTop)
  const settle = async () => {
    let prev = await scrollTop()
    for (let k = 0; k < 12; k++) {
      await page.waitForTimeout(120)
      const now = await scrollTop()
      if (now === prev) return
      prev = now
    }
  }
  const offset = async (): Promise<number> => {
    const box = (await history.boundingBox())!
    if (typeof target === 'string') return (await passageRects(panel, target))[0].top - (box.y + box.height * at)
    const r = (await target.boundingBox())!
    return r.y + (capRow ? Math.min(r.height, 200) : r.height) / 2 - (box.y + box.height * at)
  }
  for (let i = 0; i < 40; i++) {
    const delta = await offset()
    if (Math.abs(delta) < tolerance) {
      await settle()
      if (Math.abs(await offset()) < tolerance) return
      continue
    }
    const step = Math.max(-maxStep, Math.min(maxStep, Math.round(delta)))
    const before = await scrollTop()
    const box = (await history.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, step)
    await page.waitForTimeout(140)
    if (i === 0 || await scrollTop() !== before) continue
    await page.waitForTimeout(300)
    if (await scrollTop() !== before) continue
    await history.evaluate((el, dy) => { el.scrollTop += dy }, step)
    await page.waitForTimeout(60)
    if (await scrollTop() === before) { await settle(); return }
  }
  await settle()
}

/** Drag-select `phrase` with the real mouse (the selection bar reads these
 *  events, so the gesture IS the test). Scroll it into view first. */
export async function selectPassage(page: Page, panel: Locator, phrase: string): Promise<string> {
  const rects = await passageRects(panel, phrase)
  const first = rects[0]
  const last = rects[rects.length - 1]
  const startX = first.left + 1
  const startY = first.top + first.height / 2
  const endX = last.right - 1
  const endY = last.top + last.height / 2
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move((startX + endX) / 2, (startY + endY) / 2, { steps: 5 })
  await page.mouse.move(endX, endY, { steps: 5 })
  await page.mouse.up()
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '')
  expect(selected.trim().length).toBeGreaterThan(0)
  return selected
}

export interface ThreadsRecord {
  threadAnchors?: Array<{ msgId: string }>
  threadMeta?: Array<Record<string, unknown> & { headId: string }>
  pinnedMessages?: unknown[]
  [k: string]: unknown
}

/** GET the session record (server truth, not the UI's view of it). */
export async function readRecord(request: APIRequestContext, sessionId: string): Promise<ThreadsRecord> {
  const res = await request.get(`/api/sessions/${sessionId}`)
  expect(res.ok(), `GET session ${sessionId}: ${res.status()}`).toBe(true)
  return ((await res.json()) as { session: ThreadsRecord }).session
}

const META_FIELDS = [
  'status', 'title', 'titleSource', 'titleState', 'question', 'takeaway', 'takeawaySource', 'takeawayState',
  'hidden', 'suggestDismissed', 'refinedAt',
] as const

/** The number the next Ask gets: one past the highest `seq` the record holds.
 *  (A fixture reset restores the seed's entries but a meta entry a previous test
 *  added keeps its write-once seq, so the next number is read, not assumed.) */
export async function nextQuestionNumber(request: APIRequestContext, sessionId: string): Promise<number> {
  const rec = await readRecord(request, sessionId)
  let max = 0
  for (const m of rec.threadMeta ?? []) { const s = (m as { seq?: number }).seq; if (typeof s === 'number' && s > max) max = s }
  return max + 1
}

/**
 * Put a fixture session back to its seeded anchors, meta and pins. Anchors and
 * pins are whole-list writes; meta is an UPSERT on the server, so every seeded
 * field is written back (null for the ones the seed does not have), and an
 * entry a test added is neutralized (its anchor is gone, so it draws nothing).
 */
export async function resetThreadsFixture(request: APIRequestContext, sessionId: string): Promise<void> {
  const seed = seededThreadState(sessionId, Date.now())
  expect(seed, `no threads fixture named ${sessionId}`).not.toBeNull()
  const current = await readRecord(request, sessionId)
  const seededHeads = new Set(seed!.threadMeta.map((m) => m.headId))
  const meta: Array<Record<string, unknown>> = seed!.threadMeta.map((m) => {
    const entry: Record<string, unknown> = { headId: m.headId }
    for (const f of META_FIELDS) entry[f] = (m as unknown as Record<string, unknown>)[f] ?? null
    return entry
  })
  for (const m of current.threadMeta ?? []) {
    if (seededHeads.has(m.headId)) continue
    const entry: Record<string, unknown> = { headId: m.headId }
    for (const f of META_FIELDS) entry[f] = null
    entry.status = 'older'
    meta.push(entry)
  }
  const res = await request.patch(`/api/sessions/${sessionId}`, {
    data: { thread_anchors: seed!.threadAnchors, thread_meta: meta, pinned_messages: seed!.pinnedMessages },
  })
  expect(res.ok(), `reset ${sessionId}: ${res.status()} ${await res.text()}`).toBe(true)
}

/** Characters the new UI never shows: the Unicode Arrows block, the two curved
 *  arrows next to it, and em / en dashes. */
export const BANNED_GLYPHS = /[\u2190-\u21FF\u2934\u2935\u2013\u2014]/
/** The new UI says question(s); the old word must not come back. */
export const BANNED_WORD = /\bthreads?\b/i

export interface GlyphHit { where: 'text' | 'aria-label' | 'title'; value: string }

/**
 * Scan visible text, aria-labels and titles under `scope` (default: the whole
 * page) for banned glyphs and the banned word. Transcript message bodies are
 * skipped unless `includeTranscript` (model text is not UI).
 */
export async function findBannedGlyphs(page: Page, scope?: Locator, opts: { includeTranscript?: boolean } = {}): Promise<GlyphHit[]> {
  const root = scope ?? page.locator('body')
  return root.evaluate((el, a) => {
    const glyph = new RegExp(a.glyph)
    const word = new RegExp(a.word, 'i')
    const bad = (s: string) => glyph.test(s) || word.test(s)
    // The outline rail's label and Back button predate the question UI and keep
    // their own characters (a session without questions renders exactly as before).
    const skip = (n: Element | null) => !!n?.closest('.session-toc-rail, .session-toc-back')
      || (!a.includeTranscript && !!n?.closest('.session-msg-content'))
    const hits: Array<{ where: 'text' | 'aria-label' | 'title'; value: string }> = []
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const parent = n.parentElement
      if (!parent || skip(parent) || !n.textContent?.trim()) continue
      if (parent.closest('script,style')) continue
      if (parent.getClientRects().length === 0) continue
      if (bad(n.textContent)) hits.push({ where: 'text', value: n.textContent.trim().slice(0, 120) })
    }
    for (const node of Array.from(el.querySelectorAll('[aria-label],[title]'))) {
      if (skip(node)) continue
      for (const attr of ['aria-label', 'title'] as const) {
        const v = node.getAttribute(attr)
        if (v && bad(v)) hits.push({ where: attr, value: v.slice(0, 120) })
      }
    }
    return hits
  }, { glyph: BANNED_GLYPHS.source, word: BANNED_WORD.source, includeTranscript: !!opts.includeTranscript })
}

/** Assert the scan comes back empty (prints every hit on failure). */
export async function noBannedGlyphs(page: Page, scope?: Locator, opts: { includeTranscript?: boolean } = {}): Promise<void> {
  const hits = await findBannedGlyphs(page, scope, opts)
  expect(hits, `banned glyphs or words in the UI: ${JSON.stringify(hits)}`).toEqual([])
}
