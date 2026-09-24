/**
 * Seeded chaos harness for the CRON pill and the cron job card.
 *
 * The pill and the card are driven by a stream the browser does not control: the
 * daemon republishes `session:cron-metadata` whenever it re-observes a session,
 * and the store accepts or drops each observation on its own rules (first epoch
 * wins, revision must strictly increase). Every earlier spec pushed a HAND
 * PICKED sequence, so the shapes nobody thought of (a 32-job list, a prompt at
 * the 2,000-character limit, a late duplicate arriving between two presence
 * flips) were never rendered at all. This file pushes long
 * random-but-reproducible sequences and re-derives the WHOLE card from the last
 * ACCEPTED payload after every push, so a divergence names itself instead of
 * showing up later as "the card looked wrong".
 *
 * Everything lives here because the same scenarios run in two engines
 * (`test.use({ browserName })` is per file): session-cron-chaos.spec.ts and
 * session-cron-chaos.webkit.spec.ts are thin callers.
 *
 * Techniques copied from session-cron-supervision.spec.ts (read that first):
 * capture the app's own /ws socket and dispatch server frames into it; rewrite
 * BOTH REST carriers of cron metadata so a rehydration can never contradict what
 * the WS pushed; one epoch per page, never changed mid-test.
 */
import fs from 'node:fs/promises'
import { expect, type Locator, type Page } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import type { SessionCronJob, SessionCronMetadata } from '../../../src/core/types'

export const SID = 'pw-vscode-session'
export const TASK = 'pw-task-vscode'
export const SHOTS = '/tmp/session-cron-chaos'
/** One epoch for every page: the store adopts the FIRST epoch it sees and drops
 *  any later one unless a reconnect opened intake. Never vary this mid-test. */
const CRON_EPOCH = 'chaos-epoch'
/** U+00B7, the separator CronJobsCard joins its facts and heading count with. */
const DOT = ' \u00B7 '
/** The two seeds the spec files run. Fixed on purpose: a failure has to be
 *  replayable exactly, and a fresh random seed per run makes it a rumour. */
export const SEEDS = [0x5eed1234, 0x0c70beef] as const
const HOUR = 3_600_000
/** src/core/types.ts: SESSION_CRON_PROMPT_LIMIT / SESSION_CRON_JOB_LIMIT. */
const PROMPT_LIMIT = 2000
const JOB_LIMIT = 32

export async function ensureShots(): Promise<void> {
  await fs.mkdir(SHOTS, { recursive: true })
}

// --------------------------- payload generation ---------------------------

