/**
 * A request nobody clicked is tried again quietly, and its failure never pops up by itself
 * (web/src/api/background-retry.ts). 2026-11-16, the user, on a red `PUT /api/drafts → 500`
 * card for a draft save: "can we avoid error unless we really try", "only error useful to
 * customer".
 *
 * The real web client (request() through apiGet/apiPut/apiPost) over a stubbed fetch, and two
 * inventories read from the source, so a new member of the class fails here:
 * - every write the browser sends on its own (a draft save, a settings sync, a visit batch)
 *   goes out with `quietRetry: true`;
 * - every place in the web app that raises an error card is a known one that answers a
 *   person's own action, never a request nobody clicked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { apiGet, apiPost, apiPut, ApiError } from '../../web/src/api/client'
import { quietRetryTiming, quietRetryDelays, quietlyRetryable } from '../../web/src/api/background-retry'

const DELAYS = [20, 40]
const REAL_DELAYS = [...quietRetryTiming.delaysMs]

type Answer = { status: number; body?: unknown } | 'network'

let calls: Array<{ url: string; method: string; opId?: string }>
let answers: Answer[]

beforeEach(() => {
  calls = []
  answers = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>
    calls.push({ url, method: String(init.method), opId: headers['x-walnut-op-id'] })
    const a = answers.shift() ?? { status: 200, body: { ok: true } }
    if (a === 'network') throw new TypeError('Failed to fetch')
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status, headers: { 'Content-Type': 'application/json' } })
  }))
  vi.spyOn(Math, 'random').mockReturnValue(0)
  quietRetryTiming.delaysMs = [...DELAYS]
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { quietRetryTiming.delaysMs = [...REAL_DELAYS]; vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('the quiet retry of a request nobody clicked', () => {
  it('a GET that fails once (500) and then answers resolves, after one quiet retry', async () => {
    answers.push({ status: 500, body: { error: 'File lock timeout after 10000ms' } })
    await expect(apiGet('/api/drafts')).resolves.toEqual({ ok: true })
    expect(calls).toHaveLength(2)
  })

  it('a quiet-retry save that fails once (500, 502, a busy 503, a dropped connection) lands on the retry, under one op id', async () => {
    for (const first of [{ status: 500 }, { status: 502 }, { status: 503, body: { error: 'busy', retry: true } }, 'network'] as Answer[]) {
      calls = []
      answers = [first]
      await expect(apiPut('/api/drafts', { drafts: {} }, { background: true, quietRetry: true })).resolves.toEqual({ ok: true })
      expect(calls).toHaveLength(2)
      expect(calls[1]!.opId).toBe(calls[0]!.opId)
    }
  })

  it('a failure that stays is tried the full count with growing waits, then rejects for the caller to judge', async () => {
    answers.push({ status: 500 }, { status: 500 }, { status: 500 })
    const t0 = Date.now()
    await expect(apiPut('/api/drafts', { drafts: {} }, { background: true, quietRetry: true })).rejects.toBeInstanceOf(ApiError)
    expect(calls).toHaveLength(1 + DELAYS.length)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(DELAYS.reduce((a, b) => a + b, 0) - 5)
  })

  it('a slow or down server is not sent more: a 504, a 503 that does not ask, a deadline that ran out', async () => {
    answers.push({ status: 504 })
    await expect(apiGet('/api/x')).rejects.toBeInstanceOf(ApiError)
    answers.push({ status: 503, body: { error: { code: 'host_reconnecting' } } })
    await expect(apiGet('/api/x')).rejects.toBeInstanceOf(ApiError)
    expect(calls).toHaveLength(2)
    expect(quietlyRetryable(new DOMException('t', 'TimeoutError'), { write: false })).toBe(false)
  })

  it('a background write that did not ask for quiet retries is sent once (a refresh request would act twice)', async () => {
    answers.push({ status: 500 })
    await expect(apiPost('/api/v1/org/nodes/n1/brief-refresh', { by: 'web' }, { background: true })).rejects.toBeInstanceOf(ApiError)
    expect(calls).toHaveLength(1)
  })

  it('a write the person made is never sent again blind (it may have landed): its caller reports it', async () => {
    answers.push({ status: 500 })
    await expect(apiPost('/api/tasks', { title: 'Acme' })).rejects.toBeInstanceOf(ApiError)
    expect(calls).toHaveLength(1)
  })

  it('an answer is not retried: a 4xx, a 501, or a status the caller expects', async () => {
    answers.push({ status: 404 })
    await expect(apiGet('/api/x')).rejects.toBeInstanceOf(ApiError)
    answers.push({ status: 501 })
    await expect(apiGet('/api/x')).rejects.toBeInstanceOf(ApiError)
    answers.push({ status: 503 })
    await expect(apiGet('/api/x', undefined, { quietStatuses: [503] })).rejects.toBeInstanceOf(ApiError)
    expect(calls).toHaveLength(3)
  })

  it('a caller that gives up during the wait stops the retries', async () => {
    answers.push({ status: 500 })
    quietRetryTiming.delaysMs = [2_000, 2_000]
    const ctrl = new AbortController()
    const p = apiGet('/api/x', undefined, { signal: ctrl.signal })
    setTimeout(() => ctrl.abort(), 100)
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).toHaveLength(1)
  })

  it('the policy: only a failure a moment can cure, and a write only when its answer allows a resend', () => {
    expect(quietlyRetryable(new TypeError('Failed to fetch'), { write: false })).toBe(true)
    expect(quietlyRetryable(new ApiError(503, 'm', { error: { code: 'leader_unsure', why: 'lost_answer' }, retry: true }), { write: true })).toBe(false)
    expect(quietlyRetryable(new ApiError(503, 'm', { error: 'busy', retry: true }), { write: true })).toBe(true)
    expect(quietRetryDelays(() => 1)).toEqual(DELAYS.map((ms) => Math.round(ms * 1.25)))
  })
})

const WEB = path.resolve(__dirname, '../../web/src')
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}
const FILES = sourceFiles(WEB).map((file) => ({ rel: path.relative(WEB, file), text: fs.readFileSync(file, 'utf8') }))

/** The call's text from its name to its closing parenthesis. */
function callText(text: string, start: number): string {
  let depth = 0
  for (let i = text.indexOf('(', start); i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) return text.slice(start, i + 1)
  }
  return text.slice(start)
}

