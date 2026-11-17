/**
 * What the notice stack covers stays reachable, and nothing moves when a notice comes or goes
 * (web/src/components/common/corner-stack.tsx, web/src/styles/corner-stack.css). The stack floats
 * at the bottom left beside the rail over the page, like a system notification; it measures how
 * much of the window's bottom it covers (data-room on the stack, absent while it covers nothing)
 * and every scroller beside the rail whose rule asks for it (var(--corner-stack-room, 0px)) gets
 * that much extra room at its end (corner-stack-room.ts). 2026-11-16: the host
 * connect card sat over the task panel's found-computer row, a footer under the list, so its Not
 * now could not be clicked, even with the card minimized (first-use.spec.ts, "double-clicking
 * Connect ..."); the row is the list's last section now.
 *
 * The class check, in a real page (corner-stack-room.ts): on every page and side bar of the rail
 * (read from the rail itself), a note, the Org page and a Settings page, at a tall and a short
 * window, with a notice showing:
 *  - every list the stack overlaps (filled past its height, so a short fixture list counts as a
 *    full one) scrolls its last row clear of the stack;
 *  - no control that does not scroll is painted under it;
 *  - nothing on the page moved or changed size when the notice came.
 * A new page, panel or side bar at the bottom left that misses the room fails here by name. With
 * the stack empty the room is gone: no gap at a list's end.
 */
import { expect, test } from '@playwright/test'
import {
  CHAT_SURFACES, closeToast, homeWithNotice, markLayout, movedSince, openHome, openSession, pendingApproval, railWalk, raiseToast, roomNow,
  routeSocket, SHOTS, unreachableUnderStack as unreachable,
} from './corner-stack-room'
import { BOTTOM_LEFT, stackPlace, taskbarLift } from './corner-stack-place'

test.describe.configure({ timeout: 300_000 })

for (const vp of [{ width: 1280, height: 800 }, { width: 1100, height: 560 }]) {
  test(`the task list scrolls its end clear of the notice stack, nothing moves when it comes or goes, no gap when it is empty (${vp.width}x${vp.height})`, async ({ page }, info) => {
    await homeWithNotice(page, info, vp, 'overlay')
  })
}

test('with a session column open beside it, the task list still scrolls clear of the stack; the stack floats over the chat by choice', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const sock = await routeSocket(page)
  await openHome(page, sock)
  await openSession(page)
  // The chat scrolls by itself as it streams: not the notice's doing.
  await markLayout(page, ['.main-page-session-column'])
  await raiseToast(page, sock, 'column')
  // The session column is the one thing the stack floats over on purpose: the user chose a notice
  // overlapping the chat beside the task panel over a chat that moves under their eyes whenever a
  // notice comes or goes (2026-11-16: "just show like notification overlap").
  const r = await unreachable(page, CHAT_SURFACES)
  expect(r.bad).toEqual([])
  expect(r.checked.some((n) => n.startsWith('div.home-navigation-scroll'))).toBe(true)
  expect(await movedSince(page)).toEqual([])
})

test('with an approval card in the stack as well, the room is the whole stack and the list still scrolls clear of it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  // Every other case here empties the approvals (routeSocket); this one keeps one pending card in
  // the stack, under the toast, as a person waiting on a script sees it.
  const sock = await routeSocket(page, [], [pendingApproval('apr-corner-room')])
  await openHome(page, sock)
  const stack = page.getByTestId('corner-stack')
  await expect(stack.locator('[data-testid="approval-card"]')).toHaveCount(1, { timeout: 15_000 })
  await expect.poll(() => roomNow(page)).not.toBe('')
  const cardOnly = Number(await roomNow(page))
  await markLayout(page)
  const toast = await raiseToast(page, sock, 'approval')
  await expect.poll(async () => Number(await roomNow(page))).toBeGreaterThan(cardOnly)
  const s = (await stack.boundingBox())!
  expect(Number(await roomNow(page)), 'the room is the whole stack, the card included').toBe(Math.ceil(800 - s.y) + 8)
  const r = await unreachable(page)
  expect(r.bad).toEqual([])
  expect(r.checked.some((n) => n.startsWith('div.home-navigation-scroll'))).toBe(true)
  expect(await movedSince(page), 'nothing moves when a notice joins the card').toEqual([])
  // The toast goes and the card stays: the room shrinks back to the card's, no further.
  await toast.locator('.notification-toast-close').click()
  await expect(toast).toHaveCount(0)
  await expect.poll(async () => Number(await roomNow(page))).toBe(cardOnly)
  expect(await movedSince(page)).toEqual([])
})

