/**
 * Design 1, "Worked for" (2026-11-11, the user picked it from the session chat
 * designs: "recommend is good, but no line needed", and the messages sent and
 * received "also as one of new type"). A finished turn reads as the person's
 * message, one quiet line "Worked for 2m 16s · Received 1 message · Sent 2 · Ran
 * 3 tools", and the answer. Opened, the turn is ONE flat list: every step the same
 * row (a line icon, what it did, what it touched), the message sent and the one
 * received among them, the session's words on the way one line each. A row opens
 * to its detail in place. A step the person refused stands above the fold, red. A
 * running turn is one live line with the step it is on under it, and a permission
 * prompt stays outside the fold, where it can be answered.
 *
 * History and the WS are mocked (session-live-turn-fold.spec.ts harness), so the
 * live turn is really live. The run records a video (the acceptance clip).
 */
import { test, expect, type Page } from '@playwright/test'
import { createEnvelopeKit } from '../../../src/core/peers/envelope-kit'

const SESSION_ID = 'pw-worked-for'
const SHOTS = process.env.WORKED_FOR_SHOTS ?? '/tmp/worked-for'

test.use({ video: { mode: 'on', size: { width: 1280, height: 900 } } })

async function injectEvent(page: Page, name: string, data: unknown) {
  await page.evaluate(({ name, data }) => {
    const ws = (window as any).__capturedWs as WebSocket | undefined
    if (!ws) throw new Error('No captured WebSocket')
    ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name, data, seq: Date.now() }) }))
  }, { name, data })
}

const kit = createEnvelopeKit()
const received = kit.buildWalnutMessage({
  kind: 'peer-note',
  attrs: { from: 'Stability ledger [abcd1234]', title: 'WF_RECV the memory check is done' },
  body: 'WF_RECV_BODY The page holds 1.6 GB on your data; the heap is mostly chat history.',
})
const at = (s: number) => new Date(Date.UTC(2026, 10, 11, 6, 0, s)).toISOString()
const sendCommand = `walnut tools call task_send '{"to":"mw1abcde-1234","title":"WF_SENT Measure the page","text":"WF_SENT_BODY Please measure the real page on his data and fix the heaviest item first."}'`
const HISTORY = [
  { role: 'user', text: 'WF_ASK for the side bar of the task, show the parent title after Worker', timestamp: at(0) },
  { role: 'assistant', text: '', msgId: 'wf-a1', timestamp: at(20), thinking: 'I am looking at the side bar screenshot first.', tools: [
    { name: 'Read', toolUseId: 'wf-t1', input: { file_path: '/repo/web/src/components/tasks/TaskSidebar.tsx' }, result: 'export function TaskSidebar() {}' },
    { name: 'Bash', toolUseId: 'wf-t2', input: { command: 'git log --oneline -3' }, result: 'WF_OUTPUT a1b2c3 fix(sidebar): parent title\nd4e5f6 test(sidebar)' },
    { name: 'Bash', toolUseId: 'wf-t3', input: { command: sendCommand }, result: '{"ok":true,"delivery":"queued"}' },
  ] },
  { role: 'user', text: received, timestamp: at(40) },
  { role: 'assistant', text: 'WF_WORDS It is the same deliverable, so I reopen it with force.', msgId: 'wf-a2', timestamp: at(60) },
  { role: 'assistant', text: '', msgId: 'wf-a3', timestamp: at(70), tools: [
    { name: 'Grep', toolUseId: 'wf-t4', input: { pattern: 'WorkerPill' }, result: 'No matches found', isError: true },
    { name: 'Bash', toolUseId: 'wf-t5', input: { command: 'walnut tools call task_create @c.json', description: 'Create task for Claude Code default auto mode' }, result: 'Permission for this action was denied by the Claude Code auto mode classifier.', isError: true },
  ] },
  { role: 'assistant', text: 'WF_ANSWER Both things are handed to the side bar task; nothing has landed yet.', msgId: 'wf-a4', timestamp: at(136) },
  { role: 'user', text: 'WF_ASK2 and the Mac extension one?', timestamp: at(200) },
]

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const OrigWebSocket = window.WebSocket
    window.WebSocket = class PatchedWebSocket extends OrigWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        const socketUrl = new URL(String(url), window.location.href)
        if (socketUrl.pathname === '/ws' && !(window as any).__capturedWs) {
          (window as any).__capturedWs = this
          const origSend = this.send.bind(this)
          this.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
            try {
              const parsed = JSON.parse(data as string)
              if (parsed.type === 'req' && parsed.method === 'session:stream-subscribe') {
                setTimeout(() => {
                  this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'res', id: parsed.id, ok: true, payload: { blocks: [], isStreaming: false } }) }))
                }, 10)
                return
              }
            } catch { /* non-JSON */ }
            origSend(data)
          }
        }
      }
    } as any
    for (const key of Object.getOwnPropertyNames(OrigWebSocket)) {
      if (key !== 'prototype' && key !== 'length' && key !== 'name') {
        try { (window.WebSocket as any)[key] = (OrigWebSocket as any)[key] } catch { /* read-only */ }
      }
    }
  })
  await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
    const since = new URL(route.request().url()).searchParams.get('since')
    if (since !== null) return route.fulfill({ json: { messages: [], cursor: HISTORY.length, delta: true } })
    return route.fulfill({ json: { messages: HISTORY, cursor: HISTORY.length, delta: false } })
  })
  await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback()
    await route.fulfill({ json: { session: {
      claudeSessionId: SESSION_ID, taskId: 'pw-task-worked-for', project: 'Walnut', process_status: 'running',
      mode: 'bypass', startedAt: at(0), lastActiveAt: new Date().toISOString(), messageCount: HISTORY.length, title: 'Worked for session',
    } } })
  })
})

