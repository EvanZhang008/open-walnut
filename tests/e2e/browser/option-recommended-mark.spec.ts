/**
 * A question option an agent marked "(Recommended)" shows its words without the mark and
 * "Recommended" at the row's right end, as the phone and the Threads card show it; the answer
 * sent back is still the label as the agent wrote it (2026-11-26).
 *
 * Two of the web's question renderers: the session's question card (PromptCards) and the
 * notification center's answer form (PermissionAnswerForm). The prompt is dispatched on the
 * page's own socket and the feed is served by a route stub, so nothing reaches a real session.
 */
import { expect, test, type Locator, type Page, type Route } from '@playwright/test'
import fs from 'node:fs/promises'
import { isolateUiPrefs } from './todo-panel-helpers'

const SID = 'pw-option-rec-session'
const TASK_ID = 'pw-task-option-rec'
const SHOTS = `${process.env.WALNUT_TASK_DIR ?? '/tmp'}/shots/option-recommended`

test.use({ viewport: { width: 1512, height: 945 } })

const QUESTIONS = [{
  question: 'Which database should the inventory service use?', header: 'Store', multiSelect: false,
  options: [
    { label: 'Postgres (Recommended)', description: 'A server, already run for orders' },
    { label: 'SQLite', description: 'One file beside the service' },
  ],
}]
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()

async function shot(target: Locator, name: string): Promise<void> {
  await fs.mkdir(SHOTS, { recursive: true })
  await target.screenshot({ path: `${SHOTS}/${name}.png` })
}

/** The mark CSS draws after the label, or '' when there is none. */
const markOf = (label: Locator) => label.evaluate((el) => getComputedStyle(el, '::after').content.replace(/^"|"$/g, ''))

async function captureSocket(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try { localStorage.setItem('open-walnut-home-chat-visible', 'false') } catch { /* storage off */ }
    const Original = window.WebSocket
    class Captured extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        const holder = window as unknown as { __promptWs?: WebSocket }
        if (new URL(String(url), location.href).pathname === '/ws' && !holder.__promptWs) holder.__promptWs = this
      }
    }
    for (const key of Object.getOwnPropertyNames(Original)) {
      if (key === 'prototype' || key === 'length' || key === 'name') continue
      try { (Captured as unknown as Record<string, unknown>)[key] = (Original as unknown as Record<string, unknown>)[key] } catch { /* read-only */ }
    }
    window.WebSocket = Captured as typeof WebSocket
  })
}

/** A session panel with a stubbed session, its own socket captured; returns the answers it posts. */
async function openSession(page: Page): Promise<{ panel: Locator; bodies: Record<string, unknown>[] }> {
  await isolateUiPrefs(page)
  await captureSocket(page)
  await page.route(`**/api/sessions/${SID}`, (route: Route) => route.fulfill({
    json: {
      session: {
        claudeSessionId: SID, taskId: TASK_ID, project: 'Walnut', process_status: 'running', mode: 'default',
        startedAt: iso(600_000), lastActiveAt: iso(2000), messageCount: 2, title: 'Inventory store',
      },
      pendingPermissions: [],
    },
  }))
  const messages = [
    { role: 'user', text: 'Pick a store for the inventory service.', timestamp: iso(60_000), msgId: 'u-1' },
    { role: 'assistant', text: 'I have two candidates; one question first.', timestamp: iso(59_000), msgId: 'a-1' },
  ]
  await page.route(`**/api/sessions/${SID}/history**`, (route: Route) => route.fulfill({ json: { messages, cursor: messages.length, delta: false } }))
  const bodies: Record<string, unknown>[] = []
  await page.route(`**/api/sessions/${SID}/permission`, async (route: Route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    bodies.push(body)
    await route.fulfill({ json: { status: 'resolved', requestId: body.requestId, allow: true } })
  })
  await page.goto(`/?s1=${SID}`)
  const panel = page.locator(`.session-panel[data-session-id="${SID}"]`).first()
  await expect(panel.locator('[data-message-id="a-1"]')).toBeAttached({ timeout: 30_000 })
  return { panel, bodies }
}

async function prompt(page: Page, data: Record<string, unknown>): Promise<void> {
  await page.evaluate((d) => {
    const ws = (window as unknown as { __promptWs?: WebSocket }).__promptWs
    if (!ws) throw new Error('socket not captured')
    ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name: 'session:permission-request', data: d, seq: Date.now() }) }))
  }, { sessionId: SID, taskId: TASK_ID, ...data })
}

const fillOf = (el: Locator) => el.evaluate((e) => getComputedStyle(e).backgroundColor)
/** The family's primary key fill on this page, from a probe key. */
const primaryFill = (page: Page) => page.evaluate(() => {
  const probe = document.createElement('button')
  probe.className = 'btn btn-primary'
  probe.style.cssText = 'position:absolute;visibility:hidden'
  document.body.appendChild(probe)
  const c = getComputedStyle(probe).backgroundColor
  probe.remove()
  return c
})