/** mulberry32: 32-bit, seeded, identical in every engine and every run. */
function rngFor(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

const pick = <T>(rng: () => number, values: readonly T[]): T => values[Math.floor(rng() * values.length)]
const int = (rng: () => number, min: number, max: number): number => min + Math.floor(rng() * (max - min + 1))

/** Human wording as the CLI reports it: absent, short, at the 200-char field
 *  limit, multi-line, and non-ASCII (as escapes: the source stays English). */
const SCHEDULES: readonly (string | null)[] = [
  null,
  'Every day at 9:23 AM',
  'Every 5 minutes',
  `Every Monday at 8:00 AM ${'and again on the hour after that, '.repeat(6)}`.slice(0, 200),
  'Every day at 9:23 AM\n(host local time)',
  '\u6BCF\u5929\u4E00\u6B21 9:23',
]

/** Raw expressions: absent, ordinary, at the 128-char field limit, a phrase the
 *  host could not evaluate, and empty (which only ever pairs with a schedule -
 *  see makeJob). */
const CRONS: readonly (string | null)[] = [
  null,
  '*/5 * * * *',
  '23 9 * * *',
  'every 5 minutes',
  // Exactly 128 characters, the field limit. No trailing padding: a heading that
  // ends in spaces would compare against DOM text for reasons unrelated to cron.
  `0,5,10,15,20,25,30,35,40,45,50,55 0,3,6,9,12,15,18,21 1,8,15,22 1,4,7,10 ${'0,'.repeat(40)}0`.slice(0, 128),
  '',
]

const LONG_PROMPT = 'x'.repeat(PROMPT_LIMIT)
const MULTILINE_PROMPT = 'Daily disk inspection.\n\nDo the full check, not a summary.\n'
  + `${'Keep going with enough text that the collapsed preview has to trim it. '.repeat(8)}\nLast line.`
const PROMPTS: readonly (string | null)[] = [
  null,
  'Short prompt',
  LONG_PROMPT,
  MULTILINE_PROMPT,
  '\u78C1\u76D8\u5DE1\u68C0 \u6BCF\u5929\u4E00\u6B21\nCheck the disk and report in the task.',
  `${MULTILINE_PROMPT}${'tail '.repeat(400)}`.slice(0, PROMPT_LIMIT),
]

/** Ids the daemon can produce: the CLI's 8-hex handle and a long opaque one at
 *  the 64-char ceiling. The index is baked in so a payload can never carry a
 *  duplicate id - one collision would make the WHOLE list malformed
 *  (normalizeSessionCronJobs returns null, the store keeps presence and drops
 *  the details) and the oracle would be comparing against a shape the store
 *  never stored. */
function makeId(rng: () => number, index: number): string {
  const tag = index.toString(16).padStart(2, '0')
  const body = Array.from({ length: 6 }, () => Math.floor(rng() * 16).toString(16)).join('')
  if (rng() < 0.7) return `${tag}${body}`
  return `job-${tag}-${body}`.padEnd(64, 'z').slice(0, 64)
}

function makeJob(rng: () => number, index: number, now: number): SessionCronJob {
  const schedule = pick(rng, SCHEDULES)
  let cron = pick(rng, CRONS)
  // An empty expression with no schedule would render an EMPTY heading. The
  // daemon never does that (cron comes straight from the CronCreate input), so
  // the generator does not either. Empty-with-a-schedule stays in, and the oracle
  // deliberately reads the <code> chip off TRUTHINESS rather than off null: the
  // store's normalizer may or may not fold '' into null (it does today), and
  // either way the rendered card is the same, so this spec does not pin which
  // side of that coercion the tree is on.
  if (cron === '' && schedule === null) cron = '*/5 * * * *'
  const prompt = pick(rng, PROMPTS)
  return {
    id: makeId(rng, index),
    cron,
    schedule,
    prompt,
    // Truncation is something the server did to the text, so it only makes sense
    // at the limit; anywhere else the note would be a lie.
    promptTruncated: prompt !== null && prompt.length === PROMPT_LIMIT && rng() < 0.9,
    recurring: rng() < 0.7,
    durable: rng() < 0.3,
    createdAt: rng() < 0.6 ? now - int(rng, 1, 90) * 60_000 : null,
    nextRunAt: rng() < 0.75 ? now + int(rng, -90, 36 * 60) * 60_000 : null,
    expiresAt: rng() < 0.6 ? now + int(rng, 1, 7 * 24) * HOUR : null,
  }
}

/** Daemon publication order: next run first (unknown last), then id. Written
 *  with an explicit key instead of `(a.nextRunAt ?? Infinity) - (...)` because
 *  Infinity - Infinity is NaN, and a comparator that returns NaN leaves the
 *  order up to the engine - the one thing an order oracle cannot tolerate. */
function sortJobs(jobs: SessionCronJob[]): SessionCronJob[] {
  const key = (job: SessionCronJob) => job.nextRunAt ?? Number.MAX_SAFE_INTEGER
  return [...jobs].sort((a, b) => (key(a) - key(b)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** `legacy` = a daemon that predates job reporting (no `jobs` key at all). */
type JobsMode = 'legacy' | 'empty' | number

function metadataFor(
  rng: () => number,
  revision: number,
  presence: SessionCronMetadata['presence'],
  mode: JobsMode,
  now: number,
): SessionCronMetadata {
  // Everything except `presence` and `jobs` is held at the value that lets the
  // pill show, so "pill iff presence === 'active'" is a real oracle rather than
  // an accident of source / known / stale / validUntil.
  const base: SessionCronMetadata = {
    sessionId: SID, epoch: CRON_EPOCH, revision, presence, source: 'cron',
    known: true, stale: false, observedAt: now, validUntil: null,
  }
  if (mode === 'legacy') return base
  if (mode === 'empty') return { ...base, jobs: [] }
  return { ...base, jobs: sortJobs(Array.from({ length: mode }, (_, index) => makeJob(rng, index, now))) }
}

/** A hand-built active observation, for the scenarios that need exact jobs. */
function activeWith(revision: number, jobs: SessionCronJob[], now = Date.now()): SessionCronMetadata {
  return {
    sessionId: SID, epoch: CRON_EPOCH, revision, presence: 'active', source: 'cron',
    known: true, stale: false, observedAt: now, validUntil: null, jobs: sortJobs(jobs),
  }
}

export interface ChaosStep {
  metadata: SessionCronMetadata
  /** What the browser store must do with it. `ignore` covers both a lower
   *  revision (rejected-stale) and an equal one (duplicate). */
  verdict: 'accept' | 'ignore'
}

/**
 * The sequence, fixed by seed. Some steps are RESERVED so every seed covers the
 * shapes that matter (a legacy daemon, an active-but-empty list, a full 32-job
 * list, both non-active presences, a job with every optional field at its floor)
 * and 8 of 40 steps are deliberately stale; every other step is random. An
 * ignored step always carries visibly different content, so a store that wrongly
 * applied one would CHANGE the DOM rather than coincide with it.
 */
export function planChaos(seed: number, steps = 40): ChaosStep[] {
  const rng = rngFor(seed)
  const now = Date.now()
  const stale = new Set([3, 8, 14, 19, 24, 29, 34, 38])
  const reserved = new Map<number, { presence: SessionCronMetadata['presence']; mode: JobsMode }>([
    [0, { presence: 'active', mode: 3 }],
    [6, { presence: 'active', mode: 'legacy' }],
    [11, { presence: 'active', mode: 'empty' }],
    [16, { presence: 'active', mode: JOB_LIMIT }],
    [21, { presence: 'inactive', mode: 'empty' }],
    [26, { presence: 'unknown', mode: 'empty' }],
    [31, { presence: 'active', mode: 1 }],
  ])
  const plan: ChaosStep[] = []
  let accepted = 0
  for (let step = 0; step < steps; step += 1) {
    if (stale.has(step) && accepted > 0) {
      // A revision at or below the current one, with content unlike the accepted
      // state: presence flips and the list becomes one marker row.
      const revision = Math.max(1, accepted - int(rng, 0, 2))
      const marker = { ...makeJob(rng, 0, now), id: `stale${step}` }
      plan.push({ metadata: activeWith(revision, [marker], now), verdict: 'ignore' })
      continue
    }
    const shape = reserved.get(step) ?? {
      presence: pick(rng, ['active', 'active', 'active', 'inactive', 'unknown'] as const),
      mode: (rng() < 0.12 ? 'legacy' : rng() < 0.12 ? 'empty' : int(rng, 1, 12)) as JobsMode,
    }
    accepted += int(rng, 1, 3)
    plan.push({ metadata: metadataFor(rng, accepted, shape.presence, shape.mode, now), verdict: 'accept' })
  }
  return plan
}

// --------------------------- page plumbing ---------------------------

/** Capture the app's own /ws socket so daemon frames can be replayed into it.
 *  Static properties are copied onto the replacement for WebKit's sake. */
async function captureWs(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const Original = window.WebSocket
    class ChaosWebSocket extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        if (new URL(String(url), window.location.href).pathname !== '/ws') return
        ;(window as Window & { __chaosWs?: WebSocket }).__chaosWs = this
      }
    }
    for (const key of Object.getOwnPropertyNames(Original)) {
      if (key === 'prototype' || key === 'length' || key === 'name') continue
      try {
        ;(ChaosWebSocket as unknown as Record<string, unknown>)[key] = (Original as unknown as Record<string, unknown>)[key]
      } catch {
        // Read-only browser constants are already inherited by the subclass.
      }
    }
    window.WebSocket = ChaosWebSocket as unknown as typeof WebSocket
  })
}

