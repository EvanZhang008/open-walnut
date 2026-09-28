/**
 * Playwright browser test: the workflow stage graph watched LIVE, through the real
 * server, daemon and session runner, driven by the mock CLI's `workflow-test-live`
 * scenario (five phases on a real clock, CLI field names, queued agents as ghosts).
 *
 * What it pins: every state the graph shows mid-run is one the clocks prove at that
 * moment. Nothing after the running stage claims a relationship before its agents
 * exist; Fetch reads "starts as each finishes" while Search still runs; Fetch waits
 * on Search when every fetch so far is done, then runs again when the last search
 * hands it more; Verify stays "Not started" until all of Fetch is over; the counts
 * are the agents that exist, never a guessed total. A MutationObserver records every
 * render, so a short window cannot slip between two polls.
 */
import fs from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL, draftComposer, openDraftOnCwd } from './draft-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
/** One unit of the scenario's clock (27 units per run). Raise it for a recording. */
const UNIT_MS = Number(process.env.WF_LIVE_UNIT_MS ?? 600)
const SHOTS = process.env.PW_SCREENSHOT_DIR ?? '/tmp/workflow-live-run'

let fixtureRoot = ''
test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
// A recording (PW_VIDEO=1) keeps the full window size instead of the 800px default.
if (process.env.PW_VIDEO) test.use({ video: { mode: 'on', size: { width: 1280, height: 800 } } })

test.beforeAll(async () => {
  ;({ fixtureRoot } = await discoverBrowserFixture(TEST_PORT))
  await fs.mkdir(SHOTS, { recursive: true })
})

interface Card { title: string; state: string; sub: string; count: string }
interface Snapshot { t: number; cards: Card[]; links: string[] }

/** Record the graph after every DOM change (cards' titles, states, lines, counts; link kinds). */
async function startStageRecorder(page: Page) {
  await page.evaluate(() => {
    const log: unknown[] = []
    ;(window as any).__stageLog = log
    let last = ''
    const snap = () => {
      const root = document.querySelector('.main-page-session-column .wf-overview')
      if (!root) return
      const cards = [...root.querySelectorAll('.wf-stage-card')].map(el => ({
        title: el.querySelector('.wf-stage-card-title')?.textContent ?? '',
        state: ([...el.classList].find(c => /^wf-stage-card--(done|failed|running|waiting|future)$/.test(c)) ?? '').replace('wf-stage-card--', ''),
        sub: el.querySelector('.wf-stage-card-sub')?.textContent ?? '',
        count: el.querySelector('.wf-stage-card-count')?.textContent ?? '',
      }))
      const links = [...root.querySelectorAll('.wf-stage-link')].map(el => el.getAttribute('data-link-kind') ?? '')
      const key = JSON.stringify([cards, links])
      if (cards.length && key !== last) { last = key; log.push({ t: Math.round(performance.now()), cards, links }) }
    }
    new MutationObserver(snap).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
  })
}

const card = (s: Snapshot, title: string) => s.cards.find(c => c.title === title)
const state = (s: Snapshot, title: string) => card(s, title)?.state

/** Each step must be seen, in this order, somewhere in the recorded renders. */
function expectInOrder(log: Snapshot[], steps: [string, (s: Snapshot) => boolean][]) {
  let from = 0
  for (const [name, holds] of steps) {
    const at = log.findIndex((s, i) => i >= from && holds(s))
    expect(at, `${name} (searched ${log.length - from} renders from #${from})`).toBeGreaterThanOrEqual(0)
    from = at
  }
}