/** A pause the clip can be watched at; nothing waits on it. */
const beat = (page: Page, ms = 700) => page.waitForTimeout(ms)

for (const theme of ['light', 'dark'] as const) {
  test(`a finished turn is one line, opens to one list of rows, and a running turn is one live line (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(`/sessions?id=${SESSION_ID}`)
    await page.evaluate((t) => { document.documentElement.dataset.theme = t }, theme)
    await page.waitForFunction(() => (window as any).__capturedWs?.readyState === WebSocket.OPEN, null, { timeout: 10000 })
    const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
    const history = panel.locator('.session-history')
    await expect(history).toContainText('WF_ANSWER Both things', { timeout: 15000 })
    await beat(page)

    // Finished: the person's words, one line, the answer.
    const fold = history.locator('[data-testid="turn-fold"]').first()
    await expect(fold).toHaveAttribute('data-open', 'false')
    await expect(fold.locator('[data-testid="turn-fold-lead"]')).toHaveText(/^Worked for 2m 16s/)
    await expect(fold.locator(':scope > .tool-run-toggle .tool-run-label')).toHaveText('Received 1 message · Sent 2 · Ran 3 tools')
    // No rule under the line, and nothing of the work outside it but the refused step.
    expect(await fold.locator(':scope > .tool-run-toggle').evaluate((el) => getComputedStyle(el).borderBottomWidth)).toBe('0px')
    const outside = await history.evaluate((h) => Array.from(h.querySelectorAll('.provenance-card, .chat-tool-block')).filter((c) => !c.closest('[data-testid="turn-fold"]')).length)
    expect(outside).toBe(0)
    const lifted = history.locator('[data-testid="lifted-step"]')
    await expect(lifted).toHaveCount(1)
    await expect(lifted).toContainText('Create task for Claude Code default auto mode')
    await expect(lifted).toContainText('Permission for this action was denied')
    await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${theme}-1-collapsed.png` }).catch(() => {})

    // Opened: one flat list, every step one row with its own icon.
    await fold.locator(':scope > .tool-run-toggle').click()
    await expect(fold).toHaveAttribute('data-open', 'true')
    await beat(page)
    const body = fold.locator(':scope > .process-fold-body')
    // No second "Ran N tools" line to open inside it.
    await expect(body.locator('.tool-run-flat')).not.toHaveCount(0)
    const icons = await body.evaluate((b) => Array.from(b.querySelectorAll('.chat-tool-block-header, .provenance-card, .tool-run-row--step > .tool-run-toggle'))
      .map((row) => row.querySelector('svg.step-icon')?.getAttribute('data-step-icon') ?? 'none'))
    expect(icons).toEqual(expect.arrayContaining(['eye', 'terminal', 'send', 'received', 'message', 'alert', 'thought']))
    expect(icons).not.toContain('none')
    // A step is a row, not a message: no copy, pin or time line under a card or a call.
    expect(await body.evaluate((b) => Array.from(b.querySelectorAll('.session-msg-actions')).filter((x) => !x.closest('[data-testid="folded-words"]')).length)).toBe(0)
    // The sent and the received message are rows of the same height as a command's.
    const heights = await body.evaluate((b) => ({
      sent: (b.querySelector('.provenance-card[data-envelope-kind="outbound"]') as HTMLElement).getBoundingClientRect().height,
      recv: (b.querySelector('.provenance-card:not([data-envelope-kind="outbound"])') as HTMLElement).getBoundingClientRect().height,
      cmd: (b.querySelector('.chat-tool-block-bash > .chat-tool-block-header') as HTMLElement).getBoundingClientRect().height,
    }))
    expect(Math.abs(heights.sent - heights.cmd)).toBeLessThanOrEqual(4)
    expect(Math.abs(heights.recv - heights.cmd)).toBeLessThanOrEqual(4)
    await expect(body.locator('.provenance-card[data-envelope-kind="outbound"]').first()).toContainText('WF_SENT Measure the page')
    await expect(body.locator('.provenance-card:not([data-envelope-kind="outbound"])')).toContainText('WF_RECV the memory check is done')
    await expect(body.locator('[data-testid="folded-words"]')).toContainText('WF_WORDS It is the same deliverable')
    await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${theme}-2-opened.png` }).catch(() => {})

    // One row opened to its detail: a command's output, then a sent message's text.
    const cmd = body.locator('.chat-tool-block-bash', { hasText: 'git log --oneline -3' })
    await cmd.locator('.chat-tool-block-header').click()
    await expect(cmd).toContainText('WF_OUTPUT a1b2c3')
    await beat(page)
    const sent = body.locator('.provenance-card[data-envelope-kind="outbound"]').first()
    await sent.locator('.op-card-main').click()
    await expect(sent).toContainText('WF_SENT_BODY Please measure the real page')
    await beat(page)
    await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${theme}-3-row-opened.png` }).catch(() => {})
    await sent.locator('.op-card-main').click()
    await cmd.locator('.chat-tool-block-header').click()
    await expect(cmd).not.toContainText('WF_OUTPUT a1b2c3')
    await beat(page, 400)

    // Collapsed again.
    await fold.locator(':scope > .tool-run-toggle').click()
    await expect(fold).toHaveAttribute('data-open', 'false')
    await expect(body).toHaveCount(0)
    await beat(page)

    // A running turn: one live line, the step it is on under it.
    await injectEvent(page, 'session:thinking-delta', { sessionId: SESSION_ID, delta: 'WF_LIVE_THOUGHT I should check the extension build first.', msgId: 'wf-live-1' })
    await injectEvent(page, 'session:tool-use', { sessionId: SESSION_ID, toolName: 'Bash', toolUseId: 'wf-live-t1', input: { command: 'make extension' } })
    // The live line is the turn's run (or its fold, when it took in a message): either way one
    // line, and under it what it does now.
    const peek = history.locator('[data-testid="run-peek"], [data-testid="turn-fold-peek"]').last()
    await expect(peek).toContainText('make extension', { timeout: 10000 })
    await expect(peek).toContainText('WF_LIVE_THOUGHT I should check')
    await beat(page, 1200)
    await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${theme}-4-running.png` }).catch(() => {})

    // A permission prompt stays outside the fold, where it is answered.
    await injectEvent(page, 'session:tool-result', { sessionId: SESSION_ID, toolUseId: 'wf-live-t1', result: 'ok' })
    await injectEvent(page, 'session:permission-request', { sessionId: SESSION_ID, requestId: 'wf-perm-1', toolName: 'Bash', toolUseId: 'wf-live-t2', input: { command: 'rm -rf build/extension' } })
    const card = panel.locator('.permission-request-card').first()
    await expect(card).toBeVisible({ timeout: 10000 })
    expect(await card.evaluate((c) => !!c.closest('[data-testid="turn-fold"]'))).toBe(false)
    await beat(page, 1200)
    await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${theme}-5-permission.png` }).catch(() => {})
  })
}
