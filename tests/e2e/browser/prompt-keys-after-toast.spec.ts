/**
 * Two panes, each with a pending prompt card, so number keys go to neither until
 * the person picks one. A toast from a third session sits over the right pane;
 * clicking its Deny must not make that pane the one keys answer once the toast
 * leaves: a digit then would pick a choice on a prompt nobody looked at.
 *
 * Page-local: prompts are injected on the page's own socket, the sessions'
 * records and history are stubbed, and every answer POST is answered here.
 */
import { expect, test, type Page, type Route } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'

const PANES = ['pw-keys-toast-left', 'pw-keys-toast-right']
const OFF_SCREEN = 'pw-keys-toast-elsewhere'
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()

test.use({ viewport: { width: 1280, height: 800 } })

async function inject(page: Page, name: string, data: Record<string, unknown>): Promise<void> {
  await page.evaluate(({ n, d }) => {
    const ws = (window as unknown as { __keysWs?: WebSocket }).__keysWs
    if (!ws) throw new Error('socket not captured')
    ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name: n, data: d, seq: Date.now() }) }))
  }, { n: name, d: data })
}

test('a click on a toast over a pane does not hand that pane the number keys', async ({ page }) => {
  test.setTimeout(90_000)
  await isolateUiPrefs(page)
  await page.addInitScript(() => {
    try { localStorage.setItem('open-walnut-home-chat-visible', 'false') } catch { /* storage off */ }
    const Original = window.WebSocket
    class Captured extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        const holder = window as unknown as { __keysWs?: WebSocket }
        if (new URL(String(url), location.href).pathname === '/ws' && !holder.__keysWs) holder.__keysWs = this
      }
    }
    for (const key of Object.getOwnPropertyNames(Original)) {
      if (key === 'prototype' || key === 'length' || key === 'name') continue
      try { (Captured as unknown as Record<string, unknown>)[key] = (Original as unknown as Record<string, unknown>)[key] } catch { /* read-only */ }
    }
    window.WebSocket = Captured as typeof WebSocket
  })
  const answered: string[] = []
  for (const sid of [...PANES, OFF_SCREEN]) {
    await page.route(`**/api/sessions/${sid}`, (route: Route) => route.fulfill({
      json: {
        session: { claudeSessionId: sid, taskId: `task-${sid}`, project: 'Walnut', process_status: 'running', mode: 'default', startedAt: iso(600_000), lastActiveAt: iso(2000), messageCount: 1, title: `Keys ${sid}` },
        pendingPermissions: [],
      },
    }))
    await page.route(`**/api/sessions/${sid}/history**`, (route: Route) => route.fulfill({
      json: { messages: [{ role: 'user', text: 'Run the tests.', timestamp: iso(60_000), msgId: `u-${sid}` }], cursor: 1, delta: false },
    }))
    await page.route(`**/api/sessions/${sid}/permission`, async (route: Route) => {
      const body = route.request().postDataJSON() as { requestId: string; allow: boolean }
      answered.push(body.requestId)
      await route.fulfill({ json: { status: 'resolved', requestId: body.requestId, allow: body.allow } })
    })
  }
  await page.goto(`/?s1=${PANES[0]}&s2=${PANES[1]}`)
  const pane = (sid: string) => page.locator(`.session-panel[data-session-id="${sid}"]`).first()
  for (const sid of PANES) await expect(pane(sid)).toBeVisible({ timeout: 30_000 })

  for (const sid of PANES) {
    await inject(page, 'session:permission-request', { sessionId: sid, taskId: `task-${sid}`, requestId: `req-${sid}`, toolName: 'Bash', input: { command: `echo ${sid}` } })
  }
  const cards = page.locator('.permission-request-card[data-prompt-pending="true"]')
  await expect(cards).toHaveCount(2)

  // A third session's ask toasts (its pane is not open) at the top right, over the right pane.
  const elsewhere = { sessionId: OFF_SCREEN, requestId: `req-${OFF_SCREEN}`, toolName: 'Bash', input: { command: `echo ${OFF_SCREEN}` } }
  await inject(page, 'session:permission-request', elsewhere)
  await inject(page, 'notification:new', {
    id: `notif-${elsewhere.requestId}`, kind: 'permission', severity: 'warning', title: 'Bash', body: elsewhere.input.command,
    timestamp: Date.now(), read: false, dedupKey: `perm:${elsewhere.requestId}`, requestId: elsewhere.requestId, toolName: 'Bash',
    sessionId: OFF_SCREEN, input: elsewhere.input, sessionTitle: 'Keys elsewhere', project: 'Walnut',
  })
  const toast = page.locator('.nfc-perm-toast').filter({ hasText: elsewhere.input.command })
  await expect(toast).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(600)
  await toast.getByRole('button', { name: 'Deny', exact: true }).click()
  await expect.poll(() => answered).toEqual([elsewhere.requestId])
  // The toast says what went, then leaves; the pointer has not moved since.
  await expect(toast).toHaveCount(0, { timeout: 10_000 })

  await page.keyboard.press('1')
  await page.waitForTimeout(300)
  await expect(page.locator('.permission-request-card .is-picked')).toHaveCount(0)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(300)
  expect(answered, 'no pane took the keys from a click on the toast').toEqual([elsewhere.requestId])

  // The person points at the right pane's card: now its keys answer it.
  await pane(PANES[1]).locator('.permission-request-card').hover()
  await page.keyboard.press('1')
  await expect(pane(PANES[1]).locator('.permission-request-card .is-picked')).toHaveCount(1)
})
