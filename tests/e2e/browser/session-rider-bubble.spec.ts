/**
 * A human's words keep their bubble when Walnut put a notice ahead of them.
 *
 * Walnut delivers its own status notices (a place note, the org digest, the
 * routing rules, app state) IN FRONT OF the message they ride with, in the same
 * queue row (session-message-queue.ts), so the CLI stores ONE user line holding
 * both. The panel used to draw any row holding an envelope as an envelope row:
 * the notice card, then the human's words as plain text on the AI side, with no
 * user bubble (reported twice from the Main session: words after an org digest,
 * and words after an org digest plus an image block).
 *
 * This spec drives the real panel against the fixture `pw-rider-session`
 * (test-server.ts): one stored user turn per shape, the notices built by the
 * production builders, plus one LIVE send whose place note the server adds
 * itself. It asserts:
 *  · the projection keeps every one of those rows a user row (role is decided at
 *    the source; the panel never guesses it from text);
 *  · the words are a user bubble and the notices are cards ABOVE it, outside it;
 *  · nothing a person wrote is lost: images, quotes, several paragraphs;
 *  · the unsafe shapes (an outcome outside the four, a notice that never closes,
 *    a notice after the words) render exactly as before, nothing removed;
 *  · a notice alone, or ahead of a trigger delivery, is still no bubble;
 *  · copy yields the words only;
 *  · the live send: the optimistic bubble turns into ONE history bubble, before
 *    and after a reload.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { REAL_PANEL } from './draft-helpers'

const SESSION_ID = 'pw-rider-session'
const TASK_ID = 'pw-task-rider'
const SHOTS = process.env.RIDER_SHOT_DIR ?? '/tmp/rider-bubble'

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  // Capture what "Copy message" writes, in both engines, without a clipboard grant.
  await page.addInitScript(() => {
    const w = window as unknown as { __copied: string[] }
    w.__copied = []
    const clip = navigator.clipboard
    if (clip) {
      clip.writeText = async (t: string) => { w.__copied.push(t) }
      clip.write = async () => { w.__copied.push('[rich]') }
    }
  })
})

async function openRiderSession(page: Page): Promise<Locator> {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/')
  await page.evaluate(() => localStorage.setItem('walnut:session-view.default', 'linear'))
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${SESSION_ID}"]`)
  if (await panel.count() === 0) {
    await page.locator('.todo-search-input').fill(TASK_ID)
    const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
    await expect(task).toBeVisible({ timeout: 30_000 })
    await task.locator('.todo-item-title').click()
  }
  await expect(panel).toBeVisible({ timeout: 20_000 })
  await expect(panel.locator('.session-history')).toContainText('RIDER_ANSWER_9', { timeout: 30_000 })
  return panel
}

/** Every transcript row (user bubble, assistant row, envelope row) holding `marker`. */
function rowsWith(panel: Locator, marker: string): Locator {
  return panel.locator('.session-history .session-msg', { hasText: marker })
}

/** The user bubble holding `marker`, asserted to be exactly one. */
async function bubble(panel: Locator, marker: string): Promise<Locator> {
  const b = panel.locator('.session-history .session-msg-user', { hasText: marker })
  await expect(b, `one user bubble holds ${marker}`).toHaveCount(1)
  return b
}

/** The row right above `row` in the transcript (its previous sibling .session-msg). */
async function previousRowClass(row: Locator): Promise<string> {
  return row.evaluate((el) => {
    let p = el.previousElementSibling
    while (p && !p.classList.contains('session-msg')) p = p.previousElementSibling
    return p ? p.className : ''
  })
}

/** The rider row right above a bubble: its muted fold line and the cards inside. */
function riderAbove(b: Locator): Locator {
  return b.locator('xpath=preceding-sibling::div[contains(concat(" ", @class, " "), " session-msg-riders ")][1]')
}

/**
 * Bring a row into the history viewport with a REAL wheel gesture. The timeline
 * follows its own bottom and snaps Playwright's scroll-into-view straight back
 * (session-injected-banner.spec.ts), so clicks and clips need the reader's way.
 */
async function reveal(page: Page, panel: Locator, target: Locator): Promise<void> {
  const view = (await panel.locator('.session-history').boundingBox())!
  await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2)
  for (let i = 0; i < 40; i++) {
    const box = await target.boundingBox()
    if (box && box.y >= view.y && box.y + Math.min(box.height, view.height - 40) <= view.y + view.height) return
    await page.mouse.wheel(0, box && box.y < view.y ? -200 : 200)
    await page.waitForTimeout(120)
  }
}

