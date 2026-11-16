/**
 * Home stays quick at the user's data density while agents write.
 *
 * The complaint (2026-11-16, task 9bceb9f2): "like something typing will show up slow, and
 * press command n it just don't show up quickly enough ... load chat, still slow, send chat,
 * open file". Measured on his Mac: the app's list held 965 tasks (about 150 open) and the
 * server pushed about 1,060 socket frames a minute, among them about 13 task updates a
 * minute, most an agent's status words. Each update drew Home's whole task list twice and
 * every open chat column (its panel twice, its history once), and Cmd+N drew the task list
 * twice as well, though it changes nothing in it. On a Mac whose processor the rest of the
 * machine keeps busy, those draws are what a key or Cmd+N waits behind.
 *
 * Two guards, on the production bundle:
 *  - what draws: an agent's status write draws the task list once and no open chat; Cmd+N
 *    and typing draw no task list at all (src: web/src/utils/render-count.ts counts draws);
 *  - how long: typing, Cmd+N, a send and a chat's opening against their budgets while the
 *    production mix of socket frames arrives.
 */
import { test, expect, type Page } from '@playwright/test'
import { serveProductionBundle } from './production-bundle'
import { isolateUiPrefs } from './todo-panel-helpers'
import { draftComposer, loadHome, REAL_PANEL, seedColumns } from './draft-helpers'
import { keepTaskFramesTo } from './task-list-stub'

test.use({ viewport: { width: 1440, height: 900 } })
test.setTimeout(240_000)

/** The Mac app's list on 2026-11-16: 965 tasks, 84% of them completed. */
const TASKS = 965
const CHAT = 'pw-threads-dense-session'
const BUDGET = { keyP95: 50, cmdN: 150, sendP95: 200, chatOpen: 1000 }

function denseTasks(n: number): Array<Record<string, unknown>> {
  const at = new Date().toISOString()
  return Array.from({ length: n }, (_, i) => ({
    id: `density-${i}`, title: `Review item ${i}: ${'a deliberately long task title '.repeat(i % 6 === 0 ? 4 : 1)}`,
    status: i < n * 0.84 ? 'done' : i < n * 0.86 ? 'in_progress' : 'todo',
    phase: i < n * 0.84 ? 'COMPLETE' : i < n * 0.86 ? 'IN_PROGRESS' : 'TODO',
    priority: 'none', project: i % 61 === 60 ? '' : `Project ${i % 61}`,
    source: 'local', created_at: at, updated_at: at,
    description: 'x'.repeat(i % 7 === 0 ? 1200 : 80), summary: 's'.repeat(200), note: 'n'.repeat(i % 5 === 0 ? 3000 : 100),
    subtasks: [], tags: ['a', 'b'], session_ids: [],
  }))
}

/** An open task the agent behind it reports on: what production sends most (53%, source user-status). */
function statusWrite(tasks: Array<Record<string, unknown>>, n: number): Record<string, unknown> {
  const open = tasks.slice(Math.floor(TASKS * 0.86))
  const task = open[n % open.length]!
  return { task: { ...task, updated_at: new Date().toISOString(), user_status: { state: 'working', now: `Reading the logs, step ${n}`, next: 'Fix it', at: new Date().toISOString() } } }
}

async function instrument(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>
    w.__walnutRenderCounts = {}
    // Every socket the app opens, so the spec can hand it the frames the server sends.
    const Native = window.WebSocket
    const socks: WebSocket[] = []
    w.__pwSocks = socks
    class Probe extends Native { constructor(u: string | URL, p?: string | string[]) { super(u, p); socks.push(this) } }
    window.WebSocket = Probe as unknown as typeof WebSocket
    // The frame after now has run its style, layout and paint: rAF, then a task.
    const afterFrame = () => new Promise<number>((r) => requestAnimationFrame(() => { const c = new MessageChannel(); c.port1.onmessage = () => r(Date.now()); c.port2.postMessage(0) }))
    const keys: number[] = []
    w.__keyDone = keys
    document.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return
      const i = keys.length; keys.push(0)
      void afterFrame().then((t) => { keys[i] = t })
    }, true)
    w.__watch = (sel: string, text?: string) => {
      w.__watched = new Promise<number>((resolve) => {
        const until = Date.now() + 15_000
        const look = () => {
          if (Date.now() > until) { resolve(-1); return }
          const el = document.querySelector(sel) as HTMLElement | null
          if (el && el.getClientRects().length > 0 && (!text || (el.textContent ?? '').includes(text))) { void afterFrame().then(resolve); return }
          requestAnimationFrame(look)
        }
        look()
      })
    }
  })
}