for (const height of [800, 560]) {
  test(`Home's states with a notice: picking tasks, a session minimized to the taskbar (1280x${height})`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height })
    const sock = await routeSocket(page)
    await openHome(page, sock)
    const stack = page.getByTestId('corner-stack')
    const judge = async (stop: string, own: string[] = []) => {
      await markLayout(page, own)
      const toast = await raiseToast(page, sock, stop)
      const r = await unreachable(page, own)
      expect(r.bad, stop).toEqual([])
      expect(r.checked.some((n) => n.startsWith('div.home-navigation-scroll')), stop).toBe(true)
      expect(await movedSince(page), `${stop}: nothing moves when a notice comes`).toEqual([])
      return toast
    }

    // Picking tasks: the selection bar sits right under the toolbar (2026-11-16 review: as a footer
    // under the list, the stack covered Group, the batch verbs and Cancel). Its verbs take real clicks.
    await page.locator('.todo-search-input').fill('pw-vscode-session')
    const row = page.locator('.todo-panel-item[data-task-id="pw-task-vscode"]')
    await row.locator('.task-kebab-btn').click()
    await page.locator('.task-kebab-menu').getByText('Select…').click()
    const bar = page.locator('.task-selection-bar')
    await expect(bar).toBeVisible()
    let toast = await judge('picking')
    const toolbarBottom = (await page.locator('.main-page-todo .todo-panel-toolbar').first().boundingBox())!.y
    expect((await bar.boundingBox())!.y).toBeGreaterThanOrEqual(toolbarBottom)
    expect((await bar.boundingBox())!.y + (await bar.boundingBox())!.height, 'the bar ends above the stack').toBeLessThanOrEqual((await stack.boundingBox())!.y)
    await bar.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(bar).toHaveCount(0)
    await closeToast(page, toast)
    await page.locator('.todo-search-input').fill('')

    // A session minimized to the taskbar: the stack stands on the taskbar, so its chips at the left
    // stay in reach (2026-11-16 review), and nothing else moves.
    await openSession(page)
    await page.locator('.main-page-session-column').getByRole('button', { name: 'Minimize session to the taskbar' }).first().click()
    const chip = page.locator('.session-taskbar-chip').first()
    await expect(chip).toBeVisible({ timeout: 10_000 })
    toast = await judge('taskbar')
    expect(await taskbarLift(page), 'the taskbar shows').toBeGreaterThan(0)
    expect(await stackPlace(page), 'the stack stands on the taskbar').toBe(BOTTOM_LEFT)
    await chip.click({ trial: true })
    await closeToast(page, toast)
    // Back off the taskbar, the stack sits at the window's bottom again.
    await chip.click()
    await expect(page.locator('.session-taskbar')).toHaveCount(0)
    toast = await raiseToast(page, sock, 'after-taskbar')
    expect(await taskbarLift(page)).toBe(0)
    expect(await stackPlace(page)).toBe(BOTTOM_LEFT)
    await closeToast(page, toast)
  })
}

const MISSING_HEALTH = {
  hasReadyProvider: false, claudeCliAvailable: false, claudeCodeNeeded: true,
  localClaude: { checkedAt: 1, claude: { found: false }, problems: [{ kind: 'claude_missing', message: 'Claude Code is not installed on this computer.', commands: ['claude'] }] },
}

for (const height of [800, 560]) {
  test(`an empty list with the welcome card: a notice shrinks nothing and the card's end stays reachable (1280x${height})`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height })
    // A first visit: no tasks, Claude Code missing, the Ask slot closed, so the welcome card sits
    // at the top of the task panel above the (empty) list (home-first-use-card.ts).
    await page.addInitScript(() => { try { localStorage.setItem('open-walnut-home-chat-visible', 'false') } catch { /* storage off */ } })
    await page.route('**/api/tasks*', async (route) => {
      if (route.request().method() !== 'GET' || new URL(route.request().url()).pathname !== '/api/tasks') return route.continue()
      await route.fulfill({ json: { tasks: [], groups: [], completedHidden: 0 } })
    })
    await page.route('**/api/system/health', (route) => route.fulfill({ json: MISSING_HEALTH }))
    const sock = await routeSocket(page, ['system:health', 'task:created', 'task:updated'])
    await openHome(page, sock, 'overlay', '[data-testid="first-use-in-tasks"] [data-testid="first-use-setup"]')
    const card = page.getByTestId('first-use-in-tasks')
    const cardBox = await card.boundingBox()
    // The first visit's draft column beside the panel is a chat column: the stack floats over it by
    // choice, as over a session's (2026-11-16, the user: "just show like notification overlap").
    const column = ['.main-page-session-column']
    await markLayout(page, column)
    const toast = await raiseToast(page, sock, 'welcome')
    expect(await movedSince(page), 'the welcome card and the list keep their size').toEqual([])
    expect(await card.boundingBox()).toEqual(cardBox)
    const under = await unreachable(page, CHAT_SURFACES)
    expect(under.bad).toEqual([])
    expect(under.checked.some((n) => n.startsWith('div.first-use-in-tasks') || n.startsWith('div.home-navigation-scroll'))).toBe(true)
    await page.screenshot({ path: `${SHOTS}/welcome-${height}.png`, clip: { x: 0, y: 0, width: 720, height } })
    await closeToast(page, toast)
    expect(await movedSince(page)).toEqual([])
  })
}

for (const height of [800, 560]) {
  test(`every page and side bar of the rail keeps what the stack covers reachable and still (1280x${height})`, async ({ page }) => {
    await railWalk(page, height, 'overlay')
  })
}
