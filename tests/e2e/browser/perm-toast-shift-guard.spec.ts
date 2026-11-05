/**
 * Two permission toasts stacked: the one at the stack's anchored edge is answered,
 * leaves, and the other one slides into its place. A click that lands there in the moment it moves
 * (a double click, or a second click meant for the toast that left) must not
 * answer the other session's ask. Once the toast has sat still a beat, a click
 * answers it as usual.
 *
 * Page-local: both asks are injected on this page's own WebSocket and every
 * permission POST is answered by a route, so nothing reaches the shared server.
 */
import { expect, test, type Page } from '@playwright/test'

const NONCE = `shift-${Date.now().toString(36)}`
const ASKS = [
  { sessionId: `pw-shift-a-${NONCE}`, requestId: `req-shift-a-${NONCE}`, command: `echo first-${NONCE}` },
  { sessionId: `pw-shift-b-${NONCE}`, requestId: `req-shift-b-${NONCE}`, command: `echo second-${NONCE}` },
]

test.use({ viewport: { width: 1280, height: 800 } })

async function injectEvent(page: Page, name: string, data: unknown): Promise<void> {
  await page.evaluate(({ eventName, eventData }) => {
    const ws = (window as unknown as { __capturedShiftWs?: WebSocket }).__capturedShiftWs
    if (!ws) throw new Error('test WebSocket was not captured')
    ws.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'event', name: eventName, data: eventData, seq: Date.now() }),
    }))
  }, { eventName: name, eventData: data })
}

function record(ask: typeof ASKS[number]) {
  return {
    id: `notif-${ask.requestId}`,
    kind: 'permission',
    severity: 'warning',
    title: 'Bash',
    body: ask.command,
    timestamp: Date.now(),
    read: false,
    dedupKey: `perm:${ask.requestId}`,
    requestId: ask.requestId,
    toolName: 'Bash',
    sessionId: ask.sessionId,
    input: { command: ask.command },
    host: 'shift-guard-host',
    sessionTitle: `Shift guard ${ask.requestId}`,
    project: 'Walnut',
  }
}

test('a toast that slides up under the pointer ignores the click that was meant for the one above', async ({ page, baseURL }) => {
  test.setTimeout(90_000)
  await page.addInitScript(() => {
    const original = window.WebSocket
    window.WebSocket = class ShiftTestWebSocket extends original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        const holder = window as unknown as { __capturedShiftWs?: WebSocket }
        if (new URL(String(url), window.location.href).pathname === '/ws' && !holder.__capturedShiftWs) holder.__capturedShiftWs = this
      }
    } as typeof WebSocket
    for (const key of Object.getOwnPropertyNames(original)) {
      if (key === 'prototype' || key === 'length' || key === 'name') continue
      try { (window.WebSocket as unknown as Record<string, unknown>)[key] = (original as unknown as Record<string, unknown>)[key] } catch { /* read-only */ }
    }
  })
  const answered: string[] = []
  await page.route('**/api/sessions/pw-shift-*/permission', async (route) => {
    const body = route.request().postDataJSON() as { requestId: string; allow: boolean }
    answered.push(body.requestId)
    await route.fulfill({ json: { status: 'resolved', requestId: body.requestId, allow: body.allow } })
  })

  await page.goto(`${baseURL}/`)
  await page.waitForLoadState('networkidle')
  for (const ask of ASKS) {
    await injectEvent(page, 'session:permission-request', { sessionId: ask.sessionId, requestId: ask.requestId, toolName: 'Bash', input: { command: ask.command } })
    await injectEvent(page, 'notification:new', record(ask))
  }
  const toastOf = (ask: typeof ASKS[number]) => page.locator('.nfc-perm-toast').filter({ hasText: ask.command })
  await expect(toastOf(ASKS[0])).toBeVisible({ timeout: 20_000 })
  await expect(toastOf(ASKS[1])).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(800)

  // The toast nearer the stack's anchored edge is answered; the other one slides into its place
  // (up into a top-anchored stack, down into a bottom-anchored one).
  const boxes = await Promise.all(ASKS.map(async (a) => (await toastOf(a).boundingBox())!))
  const [top, bottom] = boxes[0].y < boxes[1].y ? [ASKS[0], ASKS[1]] : [ASKS[1], ASKS[0]]
  const viewportHeight = page.viewportSize()!.height
  const bottomAnchored = Math.max(...boxes.map((b) => b.y + b.height)) > viewportHeight - 100
  const [gone, mover] = bottomAnchored ? [bottom, top] : [top, bottom]
  const allow = toastOf(gone).getByRole('button', { name: 'Allow', exact: true })
  const box = (await allow.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.click(x, y)
  await expect.poll(() => answered).toEqual([gone.requestId])

  // The moment the moving toast's Allow is under the pointer, click again.
  await page.waitForFunction(({ px, py, cmd }) => {
    const el = document.elementFromPoint(px, py)
    return !!el?.closest('.nfc-perm-toast')?.textContent?.includes(cmd) && !!el.closest('button')
  }, { px: x, py: y, cmd: mover.command }, { timeout: 30_000, polling: 'raf' })
  await page.mouse.click(x, y)
  await page.waitForTimeout(300)
  expect(answered, 'the click meant for the toast that left did not answer the one that took its place').toEqual([gone.requestId])
  await expect(toastOf(mover).getByRole('button', { name: 'Allow', exact: true })).toBeEnabled()

  // Sat still a beat, the same toast answers a click.
  await page.waitForTimeout(500)
  await page.mouse.click(x, y)
  await expect.poll(() => answered).toEqual([gone.requestId, mover.requestId])
})