async function waitForWs(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const ws = (window as Window & { __chaosWs?: WebSocket }).__chaosWs
    return ws?.readyState === 1
  }, null, { timeout: 20_000 })
}

/**
 * Both REST carriers of cron metadata, rewritten on top of the REAL body: the
 * hydration map (`/api/sessions/status`) seeds a task row, the single-session
 * read (`/api/sessions/:id`) seeds a panel header. `read()` returns the
 * fixture's current ACCEPTED observation, so a poll or a rehydration can never
 * contradict the WS. The fixture session is seeded `stopped`, which hides the
 * pill by design, so both bodies are patched to `idle` as well.
 */
async function routeCron(page: Page, read: () => SessionCronMetadata | null): Promise<void> {
  await page.route((url) => url.pathname === '/api/sessions/status', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    expect(response.ok()).toBe(true)
    const body = await response.json()
    const metadata = read()
    body.cron = metadata ? { [SID]: metadata } : {}
    if (body.statuses?.[SID]) body.statuses[SID].process_status = 'idle'
    await route.fulfill({ response, json: body })
  })
  await page.route((url) => url.pathname === `/api/sessions/${SID}`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    expect(response.ok()).toBe(true)
    const body = await response.json()
    body.cron = read()
    if (body.session) body.session.process_status = 'idle'
    await route.fulfill({ response, json: body })
  })
}

/** Console noise the FIXTURE produces for reasons unrelated to cron. Narrow
 *  predicates on purpose (never a blanket "ignore errors"): the fixture has no
 *  AI provider, so the agent-search probe answers 503 {code:'ai_disabled'} - the
 *  same response session-cron-supervision.spec.ts tolerates - and the browser
 *  logs the failed response itself as a console error. */
const TOLERATED: readonly ((text: string, url: string) => boolean)[] = [
  (text, url) => /Failed to load resource/i.test(text) && url.includes('/api/search/agent'),
]

export interface Watch { readonly problems: string[] }

function watchProblems(page: Page): Watch {
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const text = message.text()
    const url = message.location().url
    if (TOLERATED.some((allow) => allow(text, url))) return
    problems.push(`console.error: ${text} @ ${url}`)
  })
  return { problems }
}

/** No app navigation through page.goto: click a real link into the SPA. */
async function openHome(page: Page, baseURL: string): Promise<void> {
  await page.setContent('<a id="open-app">Open Walnut</a>')
  await page.locator('#open-app').evaluate((node, url) => { (node as HTMLAnchorElement).href = url }, baseURL)
  await page.locator('#open-app').click()
  await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 60_000 })
}

// --------------------------- the DOM oracle ---------------------------

export interface JobRowView {
  id: string
  heading: string
  code: string | null
  next: string
  facts: { first: string; second: string; last: string; count: number; expires: boolean; created: boolean }
  prompt: 'missing' | 'collapsed' | 'expanded'
  missingNote: string | null
  truncatedNote: string | null
}

export interface CardView {
  pill: boolean
  rowPill: boolean
  expanded: string | null
  card: boolean
  heading: string | null
  jobCountAttr: string | null
  note: string | null
  rows: JobRowView[]
}

/** One round trip reads the whole surface, so a comparison is atomic against a
 *  single paint instead of a dozen racing locator assertions. */