async function openHome(page: Page, tasks: Array<Record<string, unknown>>): Promise<void> {
  await serveProductionBundle(page)
  await isolateUiPrefs(page)
  await instrument(page)
  // The fixture's own list plus the user's density; other workers' task frames stay out, so
  // what draws is what this spec sends.
  const ours = new Set<string>()
  await page.route('**/api/tasks?*', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname !== '/api/tasks') return route.continue()
    const real = await (await route.fetch()).json() as { tasks: Array<{ id: string }> }
    const list = [...real.tasks, ...tasks] as Array<{ id: string }>
    for (const t of list) ours.add(t.id)
    await route.fulfill({ json: { ...real, tasks: list } })
  })
  await keepTaskFramesTo(page, ours)
  await seedColumns(page, [CHAT])
  await loadHome(page)
  await expect(page.locator(`${REAL_PANEL} textarea.chat-input-textarea`).first()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator(`${REAL_PANEL} .markdown-body`).first()).toBeVisible({ timeout: 30_000 })
  // Boot's own draws settle first.
  await page.waitForTimeout(3_000)
}

const draws = (page: Page) => page.evaluate(() => { const w = window as unknown as { __walnutRenderCounts: Record<string, number> }; const c = { ...w.__walnutRenderCounts }; w.__walnutRenderCounts = {}; return c })

/** Until Home draws nothing for 700 ms, so a step counts the draws it causes, not the tail of
 *  the last one (a list update React renders in the background can land a moment later). */
async function quiet(page: Page): Promise<void> {
  for (let i = 0; i < 15; i++) {
    await draws(page)
    await page.waitForTimeout(700)
    const c = await draws(page)
    if (!c.MainPage && !c.TodoPanel && !c.SessionPanelBody) return
  }
  throw new Error('Home kept drawing with nothing happening')
}

/** Hand the page's socket frames as the server would, `perSec` a second, with production's mix. */
async function startTraffic(page: Page, tasks: Array<Record<string, unknown>>, perSec: number): Promise<void> {
  const writes = Array.from({ length: 200 }, (_, n) => statusWrite(tasks, n))
  await page.evaluate(([rate, statusWrites]) => {
    const w = window as unknown as { __pwSocks: WebSocket[]; __traffic?: number }
    // Per second on the Mac, 2026-11-16 (a 3-minute sample of a global socket): text 5.4, thinking 5.3,
    // tool use 0.6, tool result 0.6, usage 0.7, cron:job-updated 0.6, task:updated 0.15.
    const mix: Array<[string, number]> = [['session:text-delta', 5.4], ['session:thinking-delta', 5.3], ['session:tool-use', 0.6], ['session:tool-result', 0.6], ['session:usage-update', 0.7], ['cron:job-updated', 0.6], ['task:updated', 0.15]]
    const total = mix.reduce((a, [, r]) => a + r, 0)
    let n = 0
    let carry = 0
    const pick = () => { let x = Math.random() * total; for (const [k, r] of mix) { x -= r; if (x <= 0) return k } return mix[0]![0] }
    const dataOf = (name: string): unknown => {
      const sessionId = `offscreen-session-${n % 15}`
      if (name === 'session:text-delta' || name === 'session:thinking-delta') return { sessionId, delta: 'some streamed words of a reply ', msgId: `msg_${n % 15}` }
      if (name === 'session:tool-use') return { sessionId, toolUseId: `tu_${n}`, name: 'Bash', input: { command: 'ls -la' } }
      if (name === 'session:tool-result') return { sessionId, toolUseId: `tu_${n - 1}`, result: 'x'.repeat(1200) }
      if (name === 'session:usage-update') return { sessionId, model: 'claude-opus', contextPercent: 40, inputTokens: 80000 }
      if (name === 'cron:job-updated') return { action: 'updated', jobId: `job-${n % 183}` }
      return statusWrites[n % statusWrites.length]
    }
    w.__traffic = window.setInterval(() => {
      const sock = w.__pwSocks.find((s) => s.readyState === 1)
      if (!sock?.onmessage) return
      for (carry += rate / 10; carry >= 1; carry--) {
        n++
        const name = pick()
        sock.onmessage(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name, seq: 1, data: dataOf(name) }) }))
      }
    }, 100)
  }, [perSec, writes] as const)
}