test('the session question card shows the recommended option without "(Recommended)", marked at the right and filled', async ({ page }) => {
  const { panel, bodies } = await openSession(page)
  await prompt(page, { requestId: 'req-option-rec', toolName: 'AskUserQuestion', input: { questions: QUESTIONS } })

  const card = panel.locator('.ask-user-question-card')
  await expect(card).toBeVisible()
  await shot(page.locator('body'), 'session-card-window')
  await shot(card, 'session-card')
  const best = card.locator('.qp-option').first()
  await expect(best).not.toContainText('(Recommended)')
  await expect(best.locator('.option-label')).toHaveText('Postgres')
  expect(await markOf(best.locator('.option-label'))).toBe('Recommended')
  expect(await markOf(card.locator('.qp-option').nth(1).locator('.option-label'))).not.toBe('Recommended')
  // The mark sits at the row's right end, past the words.
  const [row, label] = await Promise.all([best.boundingBox(), best.locator('.option-label').boundingBox()])
  expect(label!.x + label!.width).toBeGreaterThan(row!.x + row!.width - 30)
  // It stands out in the main colour before any pick; the other row does not.
  expect(await fillOf(best)).toBe(await primaryFill(page))
  expect(await fillOf(card.locator('.qp-option').nth(1))).not.toBe(await primaryFill(page))

  // Another row picked: the recommended one gives up its fill (its mark stays), so the pick reads strongest.
  await card.locator('.qp-option').nth(1).click()
  expect(await fillOf(best)).not.toBe(await primaryFill(page))
  expect(await markOf(best.locator('.option-label'))).toBe('Recommended')
  await best.click()
  await page.mouse.move(0, 0) // off the row: its hover fill is darker
  expect(await fillOf(best)).toBe(await primaryFill(page))
  await card.getByRole('button', { name: /^Submit/ }).click()
  await expect.poll(() => bodies.length).toBe(1)
  expect(bodies[0]).toMatchObject({ requestId: 'req-option-rec', allow: true, answers: { [QUESTIONS[0]!.question]: 'Postgres (Recommended)' } })
})

test('the notification center answer form shows the same mark, and answers with the label as written', async ({ page }) => {
  await isolateUiPrefs(page)
  const t = Date.now()
  const feed = [{
    id: 'nfc-option-rec', kind: 'permission', severity: 'warning', title: 'AskUserQuestion', body: QUESTIONS[0]!.question,
    timestamp: t - 5_000, read: false, dedupKey: 'perm:pw-option-rec', requestId: 'pw-option-rec',
    toolName: 'AskUserQuestion', sessionId: SID, input: { questions: QUESTIONS },
    host: 'nfc-host', sessionTitle: 'PW option rec session', project: 'Walnut',
  }]
  await page.routeWebSocket(/\/ws(?:\?|$)/, (ws) => { const server = ws.connectToServer(); server.onMessage((m) => { if (!String(m).includes('notification:')) ws.send(m) }) })
  await page.route('**/api/notifications', (route) => route.fulfill({ json: { feed, unreadCount: 1 } }))
  await page.route('**/api/notifications/mark-read', (route) => route.fulfill({ json: { unreadCount: 0 } }))
  let submitted: Record<string, unknown> | undefined
  await page.route(`**/api/sessions/${SID}/permission`, async (route) => {
    submitted = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({ json: { status: 'resolved', requestId: 'pw-option-rec', allow: true } })
  })
  await page.goto('/')
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Notifications' }).click()
  const panel = page.locator('.notification-panel')
  const opts = panel.locator('.nfc-answer-opt')
  await expect(opts).toHaveCount(2)
  await shot(page.locator('body'), 'notification-window')
  await shot(panel, 'notification-panel')
  await expect(opts.first()).not.toContainText('(Recommended)')
  await expect(opts.first().locator('.option-label')).toHaveText('Postgres')
  expect(await markOf(opts.first().locator('.option-label'))).toBe('Recommended')
  expect(await fillOf(opts.first())).toBe(await primaryFill(page))
  expect(await fillOf(opts.nth(1))).not.toBe(await primaryFill(page))
  await opts.first().click()
  await panel.getByRole('button', { name: 'Submit' }).click()
  await expect.poll(() => submitted).toMatchObject({ allow: true, answers: { [QUESTIONS[0]!.question]: 'Postgres (Recommended)' } })
})

