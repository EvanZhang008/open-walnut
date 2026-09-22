/**
 * Shared steps for the composer "+" menu -> "Engine settings" popover specs
 * (chromium, the scope/disk file, the failure file and the WebKit pin).
 *
 * Everything runs against the fixture server on:3457, whose HOME is isolated
 * (test-server.ts seeds HOME/.claude/settings.json). Sessions are started by
 * the specs themselves through POST /api/sessions/quick-start in fresh
 * directories under `${fixtureRoot}/projects/`, so a project-scope write can
 * be asserted on disk without touching any developer file.
 *
 * Stubs mutate a REAL response captured through `route.fetch`, so a stubbed
 * body always has the shape the server sends today.
 */
import { expect, type APIRequestContext, type Locator, type Page, type Route } from '@playwright/test'
import { readdir, readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { discoverBrowserFixture } from './codex-test-audit'
import { fixtureHome, lockUserSettingsFile, readClaudeSettings } from './engine-settings-helpers'
import { loadHome, seedColumns } from './draft-helpers'

export const TEST_PORT = 3457
export const SHOTS_DIR = '/tmp/engine-settings/ux-slice/shots'
/** Route glob for the claude settings endpoint, every method and query. */
export const CLAUDE_SETTINGS_API = '**/api/engines/claude/settings**'

export type Scope = 'default' | 'project'

export interface FileView {
  id: string; path: string; label: string; format: string; scope: 'user' | 'project'
  readOnly: boolean; exists: boolean; error?: string
}
export interface ItemView {
  key: string; label: string; help: string; type: 'boolean' | 'select' | 'text' | 'number'
  options?: Array<{ value: string; label: string; help?: string }>; allowCustom?: boolean
  default: unknown; defaultLabel?: string; scope: 'sessions' | 'terminal' | 'updates'
  file: string; value: unknown; source: 'file' | 'overlay' | 'legacy' | 'default'
  overlay?: { file: string; path: string }; legacy?: { file: string; path: string }
  writeTarget: { file: string; path: string; holds: boolean }
  overriddenBy?: { file: string; path: string }; envOverride?: { name: string; value: string }; invalid?: string
  honoredHere?: boolean; launchOverride?: string; projectLayer?: boolean; appliesOn?: string
}
export interface GroupView { id: string; title: string; help?: string; items: ItemView[] }
export interface View {
  engine: string; displayName: string; host: string; note?: string; envChecked: boolean; cwd?: string
  scope: Scope; projectScopeAvailable: boolean; appliesOn?: string; files: FileView[]; groups: GroupView[]
  changed?: string[]; gitExclude?: { path: string; outcome: string; error?: string }
}

export const sessionsItems = (view: View): ItemView[] => view.groups.find((g) => g.id === 'sessions')?.items ?? []
export const sessionsGroup = (view: View): GroupView | undefined => view.groups.find((g) => g.id === 'sessions')
export const itemOf = (view: View, key: string): ItemView | undefined =>
  view.groups.flatMap((g) => g.items).find((i) => i.key === key)

export async function fixtureRoot(): Promise<string> {
  return (await discoverBrowserFixture(TEST_PORT)).fixtureRoot
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const uniq = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

/** A fresh git checkout under the fixture's projects dir; its verdicts come from THIS repo only. */
export async function makeGitProject(root: string, name = uniq('popover-repo')): Promise<string> {
  const repo = path.join(root, 'projects', name)
  await fs.mkdir(repo, { recursive: true })
  git(repo, 'init', '-q')
  git(repo, 'config', 'core.excludesFile', path.join(repo, '.no-global-excludes'))
  return repo
}

/** A fresh directory that is NOT a git checkout (and must stay that way). */
export async function makePlainProject(root: string, name = uniq('popover-plain')): Promise<string> {
  const dir = path.join(root, 'projects', name)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/** A real session (mock CLI) whose working directory is `cwd`; returns its id (= data-session-id). */
export async function startSessionAt(request: APIRequestContext, cwd: string, engine?: string): Promise<string> {
  const res = await request.post('/api/sessions/quick-start', { data: { cwd, message: '', ...(engine ? { engine } : {}) } })
  expect(res.ok(), await res.text()).toBeTruthy()
  const { sessionId } = await res.json() as { sessionId?: string }
  expect(sessionId).toBeTruthy()
  return sessionId!
}

// ── DOM ──────────────────────────────────────────────────────────────────────

/** The home column panel of ONE session: never `.first` on '/' (the ask slot sits earlier in the DOM). */
export const panelFor = (page: Page, sid: string): Locator =>
  page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"]`)

export const plusButton = (panel: Locator): Locator => panel.locator('.chat-plus-btn')
export const composerTextarea = (panel: Locator): Locator => panel.locator('.chat-input-textarea')

/** Seed the column strip with `sids`, load '/', and wait for every panel's "+" button. */
export async function openPanels(page: Page, sids: readonly string[]): Promise<Locator[]> {
  await seedColumns(page, sids)
  await loadHome(page)
  const panels = sids.map((sid) => panelFor(page, sid))
  for (const panel of panels) await expect(plusButton(panel)).toBeVisible({ timeout: 30_000 })
  return panels
}

export async function openPlusMenu(panel: Locator): Promise<Locator> {
  await plusButton(panel).click()
  const menu = panel.locator('.chat-plus-menu[role=menu]')
  await expect(menu).toBeVisible()
  return menu
}

export const engineSettingsRow = (menu: Locator): Locator =>
  menu.locator('button.chat-plus-menu-item[role=menuitem]', { hasText: 'Engine settings' })

export const dialogOf = (page: Page): Locator => page.locator('.engine-settings-popover[role=dialog]')

/** "+" -> Engine settings; returns the (single) dialog once it is on screen. */
export async function openPopover(page: Page, panel: Locator): Promise<Locator> {
  const menu = await openPlusMenu(panel)
  await engineSettingsRow(menu).click()
  const dialog = dialogOf(page)
  await expect(dialog).toBeVisible({ timeout: 15_000 })
  return dialog
}

export const scopeOption = (dialog: Locator, scope: Scope): Locator =>
  dialog.locator(`.engine-settings-scope-option[role=radio][data-scope="${scope}"]`)

export const popoverRow = (dialog: Locator, key: string): Locator => dialog.getByTestId(`engine-setting-row-${key}`)
export const popoverRowWrap = (dialog: Locator, key: string): Locator =>
  dialog.locator(`.engine-settings-popover-row[data-key="${key}"]`)
export const rowsArea = (dialog: Locator): Locator => dialog.locator('.engine-settings-popover-rows')
export const filterBox = (dialog: Locator): Locator => dialog.locator('input.engine-settings-filter')
export const savedLine = (dialog: Locator): Locator => dialog.getByTestId('engine-settings-saved')
export const banner = (dialog: Locator): Locator => dialog.getByTestId('engine-settings-banner')

/** Ids carry dots ('permissions.defaultMode'); a CSS id selector needs them escaped. */
export const escapeId = (s: string): string => s.replace(/([.#:[\],()\s])/g, '\\$1')

export const rowControl = (dialog: Locator, engine: string, key: string): Locator =>
  dialog.locator(`#engine-setting-${engine}-${escapeId(key)}`)

/** Rows have loaded from disk: `data-state=ready` and the first sessions row is on screen. */
export async function waitForRows(dialog: Locator, firstKey = 'alwaysThinkingEnabled'): Promise<void> {
  await expect(dialog).toHaveAttribute('data-state', 'ready', { timeout: 30_000 })
  await expect(popoverRow(dialog, firstKey)).toBeVisible({ timeout: 30_000 })
}

// ── Disk ─────────────────────────────────────────────────────────────────────

export const localFileOf = (cwd: string): string => path.join(cwd, '.claude', 'settings.local.json')

/** `<cwd>/.claude/settings.local.json` parsed, or null when it does not exist. */
export async function readLocal(cwd: string): Promise<Record<string, unknown> | null> {
  try { return JSON.parse(await fs.readFile(localFileOf(cwd), 'utf-8')) as Record<string, unknown> } catch { return null }
}

export async function readExclude(cwd: string): Promise<string> {
  try { return await fs.readFile(path.join(cwd, '.git', 'info', 'exclude'), 'utf-8') } catch { return '' }
}

export const exists = async (p: string): Promise<boolean> => fs.access(p).then(() => true, () => false)

let releaseUserFile: (() => Promise<void>) | null = null

/**
 * First line of every popover spec's `beforeAll`: queue behind any other spec
 * file that writes the fixture's user settings file (see lockUserSettingsFile),
 * then reseed the keys these specs flip so a file always starts from the seed
 * whatever the previous file left behind.
 */
export async function claimUserFile(request: APIRequestContext): Promise<void> {
  const home = await fixtureHome(request)
  releaseUserFile = await lockUserSettingsFile(home)
  await writeSeedKeys(home)
}

/**
 * Put the seeded user-settings keys a popover spec touches back, so the
 * Settings-page specs (which read the same fixture HOME) still start from the
 * seed, then hand the user file to the next waiting spec file.
 */
export async function restoreSeed(request: APIRequestContext): Promise<void> {
  await writeSeedKeys(await fixtureHome(request))
  const release = releaseUserFile
  releaseUserFile = null
  await release?.()
}

async function writeSeedKeys(home: string): Promise<void> {
  const file = path.join(home, '.claude', 'settings.json')
  let current: Record<string, unknown>
  try { current = await readClaudeSettings(home) } catch { current = {} }
  const restored = { ...current, alwaysThinkingEnabled: true, outputStyle: 'Explanatory', language: 'Chinese', verbose: false }
  await fs.writeFile(file, JSON.stringify(restored, null, 2))
}

// ── Network stubs ────────────────────────────────────────────────────────────

export interface StubMatch {
  method: 'GET' | 'PATCH'
  /** Only requests whose scope query equals this (absent = 'default'); omit to match any scope. */
  scope?: Scope
  /** Hold the answer this long before fulfilling (skeleton / saving states). */
  delayMs?: number
  /** Stop intercepting after this many matches (the rest fall through to the server). */
  times?: number
}
export type CannedReply = { status: number; body: unknown }
/** `'real'` = fetch the real answer and fulfill it (after `delayMs`); a function mutates the real body. */
export type StubReply = 'real' | CannedReply | ((real: View, route: Route) => View | CannedReply)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const scopeOfUrl = (url: string): Scope => (new URL(url).searchParams.get('scope') === 'project' ? 'project' : 'default')

/**
 * Intercept the claude settings endpoint. Non-matching requests fall through
 * (`route.fallback`), so a GET stub never swallows the PATCH next to it.
 * Returns the count of matched requests (live) and an unroute function.
 */
export async function stubSettings(page: Page, match: StubMatch, reply: StubReply): Promise<{ hits: string[]; unroute: () => Promise<void> }> {
  const hits: string[] = []
  const handler = async (route: Route) => {
    const req = route.request()
    if (req.method() !== match.method) return route.fallback()
    if (match.scope && scopeOfUrl(req.url()) !== match.scope) return route.fallback()
    if (match.times !== undefined && hits.length >= match.times) return route.fallback()
    hits.push(req.url())
    if (match.delayMs) await sleep(match.delayMs)
    if (reply === 'real') {
      const res = await route.fetch()
      return route.fulfill({ response: res })
    }
    let canned: CannedReply
    if (typeof reply === 'function') {
      const res = await route.fetch()
      // A real failure is passed through untouched: mutating an error body would hand the UI a fake 200.
      if (!res.ok()) return route.fulfill({ response: res })
      // ONE read, as text, and parsed here: calling res.json() after the body has
      // been read (or after the context started tearing the response down at the
      // end of a test) fails with "Response has been disposed", which reads like a
      // product bug and is only this helper holding the response too long.
      const real = JSON.parse(await res.text()) as View
      const out = reply(real, route)
      // A view never carries `status`/`body`; a canned error always does.
      canned = 'status' in out && 'body' in out ? out : { status: 200, body: out }
    } else {
      canned = reply
    }
    return route.fulfill({ status: canned.status, contentType: 'application/json', body: JSON.stringify(canned.body) })
  }
  await page.route(CLAUDE_SETTINGS_API, handler)
  return { hits, unroute: () => page.unroute(CLAUDE_SETTINGS_API, handler) }
}

export const stubGet = (page: Page, reply: StubReply, opts: Omit<StubMatch, 'method'> = {}) =>
  stubSettings(page, { method: 'GET', ...opts }, reply)
export const stubPatch = (page: Page, reply: StubReply, opts: Omit<StubMatch, 'method'> = {}) =>
  stubSettings(page, { method: 'PATCH', ...opts }, reply)

/** The real view for a session, straight from the server (for order / copy comparisons). */
export async function captureView(request: APIRequestContext, sessionId: string, scope?: Scope): Promise<View> {
  const res = await request.get(`/api/engines/claude/settings?sessionId=${sessionId}${scope ? `&scope=${scope}` : ''}`)
  expect(res.status(), await res.text()).toBe(200)
  return await res.json() as View
}

/** Every settings request the page makes from now on, as `METHOD url`. */
export function watchSettingsRequests(page: Page): string[] {
  const seen: string[] = []
  page.on('request', (req) => { if (/\/api\/engines\/[^/]+\/settings/.test(req.url())) seen.push(`${req.method()} ${req.url()}`) })
  return seen
}

// ── Screenshots and copy ─────────────────────────────────────────────────────

export async function shot(page: Page, name: string): Promise<string> {
  await fs.mkdir(SHOTS_DIR, { recursive: true })
  const file = path.join(SHOTS_DIR, `${name}.png`)
  await page.screenshot({ path: file })
  return file
}

/**
 * Same rule as web/src/utils/engine-settings-copy.ts shortenCwd, restated
 * so the spec pins it: two head segments, `…`, the last segment, then whole
 * segments given back head first, then tail, while the result fits `max`.
 */
export function shortCwd(cwd: string, max = 48): string {
  if (cwd.length <= max) return cwd
  const root = cwd.startsWith('~/') ? '~/' : cwd.startsWith('/') ? '/' : ''
  const segments = cwd.slice(root.length).split('/').filter(Boolean)
  let short = cwd
  if (segments.length > 3) {
    let head = 2
    let tail = 1
    const render = (h: number, t: number) =>
      `${root}${segments.slice(0, h).join('/')}/…/${segments.slice(segments.length - t).join('/')}`
    for (;;) {
      if (head + tail + 1 < segments.length && render(head + 1, tail).length <= max) { head += 1; continue }
      if (head + tail + 1 < segments.length && render(head, tail + 1).length <= max) { tail += 1; continue }
      break
    }
    short = render(head, tail)
  }
  if (short.length > max) short = `${short.slice(0, Math.max(1, max - 1))}…`
  return short
}

export const HOST_LABEL = 'This Mac'
/** One line; the per-project exception and the created-file fine print live in the About overlay. */
export const LOCAL_SCOPE_NOTE = `Saves to your user settings on ${HOST_LABEL}, as Claude Code itself would.`
export const NEXT_TURN_SENTENCE = "Applies on this session's next turn."
export const projectScopeNote = (_cwd: string) =>
  'Saves to .claude/settings.local.json in this project · not tracked by git.'
export const savedUserSentence = `Saved to user settings on ${HOST_LABEL} (all projects).`
export const savedProjectBase = (cwd: string) => `Saved to this project (local), ${shortCwd(cwd)} only.`
/** The footer link before the view answers. */
export const LOADING_LINK_TEXT = 'Settings › Engines'
/**: `<titles joined by " and "> settings (<count>) are in Settings › Engines`, from the response. */
export const otherGroupsLinkText = (view: View): string => {
  const others = view.groups.filter((g) => g.id !== 'sessions' && g.items.length > 0)
  if (others.length === 0) return 'Open Settings › Engines'
  const count = others.reduce((n, g) => n + g.items.length, 0)
  return `${others.map((g) => g.title).join(' and ')} settings (${count}) are in Settings › Engines`
}
/** The footer sentence after a Reset under project scope, when the user file holds the key. */
export const removedProjectSentence = (label: string) =>
  `Removed ${label} from this project (local); the user settings value applies again.`

/** No saved sentence on screen: the footer line is absent or blank. */
export async function expectNoSaved(dialog: Locator): Promise<void> {
  await expect.poll(async () => {
    const line = savedLine(dialog)
    return (await line.count()) === 0 || ((await line.textContent()) ?? '').trim() === ''
  }).toBe(true)
}

/**
 * Click the composer textarea at a point the dialog does not cover. The popover
 * sits above the "+" button and the textarea is taller than that button, so the
 * dialog's footer can overlap the textarea's centre; a user aims for the free part.
 */
export async function clickComposerOutside(panel: Locator, dialog: Locator): Promise<void> {
  const area = composerTextarea(panel)
  const t = (await area.boundingBox())!
  const d = (await dialog.boundingBox())!
  const inside = (x: number, y: number) => x >= d.x && x <= d.x + d.width && y >= d.y && y <= d.y + d.height
  const ys = [t.height / 2, Math.min(t.height - 6, 12), t.height - 8]
  for (const y of ys) {
    for (let x = t.width - 12; x > 8; x -= 24) {
      if (!inside(t.x + x, t.y + y)) { await area.click({ position: { x, y } }); return }
    }
  }
  throw new Error(`the dialog covers the whole composer textarea (textarea ${JSON.stringify(t)}, dialog ${JSON.stringify(d)})`)
}

// ── Geometry and sources (shared by the layout-minded specs) ─────────────────

export const REPO = 'web/src'
export const NEW_SOURCES = [
  'utils/engine-settings-copy.ts', 'hooks/useEngineSettings.ts', 'hooks/engine-settings-model.ts',
  'components/chat/plus-menu-actions.ts', 'components/chat/PlusMenuActionRows.tsx',
  'components/sessions/useEngineSettingsEntry.tsx', 'components/sessions/engine-settings-popover-focus.ts',
]

/** Any file the popover slice added (component + stylesheet), by name. */
export async function popoverSources(): Promise<string[]> {
  const hits: string[] = []
  for (const dir of ['components/sessions', 'components/settings', 'components/chat', 'styles']) {
    const full = path.join(REPO, dir)
    for (const name of await readdir(full).catch(() => [] as string[])) {
      if (/engine-?settings-?popover|EngineSettingsPopover/i.test(name)) hits.push(path.join(full, name))
    }
  }
  return hits
}

export const readSource = (file: string) => readFile(file, 'utf-8').catch(() => '')

export const rect = (loc: Locator) => loc.evaluate((el) => {
  const r = el.getBoundingClientRect()
  return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
})

export async function expectInViewport(page: Page, dialog: Locator): Promise<void> {
  const r = await rect(dialog)
  const vp = page.viewportSize()!
  expect(r.top, 'top').toBeGreaterThanOrEqual(0)
  expect(r.left, 'left').toBeGreaterThanOrEqual(0)
  expect(r.bottom, 'bottom').toBeLessThanOrEqual(vp.height + 0.5)
  expect(r.right, 'right').toBeLessThanOrEqual(vp.width + 0.5)
}

/** A real mouse click on the panel's message area, at a point the dialog does not cover. */
export async function clickOutside(page: Page, panel: Locator, dialog: Locator): Promise<void> {
  const p = await rect(panel)
  const d = await rect(dialog)
  // At 620px the dialog can span a narrow panel's whole width, so points are
  // tried at several heights of the panel, not just one.
  for (const y of [p.top + Math.min(120, p.height / 3), p.top + 8, d.bottom + 8]) {
    if (y <= p.top || y >= p.bottom) continue
    const x = [p.left + 12, p.right - 12].find((cx) => cx < d.left || cx > d.right || y < d.top || y > d.bottom)
    if (x !== undefined) { await page.mouse.click(x, y); return }
  }
  expect(undefined, 'a panel point outside the dialog').toBeDefined()
}

/** iOS-style row: text left, control right, vertically centered; no band under the text. */
export async function expectSideBySide(dialog: Locator, key: string): Promise<void> {
  const row = await rect(popoverRow(dialog, key))
  const copy = await rect(popoverRow(dialog, key).locator('.settings-row-copy'))
  const control = await rect(popoverRow(dialog, key).locator('.engine-setting-control'))
  expect(control.left).toBeGreaterThanOrEqual(copy.right - 0.5)
  const rowCenter = row.top + row.height / 2
  const controlCenter = control.top + control.height / 2
  expect(Math.abs(controlCenter - rowCenter)).toBeLessThanOrEqual(6)
}

/** Rows whose whole box sits inside the rows area's visible box (plus the geometry, for the report). */
export const rowsGeometry = (dialog: Locator) => rowsArea(dialog).evaluate((area) => {
  const a = area.getBoundingClientRect()
  const rows = Array.from(area.querySelectorAll('.engine-settings-popover-row')).map((el) => {
    const r = el.getBoundingClientRect()
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) }
  })
  return {
    area: { top: Math.round(a.top), bottom: Math.round(a.bottom), height: Math.round(a.height) },
    rows: rows.slice(0, 5),
    visible: rows.filter((r) => r.top >= a.top - 0.5 && r.bottom <= a.bottom + 0.5).length,
  }
})
export const fullyVisibleRows = async (dialog: Locator) => (await rowsGeometry(dialog)).visible