/**
 * The stores the browser writes on its own, never on a click: a draft as it is typed, the
 * settings sync, the visit batch. A new one joins this list.
 */
const AUTOMATIC_WRITE_ROUTES = ['/api/drafts', '/api/ui-prefs', '/api/page-visits']

describe('every write the browser sends on its own is retried quietly', () => {
  const sites = FILES.flatMap(({ rel, text }) => [...text.matchAll(/\bapi(Put|Post|Patch|Delete)\(\s*['`]([^'`]+)['`]/g)]
    .filter((m) => AUTOMATIC_WRITE_ROUTES.includes(m[2]!.split('?')[0]!))
    .map((m) => ({ rel, route: m[2]!, call: callText(text, m.index!) })))

  it('finds the known writers (so the scan itself still works)', () => {
    expect(new Set(sites.map((s) => s.route))).toEqual(new Set(AUTOMATIC_WRITE_ROUTES))
  })

  it.each(sites.map((s) => [`${s.rel} ${s.route}`, s] as const))('%s asks for quiet retries', (_label, site) => {
    expect(site.call).toMatch(/quietRetry:\s*true/)
  })
})

/**
 * Every place in the web app that raises an error card, and the person's own action it
 * answers. A request nobody clicked never pops up: it is retried, then logged. A new place
 * joins this list only once it answers a click, says in plain words what was not done, and
 * never shows a raw answer for a request the browser sent on its own.
 */
const ERROR_CARD_SITES: Record<string, string> = {
  'components/common/OperationErrorBridge.tsx': 'a task change the person made (TasksContext operationError)',
  'components/common/NotificationActionButtons.tsx': 'a button the person pressed on a card',
  'components/layout/SidebarStatusItems.tsx': 'a status item action the person clicked',
  'components/layout/useAppUpdateActions.ts': 'the update button the person pressed',
  'components/sessions/ComposerModelPill.tsx': 'a model the person picked',
  'components/sessions/SessionPanel.tsx': 'Open in VS Code, clicked',
  'components/tasks/NavigationSections.tsx': 'a sidebar section the person dragged',
  'components/tasks/TaskSyncMenuRows.tsx': 'a sync setting the person changed',
  'components/tasks/useHomeFilters.ts': 'a filter the person archived',
  'contexts/notifications/NotificationProvider.tsx': 'an agent turn the person started failed (agent error event)',
  'hooks/useCalendarEvents.ts': 'a calendar event the person showed, hid or edited',
  'hooks/useChat.ts': 'a chat message the person sent',
  'hooks/useNavigationPreference.ts': 'a navigation preference the person set',
  'hooks/useSessionControls.ts': 'a session setting the person changed',
  'pages/MainPage.tsx': 'Quick Start, clicked',
  'popout/PopoutSession.tsx': 'Fork, clicked in a popout',
  'undo/TaskUndoContext.tsx': 'a pin or an undo the person pressed',
}

describe('every error card in the web app answers a person\'s own action', () => {
  const found = FILES.filter(({ text }) => /kind:\s*'operation-error'/.test(text)).map(({ rel }) => rel).sort()

  it('lists every place that raises one (a new one is reviewed and added here)', () => {
    expect(found).toEqual(Object.keys(ERROR_CARD_SITES).sort())
  })
})