async function timed(page: Page, sel: string, text: string | undefined, act: () => Promise<void>): Promise<number> {
  await page.evaluate(([s, t]) => (window as unknown as { __watch: (s: string, t?: string) => void }).__watch(s!, t ?? undefined), [sel, text ?? null] as const)
  const t0 = Date.now()
  await act()
  const done = await page.evaluate(() => (window as unknown as { __watched: Promise<number> }).__watched)
  expect(done, `${sel} showed`).toBeGreaterThan(0)
  return done - t0
}

/** Each key's press to the frame after it, one key every 80 ms. */
async function typeTimed(page: Page, text: string): Promise<number[]> {
  const before = await page.evaluate(() => (window as unknown as { __keyDone: number[] }).__keyDone.length)
  const sent: number[] = []
  for (const c of text) { sent.push(Date.now()); await page.keyboard.press(c === ' ' ? 'Space' : c); await page.waitForTimeout(80) }
  await page.waitForTimeout(400)
  const done = (await page.evaluate(() => (window as unknown as { __keyDone: number[] }).__keyDone)).slice(before)
  return done.map((d, i) => d - sent[i]!)
}

const p95 = (v: number[]) => [...v].sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(v.length * 0.95))]!
const NEW_TASK = process.platform === 'darwin' ? 'Meta+n' : 'Alt+n'

async function closeDrafts(page: Page): Promise<void> {
  await page.keyboard.press('Escape').catch(() => {})
  const close = page.locator('.main-page-session-column .draft-session-panel').first().locator('button[aria-label*="Close" i]').first()
  if (await close.count()) await close.click().catch(() => {})
  await page.waitForTimeout(400)
}

test('an agent status write draws the task list once and no open chat; Cmd+N and typing draw no task list', async ({ page }) => {
  const tasks = denseTasks(TASKS)
  await openHome(page, tasks)
  // The counter is wired into each component the guard reads: boot drew every one of them.
  const boot = await draws(page)
  for (const name of ['MainPage', 'TodoPanel', 'SessionPanelBody', 'SessionChatHistory']) expect(boot[name] ?? 0, `${name} counts its draws`).toBeGreaterThan(0)

  // 20 status writes for tasks no column shows, 100 ms apart.
  const writes = Array.from({ length: 20 }, (_, n) => statusWrite(tasks, n))
  await page.evaluate(async (frames) => {
    const sock = (window as unknown as { __pwSocks: WebSocket[] }).__pwSocks.find((s) => s.readyState === 1)!
    for (const data of frames) {
      sock.onmessage!(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name: 'task:updated', seq: 1, data }) }))
      await new Promise((r) => setTimeout(r, 100))
    }
    await new Promise((r) => setTimeout(r, 600))
  }, writes)
  const afterWrites = await draws(page)
  // Once each: before, twice each (two of its states set to what they already held).
  expect(afterWrites.TodoPanel ?? 0, JSON.stringify(afterWrites)).toBeLessThanOrEqual(22)
  // No open chat draws for another task's status (before: its panel twice, its history once, per write).
  expect(afterWrites.SessionPanelBody ?? 0, JSON.stringify(afterWrites)).toBeLessThanOrEqual(3)
  expect(afterWrites.SessionChatHistory ?? 0, JSON.stringify(afterWrites)).toBe(0)

  // Typing in the chat's composer draws nothing outside it: its panel once, when the box
  // goes from empty to holding words (its send button wakes), never once a key.
  const box = page.locator(`${REAL_PANEL} textarea.chat-input-textarea`).first()
  await box.click()
  await quiet(page)
  await page.keyboard.type('hello there, a line typed fast', { delay: 40 })
  await page.waitForTimeout(600)
  const afterTyping = await draws(page)
  expect({ MainPage: afterTyping.MainPage ?? 0, TodoPanel: afterTyping.TodoPanel ?? 0 }, JSON.stringify(afterTyping)).toEqual({ MainPage: 0, TodoPanel: 0 })
  expect(afterTyping.SessionPanelBody ?? 0, JSON.stringify(afterTyping)).toBeLessThanOrEqual(1)
  await box.fill('')

  // Cmd+N opens a draft column and leaves the task list as it was (before: two draws).
  await page.locator('body').click({ position: { x: 5, y: 5 } })
  await quiet(page)
  await page.keyboard.press(NEW_TASK)
  await expect(draftComposer(page)).toBeVisible()
  await page.waitForTimeout(600)
  const afterNew = await draws(page)
  expect(afterNew.TodoPanel ?? 0, JSON.stringify(afterNew)).toBe(0)

  // Typing in the draft's composer: nothing outside it either.
  await draftComposer(page).click()
  await quiet(page)
  await page.keyboard.type('a new task, typed fast', { delay: 40 })
  await page.waitForTimeout(600)
  const afterDraft = await draws(page)
  expect({ MainPage: afterDraft.MainPage ?? 0, TodoPanel: afterDraft.TodoPanel ?? 0 }).toEqual({ MainPage: 0, TodoPanel: 0 })
})