test('a new ask that lands under a resting pointer ignores the click meant for the toast that was there', async ({ page, baseURL }) => {
  test.setTimeout(90_000)
  await page.addInitScript(() => {
    const original = window.WebSocket
    window.WebSocket = class ShiftTestWebSocket extends original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        const holder = window as unknown as { __capturedShiftWs?: WebSocket }
        if (new URL(String(url), window.location.href).pathname === '/ws' && !holder.__capturedShiftWs) holder.__capturedShiftWs = this
      }
    } as typeof WebSocket
    for (const key of Object.getOwnPropertyNames(original)) {
      if (key === 'prototype' || key === 'length' || key === 'name') continue
      try { (window.WebSocket as unknown as Record<string, unknown>)[key] = (original as unknown as Record<string, unknown>)[key] } catch { /* read-only */ }
    }
  })
  const answered: string[] = []
  await page.route('**/api/sessions/pw-shift-*/permission', async (route) => {
    const body = route.request().postDataJSON() as { requestId: string; allow: boolean }
    answered.push(body.requestId)
    await route.fulfill({ json: { status: 'resolved', requestId: body.requestId, allow: body.allow } })
  })
  const nonce = `land-${Date.now().toString(36)}`
  const asks = ['a', 'b', 'c'].map((k) => ({ sessionId: `pw-shift-${k}-${nonce}`, requestId: `req-shift-${k}-${nonce}`, command: `echo ${k}-${nonce}` }))
  await page.goto(`${baseURL}/`)
  await page.waitForLoadState('networkidle')
  const send = async (ask: typeof asks[number]) => {
    await injectEvent(page, 'session:permission-request', { sessionId: ask.sessionId, requestId: ask.requestId, toolName: 'Bash', input: { command: ask.command } })
    await injectEvent(page, 'notification:new', record(ask))
  }
  const toastOf = (ask: typeof asks[number]) => page.locator('.nfc-perm-toast').filter({ hasText: ask.command })
  await send(asks[0])
  await send(asks[1])
  await expect(toastOf(asks[0])).toBeVisible({ timeout: 20_000 })
  await expect(toastOf(asks[1])).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(800)
  // The pointer rests on the top toast's Allow, reading it.
  const top = page.locator('.notification-toaster .nfc-perm-toast').first()
  const topText = (await top.textContent()) ?? ''
  const upper = asks.find((a) => topText.includes(a.command))!
  const allowTop = top.getByRole('button', { name: 'Allow', exact: true })
  await expect(allowTop).toBeVisible()
  const box = (await allowTop.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.move(x + 1, y)
  // A third ask arrives; once whatever is under the pointer is a different toast than before, click.
  await send(asks[2])
  await page.waitForFunction(({ px, py, cmd }) => {
    const el = document.elementFromPoint(px, py)
    const toast = el?.closest('.nfc-perm-toast')
    return !!toast && !toast.textContent?.includes(cmd) && !!el!.closest('button')
  }, { px: x, py: y, cmd: upper.command }, { timeout: 15_000, polling: 'raf' }).catch(() => { /* the stack kept the same toast there */ })
  const under = await page.evaluate(({ px, py }) => document.elementFromPoint(px, py)?.closest('.nfc-perm-toast')?.textContent ?? '', { px: x, py: y })
  await page.mouse.click(x, y)
  await page.waitForTimeout(300)
  if (!under.includes(upper.command)) {
    expect(answered, 'a toast that just arrived under the pointer did not take the click').toEqual([])
  } else {
    // The same toast stayed under the pointer: it never moved, so the click answers it.
    expect(answered).toEqual([upper.requestId])
  }
})

