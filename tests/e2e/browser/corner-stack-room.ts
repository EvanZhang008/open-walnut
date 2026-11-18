import fs from 'node:fs'
import { expect, type Locator, type Page, type TestInfo, type WebSocketRoute } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'

/** Where the room specs put their screenshots. */
export const SHOTS = process.env.CORNER_ROOM_SHOTS || 'test-results/corner-stack-room'

/**
 * The page's own WebSocket, kept so a test can raise a notice as the server would. Events named in
 * `drop` are the test's to send (a health snapshot it set up), never the server's. So is every
 * request for a person's yes: another file on the shared fixture server may be asking one
 * (approvals.spec.ts), and its card would join this test's stack; the page's first read of them
 * answers none too.
 */
export async function routeSocket(
  page: Page, drop: string[] = [], approvals: unknown[] = [],
  /** A frame this page must not see (a spec that answers the task list passes the shared
   *  foreignTaskFrame filter from task-list-stub.ts, so another worker's task never lands here). */
  skip?: (text: string) => boolean,
): Promise<() => WebSocketRoute | null> {
  let socket: WebSocketRoute | null = null
  const dropped = [...drop, 'approval:changed']
  // This page's own approvals only (none unless a test passes its own): one a parallel spec makes on
  // the shared fixture would join the stack and change the room mid-judgement.
  await page.route((url) => url.pathname === '/api/v1/approvals', (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: { approvals, keys: [] } })
    : route.continue())
  await page.routeWebSocket(/\/ws(?:\?|$)/, (route) => {
    socket = route
    const server = route.connectToServer()
    server.onMessage((message) => {
      if (skip?.(String(message))) return
      try {
        const frame = JSON.parse(String(message)) as { type?: string; name?: string }
        if (frame.type === 'event' && dropped.includes(frame.name ?? '')) return
      } catch { /* not ours to read: pass it on */ }
      route.send(message)
    })
  })
  return () => socket
}

/** A pending approval for this page only (routeSocket's third argument): its card joins the stack. */
export function pendingApproval(id: string): unknown {
  const now = Date.now()
  return {
    id, what: 'Corner room approval', digest: '0'.repeat(64), mode: 'tap',
    requester: { host: 'pw-host', local: true, cwd: '/work/site', command: 'release.sh', identity: 'none' },
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 30 * 60_000).toISOString(), status: 'pending',
  }
}

/**
 * The Passwords app unlocked, for this page only: its vault reads answered at the transport with a
 * fake vault of `rows` logins and no recovery kit (so the side's warning shows too), and every write
 * refused, so the shared fixture's real vault and its lock are never touched (vault-lock.ts).
 */
export async function fakeUnlockedVault(page: Page, rows = 60): Promise<void> {
  const at = new Date(Date.UTC(2026, 0, 1)).toISOString()
  const items = Array.from({ length: rows }, (_, i) => ({
    id: `pw-room-${i}`, type: 'login', title: `Example site ${String(i + 1).padStart(2, '0')}`, username: `person${i}@example.com`,
    urls: [`https://site${i}.example.com`], hasPassword: true, hasTotp: false, agentAccess: 'ask', createdAt: at, updatedAt: at,
  }))
  const status = {
    setUp: true, open: true, unlocked: true, agentsWhileAway: false, hasSecretKey: true, itemCount: rows,
    autoLockMinutes: 0, lockAfterIdleMinutes: null, waitMs: 0, privateLink: true, hasRecovery: false,
  }
  const reads: Record<string, unknown> = {
    '/api/v1/vault/status': status,
    '/api/v1/vault/items': { items },
    '/api/v1/vault/report': { weak: [], reused: [], old: [], insecureUrl: [] },
    '/api/v1/vault/agent/log': { entries: [] },
    '/api/v1/vault/agent/policy': { agents: 'ask', grantMs: 0, grants: [] },
  }
  await page.route((url) => url.pathname.startsWith('/api/v1/vault/'), (route) => {
    const path = new URL(route.request().url()).pathname
    if (route.request().method() !== 'GET') return route.fulfill({ status: 403, json: { error: 'read-only test page' } })
    return path in reads ? route.fulfill({ json: reads[path] }) : route.fulfill({ status: 404, json: { error: 'not in this test page' } })
  })
}

