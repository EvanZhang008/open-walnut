/**
 * Prompt cards in a phone's session timeline (spec 4.2, 4.4, 4.7; C31, C60,
 * C65, C70, C81, C82, C83, C84).
 *
 * The prompts are injected on the page's own socket as the exact frames the
 * server broadcasts (`session:permission-request`), the session's record and
 * history are stubbed, and every answer POST is answered by the test, so
 * nothing here reaches the fixture's CLI or its shared board.
 */
import { expect, test, type Locator, type Page, type Route } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { PHONE, findSmallTargets, setKeyboardInset } from './phone-helpers'

const SID = 'pw-question-recovery-session'
const TASK_ID = 'pw-task-question-recovery'
const SHOTS = '/tmp/mobile-web/phone-prompts'

test.use({
  viewport: PHONE.viewport,
  screen: PHONE.screen,
  deviceScaleFactor: PHONE.deviceScaleFactor,
  isMobile: true,
  hasTouch: true,
  userAgent: PHONE.userAgent,
})

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
const overlay = (page: Page) => page.locator(`.main-page-session-column.is-mobile-active .session-panel[data-session-id="${SID}"]`)
const timeline = (page: Page) => overlay(page).locator('.session-history')
const cards = (page: Page) => overlay(page).locator('.permission-request-card')
const pill = (page: Page) => overlay(page).getByTestId('phone-prompt-pill')

function historyOf(turns: number, longLast = false) {
  const msgs: Record<string, unknown>[] = []
  for (let i = 1; i <= turns; i++) {
    msgs.push({ role: 'user', text: `Request ${i} for the shed inventory`, timestamp: iso(90_000 - i * 1000), msgId: `u-${i}` })
    msgs.push({ role: 'assistant', text: `Working on request ${i}. `.repeat(longLast && i === turns ? 140 : 25), timestamp: iso(89_000 - i * 1000), msgId: `a-${i}` })
  }
  return msgs
}

interface Answers { bodies: Record<string, unknown>[]; fail: boolean }

async function setup(page: Page, turns = 2, open: { pending?: unknown[]; longLast?: boolean } = {}): Promise<Answers> {
  const answers: Answers = { bodies: [], fail: false }
  await isolateUiPrefs(page)
  await page.addInitScript(() => {
    try { localStorage.setItem('open-walnut-home-chat-visible', 'false') } catch { /* storage off */ }
    const Original = window.WebSocket
    class Captured extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        const holder = window as unknown as { __phoneWs?: WebSocket }
        if (new URL(String(url), location.href).pathname === '/ws' && !holder.__phoneWs) holder.__phoneWs = this
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
        startedAt: iso(600_000), lastActiveAt: iso(2000), messageCount: turns * 2, title: 'Question recovery fixture',
      },
      pendingPermissions: open.pending ?? [],
    },
  }))
  const messages = historyOf(turns, open.longLast)
  await page.route(`**/api/sessions/${SID}/history**`, (route: Route) =>
    route.fulfill({ json: { messages, cursor: messages.length, delta: false } }))
  await page.route(`**/api/sessions/${SID}/permission`, async (route: Route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    answers.bodies.push(body)
    if (answers.fail) { await route.fulfill({ status: 500, json: { error: 'unavailable' } }); return }
    await route.fulfill({ json: { status: 'resolved', requestId: body.requestId, allow: body.allow } })
  })
  await page.goto(`/?s1=${SID}`)
  await expect(overlay(page)).toBeVisible({ timeout: 30_000 })
  await expect(timeline(page).locator('[data-message-id="a-1"]')).toBeAttached({ timeout: 20_000 })
  return answers
}

async function inject(page: Page, name: string, data: unknown): Promise<void> {
  await page.evaluate(({ n, d }) => {
    const ws = (window as unknown as { __phoneWs?: WebSocket }).__phoneWs
    if (!ws) throw new Error('socket not captured')
    ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name: n, data: d, seq: Date.now() }) }))
  }, { n: name, d: data })
}

const ask = (requestId: string, toolName: string, input: Record<string, unknown>) =>
  ({ sessionId: SID, requestId, toolName, input, reason: `ask ${requestId}` })

const box = async (l: Locator) => (await l.boundingBox())!