test('a toast that grows from its own Details still answers the next click at once', async ({ page, baseURL }) => {
  test.setTimeout(90_000)
  await page.addInitScript(() => {
    const original = window.WebSocket
    window.WebSocket = class ShiftTestWebSocket extends original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        const holder = window as unknown as { __capturedShiftWs?: WebSocket }
        if (new URL(String(url), window.location.href).pathname === '/ws' && !holder.__capturedShiftWs) holder.__capturedShiftWs = this
      }
    } as typeof WebSocket
    for (const key of Object.getOwnPropertyNames(original)) {
      if (key === 'prototype' || key === 'length' || key === 'name') continue
      try { (window.WebSocket as unknown as Record<string, unknown>)[key] = (original as unknown as Record<string, unknown>)[key] } catch { /* read-only */ }
    }
  })
  const answered: string[] = []
  await page.route('**/api/sessions/pw-shift-*/permission', async (route) => {
    const body = route.request().postDataJSON() as { requestId: string; allow: boolean }
    answered.push(body.requestId)
    await route.fulfill({ json: { status: 'resolved', requestId: body.requestId, allow: body.allow } })
  })
  const nonce = `grow-${Date.now().toString(36)}`
  const ask = { sessionId: `pw-shift-g-${nonce}`, requestId: `req-shift-g-${nonce}`, command: `echo ${nonce} ${'long-argument '.repeat(40)}` }
  await page.goto(`${baseURL}/`)
  await page.waitForLoadState('networkidle')
  await injectEvent(page, 'session:permission-request', { sessionId: ask.sessionId, requestId: ask.requestId, toolName: 'Bash', input: { command: ask.command } })
  await injectEvent(page, 'notification:new', record(ask))
  const toast = page.locator('.nfc-perm-toast').filter({ hasText: nonce })
  await expect(toast).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(800)
  const before = (await toast.boundingBox())!
  await toast.getByTestId('notice-details').click()
  await expect(toast.getByTestId('notice-details')).toHaveAttribute('aria-expanded', 'true')
  const after = (await toast.boundingBox())!
  expect(after.height, 'the command opened in place').toBeGreaterThan(before.height)
  // Its own growth is the person's doing, not a row sliding under the pointer: no hold.
  await expect(toast).not.toHaveAttribute('data-settling', '')
  await toast.getByRole('button', { name: 'Deny', exact: true }).click()
  await expect.poll(() => answered).toEqual([ask.requestId])
})
