/**
 * The real Walnut extension in Chromium, connected to the fixture Walnut, with a few local sites
 * and the side panel opened as a window of its own for the person's window (`?window=`, what a
 * browser with no side panel gets: Playwright cannot open Chrome's side panel itself). Shared by
 * the side panel specs (extension-panel-*.spec.ts).
 */
import { expect, chromium, type BrowserContext, type FrameLocator, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bunRuntime } from '../../helpers/bun-runtime'
import { presetPanelDesign } from './status-section-helpers'

export interface PanelLab {
  ctx: BrowserContext
  extId: string
  base: string
  port: number
  doc: Page
  docWindow: number
  site: (host: string, p: string) => string
  close: () => Promise<void>
}

export const PAGES: Record<string, { title: string; body: string }> = {
  '/notes': {
    title: 'Release notes 4.2',
    body: `<h1>Release notes 4.2</h1>
      <p id="p1">The sync engine now retries a failed upload three times before it gives up.</p>
      <p id="p2">Dark mode follows the system setting on every page.</p>
      <label>Feedback <input id="fb" name="fb"></label>`,
  },
  '/other': { title: 'Another page', body: '<h1>Another page</h1><p>Nothing to see.</p>' },
  '/login': {
    title: 'Sign in',
    body: `<form id="f" onsubmit="return false"><label>Email <input id="user" name="email" type="email" autocomplete="username"></label>
      <label>Password <input id="pass" name="password" type="password" autocomplete="current-password"></label><button>Sign in</button></form>`,
  },
}

function startSites(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    const page = PAGES[new URL(req.url ?? '/', 'http://x').pathname]
    res.writeHead(page ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page ? `<!doctype html><html><head><title>${page.title}</title></head><body>${page.body}</body></html>` : 'not found')
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port })))
}

/** Build the extension, start Chromium with it, connect it to the fixture Walnut, open a page. */
export async function startPanelLab(base: string, label: string): Promise<PanelLab> {
  // PW_EXTENSION_DIR: a build made earlier (an A/B of two builds on one fixture); else this tree's, now.
  const dir = process.env.PW_EXTENSION_DIR || fs.mkdtempSync(path.join(os.tmpdir(), `walnut-ext-${label}-`))
  if (!process.env.PW_EXTENSION_DIR) execFileSync(bunRuntime(), ['scripts/build-extension.mjs', '--out', dir, '--no-zip'], { stdio: 'pipe' })
  const { server, port } = await startSites()
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), `walnut-ext-profile-${label}-`)), {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1100, height: 760 },
    args: [
      `--disable-extensions-except=${path.join(dir, 'chrome')}`,
      `--load-extension=${path.join(dir, 'chrome')}`,
      '--host-resolver-rules=MAP *.example.test 127.0.0.1',
    ],
  })
  // The panel's view choices (the page it was left on, the agent, Home's tab) are mirrored to
  // ui-prefs, and the fixture serves every spec: this browser keeps them to itself.
  await ctx.route('**/api/ui-prefs', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: route.request().method() === 'GET' ? '{"prefs":{}}' : '{"ok":true}' }))
  // The extension's first page is Home's own task panel in Home's layout. Home opens By project
  // for a new person (2026-11-06); these specs check the Flat status rows, the layout the person
  // picked on his own Home, so the browser starts on Flat as his does (ui-prefs stay here, above).
  await presetPanelDesign(ctx, 'status')
  let worker = ctx.serviceWorkers()[0]
  if (!worker) worker = await ctx.waitForEvent('serviceworker')
  worker.on('console', (m) => { if (m.type() === 'error') console.log(`[background error] ${m.text()}`) })
  const extId = new URL(worker.url()).host

  const p = await ctx.newPage()
  await p.goto(`chrome-extension://${extId}/popup.html`)
  await p.locator('#server').fill(base)
  const opened = ctx.waitForEvent('page')
  await p.getByTestId('popup-connect').click()
  const connect = await opened
  // Walnut's whole app loads first (Vite compiles it on the first visit): minutes on a busy host.
  await expect(connect.getByRole('heading', { name: 'Connect this browser to Walnut?' })).toBeVisible({ timeout: 150_000 })
  // Agents in this browser stay off here, as the person may choose on this page (on by default):
  // a browser of this spec must not join the fixture Walnut's agents beside the agent specs' own.
  // (A build from before that choice, PW_EXTENSION_DIR's, has no such box.)
  const agents = connect.getByTestId('connect-extension-agents')
  if (await agents.count()) await agents.uncheck()
  await connect.getByTestId('connect-extension-go').click()
  await expect(connect.getByTestId('connect-extension-done')).toBeVisible({ timeout: 20_000 })
  await connect.close()
  await p.close()

  const site = (host: string, pth: string) => `http://${host}:${port}${pth}`
  const doc = ctx.pages()[0]
  await doc.goto(site('docs.example.test', '/notes'))
  await doc.bringToFront()
  const docWindow = await ctx.serviceWorkers()[0].evaluate(async () => {
    const [t] = await chrome.tabs.query({ active: true, url: 'http://docs.example.test/*' })
    return t?.windowId ?? 0
  })
  expect(docWindow).toBeGreaterThan(0)
  return {
    ctx, extId, base, port, doc, docWindow, site,
    close: async () => {
      await ctx.close()
      await new Promise<void>((r) => server.close(() => r()))
    },
  }
}

