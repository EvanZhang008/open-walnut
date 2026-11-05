/**
 * A Claude prompt's choices on the desktop timeline card: the remembering options
 * the server builds from the CLI's suggestions (Allow for this session, Always
 * allow in this project), a deny that carries a note to the agent, and number
 * keys plus Enter (web/src/components/sessions/prompt-keys.ts).
 *
 * The prompts are injected on the page's own socket as the exact frames the
 * server broadcasts (`session:permission-request`), the session's record and
 * history are stubbed, and every answer POST is answered by the test, so
 * nothing here reaches the fixture's CLI or its shared board.
 */
import { expect, test, type Locator, type Page, type Route } from '@playwright/test'
import fs from 'node:fs/promises'
import { isolateUiPrefs } from './todo-panel-helpers'

const SID = 'pw-permission-keys-session'
const TASK_ID = 'pw-task-permission-keys'
const SHOTS = `${process.env.WALNUT_TASK_DIR ?? '/tmp'}/shots/permission-prompt-keys`

test.use({ viewport: { width: 1280, height: 860 } })

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
const panel = (page: Page) => page.locator(`.session-panel[data-session-id="${SID}"]`).first()
const cardOf = (page: Page, requestId: string) => panel(page).locator(`.permission-request-card[data-request-id="${requestId}"]`)