/** The room the stack gives now, in px ('' while it covers nothing). */
export const roomNow = (page: Page) => page.evaluate(() => document.querySelector<HTMLElement>('[data-testid="corner-stack"]')?.dataset.room ?? '')

/** An agent error toast in the stack, long enough that it cuts its text and offers Details. */
export async function raiseToast(page: Page, sock: () => WebSocketRoute | null, label: string): Promise<Locator> {
  const why = Array.from({ length: 12 }, (_, i) => `step ${i + 1} of the request was refused by the provider`).join('; ')
  sock()!.send(JSON.stringify({ type: 'event', name: 'agent:error', data: { agentId: `agent-corner-room-${label}`, error: `401 unauthorized (corner room ${label}): ${why}` }, seq: -1 }))
  const toast = page.locator('[data-testid="corner-stack"] .notification-toast', { hasText: `corner room ${label}` })
  await expect(toast).toBeVisible({ timeout: 10_000 })
  await expect.poll(() => toast.evaluate((el) => el.getAnimations().length)).toBe(0)
  await expect.poll(() => roomNow(page)).not.toBe('')
  return toast
}

/** Its x, clicked as a person does, and the room gone with it. */
export async function closeToast(page: Page, toast: Locator): Promise<void> {
  await toast.locator('.notification-toast-close').click()
  await expect(toast).toHaveCount(0)
  await expect.poll(() => roomNow(page)).toBe('')
}

/**
 * Scrollbars that take no width, as the Mac's default overlay ones and Playwright's headless
 * Chromium (--hide-scrollbars) have. With classic ones a list that starts to scroll when a notice
 * comes keeps its width only where scrollbar-gutter: stable is honoured: Chromium, not WebKit 26
 * beside a ::-webkit-scrollbar style (measured 2026-11-17, docs/reference/notification-lifecycle.md).
 */
export async function hideScrollbars(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const hide = () => document.head.appendChild(Object.assign(document.createElement('style'), { textContent: '::-webkit-scrollbar { width: 0 !important; height: 0 !important; }' }))
    if (document.head) hide(); else document.addEventListener('DOMContentLoaded', hide)
  })
}

/** What unreachableUnderStack found: what it could not reach, and the lists it judged. */
export interface UnderStack { bad: string[]; checked: string[] }

/**
 * The chats the stack floats over by the user's choice (2026-11-16: "just show like notification
 * overlap"): a notice overlapping a chat beside the task panel, over a chat that moves under the
 * eyes whenever one comes or goes. A session column, and Home's Ask Walnut slot, which is a session
 * panel too (its composer reaches under the stack's right half; review r3 found it judged by no
 * case, so it is named here rather than passed by the half-hidden rule).
 */
export const CHAT_SURFACES = ['.main-page-session-column', '.main-page-chat']

/**
 * What a person cannot bring out from under the notice stack right now, by name (`bad` empty
 * when nothing), and the lists it judged (`checked`, so a caller can tell the check saw
 * something). The stack floats at the bottom left beside the rail
 * (web/src/components/common/corner-stack.tsx) and overlaps the page like a system notification;
 * what it covers must still be reachable (corner-stack-room.spec.ts):
 *
 *  - a list: every innermost scroller of the page the stack overlaps is filled past its height
 *    (a tall probe row, removed again), so a list the fixture keeps short is judged as a full one;
 *    it is scrolled to its end and its last row must then end above the stack's top. A scroller
 *    already full is judged as it is.
 *  - a control (a button, a link, a field) that no scroller can move: the stack hides none of them
 *    (half of it or more, where it is painted). Text that does not scroll (a hint line) and the
 *    rest of a large surface (an editor reaching under it) are overlapped by design.
 * Neither counts inside `overlapAllowed`: what the user chose to have the stack float over (by
 * default the chats, CHAT_SURFACES).
 */