async function readView(page: Page): Promise<CardView> {
  return page.evaluate(({ sid, task, dot }) => {
    const panel = document.querySelector(`.main-page-session-column .session-panel[data-session-id="${sid}"]`)
    const text = (node: Element | null): string | null => (node ? node.textContent ?? '' : null)
    const pill = panel?.querySelector('.session-cron-pill') ?? null
    const card = panel?.querySelector('.session-cron-detail') ?? null
    const rows = card
      ? [...card.querySelectorAll('.session-cron-job')].map((li) => {
        const parts = (text(li.querySelector('.session-cron-job-facts')) ?? '').split(dot)
        const next = text(li.querySelector('.session-cron-job-next')) ?? ''
        const toggle = li.querySelector('.session-cron-prompt-toggle')
        const body = li.querySelector('.session-cron-prompt-text')
        return {
          id: li.getAttribute('data-job-id') ?? '',
          heading: text(li.querySelector('.session-cron-job-heading strong')) ?? '',
          code: text(li.querySelector('.session-cron-job-heading code')),
          // Clock text moves with the wall clock; only its two SHAPES are stable.
          next: next === 'Next run not computable from this expression' ? 'not-computable'
            : /^Next run .+\)$/.test(next) ? 'reported' : `unexpected: ${next}`,
          facts: {
            first: parts[0] ?? '',
            second: parts[1] ?? '',
            last: parts[parts.length - 1] ?? '',
            count: parts.length,
            expires: parts.some((part) => part.startsWith('Expires ')),
            created: parts.some((part) => part.startsWith('Created ')),
          },
          prompt: (!toggle ? 'missing' : body ? 'expanded' : 'collapsed') as 'missing' | 'collapsed' | 'expanded',
          missingNote: text(li.querySelector(':scope > .session-cron-prompt-note')),
          truncatedNote: text(li.querySelector('.session-cron-prompt .session-cron-prompt-note')),
        }
      })
      : []
    return {
      pill: !!pill,
      rowPill: !!document.querySelector(`.todo-panel-item[data-task-id="${task}"] .session-cron-pill`),
      expanded: pill?.getAttribute('aria-expanded') ?? null,
      card: !!card,
      heading: text(card?.querySelector('.session-cron-detail-heading strong') ?? null),
      jobCountAttr: card?.getAttribute('data-job-count') ?? null,
      // The card-level note (no details / empty list) lives in the scrolling body, never inside a row.
      note: text(card?.querySelector(':scope > .session-cron-detail-body > .session-cron-prompt-note') ?? null),
      rows,
    }
  }, { sid: SID, task: TASK, dot: DOT })
}

/**
 * What the card MUST show for one accepted observation, derived from the payload
 * alone and never from the DOM. Clock text is reduced to "reported / not
 * computable" and the facts line to its fixed parts: the rest moves with the
 * wall clock, and asserting it would make the oracle a coin flip.
 */
export function expectedView(metadata: SessionCronMetadata | null, cardOpen: boolean): CardView {
  const empty: CardView = {
    pill: false, rowPill: false, expanded: null, card: false,
    heading: null, jobCountAttr: null, note: null, rows: [],
  }
  if (metadata?.presence !== 'active') return empty
  const base = { ...empty, pill: true, rowPill: true, expanded: cardOpen ? 'true' : 'false' }
  if (!cardOpen) return base
  const jobs = metadata.jobs
  return {
    ...base,
    card: true,
    heading: jobs === undefined ? 'Cron job' : `Cron job${jobs.length === 1 ? '' : 's'}${DOT}${jobs.length}`,
    jobCountAttr: jobs === undefined ? 'unknown' : String(jobs.length),
    note: jobs === undefined
      ? 'The host confirmed a live cron job but its daemon predates job details. They appear after the daemon updates.'
      : jobs.length === 0 ? 'The host reports a live cron job but sent no job details.' : null,
    rows: (jobs ?? []).map((job) => ({
      id: job.id,
      heading: job.schedule ?? job.cron ?? 'Schedule not reported',
      code: job.cron && job.schedule ? job.cron : null,
      next: job.nextRunAt !== null ? 'reported' : 'not-computable',
      facts: {
        first: job.recurring ? 'Recurring' : 'Runs once',
        second: job.durable ? 'Saved to disk' : 'Session-only',
        last: `Job ${job.id}`,
        expires: job.recurring && job.expiresAt !== null,
        created: job.createdAt !== null,
        count: 3 + (job.recurring && job.expiresAt !== null ? 1 : 0) + (job.createdAt !== null ? 1 : 0),
      },
      prompt: job.prompt ? 'collapsed' : 'missing',
      missingNote: job.prompt ? null : 'Prompt not reported for this job.',
      truncatedNote: null,
    })),
  }
}

// --------------------------- fixture ---------------------------

export interface CronFixture {
  page: Page
  panel: Locator
  row: Locator
  pill: Locator
  card: Locator
  watch: Watch
  /** Dispatch one frame; `accepted` also makes it the REST truth. */
  push(metadata: SessionCronMetadata, accepted: boolean): Promise<void>
  /** Dispatch many frames in ONE evaluate, with no await between them. */
  pushBurst(list: SessionCronMetadata[]): Promise<void>
  read(): Promise<CardView>
  /** Open the card through the pill - the only way in. */
  openCard(): Promise<void>
}