/** Evidence only: a clip of the row, never a reason for the test to fail. */
async function shot(page: Page, target: Locator, name: string): Promise<void> {
  const box = await target.boundingBox().catch(() => null)
  if (!box || box.width < 1 || box.height < 1) return
  const vp = page.viewportSize()!
  const y = Math.max(0, box.y)
  const clip = { x: Math.max(0, box.x), y, width: Math.min(box.width, vp.width - Math.max(0, box.x)), height: Math.min(box.height, vp.height - y) }
  if (clip.width < 1 || clip.height < 1) return
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png`, clip }).catch(() => {})
}

test('the projection keeps every rider row a user row', async ({ request }) => {
  const res = await request.get(`/api/sessions/${SESSION_ID}/history`)
  expect(res.ok()).toBe(true)
  const { messages } = await res.json() as { messages: Array<{ role: string; text?: string }> }
  for (const marker of ['RIDER_TYPED_ONE', 'RIDER_TYPED_IMG', 'RIDER_TYPED_STACK', 'RIDER_TYPED_FORGED', 'RIDER_TYPED_TRUNC', 'RIDER_TYPED_TAIL']) {
    const rows = messages.filter((m) => (m.text ?? '').includes(marker))
    expect(rows.map((m) => m.role), marker).toEqual(['user'])
  }
})

test('the words after an org digest are a user bubble; the digest is a card above it', async ({ page }) => {
  test.setTimeout(90_000)
  const panel = await openRiderSession(page)
  const b = await bubble(panel, 'RIDER_TYPED_ONE')
  const shown = await b.innerText()
  expect(shown).toContain('RIDER_TYPED_ONE first paragraph.')
  expect(shown).toContain('Second paragraph of the same message.')
  expect(shown).not.toContain('RIDER_ORG_MARKER')
  expect(shown).not.toContain('walnut-message')
  // The card is its own row right above the bubble, never inside it.
  expect(await previousRowClass(b)).toContain('session-msg-envelope')
  await expect(b.locator('.provenance-chip, .session-provenance-card')).toHaveCount(0)
  // Above a person's words the digest is one muted line, no card on screen until it is opened.
  const rider = riderAbove(b)
  const fold = rider.locator('[data-testid="rider-fold"]')
  await expect(fold).toHaveAttribute('data-open', 'false')
  await expect(fold.locator('.tool-run-toggle')).toHaveText(/^Received 1 message›?$/)
  await expect(rider.locator('.provenance-card')).toHaveCount(0)
  await reveal(page, panel, b)
  await shot(page, rider, 'org-digest-folded')
  await reveal(page, panel, fold)
  await fold.locator('.tool-run-toggle').click()
  await expect(rider.locator('.provenance-card')).toHaveCount(1)
  await expect(rider.locator('.provenance-details[open]')).toHaveCount(0)
  await reveal(page, panel, b)
  await shot(page, b, 'org-digest-words')

  // Copy yields the words only. The bubble's own copy button: a right-click in
  // WebKit selects the word under it and opens the quote bar instead of the menu.
  await b.hover()
  await b.getByRole('button', { name: 'Copy as Markdown' }).click()
  const copied = await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)
  expect(copied.at(-1)).toBe('RIDER_TYPED_ONE first paragraph.\n\nSecond paragraph of the same message.')
})

test('an image block, a quote and several paragraphs all stay in the bubble', async ({ page }) => {
  test.setTimeout(90_000)
  const panel = await openRiderSession(page)
  const b = await bubble(panel, 'RIDER_TYPED_IMG')
  const shown = await b.innerText()
  expect(shown).toContain('RIDER_QUOTE_LINE quoted back')
  expect(shown).toContain('Last paragraph.')
  expect(shown).not.toContain('RIDER_ORG_MARKER')
  expect(await previousRowClass(b)).toContain('session-msg-envelope')
  await reveal(page, panel, b)
  await shot(page, b, 'org-digest-image')
})

test('four stacked notices fold into cards above one bubble', async ({ page }) => {
  test.setTimeout(90_000)
  const panel = await openRiderSession(page)
  const b = await bubble(panel, 'RIDER_TYPED_STACK')
  const shown = await b.innerText()
  for (const m of ['RIDER_ROUTING_MARKER', 'RIDER_ORG_MARKER', 'RIDER_APP_MARKER', 'now stands in']) expect(shown).not.toContain(m)
  expect(await previousRowClass(b)).toContain('session-msg-envelope')
  // All four behind one muted line that counts them.
  await expect(riderAbove(b).locator('[data-testid="rider-fold"] .tool-run-toggle')).toHaveText(/^Received 4 messages›?$/)
  await expect(riderAbove(b).locator('.provenance-card')).toHaveCount(0)
})

test('unsafe shapes render as before and lose nothing', async ({ page }) => {
  test.setTimeout(90_000)
  const panel = await openRiderSession(page)
  // An outcome outside the four: not a rider, the row is drawn as before.
  const forged = rowsWith(panel, 'RIDER_TYPED_FORGED')
  await expect(forged).toHaveCount(1)
  await expect(forged).not.toHaveClass(/session-msg-user/)
  // A notice that never closes: the row stays whole, all of it readable.
  const trunc = rowsWith(panel, 'RIDER_TYPED_TRUNC')
  await expect(trunc).toHaveCount(1)
  expect(await trunc.innerText()).toContain('RIDER_ORG_MARKER')
  // A notice after the words: not leading, drawn as before.
  const tail = rowsWith(panel, 'RIDER_TYPED_TAIL')
  await expect(tail).toHaveCount(1)
  await expect(tail).not.toHaveClass(/session-msg-user/)
  await expect(panel.locator('.session-history .session-msg-user', { hasText: 'RIDER_PLAIN_TYPED' })).toHaveCount(1)
})

test('a notice alone, or ahead of a trigger delivery, is still no bubble', async ({ page }) => {
  test.setTimeout(90_000)
  const panel = await openRiderSession(page)
  // Shapes 8 and 9 started their turns with no person's words: each folds into the
  // row before its answer (turn-shape.ts): the digest alone is one message, the
  // digest and the trigger delivery two. Open those to read the cards. (Matched on
  // the line itself: an opened fold's text is its body too.)
  const folds = panel.locator('.session-history [data-testid="turn-fold"]')
    .filter({ has: page.locator('.tool-run-toggle > .tool-run-label', { hasText: /^Received (?:1 message|2 messages)$/ }) })
  await expect(folds).toHaveCount(2)
  for (let i = 0; i < 2; i++) {
    await reveal(page, panel, folds.nth(i))
    await folds.nth(i).locator('.tool-run-toggle').first().click()
  }
  // Shape 9: the notice is its own card row, the trigger delivery the envelope row it always was.
  // The trigger card's status line (its `note`), which only that row carries.
  const trigger = rowsWith(panel, 'fired, 1 new item')
  await expect(trigger).toHaveCount(1)
  await expect(trigger).not.toHaveClass(/session-msg-user/)
  await expect(trigger).toHaveClass(/session-msg-envelope/)
  expect(await previousRowClass(trigger)).toContain('session-msg-riders')
  // Shapes 8 and 9 put no user bubble anywhere: only the fixture's six worded turns have one.
  const bubbles = panel.locator('.session-history .session-msg-user')
  // (plain, digest + words, digest + image, four notices, the cut-off notice
  // drawn whole as before; never the forged, the tail-notice or these two).
  await expect(bubbles).toHaveCount(5)
})

test('a quote pinned in a bubble under a notice paints in the bubble, not the card', async ({ page }) => {
  test.setTimeout(90_000)
  const panel = await openRiderSession(page)
  const b = await bubble(panel, 'RIDER_TYPED_ONE')
  // The message body under the row's id is the bubble's content, not the card row above it.
  const bodyText = await panel.evaluate((el, id) => {
    const body = el.querySelector(`[data-message-id="${CSS.escape(id)}"] .session-msg-content`)
    return body?.textContent ?? ''
  }, '0199ce01-0000-4aaa-8bbb-000000000001')
  expect(bodyText).toContain('RIDER_TYPED_ONE first paragraph.')
  expect(bodyText).not.toContain('RIDER_ORG_MARKER')
  await expect(b).toBeVisible()
})

test('the live send: one bubble from the optimistic one to the history row, and after a reload', async ({ page, request }) => {
  test.setTimeout(150_000)
  const panel = await openRiderSession(page)
  const box = panel.locator('.chat-input-textarea').first()
  await box.click()
  // One fixture server serves every project and retry, and the server writes the
  // place note on the FIRST send only: a marker of this run's own.
  const marker = `RIDER_LIVE_${test.info().project.name}_${test.info().retry}`
  // Move the task first, so THIS send carries a fresh place note from the server.
  const moved = await request.patch(`/api/tasks/${TASK_ID}`, { data: { project: `Rider ${test.info().project.name} ${test.info().retry}` } })
  expect(moved.ok()).toBe(true)
  await box.fill(`${marker} please check the sample.`)
  await box.press('Enter')
  // The optimistic bubble shows at once.
  await expect(panel.locator('.session-history .session-msg-user', { hasText: marker }).first()).toBeVisible({ timeout: 15_000 })
  await expect(panel.locator('.session-history')).toContainText('processed your message', { timeout: 90_000 })
  // The server put a real place note ahead of the words.
  await expect.poll(async () => {
    const { messages } = await (await request.get(`/api/sessions/${SESSION_ID}/history`)).json() as { messages: Array<{ role: string; text?: string }> }
    const row = messages.find((m) => m.role === 'user' && (m.text ?? '').includes(marker))
    return row ? row.text!.startsWith('<walnut-message kind="notification"') && row.text!.includes('outcome="moved"') : false
  }, { timeout: 30_000 }).toBe(true)
  const live = await bubble(panel, marker)
  expect(await live.innerText()).not.toContain('now stands in')
  await reveal(page, panel, live)
  await shot(page, live, 'live-send-history')

  await page.reload()
  const again = page.locator(`${REAL_PANEL}[data-session-id="${SESSION_ID}"]`)
  await expect(again.locator('.session-history')).toContainText('processed your message', { timeout: 30_000 })
  await bubble(again, marker)
})