test('a live workflow run: the graph only claims what the clocks prove, as it happens', async ({ page }, testInfo) => {
  test.setTimeout(150_000)
  const shot = (name: string) => page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-${name}.png`, scale: 'css' })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))

  await page.setContent(`<a href="http://localhost:${TEST_PORT}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut', exact: true }).click()
  // A cold dev server compiles the SPA on first load.
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 60_000 })
  await openDraftOnCwd(page, `${fixtureRoot}/projects/walnut`)
  await startStageRecorder(page)

  const quickStart = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
  const input = draftComposer(page)
  await input.fill(`workflow-test-live:${UNIT_MS}`)
  await input.press('Enter')
  const { taskId } = await (await quickStart).json() as { taskId: string }
  let sessionId = ''
  await expect.poll(async () => {
    const body = await (await page.request.get(`/api/sessions/task/${taskId}`)).json() as { sessions: { claudeSessionId: string }[] }
    sessionId = body.sessions[0]?.claudeSessionId ?? ''
    return sessionId
  }, { timeout: 30_000 }).not.toBe('')
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${sessionId}"]`)

  // The run's card starts collapsed (it never takes over a chat on its own); open it
  // the moment it appears, as a user watching the run would.
  const wfCard = panel.locator('.wf-card:not(.wf-card--bar)')
  await expect(wfCard).toBeVisible({ timeout: 30_000 })
  await wfCard.locator('.wf-card-collapse').click()
  const overview = wfCard.locator('.wf-overview')
  await expect(overview).toHaveClass(/wf-overview--narrow/)
  await expect(overview.locator('.wf-stage-card-title')).toHaveText(['Scope', 'Search', 'Fetch', 'Verify', 'Synthesize'])

  // Opportunistic shots of the moments worth seeing; the recorder is the proof.
  const whenSeen = async (predicate: string, name: string) => {
    await page.waitForFunction(predicate, undefined, { polling: 'raf', timeout: 60_000 }).then(() => shot(name), () => {})
  }
  await whenSeen(`!!document.querySelector('.main-page-session-column .wf-stage-link--stream')`, 'live-1-streaming')
  await whenSeen(`!!document.querySelector('.main-page-session-column .wf-stage-card--waiting')`, 'live-2-waiting')
  await whenSeen(`[...document.querySelectorAll('.main-page-session-column .wf-stage-card--running .wf-stage-card-title')].some(e => e.textContent === 'Verify')`, 'live-3-verify')

  // The run ends: every stage settles, the one failed fetch keeps Fetch marked.
  await expect.poll(async () => overview.locator('.wf-stage-card').evaluateAll(els => els.map(el => [...el.classList].find(c => /--(done|failed|running|waiting|future)$/.test(c)))), { timeout: 60_000 })
    .toEqual(['wf-stage-card--done', 'wf-stage-card--done', 'wf-stage-card--failed', 'wf-stage-card--done', 'wf-stage-card--done'])
  const log = await page.evaluate(() => (window as any).__stageLog) as Snapshot[]
  await fs.writeFile(`${SHOTS}/${testInfo.project.name}-stage-log.json`, JSON.stringify(log, null, 1))

  expectInOrder(log, [
    ['Scope runs, and nothing after it claims a relationship',
      s => state(s, 'Scope') === 'running' && ['Search', 'Fetch', 'Verify', 'Synthesize'].every(t => state(s, t) === 'future') && s.links.every(k => k === 'next')],
    ['Search splits from Scope while Fetch has not started',
      s => state(s, 'Scope') === 'done' && state(s, 'Search') === 'running' && s.links[0] === 'split' && state(s, 'Fetch') === 'future' && card(s, 'Search')?.count === '0/5'],
    ['Fetch starts as each search finishes, while Search still runs',
      s => state(s, 'Fetch') === 'running' && state(s, 'Search') === 'running' && s.links[1] === 'stream' && state(s, 'Verify') === 'future' && card(s, 'Verify')?.sub === 'Not started'],
    ['every fetch so far is done, so Fetch waits on Search',
      s => state(s, 'Fetch') === 'waiting' && card(s, 'Fetch')?.sub === 'Waiting on Search' && state(s, 'Search') === 'running' && card(s, 'Fetch')?.count === '12/12'],
    ['the last search hands Fetch three more',
      s => state(s, 'Search') === 'done' && state(s, 'Fetch') === 'running' && card(s, 'Fetch')?.count === '12/15'],
    ['Verify waits for all of Fetch, then fans out 8 at a time, counting only agents that exist',
      s => state(s, 'Fetch') === 'failed' && state(s, 'Verify') === 'running' && s.links[2] === 'after' && card(s, 'Verify')?.sub === '8 running' && card(s, 'Verify')?.count === '0/8'],
    ['Synthesize merges the claims into one report',
      s => state(s, 'Verify') === 'done' && state(s, 'Synthesize') === 'running' && s.links[3] === 'merge'],
  ])
  // Never a state the clocks do not support: a later stage never runs before an
  // earlier one started, and "waiting" only ever appears on Fetch while Search runs.
  for (const s of log) {
    const started = s.cards.map(c => c.state !== 'future')
    expect(started.every((v, i) => i === 0 || !v || started[i - 1]), `stage order in render at ${s.t}ms`).toBe(true)
    for (const c of s.cards.filter(c => c.state === 'waiting')) {
      expect(c.title).toBe('Fetch')
      expect(state(s, 'Search')).toBe('running')
    }
  }

  // Settled: the sentences on the connectors, and the failure where it happened.
  await expect(overview.locator('.wf-stage-link-label')).toHaveText(['splits into 5', 'starts as each finishes (5 → 15)', 'after all 15, fans out to 20', 'merges 20 into 1'])
  await expect(overview.locator('.wf-stage-card--failed .wf-stage-card-sub')).toHaveText(/^1 failed · \d+s$/)
  const failedRow = overview.locator('.wf-gnode-failed')
  await expect(failedRow).toHaveCount(1)
  await expect(failedRow.locator('.wf-gnode-name')).toHaveText('fetch page 2.3')
  await failedRow.locator('.wf-gnode-head').click()
  await expect(overview.locator('.wf-agent-error')).toContainText('the page answered 403 Forbidden')
  await shot('live-4-done-column')

  // Fullscreen reads the same run left to right.
  await wfCard.locator('.wf-card-fullscreen').click()
  await expect(overview).toHaveClass(/wf-overview--wide/)
  const strip = overview.locator('.wf-stage-graph--strip')
  await expect(strip.locator('.wf-stage-link-verb')).toHaveText(['splits', 'streams', 'after all', 'merges'])
  await expect(strip.locator('.wf-stage-link-counts')).toHaveText(['1 → 5', '5 → 15', '15 → 20', '20 → 1'])
  const tops = await strip.locator('.wf-stage-card').evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().top)))
  expect(new Set(tops).size, 'one row of stages').toBe(1)
  await page.waitForTimeout(250)
  await shot('live-5-done-fullscreen')
  await page.keyboard.press('Escape')
  expect(errors).toEqual([])
})
