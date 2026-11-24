/**
 * A remote session looks and behaves the same in the console whether its host's service runs and
 * judges it (docs/plan/one-service-every-host.md, phase 2: the experiment `host_runs_sessions` on)
 * or the leader runs it on the host's daemon as before (the switch off), item by item.
 *
 * One cluster of real processes (tests/helpers/host-judge-cluster.ts: the Mac server with its
 * daemon, the host's one Walnut service under its launcher, the Mac's daemon link to it through a
 * proxy the test can cut) and a fake tunnel in front of the Mac whose pages come from this config's
 * own page server, as replica-smoke.spec.ts does for the replica. The CLI is the cluster's mock
 * (tests/helpers/replica-mock-cli.cjs): a permission prompt, a busy streamed turn with tool calls,
 * a held turn an interrupt ends, each scripted by the words sent.
 *
 * The same walk runs twice, the switch on, then off, in real UI clicks after the first load:
 *   start      a draft on devbox (Default mode), the first message; the panel and its answer
 *   streaming  a busy turn: the live line, the streamed reply, the folded tool calls, the answer
 *   usage      the context chip and the cost in the model picker
 *   permission the card for `pwd`, its choices, Allow once, the settled card and the answer
 *   turn end   the Stop button gone, the task row's pill, the row's status
 *   interrupt  a held turn, Stop, the interrupted answer
 *   link       the Mac's link to the host cut: what the panel shows; mended: the next turn answers
 *   reload     the page reloaded: the same messages in the same order
 *   stop       Terminate in the session menu: the row stopped, the pill
 * and the last test asserts the two walks saw the same, step by step (the table is written to
 * HOST_PARITY_OUT, default test-results/host-judged-parity). Each walk first proves which path it
 * took (the Mac's judgeOf: 'host' with the switch on, 'here' off).
 *
 * PW_VIDEO=1: the host-judged walk is the proof video (a caption per step, a hold on each result).
 */
import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { HOST_KEY, waitFor } from '../../helpers/replica-cluster.js'
import { startHostJudgeCluster, type HostJudgeCluster } from '../../helpers/host-judge-cluster.js'
import { startFakeTunnel, type FakeTunnel } from './replica-tunnel.js'
import { CHAT_VISIBLE_KEY, REAL_PANEL, basenameOf, closeModelPicker, draftComposer, draftCwdPill, draftModelPicker, openDraft, openPickerFold } from './draft-helpers.js'
import { pickMode } from './permission-mode-helpers.js'
import { openKebabGroup } from './kebab-group-helpers.js'
import { RECORDING } from './pw-video.js'

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1440, height: 900 } })

type Mode = 'host' | 'legacy'
type Step = Record<string, unknown>
const walks: Partial<Record<Mode, Record<string, Step>>> = {}
const OUT = process.env.HOST_PARITY_OUT || path.join(process.cwd(), 'test-results', 'host-judged-parity')
const STREAM = 'please stream 130 lines at 26 per second'

let h: HostJudgeCluster | null = null
let tunnel: FakeTunnel | null = null
let hostCwd = ''

test.beforeAll(async () => {
  test.setTimeout(900_000)
  h = await startHostJudgeCluster({ linkProxy: true })
  hostCwd = fs.realpathSync(path.join(h.c.base, 'hh', 'work'))
  const pagePort = Number(new URL(test.info().project.use.baseURL ?? 'http://localhost:3457').port || 80)
  tunnel = await startFakeTunnel({ port: 0, replicaPort: h.c.macPort, pagePort })
  await waitFor(async () => { const s = await h!.mac(`/side?host=${HOST_KEY}`); return s.active && s.linked && s.judges }, 180_000, 'the Mac to link the host\'s session channel')
  fs.mkdirSync(OUT, { recursive: true })
})

test.afterAll(async () => {
  test.setTimeout(180_000)
  await tunnel?.close().catch(() => undefined)
  await h?.stop()
})

/** The switch on the Mac (a config value, as host-judged-session-cluster-e2e.test.ts S6 turns it). */
async function setSwitch(mode: Mode): Promise<void> {
  const r = await h!.c.mac('PUT', '/api/config', { experimental: { host_runs_sessions: mode === 'host' } })
  expect(r.status, JSON.stringify(r.json)).toBe(200)
  await waitFor(async () => { const s = await h!.mac(`/side?host=${HOST_KEY}`); return s.linked && s.judges === (mode === 'host') }, 60_000, `the Mac's side to judge ${mode === 'host' ? 'on' : 'off'}`)
}

