/**
 * A long letter thread in the REAL reader: the conversation scrolls on its own,
 * under the document, and opens at its newest turn.
 *
 * The bug (2026-10-25): one scroll held the document and the thread, a long
 * digest body sat between the human and the newest reply, and its sandboxed
 * iframe took every wheel event over it, so the human could barely reach the end
 * of a long thread on the Mac app or the phone.
 *
 * Claims, each through the UI a human uses (wheel, click, typing):
 *  - opening puts the newest turn and the reply box on screen;
 *  - a reader scrolled up is never moved: not by an image above finishing its
 *    load, not by a new reply (a "New reply" button says so instead);
 *  - at the end, a new reply is followed; the human's own reply always comes
 *    into view; dragging the divider keeps the end in view;
 *  - a letter with no thread keeps its single scroll.
 *
 * Run it in WebKit too (the Mac app is a WKWebView, and WebKit has no CSS scroll
 * anchoring): PW_WEBKIT=1 npx playwright test human-inbox-thread-scroll --project webkit
 */
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { home } from './inbox-items-helpers'

const NONCE = Date.now().toString(36)
const SHOTS = process.env.PW_EVIDENCE_DIR ?? '/tmp/inbox-thread-scroll'
/** A markdown image the test releases on cue: the "image loads late" case. An
 *  `/api/` path, so the renderer keeps it as written (others go through the
 *  local-image proxy); it is `loading="lazy"`, so it is requested only as the
 *  reader scrolls up toward it, which is when its late height would push them. */
const LATE_IMAGE = `/api/pw-late-image/${NONCE}.svg`
const LATE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="420">'
  + '<rect width="600" height="420" fill="#c8a27a"/></svg>'

async function send(request: APIRequestContext, body: Record<string, unknown>): Promise<string> {
  const res = await request.post('/api/v1/human-inbox', { data: body })
  expect(res.status(), await res.text()).toBe(201)
  return (await res.json() as { id: string }).id
}

async function agentReply(request: APIRequestContext, id: string, body: Record<string, unknown>): Promise<void> {
  const res = await request.post(`/api/v1/human-inbox/${id}/reply`, { data: body })
  expect(res.status(), await res.text()).toBe(200)
}

async function humanReply(request: APIRequestContext, id: string, text: string): Promise<void> {
  const res = await request.post(`/api/v1/human-inbox/${id}/human-reply`, { data: { text } })
  expect([200, 202], await res.text()).toContain(res.status())
}

/** A digest-sized document and a 30-turn thread of mixed shapes. */
async function seedLongLetter(request: APIRequestContext, subject: string): Promise<string> {
  const sections = Array.from({ length: 120 }, (_, i) =>
    `<h3>Section ${i + 1}</h3><p>${'Long digest paragraph. '.repeat(30)}</p>`).join('')
  const id = await send(request, { subject, type: 'info', html: `<h1>Digest ${NONCE}</h1>${sections}` })
  for (let i = 1; i <= 30; i++) {
    if (i % 2 === 1) {
      await humanReply(request, id, `Human turn ${i}: ${'please look at this part again. '.repeat(i % 5 + 1)}`)
    } else if (i === 4) {
      await agentReply(request, id, { text: `Agent turn ${i} with a chart`, markdown: `Chart below.\n\n![chart](${LATE_IMAGE})\n\nAfter the chart.` })
    } else if (i % 6 === 0) {
      await agentReply(request, id, { text: `Agent turn ${i} (rich)`, markdown: `### Agent turn ${i}\n\n${'- a finding with some detail\n'.repeat(12)}` })
    } else if (i === 10) {
      await agentReply(request, id, { text: `Agent turn ${i} (html)`, html: `<p>${'An html reply. '.repeat(40)}</p>` })
    } else {
      await agentReply(request, id, { text: `Agent turn ${i}: ${'a plain answer line. '.repeat(i % 7 + 2)}` })
    }
  }
  return id
}

