/**
 * Every chat pane keeps the reader's place (2026-11-09, the user: "when click
 * from main chat and then it jump to bottom while open a another pannel", and
 * "it shoudl alwys remmebret the location"). One rule for every way a pane
 * changes: opening a question from the main chat (Main moves into the left
 * page), going back to one page, picking another question, switching between
 * Conversation Mode and Tree Mode, a turn in another pane, a reload. A pane
 * returns to the message the reader was on, at the same height, and only the
 * reader's own scroll moves it. A pane he left at the bottom stays at the bottom.
 *
 * On the place fixture (a twelve-turn main conversation, questions asked from
 * its third and eighth answers, three turns each) in the full-screen sheet,
 * with real wheels and clicks. The rule: web/src/components/sessions/reading-place.ts.
 */
import { expect, type Locator, type Page } from '@playwright/test'
import { centreInHistory, resetThreadsFixture, switchView, test } from './threads-helpers'
import { PLACE_READY, PLACE_SESSION, PLACE_TASK, PLACE_TITLES } from './threads-fixture'
import { captureSends, leftHalf, openQuestion, pagesOnScreen, rightBody, rightComposer, scrollBoxOf, send } from './tree-split-helpers'
import { openThreadsSession, sessionPanel } from './threads-helpers'

const T = PLACE_TITLES

type Place = { id: string; top: number; screenTop: number; height: number; width: number; fromBottom: number }

/** Where the reader is in `scope`'s timeline: the first row reaching below the
 *  box's top edge, its top relative to that edge, and how far the box is from its bottom. */
async function placeOf(scope: Locator): Promise<Place> {
  return scrollBoxOf(scope).evaluate((el) => {
    const box = el.getBoundingClientRect()
    // The first row reaching below the box's top edge, the row reading-place.ts anchors on.
    const edge = box.top + 1
    for (const row of Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]'))) {
      if (row.parentElement?.closest('[data-message-id]')) continue
      const r = row.getBoundingClientRect()
      if (!r.height || r.bottom <= edge) continue
      return {
        id: row.dataset.messageId ?? '', top: Math.round(r.top - box.top), screenTop: Math.round(r.top), height: Math.round(r.height), width: Math.round(r.width),
        fromBottom: Math.round(el.scrollHeight - el.clientHeight - el.scrollTop),
      }
    }
    return { id: '', top: 0, screenTop: 0, height: 0, width: 0, fromBottom: Math.round(el.scrollHeight - el.clientHeight - el.scrollTop) }
  })
}

/** The same message at the same height: exact in a box of the same width; in
 *  a narrower or wider one (the text rewraps), the same share of the message. */
function expectSamePlace(after: Place, before: Place, what: string): void {
  expect(after.id, `${what}: the reader's message`).toBe(before.id)
  if (Math.abs(after.width - before.width) <= 2) {
    expect(Math.abs(after.top - before.top), `${what}: the message's height in the box (${after.top} vs ${before.top})`).toBeLessThanOrEqual(4)
  } else {
    const share = (p: Place) => (p.top >= 0 ? p.top / 1000 : p.top / p.height)
    expect(Math.abs(share(after) - share(before)), `${what}: where in the message (${after.top}/${after.height} vs ${before.top}/${before.height})`).toBeLessThanOrEqual(0.06)
  }
  expect(after.fromBottom, `${what}: not thrown to the bottom`).toBeGreaterThan(300)
}

/** A pop back in the same box: the same message at the same height on SCREEN
 *  (the bar above the box can differ, C4), the stack's own landing. */
function expectSameOnScreen(after: Place, before: Place, what: string): void {
  expect(after.id, `${what}: the reader's message`).toBe(before.id)
  expect(Math.abs(after.screenTop - before.screenTop), `${what}: the message's height on screen (${after.screenTop} vs ${before.screenTop})`).toBeLessThanOrEqual(8)
  expect(after.fromBottom, `${what}: not thrown to the bottom`).toBeGreaterThan(300)
}

/** The pane's place once it stopped moving (a landing hold, a late layout pass). */
async function settledPlace(page: Page, scope: Locator): Promise<Place> {
  let prev = await placeOf(scope)
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(150)
    const now = await placeOf(scope)
    if (now.id === prev.id && now.top === prev.top && now.fromBottom === prev.fromBottom) {
      await page.waitForTimeout(700)
      const late = await placeOf(scope)
      if (late.id === now.id && late.top === now.top) return late
    }
    prev = now
  }
  return prev
}