export async function startFixture(page: Page, baseURL: string): Promise<CronFixture> {
  let accepted: SessionCronMetadata | null = null
  await isolateUiPrefs(page)
  // The fixture has no AI provider; the drawer's agent search would only add 503s.
  await page.addInitScript(() => localStorage.setItem('open-walnut-agent-search', '0'))
  const watch = watchProblems(page)
  await captureWs(page)
  await routeCron(page, () => accepted)
  await page.route((url) => url.pathname === `/api/sessions/${SID}/supervision`, (route) => route.fulfill({
    // On-demand host with no supervision record: no recovery row inside the card
    // and no supervision bar above it, so the surface under test is only jobs.
    json: { available: false, startup: 'on-demand', stopRequest: null, supervision: null },
  }))

  // Every wait in here gets its own generous budget: with four workers against a
  // cold fixture server this setup measured 31s, and the default 5s expect
  // timeout turned a busy machine into eight red tests that pass warm.
  await openHome(page, baseURL)
  await page.locator('.todo-search-input').fill(SID)
  const row = page.locator(`.todo-panel-item[data-task-id="${TASK}"]`)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.locator('.todo-item-title').click()
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${SID}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  // The header renders its pills only after the panel's own session fetch
  // resolves (`{!loading && <CronPill/>}`), while the task row's pill is live
  // from the store the moment an observation lands. The process badge is gated on
  // the same `!loading`, so waiting for it is what stops a push from landing in
  // one surface before the other exists at all.
  await expect(panel.locator('.session-panel-badge').last())
    .toHaveText(/^(Idle|Running|Waiting|Stopped|Error)$/, { timeout: 60_000 })
  await waitForWs(page)

  const pill = panel.locator('.session-cron-pill')
  const card = panel.locator('.session-cron-detail')
  return {
    page,
    panel,
    row,
    pill,
    card,
    watch,
    async push(metadata, isAccepted) {
      if (isAccepted) accepted = metadata
      await page.evaluate((data) => {
        const ws = (window as Window & { __chaosWs?: WebSocket }).__chaosWs
        if (!ws) throw new Error('the app WebSocket was never captured')
        ws.dispatchEvent(new MessageEvent('message', {
          data: JSON.stringify({ type: 'event', name: 'session:cron-metadata', data, seq: Date.now() }),
        }))
      }, metadata)
    },
    async pushBurst(list) {
      accepted = list[list.length - 1]
      await page.evaluate((frames) => {
        const ws = (window as Window & { __chaosWs?: WebSocket }).__chaosWs
        if (!ws) throw new Error('the app WebSocket was never captured')
        for (const data of frames) {
          ws.dispatchEvent(new MessageEvent('message', {
            data: JSON.stringify({ type: 'event', name: 'session:cron-metadata', data, seq: Date.now() }),
          }))
        }
      }, list)
    },
    read: () => readView(page),
    async openCard() {
      await expect(pill).toBeVisible()
      await pill.click()
      await expect(card).toBeVisible()
    },
  }
}

export function expectClean(watch: Watch): void {
  expect(watch.problems, 'browser console errors and uncaught exceptions').toEqual([])
}

// --------------------------- scenarios ---------------------------

/**
 * 1. The core: a long seeded sequence with the whole card re-derived from the
 * last accepted payload after EVERY push. It also pins the two rules the card
 * cannot be written without - an ignored payload changes nothing, and a later
 * active payload does NOT spring the card back open once a presence flip closed
 * it (CronJobsCard: `useEffect(() => { if (open && !cron) onClose() })`, and the
 * pill is the only way back in).
 */
export async function runSeededChaos(page: Page, baseURL: string, seed: number): Promise<void> {
  const fixture = await startFixture(page, baseURL)
  const plan = planChaos(seed)
  let accepted: SessionCronMetadata | null = null
  let cardOpen = false
  let reopens = 0

  for (const [index, step] of plan.entries()) {
    const label = `seed 0x${seed.toString(16)} step ${index}`
      + ` (rev ${step.metadata.revision}, ${step.verdict}, presence ${step.metadata.presence})`
    if (step.verdict === 'accept') accepted = step.metadata
    await fixture.push(step.metadata, step.verdict === 'accept')

    if (step.verdict === 'ignore') {
      // Give a wrongly-applied payload time to render. Its content differs from
      // the accepted state, so applying it could not look like a no-op.
      await page.waitForTimeout(120)
      expect(await fixture.read(), `${label}: an ignored payload must not touch the DOM`)
        .toEqual(expectedView(accepted, cardOpen))
      continue
    }

    const stillActive = accepted?.presence === 'active'
    if (!stillActive) cardOpen = false
    await expect.poll(() => fixture.read(), { message: label, timeout: 10_000 })
      .toEqual(expectedView(accepted, cardOpen))
    if (stillActive && !cardOpen) {
      // The card stayed closed across the flip (asserted just above). The pill is
      // the only way back in, so click it and keep checking against a live card.
      await fixture.openCard()
      cardOpen = true
      reopens += 1
      await expect.poll(() => fixture.read(), { message: `${label}: reopened`, timeout: 10_000 })
        .toEqual(expectedView(accepted, cardOpen))
    }
  }

  // The sequence has to have exercised the matrix: a seed that only ever pushed
  // small active lists would pass everything above vacuously.
  const acceptedSteps = plan.filter((step) => step.verdict === 'accept').map((step) => step.metadata)
  const jobCounts = acceptedSteps.map((step) => step.jobs?.length ?? -1)
  expect(plan.filter((step) => step.verdict === 'ignore').length, 'ignored pushes').toBeGreaterThanOrEqual(7)
  expect(jobCounts.filter((count) => count === -1).length, 'legacy payloads (no job details)').toBeGreaterThanOrEqual(1)
  expect(jobCounts.filter((count) => count === 0).length, 'empty job lists').toBeGreaterThanOrEqual(1)
  expect(Math.max(...jobCounts), 'the biggest job list').toBe(JOB_LIMIT)
  for (const presence of ['active', 'inactive', 'unknown'] as const) {
    expect(acceptedSteps.filter((step) => step.presence === presence).length, `${presence} payloads`)
      .toBeGreaterThanOrEqual(1)
  }
  expect(reopens, 'flips that closed the card and needed the pill again').toBeGreaterThanOrEqual(2)
  expectClean(fixture.watch)
}

/**
 * 2. An expanded prompt belongs to a JOB, not to a row position: reordering,
 * removing and adding jobs must leave the prompts the user opened open (JobRow is
 * keyed by job id), and the truncation note must follow the job that was actually
 * truncated.
 */