/** A caption at the top of the page and a hold on what is on screen (only while recording). */
async function caption(page: Page, text: string): Promise<void> {
  if (!RECORDING) return
  await page.evaluate((t) => {
    let el = document.getElementById('pw-caption')
    if (!el) {
      el = document.createElement('div')
      el.id = 'pw-caption'
      el.setAttribute('aria-hidden', 'true')
      el.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483646;pointer-events:none;background:rgba(20,20,24,.86);color:#fff;font:600 17px/1.35 system-ui,sans-serif;padding:9px 18px;border-radius:12px;max-width:80vw;text-align:center'
      document.documentElement.appendChild(el)
    }
    el.textContent = t
  }, text)
}
const hold = async (page: Page, ms = 1_200): Promise<void> => { if (RECORDING) await page.waitForTimeout(ms) }

/** A visible element's text, trimmed and with runs of space folded. */
const textOf = async (l: Locator): Promise<string> => {
  const t = await l.first().textContent({ timeout: 5_000 }).catch(() => null)
  return t === null ? 'absent' : t.replace(/\s+/g, ' ').trim().replace(/\s*MD\s*Rich\s*(just now|\d+\s*\w+ ago)$/, '')
}
/** Whether `l` shows up within `ms`. */
const seen = async (l: Locator, ms: number): Promise<boolean> => l.first().waitFor({ state: 'attached', timeout: ms }).then(() => true, () => false)

/**
 * What a session's timeline shows, in order: each bubble (`user: ...` / `assistant: ...`), each folded
 * tool run (`tools: Ran 10 tools`) and each permission card (`card: Bash pwd Allowed`), without the
 * message bar under a bubble (MD, Rich, its age) and with the walk's own gate file named alike.
 * `saved` is the same for the saved history rows only (the rows drawn from `[data-msg-role]`), kept
 * as evidence beside what shows.
 */
async function timeline(panel: Locator): Promise<string[]> {
  return (await timelineOf(panel)).shown
}
async function timelineOf(panel: Locator): Promise<{ shown: string[]; saved: string[]; unsaved: string[] }> {
  const raw = await panel.locator('.session-history').first().evaluate((root) => {
    const norm = (t: string | null | undefined) => (t ?? '').replace(/\s+/g, ' ').trim()
    const shown: string[] = []
    const saved: string[] = []
    const unsaved: string[] = []
    for (const el of Array.from(root.querySelectorAll('.session-msg-user, .session-msg-assistant, .tool-run-label, .permission-request-card'))) {
      if ((el as HTMLElement).offsetParent === null) continue
      let line = ''
      if (el.classList.contains('tool-run-label')) line = `tools: ${norm(el.textContent)}`
      else if (el.classList.contains('permission-request-card')) line = `card: ${norm(el.querySelector('.permission-request-tool')?.textContent)} ${norm(el.querySelector('[data-testid="permission-request-command"]')?.textContent)} ${norm(el.querySelector('.permission-request-resolved')?.textContent) || 'pending'}`
      else {
        const text = norm(el.querySelector('.session-msg-content')?.textContent)
        if (!text) continue
        line = `${el.classList.contains('session-msg-user') ? 'user' : 'assistant'}: ${text}`
        const row = el.closest('[data-msg-role]')
        if (row) saved.push(line)
        else unsaved.push(`${line} <- ${(el.parentElement?.className ?? '').slice(0, 80)}`)
      }
      shown.push(line)
    }
    return { shown, saved, unsaved }
  })
  const clean = (x: string) => x.replace(/\s*MD\s*Rich\s*(just now|\d+\s*\w+ ago)/, '').replace(/\/\S*\/gate-never-(host|legacy)/, '<gate>')
  return { shown: raw.shown.map(clean), saved: raw.saved.map(clean), unsaved: raw.unsaved.map(clean) }
}

