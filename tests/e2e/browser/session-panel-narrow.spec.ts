/**
 * A session panel stays readable in a narrow column: three session columns on Home, each
 * clamped to 200px (and to 330px, the width the user had).
 *
 * 2026-11-04, the user, on the Mac app with three narrow columns on Home: "make sure in
 * narrow the UI still reasonable"; "maybe we should make the label another line if the
 * space is narrow"; "never should be like this, one button like just use so much space and
 * in narrow mode the text can only use another col". Two screens: an idle notice ("<host> is
 * reachable, and this session's process is not running...") whose Reconnect button kept
 * its own column the whole height of the box, so in a ~330px column the words got ~65px
 * and the host name broke letter by letter; and a header title row that cut the title to
 * "Aut...", the wait pill to "Wait un...", with T, W, the tag count and the kebab all on
 * one line.
 *
 * Every surface below is drawn in the real app and held to the same rules,
 * expectReadablePanel (session-panel-narrow-helpers.ts: R1 readable lines, R2 nothing past
 * the panel, R3 a notice's words use the box, R4 the title row shows 8+ chars of each
 * label), plus R5 for a notice that names a host. The checker reads everything visible in
 * the panel, so a notice kind added later is caught without being listed here.
 *
 * Surfaces and how each is drawn (only HTTP answers are shaped; layout is the app's):
 *   - error notice, host proved reachable: a remote session record in `error`, its recheck
 *     answering reachable with an infrastructure claim (SessionPanel's provedReachable);
 *   - error notice, host not proved: the same record, the recheck proving nothing;
 *   - idle notice: `stopped` with errorMessage "No output for 30 min";
 *   - "Session returned empty": `stopped`, a history with a question and no reply;
 *   - folder gone: a record carrying `cwdGone` with a long path;
 *   - header: a real task of this spec's own, parked (WAITING with a clock), with a parent
 *     (Worker), a subtask (Leader), a trigger and link tags, and a long title;
 *   - compact offer: an idle record whose prompt cache went cold over 200K tokens ago;
 *   - permission card: a running record whose stream snapshot holds a pending permission.
 * Not drawn here:
 *   - the Ask Walnut slot's host problem card lives in the chat slot, whose width
 *     the home layout sets, not a session column; it needs host status socket frames
 *     (host-problems-helpers.ts) and is held by the host-problems specs;
 *   - the Org node chat (OrgNodeDetail's SessionPanel with a headerSlot) is on the Org page,
 *     not a Home column; the same checker can run on it once a spec opens a node chat.
 *
 * The panel count is read from config by the page; it is answered as 3 for this page only
 * (nothing is written to the fixture's config, and a config write the page makes keeps the
 * server's own value), so this spec needs no panel count lock.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { clampColumn } from './composer-controls-overflow-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { expectHostNameCut, expectReadablePanel, shootPanel } from './session-panel-narrow-helpers'
import { dropFakes } from './route-teardown'

const PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const API = `http://localhost:${PORT}`
const TARGET = 'pw-narrow-panel-target'
const FILLERS = ['pw-narrow-panel-filler-a', 'pw-narrow-panel-filler-b']
const HOST = 'devbox'
const HOSTNAME = 'garden-box-example-7f3a9c21.north-3.lab.example.net'
const WIDTHS = [200, 330] as const
/** The config key the page reads its column count from (read, never written here). */
const PANEL_COUNT_KEY = 'session_panels'

test.describe.configure({ timeout: 150_000 })
test.use({ viewport: { width: 1600, height: 900 } })

type Row = Record<string, unknown>

const userRow = (text: string, i: number): Row => ({ role: 'user', text, msgId: `narrow-u${i}`, timestamp: new Date(Date.UTC(2026, 10, 4, 9, 0, i)).toISOString() })
const replyRow = (text: string, i: number): Row => ({ role: 'assistant', text, msgId: `narrow-a${i}`, timestamp: new Date(Date.UTC(2026, 10, 4, 9, 0, i)).toISOString() })
const CHAT: Row[] = [
  userRow('Tidy up the stale thumbnails in the photo archive folders.', 0),
  replyRow('Done: 42 thumbnails removed across three folders, and the tidy-up runs again on Monday.', 1),
]