export async function runPromptPersistence(page: Page, baseURL: string): Promise<void> {
  const fixture = await startFixture(page, baseURL)
  const now = Date.now()
  const job = (id: string, minutes: number, prompt: string, promptTruncated: boolean): SessionCronJob => ({
    id, cron: '*/5 * * * *', schedule: `Every 5 minutes, job ${id}`, prompt, promptTruncated,
    recurring: true, durable: false, createdAt: now - HOUR,
    nextRunAt: now + minutes * 60_000, expiresAt: now + 5 * 24 * HOUR,
  })
  const a = job('aaaa0001', 5, 'Prompt A, short and untruncated.', false)
  const b = job('bbbb0002', 10, LONG_PROMPT, true)
  const c = job('cccc0003', 15, 'Prompt C.', false)
  const d = job('dddd0004', 2, MULTILINE_PROMPT, false)
  const rowFor = (id: string) => fixture.card.locator(`.session-cron-job[data-job-id="${id}"]`)

  await fixture.push(activeWith(1, [a, b, c], now), true)
  await fixture.openCard()
  for (const id of [a.id, b.id]) await rowFor(id).locator('.session-cron-prompt-toggle').click()
  await expect(rowFor(a.id).locator('.session-cron-prompt-text')).toBeVisible()
  await expect(rowFor(b.id).locator('.session-cron-prompt-text')).toBeVisible()
  // Only the job the server truncated says so, and only while it is expanded.
  await expect(rowFor(b.id).locator('.session-cron-prompt-note')).toHaveText('Showing the first 2,000 characters.')
  await expect(rowFor(a.id).locator('.session-cron-prompt-note')).toHaveCount(0)
  await expect(rowFor(c.id).locator('.session-cron-prompt-text')).toHaveCount(0)

  // One republication: D runs first now, C is gone, D is new.
  await fixture.push(activeWith(2, [b, a, d], now), true)
  await expect(fixture.card.locator('.session-cron-job')).toHaveCount(3)
  await expect(fixture.card.locator('.session-cron-job').first()).toHaveAttribute('data-job-id', d.id)
  await expect(rowFor(c.id)).toHaveCount(0)
  await expect(rowFor(a.id).locator('.session-cron-prompt-text')).toBeVisible()
  await expect(rowFor(b.id).locator('.session-cron-prompt-text')).toBeVisible()
  await expect(rowFor(b.id).locator('.session-cron-prompt-note')).toHaveText('Showing the first 2,000 characters.')
  // A new job arriving already expanded would mean the open flag lives on a
  // POSITION; D must start collapsed even though it took A's old place.
  await expect(rowFor(d.id).locator('.session-cron-prompt-text')).toHaveCount(0)
  await expect(rowFor(d.id).locator('.session-cron-prompt-preview')).toBeVisible()

  // Removing an expanded job closes nothing else.
  await fixture.push(activeWith(3, [b, d], now), true)
  await expect(rowFor(a.id)).toHaveCount(0)
  await expect(rowFor(b.id).locator('.session-cron-prompt-text')).toBeVisible()
  await expect(rowFor(b.id).locator('.session-cron-prompt-note')).toHaveText('Showing the first 2,000 characters.')
  await expect(rowFor(d.id).locator('.session-cron-prompt-text')).toHaveCount(0)
  expectClean(fixture.watch)
}

/** The densest list the product allows: SESSION_CRON_JOB_LIMIT jobs, every
 *  prompt at the character limit, every prompt expanded. */
async function seedDenseCard(fixture: CronFixture): Promise<void> {
  const now = Date.now()
  const jobs: SessionCronJob[] = Array.from({ length: JOB_LIMIT }, (_, index) => ({
    id: `dense${index.toString().padStart(3, '0')}`,
    cron: '*/5 * * * *',
    schedule: `Every 5 minutes, job ${index + 1} of ${JOB_LIMIT}`,
    prompt: `${index}: ${LONG_PROMPT}`.slice(0, PROMPT_LIMIT),
    promptTruncated: true,
    recurring: true,
    durable: index % 2 === 0,
    createdAt: now - (index + 1) * 60_000,
    nextRunAt: now + (index + 1) * 60_000,
    expiresAt: now + 6 * 24 * HOUR,
  }))
  await fixture.push(activeWith(1, jobs, now), true)
  await fixture.openCard()
  await expect(fixture.card.locator('.session-cron-job')).toHaveCount(JOB_LIMIT)
  // Expanded through each element's own click rather than Playwright's: a row far
  // down the card may not be scrollable into view (that is exactly what the
  // reach scenario measures), and this scenario is about layout once open.
  await fixture.card.locator('.session-cron-prompt-toggle').evaluateAll(
    (nodes) => { for (const node of nodes) (node as HTMLElement).click() },
  )
  await expect(fixture.card.locator('.session-cron-prompt-text')).toHaveCount(JOB_LIMIT)
}

/**
 * 3a. Density must not break the page around the card: nothing scrolls sideways,
 * the header keeps the pill and the status badge on one line, and the composer is
 * still on screen to type into.
 */