export async function unreachableUnderStack(page: Page, overlapAllowed: string[] = CHAT_SURFACES): Promise<UnderStack> {
  return page.evaluate((allowed) => {
    const stack = document.querySelector('[data-testid="corner-stack"]')
    if (!stack) return { bad: ['no notice stack in the page'], checked: [] }
    const s = stack.getBoundingClientRect()
    if (s.height === 0) return { bad: ['the notice stack is empty'], checked: [] }
    const across = (r: DOMRect) => r.width > 0 && r.right > s.left && r.left < s.right
    const over = (r: DOMRect) => across(r) && r.height > 0 && r.bottom > s.top && r.top < s.bottom
    const name = (el: Element | null) => !el ? 'the page' : el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '')
    const scrolls = (el: Element) => { const oy = getComputedStyle(el).overflowY; return oy === 'auto' || oy === 'scroll' }
    const overflows = (el: Element) => el.scrollHeight > el.clientHeight + 1
    const scrollerOf = (el: Element) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (scrolls(p)) return p; return null }
    const bad: string[] = []
    const checked: string[] = []

    const scrollers = [...document.querySelectorAll<HTMLElement>('.main-content *')].filter((el) =>
      !stack.contains(el) && !allowed.some((sel) => el.closest(sel)) && scrolls(el) && getComputedStyle(el).visibility !== 'hidden' && el.clientHeight > 40 && over(el.getBoundingClientRect()))
    const innermost = new Set(scrollers.filter((el) => !scrollers.some((o) => o !== el && el.contains(o))))
    for (const el of scrollers) {
      // A rich-text document it scrolls: a long one ends where its own end padding and what follows
      // it in the scroller say, so judge that room (a probe row would land outside the document).
      const doc = el.querySelector<HTMLElement>('.ProseMirror')
      if (doc && innermost.has(el)) {
        const inner = el.getBoundingClientRect().bottom - parseFloat(getComputedStyle(el).borderBottomWidth)
        const keep = el.scrollTop
        el.scrollTop = el.scrollHeight
        const contentEnd = el.getBoundingClientRect().top + el.scrollHeight - el.scrollTop
        const after = contentEnd - doc.getBoundingClientRect().bottom + parseFloat(getComputedStyle(doc).paddingBottom)
        el.scrollTop = keep
        checked.push(name(el))
        const overlap = inner - s.top
        if (after < overlap - 1) bad.push(`scroller ${name(el)}: a long document's last line stops ${Math.round(after)}px above its end, the stack covers its last ${Math.round(overlap)}px`)
        continue
      }
      let probe: HTMLElement | null = null
      if (innermost.has(el) && !overflows(el)) {
        const height = el.clientHeight
        probe = document.createElement('div')
        probe.style.cssText = 'height: 4000px; flex: none; grid-column: 1 / -1; pointer-events: none'
        el.appendChild(probe)
        // A box that grows with its content is no scroller of its own: what holds it scrolls instead.
        if (el.clientHeight !== height || !overflows(el)) { probe.remove(); continue }
      } else if (!overflows(el)) continue
      // Scrolled to its end, where its last row really is (end padding an engine leaves out of the
      // scroll range, or a row's negative margin, shows here).
      const keep = el.scrollTop
      el.scrollTop = el.scrollHeight
      let end = -Infinity
      for (const c of el.children) {
        const r = c.getBoundingClientRect()
        if (r.height > 0 && across(r)) end = Math.max(end, r.bottom)
      }
      el.scrollTop = keep
      probe?.remove()
      checked.push(name(el))
      if (end > s.top + 1) bad.push(`scroller ${name(el)}: full and scrolled to its end, its last row ends at ${Math.round(end)}, under the stack's top at ${Math.round(s.top)}`)
    }

    // Every control painted under the stack that no scroller can bring out.
    const seen = new Set<string>()
    for (const el of document.querySelectorAll<HTMLElement>('.main-content :is(button, a[href], input, textarea, select, [role="button"], [contenteditable="true"])')) {
      if (stack.contains(el) || allowed.some((sel) => el.closest(sel))) continue
      const r = el.getBoundingClientRect()
      if (!over(r)) continue
      const hidden = (Math.min(r.right, s.right) - Math.max(r.left, s.left)) * (Math.min(r.bottom, s.bottom) - Math.max(r.top, s.top))
      if (hidden < (r.width * r.height) / 2) continue
      const box = scrollerOf(el)
      if (box && overflows(box)) continue
      // Painted there: a control clipped away by its box is not hit at its middle.
      const x = Math.min(Math.max(r.left + Math.min(r.width / 2, 40), s.left + 1), s.right - 1)
      const y = Math.min(Math.max(r.top + r.height / 2, s.top + 1), s.bottom - 1)
      if (!document.elementsFromPoint(x, y).includes(el)) continue
      const key = `${name(box)} ${name(el)}`
      if (seen.has(key)) continue
      seen.add(key)
      bad.push(`${name(el)} "${(el.textContent ?? el.getAttribute('aria-label') ?? '').trim().slice(0, 30)}" in ${name(box)}: under the stack, and nothing scrolls it out`)
    }
    return { bad, checked }
  }, overlapAllowed)
}