/** Answer one session's record and history; `record` overrides the idle defaults. */
async function mockSession(page: Page, id: string, record: Row = {}, messages: Row[] = CHAT): Promise<void> {
  // The server has no such session: without this its recovery read answers "not found"
  // and every panel draws a "Recovery status unavailable" card no real session shows.
  await page.route(new RegExp(`/api/sessions/${id}/supervision$`), (route) => route.fulfill({
    json: {
      available: true, startup: 'on-demand', stopRequest: null,
      supervision: { enabled: false, state: 'inactive', reason: null, generation: 0, retryAt: null, updatedAt: Date.now() },
    },
  }))
  await page.route(new RegExp(`/api/sessions/${id}/history`), (route) => {
    const since = new URL(route.request().url()).searchParams.get('since')
    if (since !== null) return route.fulfill({ json: { messages: messages.slice(Number(since)), total: messages.length, cursor: messages.length, delta: true } })
    return route.fulfill({ json: { messages, total: messages.length, cursor: messages.length, delta: false } })
  })
  await page.route(new RegExp(`/api/sessions/${id}(\\?|$)`), (route, request) => {
    if (request.method() !== 'GET') return route.fulfill({ json: { ok: true } })
    return route.fulfill({
      json: {
        session: {
          claudeSessionId: id, taskId: `${id}-task`, project: 'Walnut',
          process_status: 'idle', mode: 'bypass', engine: 'claude',
          model: 'claude-fable-5-1', effort: 'high', effectiveEffort: 'high', output_mode: 'rich',
          startedAt: '2026-11-04T09:00:00.000Z', lastActiveAt: new Date().toISOString(),
          messageCount: messages.length, title: 'Photo tidy-up', cwd: '/tmp',
          ...record,
        },
      },
    })
  })
}

/** The recheck an `error` session makes on open: reachable with an infrastructure claim, or nothing proved. */
async function mockRecheck(page: Page, id: string, reachable: boolean): Promise<void> {
  await page.route(new RegExp(`/api/sessions/${id}/recheck$`), (route) => route.fulfill({
    json: reachable
      ? { sessionId: id, checked: true, reachable: true, alive: false, processStatus: 'error', infraClaim: true }
      : { sessionId: id, checked: false, reachable: false, processStatus: 'error', infraClaim: true, reason: 'no_pooled_connection' },
  }))
}

/**
 * Three columns for this page: the config read says 3. A config write the page makes (a
 * `ui` merge read from this answer) is sent with the server's own count, so nothing here
 * changes the shared fixture.
 */
async function threeColumnsForThisPage(page: Page): Promise<void> {
  let serverCount: unknown
  await page.route(/\/api\/config(\?|$)/, async (route, request) => {
    if (request.method() === 'GET') {
      const res = await route.fetch()
      const body = await res.json() as { config?: { ui?: Row } }
      serverCount = body.config?.ui?.[PANEL_COUNT_KEY]
      const ui: Row = { ...(body.config?.ui ?? {}) }
      ui[PANEL_COUNT_KEY] = '3'
      return route.fulfill({ response: res, json: { ...body, config: { ...(body.config ?? {}), ui } } })
    }
    const sent = JSON.parse(request.postData() ?? '{}') as { ui?: Row }
    if (sent.ui && PANEL_COUNT_KEY in sent.ui) {
      const ui: Row = { ...sent.ui }
      if (serverCount === undefined) delete ui[PANEL_COUNT_KEY]
      else ui[PANEL_COUNT_KEY] = serverCount
      return route.continue({ postData: JSON.stringify({ ...sent, ui }) })
    }
    return route.fallback()
  })
}

/** Home with the target first and two fillers beside it; returns the target's panel. */
async function openNarrowHome(page: Page, waitFor: (panel: Locator) => Promise<void>): Promise<Locator> {
  await isolateUiPrefs(page)
  await threeColumnsForThisPage(page)
  for (const id of FILLERS) await mockSession(page, id)
  const ids = [TARGET, ...FILLERS]
  await page.addInitScript((list) => {
    try {
      sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify((list as string[]).map((id) => ({ id, locked: false }))))
    } catch { /* ignore */ }
  }, ids)
  await page.goto('/')
  const columns = page.locator('.main-page-sessions-area > .main-page-session-column')
  await expect(columns, 'three session columns on Home').toHaveCount(3, { timeout: 60_000 })
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${TARGET}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await expect(panel.locator('.session-panel-header-top', { hasText: 'Loading...' })).toHaveCount(0, { timeout: 20_000 })
  await waitFor(panel)
  return panel
}

/** Clamp every column to `px` and wait until the target's panel has that width. */
async function atWidth(page: Page, panel: Locator, px: number): Promise<void> {
  await clampColumn(page, px)
  await expect.poll(async () => Math.round((await panel.boundingBox())?.width ?? 0), { timeout: 10_000 })
    .toBeLessThanOrEqual(px)
  await expect.poll(async () => Math.round((await panel.boundingBox())?.width ?? 0), { timeout: 10_000 })
    .toBeGreaterThan(px - 24)
}

