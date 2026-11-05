/**
 * "Always allow in this project" whose settings file the host cannot write: the server
 * holds the answer (422 with its reason). The card stays open, says why in the server's
 * words, and drops the pick so Enter does not send it again; Allow once then answers.
 *
 * Page-local: the prompt is injected on the page's own socket, the session's record and
 * history are stubbed, and every answer POST is answered here.
 */
import { expect, test, type Page, type Route } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'

const SID = 'pw-perm-save-held'
const REQ = 'req-perm-save-held'
const REASON = 'Could not save the rule: .claude/settings.local.json cannot be written. Allow once or for this session instead.'
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()

test.use({ viewport: { width: 1280, height: 800 } })

async function inject(page: Page, name: string, data: Record<string, unknown>): Promise<void> {
  await page.evaluate(({ n, d }) => {
    const ws = (window as unknown as { __heldWs?: WebSocket }).__heldWs
    if (!ws) throw new Error('socket not captured')
    ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name: n, data: d, seq: Date.now() }) }))
  }, { n: name, d: data })
}

test('a project rule the host cannot save keeps the card open and says why', async ({ page }) => {
  test.setTimeout(90_000)
  await isolateUiPrefs(page)
  await page.addInitScript(() => {
    try { localStorage.setItem('open-walnut-home-chat-visible', 'false') } catch { /* storage off */ }
    const Original = window.WebSocket
    class Captured extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        const holder = window as unknown as { __heldWs?: WebSocket }
        if (new URL(String(url), location.href).pathname === '/ws' && !holder.__heldWs) holder.__heldWs = this
      }
    }
    for (const key of Object.getOwnPropertyNames(Original)) {
      if (key === 'prototype' || key === 'length' || key === 'name') continue
      try { (Captured as unknown as Record<string, unknown>)[key] = (Original as unknown as Record<string, unknown>)[key] } catch { /* read-only */ }
    }
    window.WebSocket = Captured as typeof WebSocket
  })
  const posts: Array<{ optionId?: string }> = []
  await page.route(`**/api/sessions/${SID}`, (route: Route) => route.fulfill({
    json: {
      session: { claudeSessionId: SID, taskId: `task-${SID}`, project: 'Walnut', process_status: 'running', mode: 'default', startedAt: iso(600_000), lastActiveAt: iso(2000), messageCount: 1, title: 'Held rule' },
      pendingPermissions: [],
    },
  }))
  await page.route(`**/api/sessions/${SID}/history**`, (route: Route) => route.fulfill({
    json: { messages: [{ role: 'user', text: 'Run the tests.', timestamp: iso(60_000), msgId: `u-${SID}` }], cursor: 1, delta: false },
  }))
  await page.route(`**/api/sessions/${SID}/permission`, async (route: Route) => {
    const body = route.request().postDataJSON() as { requestId: string; allow: boolean; optionId?: string }
    posts.push({ optionId: body.optionId })
    if (body.optionId === 'allow_always') await route.fulfill({ status: 422, json: { error: REASON } })
    else await route.fulfill({ json: { status: 'resolved', requestId: body.requestId, allow: body.allow } })
  })
  await page.goto(`/sessions?id=${SID}`)
  await expect(page.locator(`.session-panel[data-session-id="${SID}"]`).first()).toBeVisible({ timeout: 30_000 })
  await inject(page, 'session:permission-request', {
    sessionId: SID, taskId: `task-${SID}`, requestId: REQ, toolName: 'Bash', input: { command: 'npm test' },
    acpOptions: [
      { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'allow_session', kind: 'allow_always', name: 'Allow for this session', detail: 'Bash: this exact command' },
      { optionId: 'allow_always', kind: 'allow_always', name: 'Always allow in this project', detail: 'Bash: this exact command', savedTo: '.claude/settings.local.json' },
      { optionId: 'reject_once', kind: 'reject_once', name: 'Deny', takesNote: true },
    ],
  })
  const card = page.locator('.permission-request-card[data-prompt-pending="true"]')
  await expect(card).toHaveCount(1)
  await page.waitForTimeout(600)
  const always = card.locator('button[data-choice="allow_always"]')
  await always.click()
  await always.click()
  await expect.poll(() => posts.map((p) => p.optionId)).toEqual(['allow_always'])
  await expect(card.getByRole('alert')).toHaveText(REASON)
  await expect(card).toHaveCount(1)
  // The pick went with the failure: the choice no longer says what a second click saves.
  await expect(always).not.toContainText('Click again')
  await card.locator('button[data-choice="allow_once"]').click()
  await expect.poll(() => posts.map((p) => p.optionId)).toEqual(['allow_always', 'allow_once'])
})