async function openSheet(page: Page, width = 1440): Promise<Locator> {
  await page.setViewportSize({ width, height: 900 })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.addStyleTag({ content: '.notification-toaster { display: none !important; }' })
  const panel = await openThreadsSession(page, PLACE_SESSION, PLACE_TASK, undefined, { view: 'stack', pages: 'room' })
  await panel.getByRole('button', { name: 'Expand session to full screen' }).click()
  await expect(panel).toHaveClass(/open-walnut-fullscreen/)
  await expect(rightBody(panel).locator('.session-history')).toContainText('Main answer 12', { timeout: 30_000 })
  await page.waitForTimeout(800)
  return panel
}

/** Main's "Asked from this answer" row of `title`, put mid-box with the wheel. */
async function askedRow(page: Page, scope: Locator, title: string): Promise<Locator> {
  const row = scope.locator('.thread-asked-from .thread-asked-row', { hasText: title }).first()
  await expect(row).toHaveCount(1, { timeout: 15_000 })
  await centreInHistory(page, scope, row, { at: 0.55, tolerance: 80 })
  await expect(row).toBeInViewport()
  return row
}

/** A click at the row's centre as the reader's, never Playwright's scroll-into-view. */
async function clickAt(page: Page, target: Locator): Promise<void> {
  const b = (await target.boundingBox())!
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2)
}

/** The reader's own wheel over `scope`. */
async function wheel(page: Page, scope: Locator, dy: number): Promise<void> {
  const box = (await scrollBoxOf(scope).boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let left = dy; Math.abs(left) > 0;) {
    const step = Math.max(-600, Math.min(600, left))
    await page.mouse.wheel(0, step)
    left -= step
    await page.waitForTimeout(90)
  }
}

/** One page at a time: how deep the page on screen is (0 = Main). */
async function expectDepth(panel: Locator, depth: number): Promise<void> {
  await expect(panel.locator('.thread-stack')).toHaveAttribute('data-thread-depth', String(depth), { timeout: 10_000 })
}

/** What the timeline keeps (reading-place.ts), for a failure's message. */
async function kept(page: Page): Promise<string> {
  return page.evaluate((sid) => {
    const raw = localStorage.getItem(`walnut:reading-place.v1:${sid}`) ?? '{}'
    const all = JSON.parse(raw) as Record<string, { rows: Array<{ id: string; top: number }>; atBottom: boolean }>
    return Object.entries(all).map(([k, v]) => `${k.slice(-24) || 'main'}: ${v.atBottom ? 'bottom' : v.rows.slice(0, 2).map((r) => `${r.id.slice(6, 8)}@${r.top}`).join(',')}`).join(' | ')
  }, PLACE_SESSION)
}

async function expectPages(panel: Locator, pages: string[]): Promise<void> {
  await expect.poll(() => pagesOnScreen(panel), { timeout: 10_000 }).toEqual(pages)
}