/** 390 x 844, the spec's keyboard budget screen; resize before the keyboard is set. */
async function tallPhone(page: Page): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
}

/** Record, in the frame after a click, whether the card's buttons were disabled. */
async function watchClickFrame(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __clickFrames: Array<{ disabled: boolean[] }> }
    w.__clickFrames = []
    document.addEventListener('click', (e) => {
      const card = (e.target as HTMLElement).closest('.permission-request-card')
      if (!card) return
      requestAnimationFrame(() => {
        w.__clickFrames.push({ disabled: [...card.querySelectorAll('button.permission-request-btn')].map((b) => (b as HTMLButtonElement).disabled) })
      })
    }, true)
  })
}

test('Allow / Deny: side by side, armed after 500 ms, busy in the same frame, held, then settled (C31)', async ({ page }) => {
  const answers = await setup(page)
  await inject(page, 'session:permission-request', ask('req-phone-1', 'Bash', { command: 'ls -la ./garden', description: 'List the garden folder' }))
  const card = cards(page).filter({ hasText: 'ask req-phone-1' })
  await expect(card).toBeVisible({ timeout: 15_000 })
  const allow = card.getByRole('button', { name: 'Allow' })
  const deny = card.getByRole('button', { name: 'Deny' })
  // Unarmed for the first moments: disabled, 0.6.
  await expect(allow).toBeDisabled()
  await expect(allow).toBeEnabled({ timeout: 2000 })
  const a = await box(allow); const d = await box(deny)
  expect(a.height).toBeGreaterThanOrEqual(44)
  expect(d.height).toBeGreaterThanOrEqual(44)
  expect(Math.abs(a.y - d.y)).toBeLessThanOrEqual(1)
  expect(d.x).toBeGreaterThanOrEqual(a.x + a.width + 4)
  expect(d.x + d.width).toBeLessThanOrEqual(PHONE.viewport.width)
  // At the end of the timeline, never pinned.
  const pos = await card.evaluate((el) => getComputedStyle(el).position)
  expect(['static', 'relative']).toContain(pos)
  const isLast = await card.evaluate((el) => {
    const s = el.closest('.session-history')!
    const rows = [...s.querySelectorAll('[data-msg-role], .permission-request-card')]
    return rows[rows.length - 1] === el || rows.indexOf(el) >= rows.length - 2
  })
  expect(isLast).toBe(true)
  await page.screenshot({ path: `${SHOTS}/c31-pending-${test.info().project.name}.png` })

  // Fail first: the card stays, the buttons come back.
  answers.fail = true
  await watchClickFrame(page)
  const h0 = (await box(card)).height
  await allow.click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __clickFrames: Array<{ disabled: boolean[] }> }).__clickFrames.length)).toBeGreaterThan(0)
  const frame = await page.evaluate(() => (window as unknown as { __clickFrames: Array<{ disabled: boolean[] }> }).__clickFrames[0])
  expect(frame!.disabled.every(Boolean)).toBe(true)
  await expect(allow).toBeEnabled({ timeout: 10_000 })
  await expect(card).toContainText('Could not send that')
  expect(answers.bodies).toHaveLength(1)

  // Then succeed: the card holds its height, then collapses to its result.
  answers.fail = false
  await page.waitForTimeout(600)
  const t0 = await page.evaluate(() => performance.now())
  await allow.click()
  const held = await page.evaluate(async ({ start }) => {
    const el = [...document.querySelectorAll<HTMLElement>('.permission-request-card')].find((c) => c.textContent?.includes('ask req-phone-1'))!
    const h = el.getBoundingClientRect().height
    let changedAt = -1
    while (performance.now() - start < 1200) {
      await new Promise((r) => requestAnimationFrame(r))
      if (Math.abs(el.getBoundingClientRect().height - h) > 2 || el.textContent?.includes('Allowed')) { changedAt = performance.now() - start; break }
    }
    return { changedAt }
  }, { start: t0 })
  expect(held.changedAt).toBeGreaterThanOrEqual(250)
  await expect(card).toContainText('Allowed')
  expect((await box(card)).height).toBeLessThan(h0)
  expect(answers.bodies.filter((b) => b.requestId === 'req-phone-1')).toHaveLength(2)
})

