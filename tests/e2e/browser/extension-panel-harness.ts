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
  await expect(connect.getByRole('heading', { name: 'Connect this browser to Walnut?' })).toBeVisible({ timeout: 60_000 })
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
 * Open the panel window for the person's window, timed from the click. The panel opens on Ask
 * (Walnut's own Ask, with the key in its header); `view` then opens the drawer's Tasks or Passwords
 * row, the full view with its Back control (panel-ask.ts). A Walnut too old for that shape shows
 * the three tabs, where `view` picks the tab it keeps.
 */
export async function openPanel(lab: PanelLab, view?: 'ask' | 'tasks' | 'passwords'): Promise<{ panel: Page; t0: number }> {
  if (view) await sw(lab).evaluate((t: string) => chrome.storage.local.set({ panelTab: t }), view)
  const opened = lab.ctx.waitForEvent('page')
  const t0 = Date.now()
  await sw(lab).evaluate((w: number) => chrome.windows.create({ url: chrome.runtime.getURL(`sidepanel.html?window=${w}`), type: 'popup', width: 420, height: 760 }), lab.docWindow)
  const panel = await opened
  if (view === 'tasks' || view === 'passwords') await openView(panel, view)
  return { panel, t0 }
}

/** The ≡ drawer's Tasks or Passwords row: that full view over Ask, with Back. */
export async function openView(panel: Page, view: 'tasks' | 'passwords'): Promise<void> {
  const v = askView(panel)
  await expect(v.getByTestId('ext-ask-head')).toBeVisible({ timeout: 60_000 })
  // Another full view on show: Back to Ask first.
  if (await panel.locator('.panel-view:not([hidden])').count()) await backToAsk(panel)
  await v.getByTestId('ask-walnut-menu').click()
  await v.getByTestId(`ext-drawer-${view}`).click()
  await expect(panel.getByTestId(`panel-view-${view}`)).toBeVisible({ timeout: 15_000 })
}

/**
 * The Back of the full view on show: Tasks has it in the panel's bar, Passwords in its own bar
 * inside its frame (popup.ts `inView`).
 */
export async function viewBack(panel: Page): Promise<Locator> {
  const shown = panel.locator('.panel-view:not([hidden])')
  const inFrame = (await shown.getAttribute('data-testid')) === 'panel-view-passwords'
  return inFrame
    ? shown.frameLocator('iframe.panel-frame-passwords').getByTestId('panel-view-back')
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
