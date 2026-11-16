/**
 * The notice stack sits at the top of the window, centered, one width, whatever the page beside it
 * has open (web/src/components/common/corner-stack.tsx). 2026-11-16, the user: "also somehow the
 * notificaiton pill will adopt the width based on other pannel on the right, I think not need, just
 * show like noticiaton overlap on the top nice unified, just like IOS noticficaiton pelase".
 *
 * A toast is raised on Home and measured with Home's right side empty and with a session column
 * open there, at two window widths: its place and width never follow that panel. The source half
 * (the stack reads no panel or composer geometry) is tests/web/corner-stack-guard.test.ts.
 */
import { expect, test, type Page, type WebSocketRoute } from '@playwright/test'
import { pausePageClock } from './page-clock'

const SHOTS = process.env.NOTICE_TOP_SHOTS || '/tmp/notice-stack-top'

async function routeSocket(page: Page): Promise<() => WebSocketRoute | null> {
  let socket: WebSocketRoute | null = null
  await page.routeWebSocket(/\/ws(?:\?|$)/, (route) => { socket = route; route.connectToServer() })
  return () => socket
}

function agentErrorEvent(agentId: string, error: string): string {
  return JSON.stringify({ type: 'event', name: 'agent:error', data: { agentId, error }, seq: -1 })
}

/** The stack's box and the right-hand panel's width, in one read. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const r = document.querySelector('[data-testid="corner-stack"]')!.getBoundingClientRect()
    const right = document.querySelector('.main-page-right')?.getBoundingClientRect()
    const column = document.querySelector('.main-page-session-column[data-column-id]')?.getBoundingClientRect()
    return {
      top: Math.round(r.top), left: r.left, width: Math.round(r.width), vw: window.innerWidth,
      offCenter: Math.abs(r.left + r.width / 2 - window.innerWidth / 2),
      right: Math.round(right?.width ?? 0), column: Math.round(column?.width ?? 0),
    }
  })
}

test.describe.configure({ timeout: 90_000 })

for (const width of [1280, 1100]) {
  test(`a toast on Home stays at the top center, 440px wide, with the right panel empty or holding a session (${width}px)`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 800 })
    const sock = await routeSocket(page)
    await page.route('**/api/quiet*', (r) => r.fulfill({ json: { quiet: false } }))
    await page.goto('/')
    await expect(page.locator('.app-shell').first()).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => sock() !== null, { timeout: 30_000 }).toBe(true)
    // The toast's own timer stands still while it is measured.
    await page.clock.install()
    await pausePageClock(page)

    sock()!.send(agentErrorEvent('agent-notice-top', '401 unauthorized (notice stack top)'))
    const toast = page.locator('[data-testid="corner-stack"] .notification-toast', { hasText: 'notice stack top' })
    await expect(toast).toBeVisible({ timeout: 10_000 })
    await expect.poll(() => toast.evaluate((el) => el.getAnimations().length)).toBe(0)

    // Home's right side with no session open.
    await expect(page.locator('.main-page-session-column[data-column-id]')).toHaveCount(0)
    const empty = await measure(page)
    await page.screenshot({ path: `${SHOTS}/${info.project.name}-${width}-no-column.png` })

    // A session column open on the right.
    await page.locator('.todo-search-input').fill('pw-vscode-session')
    await page.locator('.todo-panel-item[data-task-id="pw-task-vscode"] .todo-item-title').click()
    await expect(page.locator('.main-page-session-column .session-panel[data-session-id="pw-vscode-session"]')).toBeVisible({ timeout: 20_000 })
    await page.locator('.todo-search-input').fill('')
    await expect(toast).toBeVisible()
    // Frames and the stack's own half-second look (the paused clock runs them): whatever it would follow has been read.
    await page.clock.runFor(600)
    const open = await measure(page)
    await page.screenshot({ path: `${SHOTS}/${info.project.name}-${width}-session-column.png` })

    // The panel really changed between the two looks, so the test can tell the stack follows it.
    expect(open.column, 'a session column opened on the right').toBeGreaterThan(200)
    expect(empty.column).toBe(0)
    for (const [name, m] of [['no column', empty], ['session column', open]] as const) {
      expect(m.top, `${name}: at the top`).toBeLessThanOrEqual(24)
      expect(m.offCenter, `${name}: centered in the window`).toBeLessThanOrEqual(1)
      expect(m.width, `${name}: the one width`).toBe(440)
    }
    expect(open.left).toBeCloseTo(empty.left, 0)
    const t = (await toast.boundingBox())!
    expect(Math.round(t.width), 'the toast fills the stack').toBe(440)
  })
}