/** The timeline once two reads a second apart agree (a reload draws its history in steps). */
async function settledTimeline(panel: Locator): Promise<string[]> {
  let last = ''
  let now: string[] = []
  await expect.poll(async () => {
    now = await timeline(panel)
    const same = JSON.stringify(now) === last
    last = JSON.stringify(now)
    return same
  }, { timeout: 30_000, intervals: [1_000] }).toBe(true)
  return now
}

/** Type into a real session's composer and send with Enter. */
async function send(page: Page, panel: Locator, text: string): Promise<void> {
  const box = panel.locator('.chat-input-textarea')
  await box.click()
  await box.fill(text)
  await hold(page, 500)
  await box.press('Enter')
}

const answersSaying = (panel: Locator, text: string | RegExp) => panel.locator('.session-msg-assistant .session-msg-content', { hasText: text })
/** The newest answer saying `text` (a streamed one and its saved twin may both show for a moment). */
const assistantSaying = (panel: Locator, text: string | RegExp) => answersSaying(panel, text).last()
/** How many answers say `text` once the timeline settled: 1 within 10 s, else what shows then. */
async function answerCount(panel: Locator, text: string | RegExp): Promise<number> {
  const answers = answersSaying(panel, text)
  await expect.poll(() => answers.count(), { timeout: 10_000 }).toBe(1).catch(() => undefined)
  return answers.count()
}
const stopTurn = (panel: Locator) => panel.getByRole('button', { name: 'Stop the running turn', exact: true })

/** The row the Mac holds of a session, as the console reads it (its judge left out: that differs by design). */
async function rowOf(sid: string): Promise<Record<string, unknown>> {
  const r = await h!.c.mac('GET', `/api/sessions/${sid}`)
  return (r.json.session ?? r.json) as Record<string, unknown>
}

/** The task row's session pill (title and state class), or 'not shown'. */
async function pillOf(page: Page, taskId: string): Promise<string> {
  const pill = page.locator(`.todo-panel-item[data-task-id="${taskId}"] .task-session-pill`).first()
  if (!(await seen(pill, 3_000))) return 'not shown'
  const cls = ((await pill.getAttribute('class')) ?? '').split(/\s+/).filter((c) => /^task-session-pill-/.test(c)).sort().join(' ')
  return `${await pill.getAttribute('title')} [${cls}]`
}