export async function runDensityLayout(page: Page, baseURL: string, shot: string): Promise<void> {
  const fixture = await startFixture(page, baseURL)
  await seedDenseCard(fixture)

  const horizontal = await fixture.card.evaluate((card) => {
    const overflow = (node: Element) => node.scrollWidth - node.clientWidth
    const pres = [...card.querySelectorAll('pre')]
    return { card: overflow(card), pres: pres.length, worstPre: Math.max(0, ...pres.map(overflow)) }
  })
  expect(horizontal.pres, 'one prompt block per job').toBe(JOB_LIMIT)
  expect(horizontal.card, 'the card must not scroll sideways').toBeLessThanOrEqual(1)
  expect(horizontal.worstPre, 'no prompt block may scroll sideways').toBeLessThanOrEqual(1)

  // The pill is an ADDITION to the header row, not something that wraps it.
  const badge = fixture.panel.locator('.session-panel-badge').last()
  const pillBox = (await fixture.pill.boundingBox())!
  const badgeBox = (await badge.boundingBox())!
  const centre = (box: { y: number; height: number }) => box.y + box.height / 2
  expect(Math.abs(centre(pillBox) - centre(badgeBox)), 'pill and status badge share one row').toBeLessThanOrEqual(4)
  const headerTop = fixture.panel.locator('.session-panel-header-top')
  expect(await headerTop.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1)

  // The composer survives: still on screen, still typable.
  const composer = fixture.panel.locator('.chat-input-textarea')
  await expect(composer).toBeVisible()
  const viewport = page.viewportSize()!
  const composerBox = (await composer.boundingBox())!
  expect(composerBox.y).toBeGreaterThanOrEqual(0)
  expect(composerBox.y + composerBox.height, 'the composer stays inside the viewport')
    .toBeLessThanOrEqual(viewport.height + 1)
  await composer.fill('typed under a full cron card')
  await expect(composer).toHaveValue('typed under a full cron card')

  const panelBox = (await fixture.panel.boundingBox())!
  const x = Math.max(0, Math.round(panelBox.x))
  const y = Math.max(0, Math.round(panelBox.y))
  await page.screenshot({
    path: `${SHOTS}/${shot}.png`,
    scale: 'css',
    clip: {
      x,
      y,
      width: Math.min(Math.round(panelBox.width), viewport.width - x),
      height: Math.min(Math.round(panelBox.height), viewport.height - y),
    },
  })
  expectClean(fixture.watch)
}

/**
 * 3b. Every job in a full card has to be READABLE. `.session-panel-body` hides
 * its overflow, so the question is whether something between the last row and
 * the panel can be scrolled BY A USER (overflow auto/scroll with hidden height)
 * and whether scrolling it to the end really brings that row inside the panel.
 * An `overflow: hidden` box does not count: it moves under script and ignores
 * the wheel. Before the card got its own scrolling body, a 32-job card ate the
 * whole panel and rows 3 to 32 could not be reached at all.
 */
export async function runDensityReach(page: Page, baseURL: string): Promise<void> {
  const fixture = await startFixture(page, baseURL)
  await seedDenseCard(fixture)

  const reach = await fixture.card.evaluate((card) => {
    const last = card.querySelector('.session-cron-job:last-of-type')!
    const panel = card.closest('.session-panel')!
    const stop = panel.parentElement
    const ancestors: { node: string; overflowY: string; hidden: number }[] = []
    let scroller: Element | null = null
    for (let node: Element | null = last; node && node !== stop; node = node.parentElement) {
      const classes = String((node as HTMLElement).className || '').split(/\s+/).filter(Boolean)
      const overflowY = getComputedStyle(node).overflowY
      const hidden = node.scrollHeight - node.clientHeight
      ancestors.push({ node: [node.tagName.toLowerCase(), ...classes].join('.'), overflowY, hidden })
      if (!scroller && /auto|scroll/.test(overflowY) && hidden > 1) scroller = node
    }
    // A user can wheel a real scroller to its end; measure the row from there.
    if (scroller) scroller.scrollTop = scroller.scrollHeight
    return {
      ancestors,
      cardHeight: Math.round(card.getBoundingClientRect().height),
      panelHeight: Math.round(panel.getBoundingClientRect().height),
      lastRowBelowPanelBy: Math.round(last.getBoundingClientRect().bottom - panel.getBoundingClientRect().bottom),
      userScrollable: scroller !== null,
    }
  })

  const measured = `measured: ${JSON.stringify(reach)}`
  expect(
    reach.userScrollable,
    `a full cron card must be reachable: either it fits, or a user-scrollable ancestor can bring its last row into view. ${measured}`,
  ).toBe(true)
  expect(
    reach.lastRowBelowPanelBy,
    `the last job row must not sit below the panel with no way to scroll to it. ${measured}`,
  ).toBeLessThanOrEqual(0)
  // The card must leave the chat room to breathe: never more than 60vh / 480px of the panel.
  expect(reach.cardHeight, `the card must stay bounded so the chat keeps its space. ${measured}`).toBeLessThanOrEqual(Math.min(481, Math.ceil(reach.panelHeight * 0.6) + 1))
  expectClean(fixture.watch)
}

/**
 * 4. The pill is a real button: it sits in the tab order, Enter opens the card,
 * and the card's close control can be tabbed to and pressed. A pill that only
 * answered a mouse would be invisible to keyboard and screen-reader users.
 */