export const sw = (lab: PanelLab) => lab.ctx.serviceWorkers()[0]

/**
 * Open the panel window for the person's window, timed from the click. The panel opens on the page
 * it was left on: the first page (New task over the task list, ExtHome.tsx) until the person went
 * to an ask. `view` 'ask' (and the full views) then goes to Ask the way a person does, from the ≡
 * drawer's New chat, when the panel opened on the first page; 'home' leaves it there. `view` then
 * opens the Tasks or Passwords full view, with its Back control (panel-ask.ts). A Walnut too old for
 * that shape shows the three tabs, where `view` picks the tab it keeps. `keepRail` opens on the side
 * bar entry it was left on, as a person's next open does.
 */
export async function openPanel(lab: PanelLab, view?: 'ask' | 'home' | 'tasks' | 'passwords', opts: { keepRail?: boolean } = {}): Promise<{ panel: Page; t0: number }> {
  if (view && view !== 'home') await sw(lab).evaluate((t: string) => chrome.storage.local.set({ panelTab: t }), view)
  // The side bar's entry of last time (panel-rail.ts) is the person's: a caller names the view it
  // wants, so the panel opens on Chat here unless it asks to keep that entry.
  if (!opts.keepRail) await sw(lab).evaluate(() => chrome.storage.local.remove('panelRail'))
  // The page the view said it was left on (panel-snap.ts `mode`): already Ask, the panel opens
  // there and nothing waits on it here (a drawing of last time stays a drawing for the caller).
  const left = await sw(lab).evaluate(async () => ((await chrome.storage.local.get('panelSnaps')).panelSnaps as { mode?: { mode?: string } } | undefined)?.mode?.mode ?? '')
  const opened = lab.ctx.waitForEvent('page')
  const t0 = Date.now()
  await sw(lab).evaluate((w: number) => chrome.windows.create({ url: chrome.runtime.getURL(`sidepanel.html?window=${w}`), type: 'popup', width: 420, height: 760 }), lab.docWindow)
  const panel = await opened
  if (view !== 'home' && left !== 'ask') await toAsk(panel)
  if (view === 'tasks' || view === 'passwords') await openView(panel, view)
  return { panel, t0 }
}

/**
 * Leave the panel on Ask (walked there when it was on another page), and closed: its next open
 * opens on Ask and draws Ask's look first, as for a person who left it there.
 */