test('two queued prompts: a double tap answers only the first; the second ignores taps while it settles in (C60)', async ({ page }) => {
  const answers = await setup(page)
  await inject(page, 'session:permission-request', ask('req-q-1', 'Bash', { command: 'du -sh ./seeds' }))
  await inject(page, 'session:permission-request', ask('req-q-2', 'Bash', { command: 'rm -rf ./seeds-old' }))
  const first = cards(page).filter({ hasText: 'ask req-q-1' })
  const second = cards(page).filter({ hasText: 'ask req-q-2' })
  await expect(second).toBeVisible({ timeout: 15_000 })
  const allow1 = first.getByRole('button', { name: 'Allow' })
  await expect(allow1).toBeEnabled({ timeout: 2000 })
  await allow1.scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  const a = await box(allow1)
  const x = a.x + a.width / 2
  const y = a.y + a.height / 2
  // The finger lands on the first card's Allow, then again 120 ms later.
  expect(await page.evaluate(({ px, py }) => document.elementFromPoint(px, py)?.closest('.permission-request-card')?.textContent?.includes('ask req-q-1') ?? false, { px: x, py: y })).toBe(true)
  await page.touchscreen.tap(x, y)
  await page.waitForTimeout(120)
  await page.touchscreen.tap(x, y)
  await page.waitForTimeout(900)
  expect(answers.bodies.map((b) => b.requestId)).toEqual(['req-q-1'])
  // The second card moved up when the first collapsed: re-armed.
  await expect(first).toContainText('Allowed')
  await inject(page, 'session:permission-request', ask('req-q-3', 'Bash', { command: 'touch ./seeds/marker' }))
  const third = cards(page).filter({ hasText: 'ask req-q-3' })
  await expect(third).toBeVisible({ timeout: 10_000 })
  const allow3 = third.getByRole('button', { name: 'Allow' })
  const b3 = await box(allow3)
  await page.touchscreen.tap(b3.x + b3.width / 2, b3.y + b3.height / 2)
  await page.waitForTimeout(200)
  expect(answers.bodies.map((b) => b.requestId)).not.toContain('req-q-3')
  await expect(allow3).toBeEnabled({ timeout: 2000 })
  await allow3.click()
  await expect.poll(() => answers.bodies.map((b) => b.requestId)).toContain('req-q-3')
})

test('a 20-line command shows its first and last lines, end included, without overflow (C84)', async ({ page }) => {
  await setup(page)
  const command = Array.from({ length: 19 }, (_, i) => `echo step-${i + 1}`).concat('echo end-marker').join('\n')
  await inject(page, 'session:permission-request', ask('req-long', 'Bash', { command }))
  const card = cards(page).filter({ hasText: 'ask req-long' })
  await expect(card).toBeVisible({ timeout: 15_000 })
  const preview = card.getByTestId('permission-command-preview')
  await expect(preview).toContainText('end-marker')
  await expect(preview).toContainText('echo step-1')
  await expect(preview).not.toContainText('echo step-10')
  await expect(preview.getByRole('button', { name: 'Show all (20 lines)' })).toBeVisible()
  const over = await card.evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(over).toBeLessThanOrEqual(1)
  await preview.getByRole('button', { name: 'Show all (20 lines)' }).click()
  await expect(preview).toContainText('echo step-10')
  await page.screenshot({ path: `${SHOTS}/c84-command-${test.info().project.name}.png` })
})