async function openLetter(page: Page, subject: string): Promise<Locator> {
  await page.getByRole('button', { name: /^Notifications/ }).click()
  const center = page.locator('.notification-panel')
  await center.locator('.nfc-rail-btn').filter({ hasText: 'Inbox' }).click()
  await center.locator('.hib-row').filter({ hasText: subject }).locator('.hib-subject').click()
  const view = page.locator('.hib-reader .hib-view')
  await expect(view.locator('.hib-thread-pane')).toBeVisible({ timeout: 20_000 })
  return view
}

/** Distance from the thread pane's end, in px. */
const fromEnd = (view: Locator) => view.locator('.hib-thread-scroll').evaluate(
  (el) => el.scrollHeight - el.scrollTop - el.clientHeight)

/** The turn at the top of the pane and its offset below the pane's top. */
const topTurn = (view: Locator) => view.locator('.hib-thread-scroll').evaluate((el) => {
  const top = el.getBoundingClientRect().top
  const turns = [...el.querySelectorAll('.hib-turn')]
  const i = turns.findIndex((t) => t.getBoundingClientRect().bottom > top + 1)
  return { i, offset: Math.round(turns[i].getBoundingClientRect().top - top) }
})

/** The newest turn is fully inside the pane, and the pane ends above the reply box. */
async function expectNewestInView(view: Locator, text: string | RegExp): Promise<void> {
  const last = view.locator('.hib-turn').last()
  await expect(last).toContainText(text, { timeout: 20_000 })
  await expect.poll(() => fromEnd(view), { timeout: 10_000 }).toBeLessThan(2)
  const pane = await view.locator('.hib-thread-scroll').boundingBox()
  const turn = await last.boundingBox()
  const composer = await view.locator('.hib-composer').boundingBox()
  expect(pane && turn && composer).toBeTruthy()
  expect(turn!.y + turn!.height).toBeLessThanOrEqual(pane!.y + pane!.height + 1)
  expect(pane!.y + pane!.height).toBeLessThanOrEqual(composer!.y + 1)
  await expect(view.locator('.hib-composer-input')).toBeInViewport()
}

/** The document pane's share of what the two panes hold. */
async function docShare(view: Locator): Promise<number> {
  const doc = (await view.locator('.hib-reader-body').boundingBox())!.height
  const pane = (await view.locator('.hib-thread-pane').boundingBox())!.height
  return doc / (doc + pane)
}

async function wheelOverThread(page: Page, view: Locator, dy: number): Promise<void> {
  const box = await view.locator('.hib-thread-scroll').boundingBox()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  for (let left = Math.abs(dy); left > 0; left -= 300) {
    await page.mouse.wheel(0, Math.sign(dy) * Math.min(300, left))
    await page.waitForTimeout(50)
  }
  await page.waitForTimeout(300)
}

test.describe.configure({ mode: 'serial' })

