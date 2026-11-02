/**
 * Each tab shows its own view (2026-11-02, a practice plugin open in two tabs on one problem: a
 * file picked in tab A switched tab B too, whose editor remounted while the user typed in it,
 * losing focus, selection and undo). localStorage is one for every tab, and the kept view was
 * read from it on every render, so B's next re-render (its clock ticks every second) took A's
 * write. Now a tab reads a kept view when it mounts it and then only its own writes change it
 * (web/src/utils/view-memory.ts); another tab's choice shows at the next mount (a reload).
 *
 * The fixture plugin (fixtures/plugin-session-plugin/web.mjs) re-renders every 200 ms, keeps the
 * file picked with walnut.ui.useView('file') and a draft per file with walnut.ui.useDraft('code',
 * { id: file }) in a text box keyed by the file. A draft lives in Walnut's draft store, one key per
 * draft: it never reaches ui-prefs. Run both engines: PW_WEBKIT=1 ... for the Mac app.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import { devices, expect, test, type Locator, type Page } from '@playwright/test'
import { bunRuntime } from '../../helpers/bun-runtime.js'

if (process.env.PW_WEBKIT) test.use({ browserName: 'webkit', userAgent: devices['Desktop Safari'].userAgent })

const PLUGIN_ID = 'plugin-session-fixture'
const APP_PATH = `/apps/${PLUGIN_ID}~main`
const SHOTS = process.env.VIEW_STATE_SHOTS ?? '/tmp/view-state-tabs'
let port = 0
let child: ChildProcessWithoutNullStreams | null = null

test.setTimeout(300_000)
test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })

async function reservePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not reserve a fixture port')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  await fs.mkdir(SHOTS, { recursive: true })
  port = await reservePort()
  let output = ''
  child = spawn(bunRuntime(), ['tests/e2e/browser/plugin-mic-server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PW_PLUGIN_MIC_PORT: String(port), PW_PLUGIN_FIXTURE: 'session' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  child.stderr.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`Plugin session fixture did not start\n${output.slice(-8000)}`)), 180_000)
    const timer = setInterval(() => {
      if (/PLUGIN_MIC_READY /.test(output)) { clearInterval(timer); clearTimeout(deadline); resolve() }
      else if (child?.exitCode !== null) { clearInterval(timer); clearTimeout(deadline); reject(new Error(`Fixture exited\n${output.slice(-8000)}`)) }
    }, 200)
  })
})

test.afterAll(async () => {
  if (!child || child.exitCode !== null) return
  const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()))
  child.kill('SIGTERM')
  const graceful = await Promise.race([exited.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), 20_000))])
  if (!graceful) child.kill('SIGKILL')
})

const base = () => `http://127.0.0.1:${port}`

/** Every test starts from no kept view: the server's copy of the view keys goes before the first load. */
async function forgetViews(page: Page): Promise<void> {
  const res = await page.request.get(`${base()}/api/ui-prefs`)
  const { prefs } = await res.json() as { prefs: Record<string, unknown> }
  const gone = Object.fromEntries(Object.keys(prefs).filter((k) => k.startsWith('open-walnut-view:') || k.startsWith('open-walnut-file-explorer'))
    .map((k) => [k, { v: null, ts: Date.now() }]))
  if (Object.keys(gone).length) await page.request.put(`${base()}/api/ui-prefs`, { data: { prefs: gone } })
}

const prepared = new WeakSet<Page>()
async function boot(page: Page, path = '/'): Promise<string[]> {
  const errors: string[] = []
  // WebKit reports a fetch a reload cut off as "... due to access control checks": the reload's, not the page's.
  page.on('pageerror', (error) => { if (!/due to access control checks/.test(error.message)) errors.push(error.message) })
  if (!prepared.has(page)) {
    prepared.add(page)
    // The Ask slot off, as plugin-session-fullscreen.spec.ts: the home column has the room.
    await page.addInitScript(() => { try { localStorage.setItem('open-walnut-home-chat-visible', '0') } catch { /* storage off */ } })
  }
  await page.goto(`${base()}${path}`)
  await expect(page.locator('.app-shell, .todo-panel').first()).toBeVisible({ timeout: 60_000 })
  return errors
}


async function openTab(page: Page): Promise<string[]> {
  const errors = await boot(page, APP_PATH)
  await expect(page.getByTestId('session-fixture-app')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('session-fixture-editor')).toBeVisible({ timeout: 30_000 })
  return errors
}

const editor = (page: Page): Locator => page.getByTestId('session-fixture-editor')
const focusedTestId = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null)
/** Marks the text box so a remount (a new element) shows. */
const markEditor = (page: Page) => editor(page).evaluate((el) => { (el as HTMLElement).dataset.mark = 'kept' })
const editorMark = (page: Page) => editor(page).getAttribute('data-mark')

async function shot(page: Page, name: string): Promise<void> {
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await page.screenshot({ path: `${SHOTS}/${engine}-${name}.png` })
}