/** At every width: the rules over the whole panel, then a screenshot. */
async function checkAtWidths(page: Page, panel: Locator, name: string, extra?: (px: number) => Promise<void>): Promise<void> {
  for (const px of WIDTHS) {
    await atWidth(page, panel, px)
    await expectReadablePanel(page, panel, `${name} at ${px}px`)
    await extra?.(px)
    await shootPanel(panel, `${name}-${px}`)
  }
}

/** The fix's contract: the notice is a PanelNotice, so R3 has a root to measure. */
async function expectNoticeContract(panel: Locator, name: string): Promise<void> {
  expect.soft(await panel.locator('[data-panel-notice]').count(), `R3 ${name}: the notice is a [data-panel-notice] root with a .panel-notice-body`).toBeGreaterThan(0)
}

test.afterEach(async ({ page }) => { await dropFakes(page) })

test.describe('notices in a narrow session column', () => {
  test('error notice, host proved reachable: words take the box, the host name is cut on one line', async ({ page }) => {
    await mockSession(page, TARGET, {
      host: HOST, hostname: HOSTNAME, process_status: 'error',
      errorMessage: 'Connection lost: unable to reach remote host',
    })
    await mockRecheck(page, TARGET, true)
    const panel = await openNarrowHome(page, async (p) => {
      await expect(p.getByText('is reachable, and this session', { exact: false })).toBeVisible({ timeout: 20_000 })
    })
    await expectNoticeContract(panel, 'reachable notice')
    await checkAtWidths(page, panel, 'error-reachable', (px) => expectHostNameCut(panel, HOSTNAME, `reachable notice at ${px}px`))
  })

  test('error notice, host not proved: the host error reads as prose', async ({ page }) => {
    await mockSession(page, TARGET, {
      host: HOST, hostname: HOSTNAME, process_status: 'error',
      errorMessage: 'Connection lost: unable to reach remote host',
    })
    await mockRecheck(page, TARGET, false)
    const panel = await openNarrowHome(page, async (p) => {
      await expect(p.locator('.session-error-banner').first()).toBeVisible({ timeout: 20_000 })
      await expect(p.getByText('Checking connection', { exact: false })).toHaveCount(0, { timeout: 15_000 })
    })
    await expectNoticeContract(panel, 'error notice')
    await checkAtWidths(page, panel, 'error-unproved')
  })

  test('idle auto-stop notice', async ({ page }) => {
    await mockSession(page, TARGET, { process_status: 'stopped', errorMessage: 'No output for 30 min' })
    const panel = await openNarrowHome(page, async (p) => {
      await expect(p.getByText('Auto-stopped after 30 min idle', { exact: false })).toBeVisible({ timeout: 20_000 })
    })
    await expectNoticeContract(panel, 'idle notice')
    await checkAtWidths(page, panel, 'idle')
  })

  test('"Session returned empty" notice', async ({ page }) => {
    await mockSession(page, TARGET, { process_status: 'stopped' }, [userRow('Tidy up the stale thumbnails in the photo archive folders.', 0)])
    const panel = await openNarrowHome(page, async (p) => {
      await expect(p.getByText('Session returned empty', { exact: false })).toBeVisible({ timeout: 20_000 })
    })
    await expectNoticeContract(panel, 'empty notice')
    await checkAtWidths(page, panel, 'returned-empty')
  })

  test('folder-gone notice with a long path', async ({ page }) => {
    await mockSession(page, TARGET, {
      process_status: 'stopped',
      cwd: '/home/someone/projects/PhotoArchiveTidy/src/ThumbnailTidyService/build',
      cwdGone: {
        cwd: '/home/someone/projects/PhotoArchiveTidy/src/ThumbnailTidyService/build',
        at: new Date().toISOString(), history: 'found',
      },
    })
    const panel = await openNarrowHome(page, async (p) => {
      await expect(p.getByTestId('folder-gone-banner')).toBeVisible({ timeout: 20_000 })
    })
    await expectNoticeContract(panel, 'folder-gone notice')
    // The path is cut in its middle: its last folder, the part that tells it apart, shows whole.
    await checkAtWidths(page, panel, 'folder-gone', async (px) => {
      const tail = panel.locator('[data-testid="folder-gone-banner"] .panel-notice-token-tail')
      await expect.soft(tail, `folder-gone at ${px}px: the path's last folder is shown`).toHaveText('/build')
      expect.soft(await tail.evaluate((el) => el.scrollWidth <= el.clientWidth + 0.5), `folder-gone at ${px}px: the path's last folder is not cut`).toBe(true)
    })
  })
})