test('a long thread opens at its newest turn and never moves a reader who scrolled up', async ({ page, request }) => {
  test.setTimeout(180_000)
  const subject = `PW thread scroll ${NONCE}`
  const id = await seedLongLetter(request, subject)

  let releaseImage!: () => void
  const imageReleased = new Promise<void>((resolve) => { releaseImage = resolve })
  let imageRequested = false
  await page.route(`**${LATE_IMAGE}`, async (route) => {
    imageRequested = true
    await imageReleased
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: LATE_SVG })
  })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))

  await home(page)
  const view = await openLetter(page, subject)

  // Opening: the newest turn and the reply box, not the top of the digest.
  await expectNewestInView(view, 'Agent turn 30')
  expect(await docShare(view)).toBeCloseTo(0.4, 1)
  await expect(view.locator('.hib-thread-head')).toHaveText('Thread · 30')
  await page.screenshot({ path: `${SHOTS}/01-open-at-newest-${test.info().project.name}.png` })

  // Scrolled up, the image ABOVE the reader finishes loading: nothing moves.
  await wheelOverThread(page, view, -1200)
  const image = view.locator(`img[src$="${NONCE}.svg"]`)
  const paneTop = (await view.locator('.hib-thread-scroll').boundingBox())!.y
  for (let i = 0; i < 30 && !imageRequested; i++) await wheelOverThread(page, view, -300)
  expect(imageRequested, 'the lazy image was never requested').toBe(true)
  expect((await image.boundingBox())!.y, 'the image is not above the reader').toBeLessThan(paneTop - 50)
  expect(await fromEnd(view)).toBeGreaterThan(400)
  const before = await topTurn(view)
  expect(before.i).toBeGreaterThan(3)
  releaseImage()
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalHeight > 0)).toBe(true)
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.getBoundingClientRect().height)).toBeGreaterThan(100)
  await page.waitForTimeout(300)
  const afterImage = await topTurn(view)
  expect(afterImage.i).toBe(before.i)
  expect(Math.abs(afterImage.offset - before.offset)).toBeLessThanOrEqual(2)

  // A new reply while scrolled up: the reader stays, a button says so.
  await agentReply(request, id, { text: `Agent turn 31 arrives while you read ${NONCE}` })
  const newReply = view.locator('.hib-new-reply')
  await expect(newReply).toBeVisible({ timeout: 20_000 })
  await expect(view.locator('.hib-turn').last()).toContainText('Agent turn 31')
  const afterReply = await topTurn(view)
  expect(afterReply.i).toBe(before.i)
  expect(Math.abs(afterReply.offset - before.offset)).toBeLessThanOrEqual(2)
  await page.screenshot({ path: `${SHOTS}/02-new-reply-button-${test.info().project.name}.png` })
  await newReply.click()
  await expectNewestInView(view, 'Agent turn 31')
  await expect(newReply).toHaveCount(0)

  // At the end, the next reply is followed with no button.
  await agentReply(request, id, { text: `Agent turn 32 follows you ${NONCE}`, markdown: `### Turn 32\n\n${'- line\n'.repeat(8)}` })
  await expectNewestInView(view, 'Agent turn 32')
  await expect(newReply).toHaveCount(0)

  // Keys move the pane too, and are the reader's: PageUp is not undone.
  await view.locator('.hib-thread-scroll').focus()
  await page.keyboard.press('PageUp')
  await page.waitForTimeout(700)
  expect(await fromEnd(view)).toBeGreaterThan(100)
  await page.keyboard.press('End')
  await expect.poll(() => fromEnd(view)).toBeLessThan(2)

  // The human's own reply comes into view even from up the thread.
  await wheelOverThread(page, view, -1200)
  expect(await fromEnd(view)).toBeGreaterThan(400)
  const mine = `My own reply ${NONCE}`
  await view.locator('.hib-composer-input').fill(mine)
  await view.getByRole('button', { name: 'Send', exact: true }).click()
  await expectNewestInView(view, mine)

  // Dragging the divider down gives the document more room and keeps the end in view.
  const docBefore = (await view.locator('.hib-reader-body').boundingBox())!.height
  const bar = (await view.locator('.hib-thread-bar').boundingBox())!
  await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2)
  await page.mouse.down()
  await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2 + 120, { steps: 6 })
  await page.mouse.up()
  const docAfter = (await view.locator('.hib-reader-body').boundingBox())!.height
  expect(docAfter).toBeGreaterThan(docBefore + 80)
  await expectNewestInView(view, mine)
  await page.screenshot({ path: `${SHOTS}/03-divider-dragged-${test.info().project.name}.png` })

  // Close and open again: back at the newest turn, default split.
  await page.locator('.hib-reader-close').click()
  await expect(page.locator('.hib-reader')).toHaveCount(0)
  const again = page.locator('.hib-reader .hib-view')
  await page.locator('.notification-panel .hib-row').filter({ hasText: subject }).locator('.hib-subject').click()
  await expectNewestInView(again, mine)
  expect(await docShare(again)).toBeCloseTo(0.4, 1)

  expect(errors, errors.join(' | ')).toEqual([])
})