/**
 * Waits until the page holds still, then notes where every laid-out element of it is (its box, and
 * each scroller's offset), so movedSince can tell whether anything moved. What nobody sees is left
 * out (a page kept mounted off its route, Home under visibility: hidden), and so is what moves by
 * itself: an element running an animation (a spinner) and what is inside `ownMotion` (a chat
 * that scrolls as it streams).
 */
export async function markLayout(page: Page, ownMotion: string[] = []): Promise<void> {
  const take = () => page.evaluate((own) => {
    const w = window as unknown as { __csrEls?: Element[] }
    w.__csrEls ??= [...document.querySelectorAll('.main-content *')].filter((el) => !el.closest('[data-testid="corner-stack"]') && !own.some((sel) => el.closest(sel)) && el.checkVisibility({ visibilityProperty: true })).slice(0, 6000)
    return w.__csrEls.map((el) => {
      if (!el.isConnected || el.getAnimations().length > 0 || !el.checkVisibility({ visibilityProperty: true })) return ''
      const r = el.getBoundingClientRect()
      return `${r.x.toFixed(1)},${r.y.toFixed(1)},${r.width.toFixed(1)},${r.height.toFixed(1)},${el.scrollTop}`
    })
  }, ownMotion)
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.evaluate(() => { delete (window as unknown as { __csrEls?: Element[] }).__csrEls })
  // Held still: three looks 400ms apart that agree (a list still loading moves between them).
  let a = await take()
  let still = 0
  for (let i = 0; i < 30 && still < 2; i++) {
    await page.waitForTimeout(400)
    const b = await take()
    still = a.every((v, j) => v === b[j]) ? still + 1 : 0
    a = b
  }
  await page.evaluate((keep) => {
    (window as unknown as { __csrKeep: [number, string][] }).__csrKeep = keep
  }, a.map((v, i) => [i, v] as [number, string]).filter(([, v]) => v !== ''))
}

/** What moved since markLayout, by name (empty when nothing did). */
export async function movedSince(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __csrEls: Element[]; __csrKeep: [number, string][] }
    const name = (el: Element) => el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '')
    const out: string[] = []
    const moved = new Set<Element>()
    for (const [i, was] of w.__csrKeep) {
      const el = w.__csrEls[i]!
      if (!el.isConnected || el.getAnimations().length > 0 || !el.checkVisibility({ visibilityProperty: true })) continue
      const r = el.getBoundingClientRect()
      const now = `${r.x.toFixed(1)},${r.y.toFixed(1)},${r.width.toFixed(1)},${r.height.toFixed(1)},${el.scrollTop}`
      if (now === was) continue
      moved.add(el)
      // Named by the outermost movers only (the list is in document order, so a moved parent is
      // seen first): what moves inside one only repeats it. At most 8 of them.
      let inside = false
      for (let p = el.parentElement; p && !inside; p = p.parentElement) inside = moved.has(p)
      if (!inside) out.push(`${name(el)}: ${was} -> ${now}`)
    }
    return out.slice(0, 8)
  })
}

// The walks the room specs share (corner-stack-room.spec.ts, corner-stack-room-classic.spec.ts).

/** How the browser draws scrollbars: none that take width (the default here), or classic ones. */
export type Bars = 'overlay' | 'classic'