test('AskUserQuestion: full-width rows, check rows, a 16 px Other, Submit waits for every answer (C82)', async ({ page }) => {
  const answers = await setup(page)
  await inject(page, 'session:permission-request', ask('req-ask', 'AskUserQuestion', {
    questions: [
      { question: 'Which beds get compost?', header: 'Beds', multiSelect: true, options: [{ label: 'North bed' }, { label: 'South bed' }, { label: 'Herb box' }] },
      { question: 'When should it run?', header: 'Timing', multiSelect: false, options: [{ label: 'This weekend' }, { label: 'Next month' }] },
    ],
  }))
  const card = overlay(page).locator('.ask-user-question-card')
  await expect(card).toBeVisible({ timeout: 15_000 })
  const submit = card.getByRole('button', { name: 'Submit' })
  await expect(submit).toBeDisabled()
  await page.waitForTimeout(600)
  const width = (await box(card)).width
  const checks = card.getByRole('checkbox')
  await expect(checks).toHaveCount(3)
  for (const opt of await card.locator('.qp-option').all()) {
    const b = await box(opt)
    expect(b.height).toBeGreaterThanOrEqual(48)
    // R3-08: one row each, the mark beside the label, not stacked above it.
    expect(b.height).toBeLessThanOrEqual(60)
    expect(b.width).toBeGreaterThanOrEqual(width - 40)
    const mark = await box(opt.locator('.qp-option-mark'))
    const label = await box(opt.locator('.qp-option-label'))
    expect(mark.x + mark.width).toBeLessThanOrEqual(label.x)
    expect(Math.abs((mark.y + mark.height / 2) - (label.y + label.height / 2))).toBeLessThanOrEqual(6)
  }
  const other = card.locator('.qp-input').first()
  expect(await other.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16)
  await card.getByRole('checkbox', { name: 'North bed' }).click()
  await card.getByRole('checkbox', { name: 'Herb box' }).click()
  await expect(card.getByRole('checkbox', { name: 'North bed' })).toHaveAttribute('aria-checked', 'true')
  await expect(submit).toBeDisabled()
  await card.getByRole('radio', { name: 'This weekend' }).click()
  await expect(submit).toBeEnabled()
  // R3-08: the user is in the card (Submit just below the fold): no pill on its fields.
  await timeline(page).evaluate((el) => {
    const sb = [...el.querySelectorAll('.ask-user-question-card button')].pop()!.getBoundingClientRect()
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: 40 }))
    el.scrollTop += sb.bottom - el.getBoundingClientRect().bottom + 30
  })
  await page.waitForTimeout(300)
  await expect(pill(page)).toBeHidden()
  await submit.scrollIntoViewIfNeeded()
  const s = await box(submit)
  expect(s.height).toBeGreaterThanOrEqual(44)
  const c = await box(card)
  expect(c.y + c.height - (s.y + s.height)).toBeLessThanOrEqual(80)
  await page.screenshot({ path: `${SHOTS}/c82-question-${test.info().project.name}.png` })
  await submit.click()
  await expect.poll(() => answers.bodies.length).toBe(1)
  expect(answers.bodies[0]).toMatchObject({ requestId: 'req-ask', allow: true })
})