test.describe('header title row in a narrow session column', () => {
  test.describe.configure({ mode: 'serial' })
  const litterTasks: string[] = []
  const litterRoutines: string[] = []
  let taskId = ''

  async function api<T>(method: string, apiPath: string, body?: unknown): Promise<T> {
    const res = await fetch(`${API}${apiPath}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) throw new Error(`${method} ${apiPath} -> ${res.status} ${await res.text()}`)
    return (await res.json()) as T
  }

  test.beforeAll(async () => {
    const stamp = Date.now()
    const parent = await api<{ task: { id: string } }>('POST', '/api/tasks', { title: `Narrow panel parent ${stamp}`, source: 'local', project: 'Walnut' })
    litterTasks.push(parent.task.id)
    const own = await api<{ task: { id: string } }>('POST', '/api/tasks', {
      title: 'Automate the stale thumbnail tidy-up across every photo folder', source: 'local', project: 'Walnut',
      parent_task_id: parent.task.id,
    })
    taskId = own.task.id
    litterTasks.push(taskId)
    const child = await api<{ task: { id: string } }>('POST', '/api/tasks', { title: `Narrow panel child ${stamp}`, source: 'local', project: 'Walnut', parent_task_id: taskId })
    litterTasks.push(child.task.id)
    const trigger = await api<{ job: { id: string } }>('POST', '/api/v1/routines/trigger', {
      name: 'Narrow panel watch', description: 'Watches nothing; it only puts a Trigger pill on the header.',
      run: `echo '{"fire": false}'`, every: '5m', prompt: 'Nothing to do.', session: taskId,
    })
    litterRoutines.push(trigger.job.id)
    const links = (await api<{ task: { tags?: string[] } }>('GET', '/api/tasks/pw-task-links')).task.tags ?? []
    if (links.length) await api('PATCH', `/api/tasks/${taskId}`, { set_tags: links })
    await api('PATCH', `/api/tasks/${taskId}`, { phase: 'WAITING', wait_until: new Date(Date.now() + 3 * 86_400_000).toISOString() })
  })

  test.afterAll(async () => {
    for (const id of litterRoutines) await fetch(`${API}/api/routines/${id}`, { method: 'DELETE' }).catch(() => undefined)
    for (const id of [...litterTasks].reverse()) await fetch(`${API}/api/tasks/${id}`, { method: 'DELETE' }).catch(() => undefined)
  })

  test('a parked task with Trigger, Worker, Leader and tags: every label readable, the kebab visible', async ({ page }) => {
    await mockSession(page, TARGET, { taskId, title: 'Automate the stale thumbnail tidy-up across every photo folder' })
    const panel = await openNarrowHome(page, async (p) => {
      const meta = p.locator('.session-panel-title-meta')
      await expect(meta.locator('.task-waiting-chip')).toBeVisible({ timeout: 30_000 })
      await expect(meta.locator('[data-testid="task-trigger-pill"]')).toBeVisible({ timeout: 30_000 })
      await expect(meta.locator('[data-testid="subtask-pill"]')).toBeVisible({ timeout: 30_000 })
      await expect(meta.locator('[data-testid="leader-pill"]')).toBeVisible({ timeout: 30_000 })
    })
    await checkAtWidths(page, panel, 'header')
  })
})

test.describe('other rows in a narrow session column', () => {
  test('a pending permission card (Allow / Deny)', async ({ page }) => {
    // The stream snapshot is answered on the app's own socket, for the target only.
    const permission = {
      type: 'permission', requestId: 'pw-narrow-perm', toolName: 'Bash',
      input: { command: 'find ./photos -name "*.thumb" -mtime +30 -delete' },
    }
    await page.addInitScript(({ target, blocks }) => {
      const Orig = window.WebSocket
      window.WebSocket = class extends Orig {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols)
          if (new URL(String(url), window.location.href).pathname !== '/ws') return
          const send = this.send.bind(this)
          this.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
            try {
              const frame = JSON.parse(data as string) as { type?: string; method?: string; id?: string; payload?: { sessionId?: string } }
              if (frame.type === 'req' && frame.method === 'session:stream-subscribe' && frame.payload?.sessionId === target) {
                setTimeout(() => this.dispatchEvent(new MessageEvent('message', {
                  data: JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: { blocks, isStreaming: false } }),
                })), 10)
                return
              }
            } catch { /* not JSON */ }
            send(data)
          }
        }
      } as typeof WebSocket
      for (const key of Object.getOwnPropertyNames(Orig)) {
        if (key !== 'prototype' && key !== 'length' && key !== 'name') {
          try { (window.WebSocket as unknown as Record<string, unknown>)[key] = (Orig as unknown as Record<string, unknown>)[key] } catch { /* read-only */ }
        }
      }
    }, { target: TARGET, blocks: [permission] })
    await mockSession(page, TARGET, { process_status: 'running' })
    const panel = await openNarrowHome(page, async (p) => {
      await expect(p.locator('.permission-request-card').first()).toBeVisible({ timeout: 20_000 })
    })
    await checkAtWidths(page, panel, 'permission-card')
  })
})