export async function runKeyboardPath(page: Page, baseURL: string): Promise<void> {
  const fixture = await startFixture(page, baseURL)
  await fixture.push(metadataFor(rngFor(11), 1, 'active', 2, Date.now()), true)
  await expect(fixture.pill).toBeVisible()
  await expect(fixture.pill).toHaveAttribute('aria-label', 'Cron job armed. Show job details')
  await expect(fixture.pill).toHaveAttribute('aria-expanded', 'false')

  // Focus whatever precedes the pill in document order, then ONE Tab must land on
  // it: that proves the pill is in the natural tab order without walking the
  // whole page, and Shift+Tab proves the order holds both ways.
  const focusable = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
  const seated = await page.evaluate((selector) => {
    const all = [...document.querySelectorAll<HTMLElement>(selector)].filter((node) => node.getClientRects().length > 0)
    const index = all.findIndex((node) => node.tagName === 'BUTTON' && node.classList.contains('session-cron-pill'))
    if (index < 1) return { index, previous: null as string | null }
    all[index - 1].focus()
    return { index, previous: all[index - 1].className }
  }, focusable)
  expect(seated.index, 'the pill button is in the document focus order').toBeGreaterThan(0)
  // WebKit follows Safari's default: plain Tab visits text fields only, and
  // Option+Tab is the "every control" walk a keyboard user turns on. Chromium
  // reaches buttons with Tab itself.
  const webkit = page.context().browser()?.browserType().name() === 'webkit'
  const tab = webkit ? 'Alt+Tab' : 'Tab'
  const backTab = webkit ? 'Alt+Shift+Tab' : 'Shift+Tab'
  await page.keyboard.press(tab)
  expect(await page.evaluate(() => document.activeElement?.className ?? '')).toContain('session-cron-pill')
  await page.keyboard.press(backTab)
  expect(await page.evaluate(() => document.activeElement?.className ?? '')).toBe(seated.previous)
  await page.keyboard.press(tab)

  await page.keyboard.press('Enter')
  await expect(fixture.card).toBeVisible()
  await expect(fixture.pill).toHaveAttribute('aria-expanded', 'true')
  await expect(fixture.pill).toHaveAttribute('aria-label', 'Cron job armed. Hide job details')

  // Walk forward to the card's close button. The bound IS the assertion: a close
  // control 80 tab stops away is not reachable in any honest sense.
  let steps = 0
  let onClose = false
  while (steps < 80 && !onClose) {
    await page.keyboard.press(tab)
    steps += 1
    onClose = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Hide cron job details')
  }
  expect(onClose, `the close button was not reachable by Tab within ${steps} stops`).toBe(true)
  await page.keyboard.press('Enter')
  await expect(fixture.card).toHaveCount(0)
  await expect(fixture.pill).toHaveAttribute('aria-expanded', 'false')
  await expect(fixture.pill).toHaveAttribute('aria-label', 'Cron job armed. Show job details')
  expectClean(fixture.watch)
}

/**
 * 5. A daemon that re-observes in a burst (a reconnect replay) delivers many
 * frames with no gap between them. The card must land on the LAST one, and stay
 * there - not on whichever frame won a race.
 */
export async function runRapidBurst(page: Page, baseURL: string): Promise<void> {
  const fixture = await startFixture(page, baseURL)
  const rng = rngFor(0x0b0b0b)
  const now = Date.now()
  await fixture.push(metadataFor(rng, 1, 'active', 2, now), true)
  await fixture.openCard()

  // Every frame is active: a non-active frame in the middle would legitimately
  // close the card (the pill is the only way in), which scenario 1 covers.
  const burst = Array.from({ length: 30 }, (_, index) => metadataFor(rng, index + 2, 'active', int(rng, 1, 6), now))
  const last = burst[burst.length - 1]
  const started = Date.now()
  await fixture.pushBurst(burst)
  await expect.poll(() => fixture.read(), { message: 'the card settles on the last frame of a burst', timeout: 2_000 })
    .toEqual(expectedView(last, true))
  const settleMs = Date.now() - started

  // ... and stays there: nothing arrives late to re-render an earlier frame.
  await page.waitForTimeout(500)
  expect(await fixture.read(), 'no earlier frame re-renders after the burst settles').toEqual(expectedView(last, true))
  expect(settleMs, 'burst settle time in ms').toBeLessThan(2_000)
  expectClean(fixture.watch)
}

/**
 * 6. Two surfaces, one truth: the task row's pill and the session header's pill
 * are separate components reading the same store, and they must never disagree -
 * not even for a single paint.
 */
export async function runSurfaceConsistency(page: Page, baseURL: string): Promise<void> {
  const fixture = await startFixture(page, baseURL)
  const rng = rngFor(0x0f11f5)
  const now = Date.now()
  const flips: SessionCronMetadata['presence'][] = [
    'active', 'inactive', 'active', 'unknown', 'active', 'inactive', 'active', 'active', 'unknown', 'active',
  ]
  for (const [index, presence] of flips.entries()) {
    const mode: JobsMode = presence === 'active' ? int(rng, 1, 4) : 'empty'
    await fixture.push(metadataFor(rng, index + 1, presence, mode, now), true)
    // Sampled DURING the transition: both pills come from the same commit, so a
    // sample may hold the old value or the new one, never one of each.
    for (let sample = 0; sample < 5; sample += 1) {
      const view = await fixture.read()
      expect(view.rowPill, `flip ${index} to ${presence}, sample ${sample}: the two pills disagree`).toBe(view.pill)
    }
    await expect.poll(() => fixture.read().then((view) => ({ pill: view.pill, rowPill: view.rowPill })), {
      message: `flip ${index} to ${presence}`,
      timeout: 10_000,
    }).toEqual({ pill: presence === 'active', rowPill: presence === 'active' })
  }
  expectClean(fixture.watch)
}