async function walk(page: Page, mode: Mode): Promise<Record<string, Step>> {
  const steps: Record<string, Step> = {}
  const evidence: Record<string, unknown> = {}
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  // Every history read of the walk and the user lines in it (evidence beside the table, not compared).
  const reads: Array<{ at: string; query: string; user: string[]; roles: string }> = []
  page.on('response', (r) => {
    const u = new URL(r.url())
    if (!/\/api\/sessions\/[^/]+\/history$/.test(u.pathname)) return
    void r.json().then((j: { messages?: Array<{ role?: string; text?: string; content?: unknown }> }) => {
      const m = Array.isArray(j?.messages) ? j.messages : []
      reads.push({ at: new Date().toISOString(), query: u.search, roles: m.map((x) => (x.role ?? '?')[0]).join(''), user: m.filter((x) => x.role === 'user').map((x) => String(x.text ?? JSON.stringify(x.content ?? '')).slice(0, 60)) })
    }).catch(() => undefined)
  })
  await page.addInitScript((key) => { try { localStorage.setItem(key, 'false') } catch { /* storage off */ } }, CHAT_VISIBLE_KEY)

  // ── start ──
  await page.goto(`http://127.0.0.1:${tunnel!.port}/`)
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 120_000 })
  await caption(page, mode === 'host' ? 'A session on devbox, run and judged by devbox\'s own service' : 'A session on devbox, run the legacy way (switch off)')
  await hold(page)
  const draft = await openDraft(page)
  await caption(page, 'Pick devbox and a folder on it')
  await draftCwdPill(draft).click()
  const picker = page.locator('.session-path-selector')
  await expect(picker).toBeVisible({ timeout: 10_000 })
  await expect(picker.locator('.sps-path-item').first()).toBeVisible({ timeout: 30_000 })
  const tab = picker.locator(`.sps-host-tab[data-host="${HOST_KEY}"]`).or(picker.locator('.sps-host-tab', { hasText: HOST_KEY })).first()
  await tab.click()
  await hold(page, 600)
  await picker.locator('.sps-search-input').fill(hostCwd)
  await hold(page, 600)
  await picker.locator('.sps-search-input').press('Shift+Enter')
  await expect(picker).toBeHidden()
  await expect(draftCwdPill(draft)).toContainText(basenameOf(hostCwd))
  await expect(draftCwdPill(draft)).toContainText(HOST_KEY)
  const draftPill = await textOf(draftCwdPill(draft))
  await caption(page, 'Default mode, so the agent asks before it runs a command')
  await pickMode(draft.locator('.draft-actions-bar .draft-mode-pill'), 'default')
  await hold(page, 600)
  await caption(page, 'Send the first message')
  const composer = draftComposer(page)
  await composer.click()
  await composer.fill('ROUND one')
  await hold(page, 500)
  await composer.press('Enter')
  const panel = page.locator(REAL_PANEL).first()
  await expect(panel).toBeVisible({ timeout: 60_000 })
  const sid = (await panel.getAttribute('data-session-id')) ?? ''
  expect(sid).toBeTruthy()
  await expect(assistantSaying(panel, 'echo: ROUND one')).toBeVisible({ timeout: 120_000 })
  // The person's first words beside the answer: shown with it, or how long after it.
  const replyAt = Date.now()
  const firstWords = panel.locator('.session-msg-user .session-msg-content', { hasText: 'ROUND one' })
  const withReply = (await firstWords.count()) > 0
  evidence.startRows = await timelineOf(panel)
  const shownAfter = withReply ? 0 : await firstWords.first().waitFor({ state: 'visible', timeout: 30_000 }).then(() => Date.now() - replyAt, () => -1)
  const judge = await h!.mac(`/judge?sid=${sid}`)
  // The path this walk is about: the host's service judges it, or the Mac runs it as before.
  expect(judge, JSON.stringify(judge)).toEqual(mode === 'host' ? { judge: 'host', host: HOST_KEY } : { judge: 'here', host: null })
  const taskId = String((await rowOf(sid)).taskId ?? '')
  steps.start = {
    panel: 'shown', answers: await answerCount(panel, 'echo: ROUND one'), bubbles: await timeline(panel),
    firstWords: withReply ? 'shown with the answer' : shownAfter < 0 ? 'not shown within 30 s of the answer' : `shown ${shownAfter < 2_000 ? 'under 2 s' : shownAfter < 10_000 ? '2 to 10 s' : 'over 10 s'} after the answer`,
    draftPill: draftPill.includes(HOST_KEY) ? `names ${HOST_KEY}` : draftPill,
    row: pick(await rowOf(sid), ['host', 'cwd', 'mode', 'provider', 'title']),
  }
  await caption(page, 'devbox answered the first message')
  await hold(page)

  // ── streaming text and tool calls ──
  await caption(page, 'A busy turn: text streams in, tool calls fold into a run')
  await send(page, panel, STREAM)
  const sawStop = await seen(stopTurn(panel), 30_000)
  const sawWorking = await seen(panel.locator('.session-working-indicator'), 30_000)
  const sawStreaming = await seen(panel.locator('[data-stream-reply]'), 30_000)
  await expect(assistantSaying(panel, /echo: streamed/)).toBeVisible({ timeout: 120_000 })
  await expect(stopTurn(panel)).toHaveCount(0, { timeout: 30_000 })
  const runs = panel.locator('.tool-run-label')
  await expect(runs.first()).toBeVisible({ timeout: 30_000 })
  steps.streaming = {
    stopWhileRunning: sawStop, workingLine: sawWorking, streamedReply: sawStreaming,
    toolRuns: await runs.evaluateAll((els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim())),
    answer: await textOf(assistantSaying(panel, /echo: streamed/)), answers: await answerCount(panel, /echo: streamed/),
  }
  await hold(page)

  // ── usage ──
  await caption(page, 'Usage: the context chip and the cost of the session')
  const pct = panel.locator('.composer-model-pill .session-detail-context-pct').first()
  const pctText = (await seen(pct, 3_000)) ? await textOf(pct) : 'not shown'
  await panel.locator('.composer-model-pill').first().click()
  const cost = await openPickerFold(draftModelPicker(page), 'cost')
  const total = cost.getByTestId('session-cost-total')
  await expect(total).toBeVisible({ timeout: 30_000 })
  await expect(total).not.toContainText('reading', { timeout: 60_000 })
  steps.usage = { contextChip: pctText, costStatus: await cost.getByTestId('session-cost').getAttribute('data-status'), costTotal: await textOf(total) }
  await hold(page)
  await closeModelPicker(page)

  // ── permission prompt and its approval ──
  await caption(page, 'The agent asks to run pwd: a permission card')
  await send(page, panel, 'please run pwd')
  const card = panel.locator('.permission-request-card[data-prompt-pending="true"]').first()
  await expect(card).toBeVisible({ timeout: 60_000 })
  const choices = await card.locator('button.permission-request-btn').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-choice')}=${(e.textContent ?? '').replace(/\s+/g, ' ').trim()}`))
  const command = await textOf(card.getByTestId('permission-request-command'))
  const requestId = (await card.getAttribute('data-request-id')) ?? ''
  const toolLabel = await textOf(card.locator('.permission-request-tool').first())
  await hold(page)
  await caption(page, 'Allow')
  const allow = card.locator('[data-choice="allow_once"], [data-choice="allow"]').first()
  const settled = panel.locator(`.permission-request-card[data-request-id="${requestId}"]`)
  // A card takes a click only once it is armed (prompt-keys.ts): wait for that, then one click.
  await expect(card).not.toHaveClass(/is-arming/, { timeout: 10_000 })
  const answered = page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/sessions\/[^/]+\/permission$/.test(new URL(r.url()).pathname), { timeout: 30_000 })
  await allow.click()
  const answer = await answered
  const answerBody = await answer.text().catch(() => '')
  expect(answer.status(), answerBody).toBeLessThan(300)
  await expect(settled.locator('.permission-request-resolved').first()).toBeVisible({ timeout: 30_000 })
  await expect(assistantSaying(panel, 'echo: ran pwd')).toBeVisible({ timeout: 60_000 })
  steps.permission = {
    tool: toolLabel, command, choices,
    settled: await textOf(settled.locator('.permission-request-resolved').first()),
    answer: await textOf(assistantSaying(panel, 'echo: ran pwd')), answers: await answerCount(panel, 'echo: ran pwd'),
  }
  await hold(page)

  // ── turn end and status ──
  await expect(stopTurn(panel)).toHaveCount(0, { timeout: 30_000 })
  const idleRow = await waitFor(async () => { const r = await rowOf(sid); return r.process_status !== 'running' ? r : null }, 30_000, 'the row to leave running')
  steps.turnEnd = {
    stopButton: await stopTurn(panel).count(), workingLine: await panel.locator('.session-working-indicator').count(),
    pill: await pillOf(page, taskId), row: pick(idleRow, ['process_status', 'work_status', 'activity']),
    pendingPermission: idleRow.pendingPermission ?? null,
  }

  // ── interrupt ──
  await caption(page, 'A long turn runs; Stop interrupts it')
  const gate = path.join(h!.c.base, `gate-never-${mode}`)
  await send(page, panel, `please hold until ${gate}`)
  await expect(stopTurn(panel)).toBeVisible({ timeout: 60_000 })
  const runningRow = await waitFor(async () => { const r = await rowOf(sid); return r.process_status === 'running' ? r : null }, 30_000, 'the row to read running')
  await hold(page)
  await stopTurn(panel).click()
  await expect(assistantSaying(panel, 'echo: interrupted')).toBeVisible({ timeout: 60_000 })
  await expect(stopTurn(panel)).toHaveCount(0, { timeout: 30_000 })
  steps.interrupt = {
    runningRow: pick(runningRow, ['process_status']), answer: await textOf(assistantSaying(panel, 'echo: interrupted')), answers: await answerCount(panel, 'echo: interrupted'),
    after: pick(await waitFor(async () => { const r = await rowOf(sid); return r.process_status !== 'running' ? r : null }, 30_000, 'the row to leave running'), ['process_status']),
  }
  await caption(page, 'Interrupted')
  await hold(page)

  // ── the host link dropped and mended ──
  await caption(page, 'The link to devbox drops')
  h!.c.cutLink()
  let down: Step
  try {
    await waitFor(async () => !(await h!.mac(`/link?host=${HOST_KEY}`)).connected, 60_000, 'the Mac to lose its link to the host')
    const banner = panel.getByTestId('session-host-down')
    const shown = await seen(banner, 45_000)
    down = {
      banner: shown,
      kind: shown ? await banner.locator('[data-testid^="session-host-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')).filter((t) => t !== 'session-host-down-note')) : [],
      note: shown ? (await textOf(banner.getByTestId('session-host-down-note'))).slice(0, 60) : '',
      sessionStillShown: await panel.isVisible(),
    }
    await hold(page, 1_500)
  } finally {
    await caption(page, 'The link comes back')
    h!.c.mendLink()
  }
  await waitFor(async () => (await h!.mac(`/link?host=${HOST_KEY}`)).connected, 120_000, 'the Mac to link the host again')
  if (mode === 'host') await waitFor(async () => { const s = await h!.mac(`/side?host=${HOST_KEY}`); return s.linked && s.judges }, 120_000, 'the session channel to link again')
  await expect(panel.getByTestId('session-host-down')).toHaveCount(0, { timeout: 60_000 })
  await caption(page, 'The next turn works')
  await send(page, panel, 'ROUND after reconnect')
  await expect(assistantSaying(panel, 'echo: ROUND after reconnect')).toBeVisible({ timeout: 120_000 })
  steps.link = { ...down, bannerGoneAfter: true, answerAfter: await textOf(assistantSaying(panel, 'echo: ROUND after reconnect')), answers: await answerCount(panel, 'echo: ROUND after reconnect') }
  await hold(page)

  // ── history after reload ──
  const before = await settledTimeline(panel)
  await caption(page, 'Reload the page: the conversation is all there')
  await page.reload()
  const again = page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"]`)
  await expect(again).toBeVisible({ timeout: 60_000 })
  await expect(assistantSaying(again, 'echo: ROUND after reconnect')).toBeVisible({ timeout: 60_000 })
  const after = await settledTimeline(again)
  steps.reload = { before, after, same: JSON.stringify(before) === JSON.stringify(after) }
  await caption(page, 'Reload the page: the conversation is all there')
  await hold(page)

  // ── stop ──
  await caption(page, 'Stop the session: More actions, Session, Terminate')
  await again.getByRole('button', { name: 'More actions', exact: true }).click()
  const session = await openKebabGroup(page.locator('.task-kebab-menu:visible'), 'session-kebab-session')
  await hold(page, 600)
  await session.getByRole('button', { name: 'Terminate', exact: true }).click()
  const confirm = page.getByRole('button', { name: 'Stop session', exact: true })
  if (await seen(confirm, 2_000)) await confirm.click()
  const stoppedRow = await waitFor(async () => { const r = await rowOf(sid); return r.process_status === 'stopped' ? r : null }, 60_000, 'the row to read stopped')
  steps.stop = {
    row: pick(stoppedRow, ['process_status']), panelShown: await again.isVisible(), stopButton: await stopTurn(again).count(),
    composerEnabled: await again.locator('.chat-input-textarea').isEnabled(), pill: await pillOf(page, taskId),
  }
  await caption(page, 'Stopped')
  await hold(page, 1_500)

  steps.pageErrors = { errors }
  fs.writeFileSync(path.join(OUT, `walk-${mode}.json`), JSON.stringify({ sid, taskId, steps, evidence, historyReads: reads }, null, 2))
  return steps
}

function pick(o: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((k) => [k, o[k] ?? null]))
}

test('host-judged: a session on devbox run and judged by its host, driven in the console', async ({ page }) => {
  test.setTimeout(900_000)
  await setSwitch('host')
  walks.host = await walk(page, 'host')
})

test('legacy: the same walk with the switch off', async ({ page }) => {
  test.setTimeout(900_000)
  await setSwitch('legacy')
  walks.legacy = await walk(page, 'legacy')
})

test('the two walks saw the same, item by item', () => {
  const a = walks.host
  const b = walks.legacy
  expect(a && b, 'both walks ran').toBeTruthy()
  const rows = Object.keys(a!).map((item) => {
    const x = JSON.stringify(a![item])
    const y = JSON.stringify(b![item])
    return { item, same: x === y, host: a![item], legacy: b![item] }
  })
  fs.writeFileSync(path.join(OUT, 'parity.json'), JSON.stringify(rows, null, 2))
  for (const r of rows) expect.soft(r.host, `${r.item}: host-judged vs legacy`).toEqual(r.legacy)
})
