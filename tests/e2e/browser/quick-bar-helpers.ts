/**
 * What the quick bar's specs share (quick-bar.spec.ts, quick-bar-modes.spec.ts): the canned speech
 * engine, the people list and the send, the experiment's switch, and the app opened by a click.
 */
import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { stubSttStatus } from './voice-selection-helpers'

export const SHOT_DIR = process.env.WALNUT_TASK_DIR ? path.join(process.env.WALNUT_TASK_DIR, 'shots') : '/tmp/quick-bar/shots'
export const KEY = 'Control+Alt+Meta+Space'
export const DRAFT = 'to Walnut VP, ship the'
export const FINAL = 'to Walnut VP, ship the quick bar first'

export const PEOPLE = [
  { id: 'pw-ceo', title: 'CEO', kind: 'ceo', project: '', state: 'waiting', stateLabel: 'Waiting', line: 'Your next message', needs: 0 },
  { id: 'pw-vp-walnut', title: 'Walnut VP', kind: 'vp', project: 'Walnut', state: 'waiting', stateLabel: 'Waiting', line: 'Pick the artifacts layout', needs: 3 },
  { id: 'pw-vp-garden', title: 'Garden VP', kind: 'vp', project: 'Garden', state: 'working', stateLabel: 'Working', line: 'Planting the spring beds', needs: 0 },
  { id: 'pw-task-tile', title: 'Pick the tile color', kind: 'task', project: 'Garden', state: 'needs', stateLabel: 'Needs you', line: 'Blue or sand?', needs: 1 },
]

export async function shot(page: Page, name: string): Promise<void> {
  await fs.mkdir(SHOT_DIR, { recursive: true })
  await page.screenshot({ path: path.join(SHOT_DIR, `quick-bar-${name}.png`) }).catch(() => {})
}

export async function setFlag(request: APIRequestContext, on: boolean): Promise<Record<string, boolean>> {
  const cfg = await (await request.get('/api/config')).json() as { config?: { experimental?: Record<string, boolean> } }
  const before = { ...(cfg.config?.experimental ?? {}) }
  const res = await request.put('/api/config', { data: { experimental: { ...before, quick_bar: on } } })
  expect(res.ok(), await res.text()).toBe(true)
  return before
}

/**
 * The switch as this page reads it, without writing the server's config: the app's own GET of
 * the config answers with `quick_bar` set. For a spec file that runs beside quick-bar.spec.ts,
 * which turns the server's switch off and on (spec files run in parallel workers on one server).
 */
export async function pinFlag(page: Page, on: boolean): Promise<void> {
  await page.route('**/api/config', async (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    const res = await r.fetch()
    const body = await res.json() as { config?: { experimental?: Record<string, boolean> } }
    if (body.config) body.config.experimental = { ...(body.config.experimental ?? {}), quick_bar: on }
    await r.fulfill({ response: res, json: body })
  })
}

/** `takes`: recordings the engine was asked to write out (none may run while voice is off). */
export interface Sends { bodies: Array<{ to?: string; text: string; follow?: boolean }>; fail: boolean; takes: number }

/** The canned engine, the people list and the send (a reply streamed in three lines). */
export async function stubAll(page: Page, said: { draft?: string; final?: string; finalDelayMs?: number } = {}): Promise<Sends> {
  const sends: Sends = { bodies: [], fail: false, takes: 0 }
  await stubSttStatus(page)
  await page.route('**/api/stt/warmup', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }))
  // The live words grow over two drafts, as they do while one talks: the second must replace the
  // first, never land beside it (2026-11-20: "to Walnut VP to Walnut VP, ..." in the proof video).
  let drafts = 0
  await page.route('**/api/stt/draft', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: said.draft ?? (drafts++ === 0 ? 'to Walnut VP' : DRAFT), durationMs: 30 }) }))
  await page.route('**/api/stt/transcribe', async (r) => {
    sends.takes++
    // A slow engine: the last words come in well after the key that ended the take.
    if (said.finalDelayMs) await new Promise((done) => setTimeout(done, said.finalDelayMs))
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: said.final ?? FINAL, durationMs: 40 }) })
  })
  await page.route('**/api/stt/save', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ recordingId: 'rec-qb-1', debugAudioPath: '/tmp/rec-qb-1.webm' }) }))
  await page.route('**/api/v1/quick/people**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ people: PEOPLE }) }))
  await page.route('**/api/v1/quick/send', async (r: Route) => {
    const body = JSON.parse(r.request().postData() ?? '{}')
    sends.bodies.push(body)
    if (sends.fail) { await r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Walnut is restarting' }) }); return }
    const to = body.to ?? 'pw-ceo'
    const lines = [
      { type: 'sent', taskId: to, sessionId: 's-1', started: false, messageId: 'm-1' },
      { type: 'delivered' },
      { type: 'text', delta: 'On it. ' },
      { type: 'result', text: 'On it. The bar ships first, the phone next.' },
    ]
    await r.fulfill({ status: 200, contentType: 'application/x-ndjson', body: lines.map((l) => JSON.stringify(l)).join('\n') + '\n' })
  })
  return sends
}

/** Voice off (no engine): the bar opens for typing. Registered last, so it wins over stubAll's. */
export async function voiceOff(page: Page): Promise<void> {
  await page.route('**/api/stt/status', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ engine: null, available: false }) }))
}

/** Walnut open; with the experiment on, also its key listener (the switch is read after the page shows). */
export async function openApp(page: Page, barOn = true): Promise<void> {
  await page.setContent(`<a href="${test.info().project.use.baseURL}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut' }).click()
  // A busy dev host takes a while to boot the app (the other specs give it 45 to 90 s).
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 90_000 })
  if (barOn) await expect(page.locator('.qb-layer')).toBeAttached({ timeout: 15_000 })
}

export const bar = (page: Page) => page.locator('.qb-center .qb-bar')
export const box = (page: Page) => page.getByRole('textbox', { name: 'Message' })
export const chip = (page: Page) => page.locator('.qb-to-name')