const RULE_CHOICES = [
  { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
  { optionId: 'allow_session', kind: 'allow_always', name: 'Allow for this session', detail: 'Bash(npm test:*)' },
  { optionId: 'reject_once', kind: 'reject_once', name: 'Deny', takesNote: true },
]

/** Each choice row's box, its words' box and its number key's top (null without one). */
const rowBoxes = (rows: Locator) => rows.evaluateAll((els) => els.map((el) => {
  const r = el.getBoundingClientRect()
  const w = el.querySelector('.permission-choice-text, .permission-choice-label')!.getBoundingClientRect()
  const k = el.querySelector('.prompt-key')?.getBoundingClientRect()
  const label = el.querySelector('.permission-choice-label')!.getBoundingClientRect()
  return { top: r.top, bottom: r.bottom, wordsTop: w.top, wordsBottom: w.bottom, labelTop: label.top, keyTop: k ? k.top : null }
}))

/** The words sit in the row's middle, and a number key on the first line of the words. */
async function expectWordsCentred(rows: Locator, what: string): Promise<void> {
  for (const [i, b] of (await rowBoxes(rows)).entries()) {
    const above = b.wordsTop - b.top
    const below = b.bottom - b.wordsBottom
    expect(Math.abs(above - below), `${what} row ${i + 1}: words ${above.toFixed(1)} px under the top, ${below.toFixed(1)} px over the bottom`).toBeLessThanOrEqual(3)
    if (b.keyTop !== null) expect(Math.abs(b.keyTop - b.labelTop), `${what} row ${i + 1}: the key is on the words' first line`).toBeLessThanOrEqual(4)
  }
}

test.describe('at a phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } })
  test("a rules list's one-line choices keep their words in the middle of the 44 px row", async ({ page }) => {
    const { panel } = await openSession(page)
    await prompt(page, { requestId: 'req-rules-phone', toolName: 'Bash', input: { command: 'npm test', description: 'Run the tests' }, reason: 'This command requires approval', acpOptions: RULE_CHOICES })
    const card = panel.locator('.permission-request-card[data-request-id="req-rules-phone"]')
    await expect(card).toBeVisible()
    await card.scrollIntoViewIfNeeded()
    await shot(card, 'rules-card-390')
    const rows = card.locator('.permission-request-choice')
    await expect(rows).toHaveCount(3)
    await expectWordsCentred(rows, '390')
  })
})

test("a Claude prompt's list that names rules still fills its main action, Allow once", async ({ page }) => {
  const { panel } = await openSession(page)
  await prompt(page, {
    requestId: 'req-rules', toolName: 'Bash', input: { command: 'npm test', description: 'Run the tests' }, reason: 'This command requires approval',
    acpOptions: [
      { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'allow_session', kind: 'allow_always', name: 'Allow for this session', detail: 'Bash(npm test:*)' },
      { optionId: 'reject_once', kind: 'reject_once', name: 'Deny', takesNote: true },
    ],
  })
  const card = panel.locator('.permission-request-card[data-request-id="req-rules"]')
  await expect(card).toBeVisible()
  await shot(card, 'rules-card')
  const rows = card.locator('.permission-request-choice')
  await expect(rows).toHaveCount(3)
  await expect(card.locator('.permission-request-choice.btn-primary')).toHaveCount(1)
  await expect(rows.first()).toHaveClass(/btn-primary/)
  expect(await fillOf(rows.first())).toBe(await primaryFill(page))
  expect(await fillOf(rows.nth(1))).not.toBe(await primaryFill(page))
  // Its words read on the fill, not in the text colour.
  expect(await rows.first().locator('.permission-choice-label').evaluate((e) => getComputedStyle(e).color)).toBe(await rows.first().evaluate((e) => getComputedStyle(e).color))
  await expectWordsCentred(rows, '1512')
})

/** The gap above and below the words of each row, read from the text itself. */
const textGaps = (rows: Locator) => rows.evaluateAll((els) => els.map((el) => {
  const r = el.getBoundingClientRect()
  const range = document.createRange()
  range.selectNodeContents(el)
  const rects = [...range.getClientRects()].filter((x) => x.height > 0 && x.width > 0)
  return { above: Math.min(...rects.map((x) => x.top)) - r.top, below: r.bottom - Math.max(...rects.map((x) => x.bottom)) }
}))

test("the notification center's rules list keeps each choice's words in its middle", async ({ page }) => {
  await isolateUiPrefs(page)
  const feed = [{
    id: 'nfc-rules-mid', kind: 'permission', severity: 'warning', title: 'Bash', body: 'npm test',
    timestamp: Date.now() - 5_000, read: false, dedupKey: 'perm:pw-rules-mid', requestId: 'pw-rules-mid',
    toolName: 'Bash', sessionId: SID, input: { command: 'npm test' }, acpOptions: RULE_CHOICES,
    host: 'nfc-host', sessionTitle: 'PW option rec session', project: 'Walnut',
  }]
  await page.routeWebSocket(/\/ws(?:\?|$)/, (ws) => { const server = ws.connectToServer(); server.onMessage((m) => { if (!String(m).includes('notification:')) ws.send(m) }) })
  await page.route('**/api/notifications', (route) => route.fulfill({ json: { feed, unreadCount: 1 } }))
  await page.route('**/api/notifications/mark-read', (route) => route.fulfill({ json: { unreadCount: 0 } }))
  await page.goto('/')
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Notifications' }).click()
  const panel = page.locator('.notification-panel')
  const rows = panel.locator('.notification-perm-btn')
  await expect(rows).toHaveCount(3)
  await shot(panel, 'notification-rules')
  for (const [i, g] of (await textGaps(rows)).entries()) {
    expect(Math.abs(g.above - g.below), `panel row ${i + 1}: words ${g.above.toFixed(1)} px under the top, ${g.below.toFixed(1)} px over the bottom`).toBeLessThanOrEqual(2)
  }
})