test.describe('every chat pane keeps the reader\'s place', () => {
  // One at a time (one fixture session), and every test runs even after one fails.
  test.describe.configure({ mode: 'default', timeout: 120_000 })
  test.beforeEach(async ({ request, page }) => {
    await resetThreadsFixture(request, PLACE_SESSION)
    // A place kept from an earlier test in this browser is not this test's.
    await page.addInitScript(() => {
      if (sessionStorage.getItem('pw-place-kept')) return
      for (const k of Object.keys(localStorage)) if (k.startsWith('walnut:reading-place.v1:')) localStorage.removeItem(k)
      sessionStorage.setItem('pw-place-kept', '1')
    })
  })

  test('opening a question from the main chat keeps Main where the reader was, and so does coming back', async ({ page }) => {
    const panel = await openSheet(page)
    await expectPages(panel, [])
    // Up in the main conversation, at the third answer's question.
    const row = await askedRow(page, rightBody(panel), T.Q1)
    const before = await settledPlace(page, rightBody(panel))
    expect(before.fromBottom).toBeGreaterThan(300)
    await clickAt(page, row)
    await expectPages(panel, ['L Main conversation', 'R 1'])
    expectSamePlace(await settledPlace(page, leftHalf(panel)), before, 'Main, moved into the left page')

    // The reader moves on in the left page, then closes the question: Main is
    // the one page again, where he left it in the left page.
    await wheel(page, leftHalf(panel), 700)
    const inLeft = await settledPlace(page, leftHalf(panel))
    await rightBody(panel).getByRole('button', { name: 'Close the right page' }).click()
    await expectPages(panel, [])
    expectSamePlace(await settledPlace(page, rightBody(panel)), inLeft, 'Main, back to one page')
  })

  test('another question on the right keeps Main, and each question comes back to its own place', async ({ page }) => {
    const panel = await openSheet(page)
    await clickAt(page, await askedRow(page, rightBody(panel), T.Q1))
    await expectPages(panel, ['L Main conversation', 'R 1'])
    // Up in question 1.
    await wheel(page, rightBody(panel), -900)
    const q1 = await settledPlace(page, rightBody(panel))
    // Question 2 from Main's eighth answer.
    await clickAt(page, await askedRow(page, leftHalf(panel), T.Q2))
    await expectPages(panel, ['L Main conversation', 'R 2'])
    const main = await settledPlace(page, leftHalf(panel))
    await wheel(page, rightBody(panel), 300)
    const q2 = await settledPlace(page, rightBody(panel))
    test.info().annotations.push({ type: 'kept after q2', description: await kept(page) })
    // Back to question 1 from the list: its place; Main unmoved.
    await openQuestion(panel, T.Q1)
    await expectPages(panel, ['L Main conversation', 'R 1'])
    expectSamePlace(await settledPlace(page, rightBody(panel)), q1, 'question 1, picked again')
    expectSamePlace(await settledPlace(page, leftHalf(panel)), main, 'Main, while the right page changed')
    test.info().annotations.push({ type: 'kept before q2 again', description: await kept(page) })
    await openQuestion(panel, T.Q2)
    expectSamePlace(await settledPlace(page, rightBody(panel)), q2, `question 2, picked again (kept: ${await kept(page)})`)
  })

  test('Conversation Mode and Tree Mode each keep the main chat where the reader was', async ({ page }) => {
    const panel = await openSheet(page)
    await askedRow(page, rightBody(panel), T.Q2)
    const tree = await settledPlace(page, rightBody(panel))
    await switchView(panel, 'linear')
    expectSamePlace(await settledPlace(page, rightBody(panel)), tree, 'Main, into Conversation Mode')
    await wheel(page, rightBody(panel), -800)
    const conv = await settledPlace(page, rightBody(panel))
    await switchView(panel, 'stack')
    expectSamePlace(await settledPlace(page, rightBody(panel)), conv, 'Main, back in Tree Mode')
    await switchView(panel, 'linear')
    expectSamePlace(await settledPlace(page, rightBody(panel)), conv, 'Main, Conversation Mode again')
  })

  test('a turn in the right page leaves Main where it is; Main at the bottom stays at the bottom', async ({ page }) => {
    const sent = captureSends(page)
    const panel = await openSheet(page)
    // At the bottom, a question opens: Main stays at the bottom.
    const atEnd = await placeOf(rightBody(panel))
    expect(atEnd.fromBottom).toBeLessThan(40)
    await openQuestion(panel, T.Q2)
    await expectPages(panel, ['L Main conversation', 'R 2'])
    await page.waitForTimeout(800)
    expect((await placeOf(leftHalf(panel))).fromBottom, 'Main left at the bottom').toBeLessThan(40)
    // Up in Main, then a turn on the right.
    await askedRow(page, leftHalf(panel), T.Q1)
    const main = await settledPlace(page, leftHalf(panel))
    await send(rightComposer(panel), 'One more on the right page')
    await expect.poll(() => sent.length).toBeGreaterThan(0)
    await expect(rightBody(panel).locator('.session-history')).toContainText('One more on the right page')
    await page.waitForTimeout(1500)
    expectSamePlace(await settledPlace(page, leftHalf(panel)), main, 'Main, during a turn on the right')
  })

  test('one page at a time: Main and a question each come back to their place in the same box', async ({ page }) => {
    // Too narrow for two pages: the question replaces Main in the one box.
    const panel = await openSheet(page, 960)
    const row = await askedRow(page, rightBody(panel), T.Q1)
    const mainAtRow = await settledPlace(page, rightBody(panel))
    await clickAt(page, row)
    await expectDepth(panel, 1)
    await wheel(page, rightBody(panel), 600)
    const q1 = await settledPlace(page, rightBody(panel))
    await page.keyboard.press('ControlOrMeta+BracketLeft')
    await expectDepth(panel, 0)
    expectSameOnScreen(await settledPlace(page, rightBody(panel)), mainAtRow, 'Main, back from question 1')
    await openQuestion(panel, T.Q1)
    await expectDepth(panel, 1)
    expectSamePlace(await settledPlace(page, rightBody(panel)), q1, 'question 1, opened again')
  })

  test('leaving full screen and coming back keeps every page where it was', async ({ page }) => {
    const panel = await openSheet(page)
    await clickAt(page, await askedRow(page, rightBody(panel), T.Q1))
    await expectPages(panel, ['L Main conversation', 'R 1'])
    await wheel(page, leftHalf(panel), -600)
    await wheel(page, rightBody(panel), -500)
    const main = await settledPlace(page, leftHalf(panel))
    const q1 = await settledPlace(page, rightBody(panel))
    await panel.getByRole('button', { name: 'Collapse session' }).click()
    await expect(panel).not.toHaveClass(/open-walnut-fullscreen/)
    await page.waitForTimeout(800)
    await panel.getByRole('button', { name: 'Expand session to full screen' }).click()
    await expect(panel).toHaveClass(/open-walnut-fullscreen/)
    await expectPages(panel, ['L Main conversation', 'R 1'])
    expectSamePlace(await settledPlace(page, leftHalf(panel)), main, 'Main, after full screen again')
    expectSamePlace(await settledPlace(page, rightBody(panel)), q1, 'question 1, after full screen again')
  })

  test('a send right after a pane came back to its place goes to the end', async ({ page }) => {
    const panel = await openSheet(page)
    // Main comes back into the left page at its place, and the reader sends from
    // Main's composer at once, while the place still holds against late layout.
    await clickAt(page, await askedRow(page, rightBody(panel), T.Q1))
    await expectPages(panel, ['L Main conversation', 'R 1'])
    const box = leftHalf(panel).locator('textarea.chat-input-textarea')
    await box.click()
    await box.fill('Straight after the place came back')
    await box.press('Enter')
    await expect(leftHalf(panel).locator('.session-history')).toContainText('Straight after the place came back')
    await page.waitForTimeout(2500)
    expect((await placeOf(leftHalf(panel))).fromBottom, 'Main follows the send to its end').toBeLessThan(40)
  })

  test('a place older than the rows a session first loads is fetched and shown', async ({ page }) => {
    // A 460-row transcript; the panel first holds its last 400 rows. The reader
    // was at pair 6 (kept in the tab, as reading there would have kept it).
    const SID = 'pw-outline-window-session'
    const ask6 = '0199bd02-0000-4aaa-8bbb-000000000005'
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.evaluate(([sid, id]) => {
      localStorage.setItem(`walnut:reading-place.v1:${sid}`, JSON.stringify({
        '': { rows: [{ id, top: 160, height: 60 }], width: 0, atBottom: false, at: Date.now() },
      }))
    }, [SID, ask6] as const)
    await page.reload()
    await page.waitForLoadState('networkidle')
    await page.locator('.todo-search-input').fill(SID)
    await page.locator('.todo-panel-item[data-task-id="pw-task-outline-window"] .todo-item-title').click()
    const panel = sessionPanel(page, SID)
    const row = panel.locator(`.session-history [data-message-id="${ask6}"]`)
    await expect(row).toBeInViewport({ timeout: 30_000 })
    await page.waitForTimeout(2000)
    const top = await row.evaluate((el) => {
      const box = el.closest('.session-history')!.getBoundingClientRect()
      return Math.round(el.getBoundingClientRect().top - box.top)
    })
    expect(Math.abs(top - 160), `pair 6 at its kept height (${top})`).toBeLessThanOrEqual(30)
  })

  test('a reload brings each pane back to its place', async ({ page }) => {
    const panel = await openSheet(page)
    await clickAt(page, await askedRow(page, rightBody(panel), T.Q1))
    await expectPages(panel, ['L Main conversation', 'R 1'])
    await wheel(page, rightBody(panel), -700)
    const main = await settledPlace(page, leftHalf(panel))
    const q1 = await settledPlace(page, rightBody(panel))
    await page.reload()
    await page.waitForLoadState('networkidle')
    const again = page.locator(`.session-panel[data-session-id="${PLACE_SESSION}"]`).first()
    await expect(again.locator('.session-history').first()).toContainText(PLACE_READY.slice(0, 10), { timeout: 30_000 }).catch(() => {})
    await expectPages(again, ['L Main conversation', 'R 1'])
    expectSamePlace(await settledPlace(page, leftHalf(again)), main, 'Main, after a reload')
    expectSamePlace(await settledPlace(page, rightBody(again)), q1, 'question 1, after a reload')
  })
})