test('plan approval: 12 lines and Show all, Approve / Keep planning side by side, armed after 500 ms (C83)', async ({ page }) => {
  const answers = await setup(page)
  const plan = Array.from({ length: 30 }, (_, i) => `${i + 1}. Plant row ${i + 1}`).join('\n')
  await inject(page, 'session:permission-request', ask('req-plan', 'ExitPlanMode', { plan }))
  const card = cards(page).filter({ hasText: 'ask req-plan' })
  await expect(card).toBeVisible({ timeout: 15_000 })
  const preview = card.getByTestId('phone-plan-preview')
  await expect(preview).toContainText('12. Plant row 12')
  await expect(preview).not.toContainText('13. Plant row 13')
  const approve = card.getByRole('button', { name: 'Approve' })
  const keep = card.getByRole('button', { name: 'Keep planning' })
  // Unarmed: a tap in the first moments does nothing.
  const a0 = await box(approve)
  await page.touchscreen.tap(a0.x + a0.width / 2, a0.y + a0.height / 2)
  expect(answers.bodies).toHaveLength(0)
  await expect(approve).toBeEnabled({ timeout: 2000 })
  const a = await box(approve); const k = await box(keep)
  expect(a.height).toBeGreaterThanOrEqual(44)
  expect(k.height).toBeGreaterThanOrEqual(44)
  expect(Math.abs(a.y - k.y)).toBeLessThanOrEqual(1)
  // Show all opens the whole plan as its own layer; back closes it.
  await preview.getByRole('button', { name: 'Show all' }).click()
  const layer = page.getByTestId('phone-plan-layer')
  await expect(layer).toContainText('30. Plant row 30')
  await page.goBack()
  await expect(layer).toHaveCount(0)
  await expect(card).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/c83-plan-${test.info().project.name}.png` })
  await keep.click()
  await expect.poll(() => answers.bodies.length).toBe(1)
  expect(answers.bodies[0]).toMatchObject({ requestId: 'req-plan', allow: false })
})

test('a prompt out of view is a pill above the composer; two read 2 prompts waiting (C31 pill, C65, C70)', async ({ page }) => {
  await setup(page, 8)
  await inject(page, 'session:permission-request', ask('req-p-1', 'Bash', { command: 'ls ./tools' }))
  const first = cards(page).filter({ hasText: 'ask req-p-1' })
  await expect(first).toBeVisible({ timeout: 15_000 })
  // R3-01: the timeline lands on the whole card, its buttons above the composer.
  await expect.poll(async () => {
    const last = await box(first.locator('button').last())
    return last.y + last.height <= (await box(overlay(page).locator('.session-panel-input'))).y
  }, { timeout: 5_000 }).toBe(true)
  await expect(pill(page)).toBeHidden()
  // Read history above: the card leaves the view, the pill comes.
  // A reader's move: the input event first (a finger's pan sends one), then the scroll.
  await timeline(page).evaluate((el) => { el.dispatchEvent(new WheelEvent('wheel', { deltaY: -40 })); el.scrollTop = 0 })
  await expect(pill(page)).toHaveText('1 prompt waiting')
  const p = await box(pill(page))
  expect(p.height).toBeGreaterThanOrEqual(44)
  // Both pills: the prompt pill on top, 8 px apart, both above the composer.
  const jump = overlay(page).locator('.scroll-to-bottom-btn.visible')
  await expect(jump).toBeVisible()
  const j = await box(jump)
  const composerTop = (await box(overlay(page).locator('.session-panel-input'))).y
  expect(p.y + p.height).toBeLessThanOrEqual(j.y)
  expect(Math.abs(j.y - (p.y + p.height) - 8)).toBeLessThanOrEqual(1)
  expect(j.y + j.height).toBeLessThanOrEqual(composerTop)
  await page.screenshot({ path: `${SHOTS}/c70-pills-${test.info().project.name}.png` })
  await inject(page, 'session:permission-request', ask('req-p-2', 'Bash', { command: 'ls ./seeds' }))
  await expect(pill(page)).toHaveText('2 prompts waiting')
  await pill(page).click()
  await expect.poll(() => first.evaluate((el) => {
    const b = el.closest('.session-history')!.getBoundingClientRect(); const r = el.getBoundingClientRect()
    return r.bottom > b.top && r.top < b.bottom
  })).toBe(true)
  // Keyboard up: the card never pins, only the pill says it waits.
  await tallPhone(page)
  await setKeyboardInset(page, 336)
  await expect(pill(page)).toBeVisible()
  for (const c of await cards(page).all()) {
    expect(['static', 'relative']).toContain(await c.evaluate((el) => getComputedStyle(el).position))
  }
  const budget = await box(timeline(page))
  expect(budget.height).toBeGreaterThanOrEqual(200)
})

test('R3-01: opening a session that waits on a prompt lands on the whole card, not the long turn above it', async ({ page }) => {
  await setup(page, 8, { longLast: true, pending: [ask('req-open', 'Bash', { command: 'ls ./tools' })] })
  const card = cards(page).filter({ hasText: 'ask req-open' })
  await expect(card).toBeVisible({ timeout: 15_000 })
  // Past the open's settle window (the turn-start landing runs for 2 s).
  await page.waitForTimeout(2500)
  const last = await box(card.locator('button').last())
  const composerTop = (await box(overlay(page).locator('.session-panel-input'))).y
  const t = await box(timeline(page))
  expect(last.y).toBeGreaterThanOrEqual(t.y)
  expect(last.y + last.height).toBeLessThanOrEqual(composerTop)
  await expect(pill(page)).toBeHidden()
  await page.screenshot({ path: `${SHOTS}/r3-01-open-${test.info().project.name}.png` })
})

test('N30: the Latest pill never sits on a prompt card a finger needs', async ({ page }) => {
  await setup(page, 8)
  await inject(page, 'session:permission-request', ask('req-n30', 'Bash', { command: 'ls ./tools' }))
  const card = cards(page).filter({ hasText: 'ask req-n30' })
  await expect(card).toBeVisible({ timeout: 15_000 })
  let steppedAside = 0
  // A little above the bottom: the card is still on screen and the jump pill shows.
  for (const up of [40, 80, 120, 160, 220, 300]) {
    await timeline(page).evaluate((el, d) => {
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: -40 }))
      el.scrollTop = el.scrollHeight - el.clientHeight - d
    }, up)
    await page.waitForTimeout(300)
    const res = await overlay(page).evaluate((root) => {
      const jump = root.querySelector<HTMLElement>('.scroll-to-bottom-btn.visible')
      if (!jump) return 'no pill'
      if (jump.hasAttribute('data-over-prompt')) return getComputedStyle(jump).pointerEvents === 'none' ? 'aside' : 'aside but tappable'
      const p = jump.getBoundingClientRect()
      for (const c of root.querySelectorAll('[data-prompt-pending="true"]')) {
        const r = c.getBoundingClientRect()
        if (r.bottom > p.top && r.top < p.bottom && r.right > p.left && r.left < p.right) return 'covers the card'
      }
      return 'clear'
    })
    expect(['no pill', 'aside', 'clear'], `${up} px above the bottom`).toContain(res)
    if (res === 'aside') steppedAside += 1
  }
  // The geometry did put the pill over the card at least once, so the rule was exercised.
  expect(steppedAside).toBeGreaterThan(0)
  // Far from the card, the pill is back.
  await timeline(page).evaluate((el) => { el.dispatchEvent(new WheelEvent('wheel', { deltaY: -40 })); el.scrollTop = 0 })
  await expect(overlay(page).locator('.scroll-to-bottom-btn.visible:not([data-over-prompt])')).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/n30-pill-${test.info().project.name}.png` })
})