test('typing, Cmd+N, a send and a chat opening stay within budget while agents write', async ({ page, browserName }) => {
  // Time on Chromium only: this container's WebKit draws in software, several times slower than
  // the Mac app's, so its numbers would gate on the machine, not the page. The Mac app's own times
  // are in its log ([perf] interaction task-new / send / file-open, [session-open] first content).
  test.skip(browserName !== 'chromium', 'timed on Chromium; the draw guard above runs on both engines')
  const tasks = denseTasks(TASKS)
  await openHome(page, tasks)
  await startTraffic(page, tasks, 14)
  await page.waitForTimeout(1_000)
  const seen: Record<string, number[]> = {}

  const box = page.locator(`${REAL_PANEL} textarea.chat-input-textarea`).first()
  await box.click()
  seen.keys = await typeTimed(page, 'the quick brown fox jumps over the lazy dog')
  expect(seen.keys.every((ms) => ms > 0), 'every key reached a frame').toBe(true)

  seen.send = []
  for (let i = 0; i < 3; i++) {
    const words = `budget send ${Date.now()}`
    await box.fill(words)
    seen.send.push(await timed(page, `${REAL_PANEL} .session-history`, words, () => page.keyboard.press('Enter')))
    await page.waitForTimeout(700)
  }

  seen.cmdN = []
  for (let i = 0; i < 4; i++) {
    await page.locator('body').click({ position: { x: 5, y: 5 } })
    seen.cmdN.push(await timed(page, '.main-page-session-column .draft-session-panel .chat-input-textarea', undefined, () => page.keyboard.press(NEW_TASK)))
    await page.waitForTimeout(300)
    await closeDrafts(page)
  }

  // A chat opened from its task row, to its first message on screen.
  await page.locator('.todo-search-input').fill('pw-vscode-session')
  const row = page.locator('.todo-panel-item[data-task-id="pw-task-vscode"]')
  await expect(row).toBeVisible({ timeout: 20_000 })
  seen.chatOpen = [await timed(page, '.session-panel[data-session-id="pw-vscode-session"] .markdown-body', undefined, () => row.locator('.todo-item-title').click())]

  test.info().annotations.push({ type: 'timings', description: JSON.stringify(seen) })
  console.log('BUDGET ' + JSON.stringify(seen))
  expect(p95(seen.keys), `key to frame p95, ms: ${JSON.stringify(seen.keys)}`).toBeLessThan(BUDGET.keyP95)
  expect(p95(seen.send), `Enter to the message on screen, ms: ${JSON.stringify(seen.send)}`).toBeLessThan(BUDGET.sendP95)
  expect(Math.max(...seen.cmdN), `Cmd+N to the draft's composer on screen, ms: ${JSON.stringify(seen.cmdN)}`).toBeLessThan(BUDGET.cmdN)
  expect(seen.chatOpen[0]!, 'a chat opened to its first message, ms').toBeLessThan(BUDGET.chatOpen)
})