export async function openHome(page: Page, sock: () => WebSocketRoute | null, bars: Bars = 'overlay', ready = '.main-page-todo .home-navigation-scroll .todo-group-project-header') {
  await page.route('**/api/quiet*', (r) => r.fulfill({ json: { quiet: false } }))
  if (bars === 'overlay') await hideScrollbars(page)
  await page.goto('/')
  await expect(page.locator('.main-page-todo > .todo-panel')).toBeVisible({ timeout: 30_000 })
  // The list has drawn its rows (a stop judged while they still arrive would see them move).
  await expect(page.locator(ready).first()).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => sock() !== null, { timeout: 30_000 }).toBe(true)
}

/** The VS Code fixture task's session, open in a column beside the task panel. */
export async function openSession(page: Page) {
  await page.locator('.todo-search-input').fill('pw-vscode-session')
  await page.locator('.todo-panel-item[data-task-id="pw-task-vscode"] .todo-item-title').click()
  await expect(page.locator('.main-page-session-column .session-panel[data-session-id="pw-vscode-session"]')).toBeVisible({ timeout: 20_000 })
  await page.locator('.todo-search-input').fill('')
  await expect(page.locator('.todo-panel-item[data-task-id="pw-task-vscode"]')).toBeVisible()
}

/** The task list with a notice: it comes, opens its details, goes; light and dark. */
export async function homeWithNotice(page: Page, info: TestInfo, vp: { width: number; height: number }, bars: Bars) {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.setViewportSize(vp)
  const sock = await routeSocket(page)
  await openHome(page, sock, bars)
  const list = page.locator('.main-page-todo .home-navigation-scroll')
  const listEnd = () => list.evaluate((el) => el.scrollHeight)
  const tag = `${info.project.name}${bars === 'classic' ? '-classic' : ''}-${vp.width}`
  const shot = (name: string) => page.screenshot({ path: `${SHOTS}/${tag}-${name}.png`, clip: { x: 0, y: 0, width: Math.min(720, vp.width), height: vp.height } })
  const stack = page.getByTestId('corner-stack')

  // Classic scrollbars really take width here (the list keeps its gutter), so the case is real.
  if (bars === 'classic') expect(await list.evaluate((el) => el.offsetWidth - el.clientWidth)).toBeGreaterThan(0)
  // Empty first: no room, the list as long as its own rows.
  expect(await roomNow(page)).toBe('')
  const plainEnd = await listEnd()

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await markLayout(page)
    const toast = await raiseToast(page, sock, scheme)
    expect(await movedSince(page), 'nothing on the page moves when a notice comes').toEqual([])
    expect((await unreachableUnderStack(page)).bad).toEqual([])
    await shot(`${scheme}-with-notice`)

    // A notice opened to its whole text grows the stack: what it covers stays reachable, and the
    // stack stays inside the window (its words scroll in it), so its x takes a real click.
    const closed = (await stack.boundingBox())!.height
    await toast.locator('.notice-details-toggle').first().click()
    await expect.poll(async () => (await stack.boundingBox())!.height).toBeGreaterThan(closed + 10)
    await expect.poll(async () => (await unreachableUnderStack(page)).bad).toEqual([])
    expect((await stack.boundingBox())!.y, 'the opened stack stays inside the window').toBeGreaterThanOrEqual(0)
    expect(await movedSince(page), 'nor when it grows').toEqual([])
    if (scheme === 'light') await shot('light-opened')

    // The last notice leaving takes the room away at once: no gap left at the list's end.
    await closeToast(page, toast)
    expect(await listEnd()).toBe(plainEnd)
    expect(await movedSince(page), 'nor when it goes').toEqual([])
    await shot(`${scheme}-empty`)
  }
}

/** The lists the walk must see where it stops (each judged as a full one), so it cannot pass by
 *  seeing nothing; a stop is judged once its list has rendered. */
export const LISTS: Record<string, string> = {
  '/': 'div.home-navigation-scroll', '/notes': 'div.notes-tree-body', '/calendar': 'div.cal-grid-scroll',
  '/tasks': 'div.tp-table-scroll', '/apps': 'div.apps-page', '/settings': 'div.settings-nav-list',
  'org': 'div.org-list-scroll', 'note': 'div.notes-editor-content', 'vault': 'div.pw-rows',
}