const RULE_OPTIONS = [
  { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
  { optionId: 'allow_session', kind: 'allow_always', name: 'Allow for this session', detail: 'Bash(npm test:*)' },
  { optionId: 'allow_always', kind: 'allow_always', name: 'Always allow in this project', detail: 'Bash(npm test:*)' },
  { optionId: 'reject_once', kind: 'reject_once', name: 'Deny', takesNote: true },
]

interface Answers { bodies: Record<string, unknown>[] }

async function shot(page: Page, name: string, requestId: string | Locator): Promise<void> {
  const dir = `${SHOTS}/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  await (typeof requestId === 'string' ? cardOf(page, requestId) : requestId).screenshot({ path: `${dir}/${name}.png` })
}

async function setup(page: Page): Promise<Answers> {
  const answers: Answers = { bodies: [] }
  await isolateUiPrefs(page)
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
  await page.route(`**/api/sessions/${SID}`, (route: Route) => route.fulfill({
    json: {
      session: {
        claudeSessionId: SID, taskId: TASK_ID, project: 'Walnut', process_status: 'running', mode: 'default',
        startedAt: iso(600_000), lastActiveAt: iso(2000), messageCount: 2, title: 'Prompt keys fixture',
      },
      pendingPermissions: [],
    },
  }))
  const messages = [
    { role: 'user', text: 'Run the test suite for the inventory module.', timestamp: iso(60_000), msgId: 'u-1' },
    { role: 'assistant', text: 'I will run the tests now.', timestamp: iso(59_000), msgId: 'a-1' },
  ]
  await page.route(`**/api/sessions/${SID}/history**`, (route: Route) =>
    route.fulfill({ json: { messages, cursor: messages.length, delta: false } }))
  await page.route(`**/api/sessions/${SID}/permission`, async (route: Route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    answers.bodies.push(body)
    await route.fulfill({ json: { status: 'resolved', requestId: body.requestId, allow: body.allow } })
  })
  await page.goto(`/?s1=${SID}`)
  await expect(panel(page)).toBeVisible({ timeout: 30_000 })
  await expect(panel(page).locator('[data-message-id="a-1"]')).toBeAttached({ timeout: 20_000 })
  return answers
}

async function injectNamed(page: Page, name: string, data: Record<string, unknown>): Promise<void> {
  await page.evaluate(({ n, d }) => {
    const ws = (window as unknown as { __promptWs?: WebSocket }).__promptWs
    if (!ws) throw new Error('socket not captured')
    ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name: n, data: d, seq: Date.now() }) }))
  }, { n: name, d: data })
}

const inject = (page: Page, data: Record<string, unknown>) => injectNamed(page, 'session:permission-request', data)

const bashAsk = (requestId: string, acpOptions?: unknown[]) => ({
  sessionId: SID, taskId: TASK_ID, requestId, toolName: 'Bash',
  input: { command: 'npm test', description: 'Run the tests' }, reason: 'This command requires approval',
  ...(acpOptions ? { acpOptions } : {}),
})

/** Focus off every field (the transcript is clicked: focus goes to <body>). */
async function clickTranscript(page: Page): Promise<void> {
  await panel(page).locator('[data-message-id="a-1"]').click()
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('BODY')
}

test.describe('Claude prompt choices on the desktop card', () => {
  test('the remembering options read as a numbered list with their rule; 2 then Enter allows for the session', async ({ page }) => {
    const answers = await setup(page)
    await inject(page, bashAsk('req-rule-1', RULE_OPTIONS))
    const card = cardOf(page, 'req-rule-1')
    await expect(card).toBeVisible()
    const rows = card.locator('.permission-request-choice')
    await expect(rows).toHaveCount(4)
    await expect(rows.nth(1)).toContainText('Allow for this session')
    await expect(rows.nth(1)).toContainText('Bash(npm test:*)')
    await expect(rows.nth(2)).toContainText('Always allow in this project')
    await expect(card.locator('.prompt-key')).toHaveText(['1', '2', '3', '4'])
    await expect(card.locator('.permission-request-keyhint')).toContainText('1–4 to choose, Enter to send')
    await shot(page, 'rule-pending', 'req-rule-1')

    await clickTranscript(page)
    // Enter before any pick sends nothing, and the hint says to pick first.
    await page.keyboard.press('Enter')
    await expect(card.locator('.permission-request-keyhint')).toContainText('Pick 1–4 first, then Enter')
    expect(answers.bodies).toEqual([])
    await page.keyboard.press('2')
    await expect(rows.nth(1)).toHaveClass(/is-picked/)
    await page.keyboard.press('3')
    await expect(rows.nth(2)).toHaveClass(/is-picked/)
    await expect(rows.nth(1)).not.toHaveClass(/is-picked/)
    await page.keyboard.press('2')
    // A digit only picks: nothing is sent before Enter.
    await page.waitForTimeout(200)
    expect(answers.bodies).toEqual([])
    await shot(page, 'rule-picked', 'req-rule-1')
    await page.keyboard.press('Enter')
    await expect.poll(() => answers.bodies.length).toBe(1)
    expect(answers.bodies[0]).toMatchObject({ requestId: 'req-rule-1', allow: true, optionId: 'allow_session' })
    expect(answers.bodies[0].message).toBeUndefined()
    // The settled card still names the rule it kept.
    await expect(card.locator('.permission-request-resolved')).toContainText('Allowed for this session')
    await expect(card.locator('.permission-request-resolved-detail')).toHaveText('Bash(npm test:*)')
    await shot(page, 'rule-settled', 'req-rule-1')
  })

  test('a note turns Deny into "Deny with note"; Enter in the note box sends it to the agent', async ({ page }) => {
    const answers = await setup(page)
    await inject(page, bashAsk('req-note-1', RULE_OPTIONS))
    const card = cardOf(page, 'req-note-1')
    const note = card.getByTestId('permission-note-input')
    await expect(note).toBeVisible()
    await note.fill('Use pnpm test instead, npm is not installed here')
    await expect(card.locator('[data-choice="reject_once"]')).toContainText('Deny with note')
    // Digits typed in the note are text, not a pick.
    await note.press('End')
    await note.type(' 2')
    await expect(card.locator('.is-picked')).toHaveCount(0)
    await shot(page, 'note-typed', 'req-note-1')
    await note.press('Enter')
    await expect.poll(() => answers.bodies.length).toBe(1)
    expect(answers.bodies[0]).toMatchObject({
      requestId: 'req-note-1', allow: false, optionId: 'reject_once',
      message: 'The user denied this tool call and said: Use pnpm test instead, npm is not installed here 2',
    })
    await expect(card.locator('.permission-request-resolved')).toHaveText('Denied with note: Use pnpm test instead, npm is not installed here 2')
    await shot(page, 'note-settled', 'req-note-1')
  })

  test('a prompt with no suggestion keeps Allow / Deny, numbered; its Deny takes a note too', async ({ page }) => {
    const answers = await setup(page)
    await inject(page, bashAsk('req-plain-1'))
    const card = cardOf(page, 'req-plain-1')
    // The same numbered list as a card with rules: no solid yes that looks chosen.
    await expect(card.locator('button.permission-request-btn')).toHaveCount(2)
    await expect(card.locator('.permission-request-choice')).toHaveCount(2)
    await expect(card.locator('.prompt-key')).toHaveText(['1', '2'])
    await expect(card.getByTestId('permission-note-input')).toBeVisible()
    await shot(page, 'plain-pending', 'req-plain-1')
    await clickTranscript(page)
    await page.keyboard.press('2')
    await page.keyboard.press('Enter')
    await expect.poll(() => answers.bodies.length).toBe(1)
    expect(answers.bodies[0]).toMatchObject({ requestId: 'req-plain-1', allow: false })
    expect(answers.bodies[0].optionId).toBeUndefined()
    await expect(card.locator('.permission-request-resolved')).toHaveText('Denied')
  })

  test('digits typed in the composer stay text and never pick', async ({ page }) => {
    const answers = await setup(page)
    await inject(page, bashAsk('req-comp-1', RULE_OPTIONS))
    const card = cardOf(page, 'req-comp-1')
    await expect(card).toBeVisible()
    const composer = panel(page).locator('textarea').first()
    await composer.click()
    await page.keyboard.type('2')
    await page.keyboard.press('Shift+Enter')
    await expect(card.locator('.is-picked')).toHaveCount(0)
    await expect(composer).toHaveValue(/^2/)
    expect(answers.bodies).toEqual([])
  })

  test('a question card: digits answer the current question and move on, Enter submits', async ({ page }) => {
    const answers = await setup(page)
    await inject(page, {
      sessionId: SID, taskId: TASK_ID, requestId: 'req-ask-1', toolName: 'AskUserQuestion',
      input: { questions: [
        { question: 'Which database?', header: 'Store', multiSelect: false, options: [{ label: 'SQLite', description: 'One file' }, { label: 'Postgres', description: 'A server' }] },
        { question: 'Which test runner?', header: 'Tests', multiSelect: false, options: [{ label: 'Vitest' }, { label: 'Jest' }, { label: 'Mocha' }] },
      ] },
    })
    const card = panel(page).locator('.ask-user-question-card')
    await expect(card).toBeVisible()
    await expect(card.locator('.ask-user-question').nth(0)).toHaveClass(/is-key-active/)
    await expect(card.locator('.permission-request-keyhint')).toContainText('1–2 to choose (question 1 of 2)')
    await clickTranscript(page)
    await page.keyboard.press('1')
    await expect(card.locator('.ask-user-question').nth(0).locator('.qp-option-selected')).toHaveText(/SQLite/)
    await expect(card.locator('.ask-user-question').nth(1)).toHaveClass(/is-key-active/)
    await page.keyboard.press('3')
    await expect(card.locator('.ask-user-question').nth(1).locator('.qp-option-selected')).toHaveText(/Mocha/)
    await expect(card.locator('.permission-request-keyhint')).toContainText('Enter: submit')
    await shot(page, 'ask-answered', card)
    await page.keyboard.press('Enter')
    await expect.poll(() => answers.bodies.length).toBe(1)
    expect(answers.bodies[0]).toMatchObject({
      requestId: 'req-ask-1', allow: true,
      answers: { 'Which database?': 'SQLite', 'Which test runner?': 'Mocha' },
    })
  })

  test('a digit pressed with focus on a button elsewhere brings focus to the card, so Enter sends the pick', async ({ page }) => {
    const answers = await setup(page)
    await inject(page, {
      sessionId: SID, taskId: TASK_ID, requestId: 'req-ask-focus', toolName: 'AskUserQuestion',
      input: { questions: [{ question: 'Which fruit?', header: 'Fruit', multiSelect: false, options: [{ label: 'Apple' }, { label: 'Banana' }, { label: 'Cherry' }] }] },
    })
    const card = panel(page).locator('.ask-user-question-card')
    await expect(card).toBeVisible()
    await page.waitForTimeout(500)
    // A control outside the card holds focus (a message's own button): Enter there would be its click.
    const outside = panel(page).locator('[data-message-id="a-1"] button').first()
    await outside.focus()
    await expect.poll(() => outside.evaluate((el) => el === document.activeElement)).toBe(true)
    await page.keyboard.press('2')
    await expect(card.locator('.qp-option-selected')).toHaveText(/Banana/)
    await expect.poll(() => card.evaluate((el) => el.contains(document.activeElement))).toBe(true)
    await page.keyboard.press('Enter')
    await expect.poll(() => answers.bodies.length).toBe(1)
    expect(answers.bodies[0]).toMatchObject({ requestId: 'req-ask-focus', allow: true, answers: { 'Which fruit?': 'Banana' } })
  })

  test('no toast covers a card already on screen; a prompt from a session off screen still toasts', async ({ page }) => {
    await setup(page)
    // The toaster reads the feed record (`notification:new`), the card the stream frame.
    const record = (sessionId: string, requestId: string, toolName: string, input: Record<string, unknown>) => ({
      id: `notif-${requestId}`, kind: 'permission', severity: 'warning', title: toolName, body: '', timestamp: Date.now(), read: false,
      dedupKey: `perm:${requestId}`, requestId, toolName, sessionId, input, acpOptions: RULE_OPTIONS, project: 'Walnut',
    })
    // By its title: the other toast's rules name `npm test` too.
    const toastsHere = page.locator('.notification-toaster .nfc-perm-toast').filter({ has: page.locator('.notification-toast-title', { hasText: /^Bash$/ }) })
    const strayHere = await toastsHere.count()
    await inject(page, bashAsk('req-toast-here', RULE_OPTIONS))
    await injectNamed(page, 'notification:new', record(SID, 'req-toast-here', 'Bash', { command: 'npm test' }))
    await expect(cardOf(page, 'req-toast-here')).toBeVisible()
    // The control: the same record for a session with no card here does toast.
    await injectNamed(page, 'notification:new', record('pw-permission-keys-elsewhere', 'req-toast-elsewhere', 'WebFetch', { url: 'https://example.com/docs' }))
    const toasts = page.locator('.notification-toaster .nfc-perm-toast')
    await expect(toasts.filter({ hasText: 'WebFetch' })).toBeVisible({ timeout: 15_000 })
    // None for the card on screen (asks other specs left on the shared server may toast too).
    await expect(toastsHere).toHaveCount(strayHere)
    // A list that names rules stays neutral until the person picks.
    const other = toasts.filter({ hasText: 'WebFetch' })
    await expect(other.locator('.nfc-perm-primary')).toHaveCount(0)
    await shot(page, 'toast-elsewhere', other)
  })

  test('a key pressed as the prompt arrives does not land on it', async ({ page }) => {
    const answers = await setup(page)
    await clickTranscript(page)
    await inject(page, bashAsk('req-arm-1', RULE_OPTIONS))
    // Same moment: the card is not yet armed for keys.
    await page.keyboard.press('1')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(150)
    expect(answers.bodies).toEqual([])
    await expect(cardOf(page, 'req-arm-1').locator('.is-picked')).toHaveCount(0)
  })
})