export async function leaveOnAsk(lab: PanelLab): Promise<void> {
  const { panel } = await openPanel(lab, 'ask')
  await expect(askView(panel).getByTestId('ext-ask-head')).toBeVisible({ timeout: 60_000 })
  await expect.poll(() => sw(lab).evaluate(async () => ((await chrome.storage.local.get('panelSnaps')).panelSnaps as { mode?: { mode?: string } } | undefined)?.mode?.mode ?? ''), { timeout: 15_000 }).toBe('ask')
  await panel.close()
}

/** The page the view shows: Ask's header, the first page, or a task's header (the first page stays mounted, hidden, under the others). */
export const pageShown = (panel: Page): Locator => {
  const v = askView(panel)
  return v.getByTestId('ext-ask-head').or(v.getByTestId('ext-home')).or(v.getByTestId('ext-task-head')).filter({ visible: true }).first()
}

/**
 * The Ask page: from the first page, the ≡ drawer's New chat; already on Ask (or a task opened
 * there), nothing. Walnut keeps the page the panel was left on, so the next open is Ask again.
 */
export async function toAsk(panel: Page): Promise<void> {
  const v = askView(panel)
  const head = v.getByTestId('ext-ask-head')
  const home = v.getByTestId('ext-home')
  await expect(pageShown(panel)).toBeVisible({ timeout: 60_000 })
  if (await head.isVisible()) return
  if (await v.getByTestId('ext-task-head').isVisible()) { await v.getByTestId('ext-task-back').click(); await expect(home).toBeVisible() }
  await v.getByTestId('ask-walnut-menu').click()
  await v.getByTestId('ask-walnut-new').click()
  await expect(head).toBeVisible({ timeout: 30_000 })
}

/**
 * A full view over the panel: Passwords from the side bar (panel-rail.ts), the way a person picks
 * it; Tasks (the approvals' "more" link, with its Back to Chat) asked for the way the frame asks.
 */
export async function openView(panel: Page, view: 'tasks' | 'passwords'): Promise<void> {
  const v = askView(panel)
  await expect(pageShown(panel)).toBeVisible({ timeout: 60_000 })
  // Another full view on show: Back to Ask first.
  if (await panel.locator('.panel-view:not([hidden])').count()) await backToAsk(panel)
  if (view === 'tasks') {
    const f = panel.frames().find((x) => x.url().includes('view=ext-panel'))!
    await f.evaluate(() => window.parent.postMessage({ walnut: 'ext-panel', type: 'open-view', view: 'tasks' }, '*'))
  } else {
    await panel.getByTestId(`panel-rail-${view}`).click()
  }
  await expect(panel.getByTestId(`panel-view-${view}`)).toBeVisible({ timeout: 15_000 })
}

/**
 * The way back from the full view on show: Tasks has its Back in the panel's bar; Passwords and
 * Settings are side bar entries, left by its Chat (their own Back is hidden beside the side bar).
 */
export async function viewBack(panel: Page): Promise<Locator> {
  const shown = panel.locator('.panel-view:not([hidden])')
  const id = await shown.getAttribute('data-testid')
  return id === 'panel-view-passwords' || id === 'panel-view-settings'
    ? panel.getByTestId('panel-rail-chat')
    : shown.locator('> .panel-view-bar').getByTestId('panel-view-back')
}

/** Back to Ask from a full view. */
export async function backToAsk(panel: Page): Promise<void> {
  await (await viewBack(panel)).click()
  await expect(panel.locator('.panel-view:not([hidden])')).toHaveCount(0)
}

export const askView = (panel: Page): FrameLocator => panel.frameLocator('iframe.panel-frame')
export const tasksView = (panel: Page): FrameLocator => panel.frameLocator('iframe.panel-frame-tasks')
export const passwordsView = (panel: Page): FrameLocator => panel.frameLocator('iframe.panel-frame-passwords')

/** The page chip of Ask's composer: it names the page the person is on ("<title> · <host>"). */
export const pageChip = (panel: Page) => askView(panel).getByTestId('ext-panel-include')

export function selectText(doc: Page, id: string): Promise<void> {
  return doc.evaluate((id) => {
    const r = document.createRange()
    r.selectNodeContents(document.getElementById(id)!)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(r)
  }, id)
}