test('a letter with no thread keeps its single scroll', async ({ page, request }) => {
  const subject = `PW thread scroll none ${NONCE}`
  await send(request, { subject, type: 'info', markdown: `# Plain ${NONCE}\n\n${'A line.\n\n'.repeat(80)}` })
  await home(page)
  await page.getByRole('button', { name: /^Notifications/ }).click()
  const center = page.locator('.notification-panel')
  await center.locator('.nfc-rail-btn').filter({ hasText: 'Inbox' }).click()
  await center.locator('.hib-row').filter({ hasText: subject }).locator('.hib-subject').click()
  const view = page.locator('.hib-reader .hib-view')
  await expect(view.locator('.hib-md-body')).toContainText(`Plain ${NONCE}`)
  await expect(view.locator('.hib-thread-pane')).toHaveCount(0)
  // The document reaches the reply box: no empty pane under it.
  const doc = (await view.locator('.hib-reader-body').boundingBox())!
  const composer = (await view.locator('.hib-composer').boundingBox())!
  expect(Math.abs(doc.y + doc.height - composer.y)).toBeLessThanOrEqual(2)
  expect(await view.locator('.hib-reader-body').evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)

  // The first reply opens the conversation pane at that reply.
  const first = `First reply ${NONCE}`
  await view.locator('.hib-composer-input').fill(first)
  await view.getByRole('button', { name: 'Send', exact: true }).click()
  await expectNewestInView(view, first)
  // A one-turn thread is shown whole: its top is not cut off under the bar.
  const pane = (await view.locator('.hib-thread-scroll').boundingBox())!
  const turn = (await view.locator('.hib-turn').first().boundingBox())!
  expect(turn.y).toBeGreaterThanOrEqual(pane.y - 1)
  expect(await view.locator('.hib-thread-scroll').evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1)
})

/** The reader's box and its two panes, in px. */
const sizes = (view: Locator) => view.evaluate((el) => {
  const h = (s: string) => Math.round(el.querySelector(s)!.getBoundingClientRect().height)
  return { reader: Math.round(el.parentElement!.getBoundingClientRect().height), doc: h('.hib-reader-body'), pane: h('.hib-thread-pane') }
})

test('the reader keeps its size: no drift, and it comes back after the window shrinks', async ({ page, request }) => {
  // The report (2026-10-26): a letter shorter than the overlay's max-height kept
  // shrinking with no input, and stayed smaller after a resize, because the
  // split read the space from the overlay's own height, which the panes set.
  const subject = `PW thread scroll steady ${NONCE}`
  const wide = 'A wide line in a code block that runs past the reader. '.repeat(6)
  const id = await send(request, {
    subject, type: 'info',
    markdown: `**Status**: ${'a line of context. '.repeat(20)}\n\n\`\`\`\n${`${wide}\n`.repeat(14)}\`\`\`\n\n${'More of the letter. '.repeat(30)}`,
  })
  await agentReply(request, id, { text: `One agent turn: ${'the update in a few lines. '.repeat(12)}` })
  await home(page)
  const view = await openLetter(page, subject)
  await expectNewestInView(view, 'One agent turn')
  const first = await sizes(view)

  // Re-renders with no layout input: typing in the reply box, then clearing it.
  const input = view.locator('.hib-composer-input')
  await input.pressSequentially('abc')
  await input.fill('')
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(500)
    expect(await sizes(view)).toEqual(first)
  }

  const viewport = page.viewportSize()!
  await page.setViewportSize({ width: viewport.width, height: viewport.height - 160 })
  await expect.poll(async () => (await sizes(view)).reader).toBeLessThan(first.reader)
  await page.setViewportSize(viewport)
  await expect.poll(() => sizes(view)).toEqual(first)

  // A new reply grows the conversation; the overlay keeps its height.
  await agentReply(request, id, { text: `A second agent turn ${NONCE}` })
  await expectNewestInView(view, `A second agent turn ${NONCE}`)
  expect((await sizes(view)).reader).toBe(first.reader)
  await page.screenshot({ path: `${SHOTS}/steady-after-reply.png` })
})