/** A composer popover: above the composer, under the top bar, finger rows. */
async function expectAboveKeyboard(page: Page, popover: Locator, rows: Locator, label: string): Promise<void> {
  await expect(popover, label).toBeVisible({ timeout: 10_000 })
  const p = await box(popover)
  const bar = await box(page.locator('.phone-topbar'))
  const composerTop = (await box(overlay(page).locator('.session-panel-input'))).y
  expect(p.y, `${label}: top under the bar`).toBeGreaterThanOrEqual(bar.y + bar.height - 1)
  expect(p.y + p.height, `${label}: bottom above the composer`).toBeLessThanOrEqual(composerTop + 2)
  expect(p.y + p.height, `${label}: bottom above the keyboard`).toBeLessThanOrEqual(844 - 336 + 2)
  const n = Math.min(await rows.count(), 6)
  expect(n).toBeGreaterThan(0)
  for (let i = 0; i < n; i++) {
    const r = rows.nth(i)
    if (!(await r.isVisible())) continue
    expect((await box(r)).height, `${label}: row ${i}`).toBeGreaterThanOrEqual(43.5)
  }
}

test('keyboard up: the slash palette, the task picker and the model menu open upward, clear of the bar (C81)', async ({ page }) => {
  await setup(page)
  await tallPhone(page)
  await setKeyboardInset(page, 336)
  const input = overlay(page).locator('.chat-input-textarea')
  await expect(input).toBeVisible()
  expect((await box(input)).y + (await box(input)).height).toBeLessThanOrEqual(844 - 336)
  await input.click()
  await input.fill('/')
  await expectAboveKeyboard(page, overlay(page).locator('.command-palette-wrap'), overlay(page).locator('.command-palette-item'), 'slash palette')
  await page.screenshot({ path: `${SHOTS}/c81-slash-${test.info().project.name}.png` })
  await input.fill('')
  await input.pressSequentially('@')
  const mention = page.locator('.mention-palette')
  await expectAboveKeyboard(page, mention, mention.locator('.mention-row'), 'task picker')
  await input.fill('')
  await page.keyboard.press('Escape')
  const pill = overlay(page).locator('.composer-model-pill').first()
  if (await pill.isVisible()) {
    await pill.click()
    const menu = page.locator('.model-picker').first()
    await expectAboveKeyboard(page, menu, menu.locator('.model-picker-row, .provider-rail-item'), 'model menu')
  } else {
    test.info().annotations.push({ type: 'model menu', description: 'no model pill on this record (no model control)' })
  }
  const small = await findSmallTargets(page, '.session-panel-input')
  test.info().annotations.push({ type: 'composer small targets', description: JSON.stringify(small) })
})