export async function railWalk(page: Page, height: number, bars: Bars) {
  // The walk opens every side bar; one a failed stop leaves open stays this page's, never the
  // shared server's for the next spec.
  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 1280, height })
  const sock = await routeSocket(page)
  await openHome(page, sock, bars)
  const rail = page.locator('.app-shell > .sidebar')
  const found: string[] = []
  const seen = new Set<string>()
  const judge = async (stop: string) => {
    await markLayout(page)
    const toast = await raiseToast(page, sock, `stop ${stop}`)
    let under = await unreachableUnderStack(page)
    const want = LISTS[stop]
    if (want) await expect.poll(async () => (under = await unreachableUnderStack(page)).checked.some((n) => n === want || n.startsWith(`${want}.`)), { message: `${stop} ${want}` }).toBe(true)
    for (const miss of under.bad) found.push(`${stop}: ${miss}`)
    for (const moved of await movedSince(page)) found.push(`${stop}: moved when the notice came: ${moved}`)
    await closeToast(page, toast)
    seen.add(stop)
    return under.checked
  }

  // The rail's pages and buttons, read from the rail itself: a new one joins this walk by itself.
  const links = [...new Set(await rail.locator('a.sidebar-link[href]').evaluateAll((els) => els.map((e) => e.getAttribute('href')!)))]
  expect(links.length).toBeGreaterThanOrEqual(6)
  for (const href of links) {
    await rail.locator(`a.sidebar-link[href="${href}"]`).first().click()
    await expect.poll(() => new URL(page.url()).pathname).toBe(href)
    await judge(href)
    if (href === '/notes') {
      // A note open in the editor.
      const file = page.locator('.notes-tree-body .notes-tree-file').first()
      await file.click()
      await expect(page.locator('.notes-editor-content')).toBeVisible({ timeout: 15_000 })
      await judge('note')
    }
    if (href === '/settings') {
      // Every Settings page (the first was judged above; a row that opens another page is not one).
      const items = page.locator('.settings-nav-list .settings-nav-item:not(.settings-nav-page-link)')
      const count = await items.count()
      expect(count).toBeGreaterThan(3)
      for (let i = 1; i < count; i++) {
        const item = items.nth(i)
        const label = (await item.innerText()).trim().split('\n')[0]
        await item.click()
        await judge(`settings ${label}`)
      }
    }
  }

  const home = rail.locator('a.sidebar-link[href="/"]').first()
  // The vault unlocked (the walk above met its lock screen): its side, sections then tools, and its
  // list of items (2026-11-17, review: Generator, Import and Lock were a footer under the stack).
  expect(links).toContain('/passwords')
  await fakeUnlockedVault(page)
  await home.click()
  await expect.poll(() => new URL(page.url()).pathname).toBe('/')
  await rail.locator('a.sidebar-link[href="/passwords"]').first().click()
  await expect(page.getByTestId('pw-app')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('pw-row')).toHaveCount(60)
  await expect(page.getByTestId('pw-no-recovery')).toBeVisible()
  const sideJudged = await judge('vault')
  expect(sideJudged.some((n) => n === 'aside.pw-side' || n.startsWith('aside.pw-side.')), `the side is judged: ${sideJudged.join(', ')}`).toBe(true)

  // The rail's buttons that open a page or a side bar beside the page (Org, Agenda, Scratchpad),
  // each from Home.
  const buttons = await rail.locator('button.sidebar-link[data-testid^="sidebar-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!))
  expect(buttons).toEqual(expect.arrayContaining(['sidebar-org', 'sidebar-toggle-calendar', 'sidebar-toggle-scratchpad']))
  for (const id of buttons) {
    const button = rail.locator(`[data-testid="${id}"]`)
    await home.click()
    await expect.poll(() => new URL(page.url()).pathname).toBe('/')
    await button.click()
    await judge(id === 'sidebar-org' ? 'org' : id)
    // A side bar closes again, so the next stop is judged on its own.
    if ((await button.getAttribute('aria-pressed')) === 'true') await button.click()
  }

  expect(found).toEqual([])
  for (const stop of Object.keys(LISTS)) expect([...seen], `the walk still stops at ${stop}`).toContain(stop)
}