test('another tab\'s pick never moves this tab while it is in use; it shows at the next mount', async ({ page: a, context }) => {
  await forgetViews(a)
  const errorsA = await openTab(a)
  const b = await context.newPage()
  const errorsB = await openTab(b)
  await expect(b.getByTestId('session-fixture-file')).toHaveText('a.py')

  // B types in a.py's box.
  await editor(b).click()
  await b.keyboard.type('def solve(nums):')
  await markEditor(b)

  // A picks b.py while B's clock re-renders B five times a second.
  await a.bringToFront()
  await a.getByTestId('session-fixture-file-b.py').click()
  await expect(a.getByTestId('session-fixture-file')).toHaveText('b.py')
  await expect(editor(a)).toHaveValue('')
  await a.waitForTimeout(1500)

  // B: still a.py, the same text box (not remounted), still focused, the caret where it was.
  await b.bringToFront()
  await expect(b.getByTestId('session-fixture-file')).toHaveText('a.py')
  expect(await editorMark(b)).toBe('kept')
  expect(await focusedTestId(b)).toBe('session-fixture-editor')
  expect(await editor(b).evaluate((el) => (el as HTMLTextAreaElement).selectionStart)).toBe('def solve(nums):'.length)
  await b.keyboard.type(' return 0')
  await expect(editor(b)).toHaveValue('def solve(nums): return 0')
  await shot(b, '1-tab-b-kept-its-file')

  // Typing in B while A switches files back and forth: not a key lost, nothing remounts.
  const typing = b.keyboard.type(' # keep going', { delay: 60 })
  for (const f of ['a.py', 'b.py', 'a.py', 'b.py']) {
    await a.getByTestId(`session-fixture-file-${f}`).click()
    await a.waitForTimeout(150)
  }
  await typing
  await expect(editor(b)).toHaveValue('def solve(nums): return 0 # keep going')
  expect(await editorMark(b)).toBe('kept')
  expect(await focusedTestId(b)).toBe('session-fixture-editor')
  await expect(b.getByTestId('session-fixture-file')).toHaveText('a.py')

  // B reloads: it mounts again and takes the file A left (b.py); its own a.py draft is kept.
  await b.waitForTimeout(400)
  await b.reload()
  await expect(b.getByTestId('session-fixture-file')).toHaveText('b.py', { timeout: 60_000 })
  await b.getByTestId('session-fixture-file-a.py').click()
  await expect(editor(b)).toHaveValue('def solve(nums): return 0 # keep going')
  await shot(b, '2-tab-b-after-reload')

  // A, still open, never took B's draft or its last pick: b.py, an empty box.
  await expect(a.getByTestId('session-fixture-file')).toHaveText('b.py')
  await expect(editor(a)).toHaveValue('')

  // The file pick syncs (ui-prefs: B's a.py, the last one picked); the draft goes to the draft store.
  await a.waitForTimeout(1500) // the mirror's 800 ms debounce
  const res = await a.request.get(`${base()}/api/ui-prefs`)
  const { prefs } = await res.json() as { prefs: Record<string, { v: unknown }> }
  expect(prefs[`open-walnut-view:plugin.${PLUGIN_ID}.file`]?.v).toBe(JSON.stringify('a.py'))
  expect(JSON.stringify(prefs)).not.toContain('keep going')
  const draftKey = `draft:plugin:${PLUGIN_ID}:code:a.py`
  expect(await b.evaluate((k) => localStorage.getItem(k), draftKey)).toBe('def solve(nums): return 0 # keep going')
  await expect.poll(async () => {
    const r = await a.request.get(`${base()}/api/drafts`)
    return JSON.stringify(await r.json())
  }, { timeout: 15_000 }).toContain('keep going')
  expect([...errorsA, ...errorsB]).toEqual([])
})

test("another tab's session panel view never moves this tab's: Files opened in A stays out of B until B mounts again", async ({ page: a, context }) => {
  await forgetViews(a)
  const errorsA = await openTab(a)
  const b = await context.newPage()
  const errorsB = await openTab(b)
  const panel = (p: Page) => p.locator('.plugin-session-view .session-panel[data-session-id="pw-plugin-session"]')
  await expect(panel(b)).toBeVisible({ timeout: 30_000 })
  await a.bringToFront()
  await panel(a).locator('.session-action-chip', { hasText: /^Files$/ }).click()
  await expect(panel(a).locator('.session-file-explorer')).toBeVisible({ timeout: 20_000 })
  await a.waitForTimeout(1500)
  await b.bringToFront()
  await expect(panel(b).locator('.session-file-explorer')).toHaveCount(0)
  await expect(panel(b).locator('.session-action-chip.session-action-chip-active')).toHaveCount(0)
  await b.reload()
  await expect(panel(b).locator('.session-file-explorer')).toBeVisible({ timeout: 60_000 })
  expect([...errorsA, ...errorsB]).toEqual([])
})
