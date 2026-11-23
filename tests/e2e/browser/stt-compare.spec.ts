/**
 * Settings › Diagnostics › Voice Accuracy (experiment stt_compare, web/src/components/settings/
 * sections/VoiceAccuracySection.tsx; server src/web/routes/stt-compare.ts).
 *
 *  1. Off: no Voice Accuracy entry in the Settings nav, nor in Find a setting.
 *  2. On: the entry is under Diagnostics; three recordings brought in as a benchmark (POST
 *     /import-bench, the only way in that runs no engine) show in the summary as estimated
 *     errors from earlier AI guesses on the same recordings, and the judge's line says its
 *     sending is not allowed (its consent is unticked), with the way to that setting.
 *  3. A recording opens in a dialog (never in its row), a glass dialog of the overlay family, inside the viewport
 *     with nothing scrolling sideways at 1280 px: Play recording and Recalculate at the top, one
 *     engine's text at a time beside the AI's guess, the text exactly as the engine wrote it
 *     (missing words listed apart), the legend, what was probably sent with its "Probably" label
 *     (the server's answer for one take carries a pairing, as the send path writes it), and Play
 *     recording, which fetches nothing until it is clicked and then fetches the recording (served
 *     here as silence, the element muted: nothing makes a sound). Escape closes it and the focus
 *     goes back to its row.
 *  4. Ticking the AI judge's consent reaches the server, and with no engine ready the run reads
 *     "Estimate errors" and runs to its end; the consent is put back after.
 *  2b. Over time: the seeded recordings are on three days, so the chart draws a line per engine, the
 *     in-use one leading; a hovered point reads out its day, and the metric switch (Time) redraws the line.
 *  5. At 390 px the recordings are a stacked list and nothing scrolls sideways (the chart too); each consent tick
 *     sits on its label's first line with the label in full beside it, and the engines'
 *     switches line up at the right whatever their state's words. The dialog opened there is on
 *     top of everything, the phone's top bar included: the point at the centre of its Close is the
 *     Close itself (2026-11-22: the top bar sat over it and took its clicks). At 320 px the dialog
 *     is a full-height sheet whose engine switch wraps instead of scrolling sideways.
 * The fixture is shared: the takes are this run's own (stamped ids), and the flag and consent go back.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { loadHome } from './draft-helpers'

const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const FLAG = 'stt_compare'
const SHOTS = `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots`
const TAKES = [0, 1, 2].map((i) => ({
  rec: `va${STAMP}n${i}`,
  ts: new Date(Date.UTC(2026, 10, 18 + i, 10, 30 + i)).toISOString(),
  silver: `Walnut test take ${i}: the second one is Tailscale, is the pairing related to it`,
  a0: `Walnut test take ${i}: the second one is tail skill, is the pairing related to it`,
  whisper: `Walnut test take ${i}: second is tail scale, is pairing related to it`,
  a3: `Walnut test take ${i}: the second one is Tailscale, is the pairing related to it`,
}))

test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)
test.use({ viewport: { width: 1280, height: 860 } })

let flagsBefore: Record<string, boolean> | null = null

async function setFlag(request: APIRequestContext, on: boolean): Promise<void> {
  const cfg = await (await request.get('/api/config')).json() as { config?: { experimental?: Record<string, boolean> } }
  flagsBefore ??= { ...(cfg.config?.experimental ?? {}) }
  const res = await request.put('/api/config', { data: { experimental: { ...(cfg.config?.experimental ?? {}), [FLAG]: on } } })
  expect(res.ok(), await res.text()).toBe(true)
}

async function seedTakes(request: APIRequestContext): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'va-bench-'))
  fs.writeFileSync(path.join(dir, 'takes.json'), JSON.stringify(TAKES.map((t) => ({
    id: t.rec, kind: 'web', audio: `/nowhere/stt-recordings/${t.rec}.webm`, ts: t.ts, dur: 42 + t.rec.length % 5, text: t.a0,
  }))))
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify({
    per_take: TAKES.map((t) => ({
      id: t.rec, silver: t.silver, terms: { Tailscale: 1 },
      texts: { A0: t.a0, whisper: t.whisper, A3: t.a3 },
      arms: { A0: { engine_ms: 2300 }, whisper: { engine_ms: 13900 }, A3: { llm_s: 2.4 } },
    })),
  }))
  const res = await request.post('/api/stt/compare/import-bench', { data: { dir } })
  expect(res.ok(), await res.text()).toBe(true)
  const out = await res.json() as { imported: number; unchanged: number }
  expect(out.imported + out.unchanged).toBe(TAKES.length)
  // A real benchmark folder (takes.json + results.json) for screenshots at real density.
  const real = process.env.STT_COMPARE_BENCH_DIR
  if (real) {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'va-real-'))
    for (const f of ['takes.json', 'results.json']) fs.copyFileSync(path.join(real, f), path.join(copy, f))
    const more = await request.post('/api/stt/compare/import-bench', { data: { dir: copy } })
    expect(more.ok(), await more.text()).toBe(true)
  }
}

async function openSettings(page: Page): Promise<void> {
  await loadHome(page)
  await page.locator('.sidebar-nav a[href^="/settings"]').click()
  await expect(page.getByTestId('settings-nav-general')).toBeVisible()
}

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: `${SHOTS}/stt-compare-${name}.png`, scale: 'css' })
}

test.afterAll(async ({ request }) => {
  await request.put('/api/stt/compare/settings', { data: { engines: { judge: { allow_upload: false } } } }).catch(() => {})
  if (flagsBefore) await request.put('/api/config', { data: { experimental: flagsBefore } })
})

test('the pane is off the nav and Find while the experiment is off', async ({ page, request }) => {
  await setFlag(request, false)
  await openSettings(page)
  await expect(page.getByTestId('settings-nav-suggest-accuracy')).toBeVisible()
  await expect(page.getByTestId('settings-nav-voice-accuracy')).toHaveCount(0)
  await page.getByTestId('settings-filter').fill('voice accuracy')
  await expect(page.getByTestId('settings-nav-voice-accuracy')).toHaveCount(0)
  await page.getByTestId('settings-filter').fill('')
})

/** A WAV of silence: what the Play test is served, so nothing can be heard even unmuted. */
function silentWav(ms = 200): Buffer {
  const rate = 8000
  const samples = Math.round((rate * ms) / 1000)
  const b = Buffer.alloc(44 + samples * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12)
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24)
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples * 2, 40)
  return b
}

/** The dialog inside the viewport, and nothing in it or the page wider than it shows. */
async function dialogFits(page: Page): Promise<{ top: number; bottom: number; vh: number; extra: number[] }> {
  return page.evaluate(() => {
    const box = document.querySelector('[data-testid="va-take-dialog"]') as HTMLElement
    const r = box.getBoundingClientRect()
    const scrollers = [document.documentElement, box, box.querySelector('.va-take-dialog-body'), box.querySelector('.settings-segmented')]
      .filter((el): el is HTMLElement => !!el)
    return { top: r.top, bottom: r.bottom, vh: window.innerHeight, extra: scrollers.map((el) => el.scrollWidth - el.clientWidth) }
  })
}

/** Is the open dialog's Close the element at its own centre (its icon inside it counts), so nothing lies over it? */
async function closeOnTop(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const close = document.querySelector('[data-testid="va-take-dialog-close"]') as HTMLElement
    const r = close.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return !!hit && (hit === close || close.contains(hit))
  })
}

test('summary, a recording opened, a consent ticked, and the phone layout', async ({ page, request }) => {
  await setFlag(request, true)
  await seedTakes(request)
  let audioFetched = false
  page.on('request', (r) => { if (/\/api\/stt\/compare\/takes\/[^/]+\/audio$/.test(r.url())) audioFetched = true })
  // The benchmark's recordings are not on this machine: Play is served silence instead.
  await page.route(/\/api\/stt\/compare\/takes\/[^/]+\/audio$/, (route) => route.fulfill({ status: 200, contentType: 'audio/wav', body: silentWav() }))
  // What the send path writes for a take whose dictation a person sent on (sent-text.ts): a pairing
  // by text, with its similarity. The benchmark has none, so the server's answer for one take gets it.
  const SENT_AT = new Date(Date.UTC(2026, 10, 18, 10, 32)).toISOString()
  const paired = `rec-${TAKES[0]!.rec}`
  const withSent = (t: Record<string, unknown>) => (t.id === paired ? { ...t, sentText: TAKES[0]!.a3, sentAt: SENT_AT, sentMatch: 'text-similarity', sentSimilarity: 0.92 } : t)
  await page.route(/\/api\/stt\/compare\/takes(\/[^/?]+)?(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const res = await route.fetch()
    const body = await res.json() as { takes?: Array<Record<string, unknown>> } & Record<string, unknown>
    const out = Array.isArray(body.takes) ? { ...body, takes: body.takes.map(withSent) } : withSent(body)
    await route.fulfill({ response: res, json: out })
  })

  await openSettings(page)
  await page.getByTestId('settings-nav-voice-accuracy').click()
  const pane = page.locator('#voice-accuracy')
  await expect(pane).toBeVisible()

  // The summary: estimated errors per engine over the shared recordings, and the judge's line.
  const summary = page.getByTestId('va-summary')
  await expect(summary.getByTestId('va-summary-row').first()).toBeVisible()
  await expect(summary).toContainText('Estimated errors')
  await expect(summary).toContainText(/on the same \d+ recordings?/)
  await expect(summary).toContainText("doesn't listen")
  await expect(summary.getByTestId('va-judge-off')).toContainText("Sending texts to the AI judge isn't allowed.")
  await expect(summary.getByTestId('va-judge-fix')).toHaveText("Review what's sent")
  await expect(summary.locator('[data-engine="whisper-large-v2"]')).toBeVisible()
  await expect(summary.locator('[data-engine="whisper-large-v2"]')).toContainText('Median time')
  // Each row is labelled by the model its results recorded (the benchmark's), never the engine in use now.
  await expect(summary.locator('[data-engine="whisper-large-v2"]').getByTestId('va-summary-model')).toContainText('11-21 benchmark')
  await shot(page, 'desktop')

  // Over time: the seeded recordings are on three days, so each engine has a line; in use first.
  const trend = page.getByTestId('va-trend')
  await expect(trend).toContainText('Over time')
  const chart = trend.getByTestId('va-trend-chart')
  await expect(chart).toBeVisible()
  await expect(trend.getByTestId('va-trend-empty')).toHaveCount(0)
  const inUseLine = chart.locator('[data-testid="va-trend-line"][data-engine="in-use"]')
  await expect(inUseLine).toHaveAttribute('data-lead', 'true')
  expect(await inUseLine.getByTestId('va-trend-point').count()).toBeGreaterThanOrEqual(2)
  await expect(trend.locator('.va-trend-legend li').first()).toHaveAttribute('data-lead', 'true')
  await expect(trend.locator('.va-trend-tick').filter({ hasText: /^\d+%$/ }).first()).toBeAttached()
  await expect(trend.getByTestId('va-trend-readout')).toContainText(/recordings?/)
  // A point under the pointer reads out its own day.
  const firstPoint = inUseLine.getByTestId('va-trend-point').first()
  const firstDay = await firstPoint.getAttribute('data-day')
  await firstPoint.hover()
  await expect(trend.getByTestId('va-trend-readout')).toHaveAttribute('data-day', firstDay!)
  // The metric switch redraws the line: Time plots median seconds.
  const pathBefore = await inUseLine.locator('path').getAttribute('d')
  await trend.getByTestId('va-trend-ms').click()
  await expect(trend.locator('.va-trend-box')).toHaveAttribute('data-metric', 'ms')
  await expect(inUseLine.getByTestId('va-trend-point').first()).toHaveAttribute('data-value', / s$/)
  await expect.poll(() => inUseLine.locator('path').getAttribute('d')).not.toBe(pathBefore)
  await expect(trend.locator('.va-trend-tick').filter({ hasText: / s$/ }).first()).toBeAttached()
  await shot(page, 'over-time')
  // Kept like any view choice; put back to Overall for the next run.
  await trend.getByTestId('va-trend-mixed').click()
  await expect(trend.locator('.va-trend-box')).toHaveAttribute('data-metric', 'mixed')

  // A recording opens in its dialog: Play and Recalculate at the top, one engine's text beside the AI's guess.
  const takes = page.getByTestId('va-takes')
  await expect(takes).toHaveAttribute('data-layout', 'matrix')
  const row = takes.locator(`[data-testid="va-take-row"][data-take="${paired}"]`)
  await row.scrollIntoViewIfNeeded()
  const rowHeight = (await row.boundingBox())!.height
  // The row's preview names what was probably sent as just that.
  await expect(row.locator('.va-take-source')).toHaveText('Probably sent: ')
  await row.click()
  const dialog = page.getByTestId('va-take-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAttribute('role', 'dialog')
  await expect(dialog.getByTestId('va-take-dialog-close')).toBeVisible()
  // The row never grows: the recording is in the dialog, and the dialog fits the window.
  expect((await row.boundingBox())!.height).toBeLessThanOrEqual(rowHeight + 1)
  const detail = dialog.getByTestId('va-take-detail')
  await expect(detail.getByTestId('va-reference')).toHaveText(TAKES[0]!.silver)
  await expect(detail.getByTestId('va-detail-in-use')).toContainText('tail')
  // The engine's text reads exactly as it was written, marks and all.
  await expect(detail.getByTestId('va-engine-text')).toHaveText(TAKES[0]!.a0)
  await expect(detail.getByTestId('va-detail-in-use').locator('.va-diff-wrong, .va-diff-extra, .va-diff-missing').first()).toBeVisible()
  await expect(detail.getByTestId('va-diff-legend')).toContainText("differs from the AI's guess")
  {
    const fit = await dialogFits(page)
    expect(fit.top, 'the dialog starts inside the window').toBeGreaterThanOrEqual(0)
    expect(fit.bottom, 'the dialog ends inside the window').toBeLessThanOrEqual(fit.vh)
    for (const extra of fit.extra) expect(extra, 'nothing in the dialog scrolls sideways at 1280 px').toBeLessThanOrEqual(1)
  }
  await expect(detail.getByTestId('va-judge-again')).toHaveText('Recalculate estimated errors')
  await expect(detail.getByTestId('va-judge-reason')).toContainText("isn't allowed")
  await detail.getByTestId('va-show-whisper-large-v2').click()
  await expect(detail.getByTestId('va-engine-text')).toHaveText(TAKES[0]!.whisper)
  await expect(detail.getByTestId('va-missing-list')).toContainText('the')
  await detail.getByTestId('va-show-sent').click()
  await expect(detail.getByTestId('va-sent-heading')).toHaveText(/^Probably what you sent \(matched by text, \d\d:\d\d\)$/)
  await expect(detail.getByTestId('va-engine-text')).toHaveText(TAKES[0]!.a3)
  await detail.getByTestId('va-show-in-use').click()
  // The switch shows the text it picked: In use is the one picked, Probably sent no longer.
  await expect(detail.getByTestId('va-show-in-use')).toHaveAttribute('aria-checked', 'true')
  await expect(detail.getByTestId('va-show-sent')).toHaveAttribute('aria-checked', 'false')
  await expect(detail.getByTestId('va-engine-text')).toHaveText(TAKES[0]!.a0)
  await expect(detail.getByTestId('va-play')).toBeVisible()
  expect(audioFetched, 'the recording is never fetched before Play is clicked').toBe(false)
  await shot(page, 'take-open')

  // Play fetches the recording, and only then; every media element is muted first (no sound, ever).
  await page.evaluate(() => {
    const play = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) { this.muted = true; this.volume = 0; return play.call(this) }
  })
  const audioRequest = page.waitForRequest(/\/api\/stt\/compare\/takes\/[^/]+\/audio$/)
  await detail.getByTestId('va-play').click()
  await audioRequest
  await expect(detail.getByTestId('va-audio')).toBeAttached()
  expect(await detail.getByTestId('va-audio').evaluate((el) => (el as HTMLAudioElement).muted)).toBe(true)

  // Escape closes it, and the focus goes back to the row it came from.
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(row.getByTestId('va-take-details')).toBeFocused()

  // Ticking the judge's consent reaches the server.
  const consent = page.getByTestId('va-consent-judge')
  await consent.scrollIntoViewIfNeeded()
  await expect(consent).not.toBeChecked()
  await consent.check()
  await expect(consent).toBeChecked()
  await expect.poll(async () => {
    const view = await (await request.get('/api/stt/compare/engines')).json() as { engines: Array<{ id: string; allow_upload: boolean }> }
    return view.engines.find((e) => e.id === 'judge')?.allow_upload
  }).toBe(true)

  // No engine is ready here, so the run only asks the AI judge: it says so, and runs to its end.
  await expect(page.getByTestId('va-run-plan')).toHaveAttribute('data-plan', 'judge-only')
  const runKey = page.getByTestId('va-run')
  await expect(runKey).toHaveText('Estimate errors')
  await runKey.scrollIntoViewIfNeeded()
  await runKey.click()
  await expect(page.getByTestId('va-last-run')).toHaveText(/^The last run (compared|found nothing)/, { timeout: 60_000 })
  await expect(page.getByTestId('va-progress')).toHaveCount(0)

  // Your data: the edited dictations kept (none yet: the benchmark has no sends), and their download.
  const pairs = page.getByTestId('va-pairs')
  await pairs.scrollIntoViewIfNeeded()
  await expect(pairs).toContainText('Edited dictations kept: 0')
  await expect(page.getByTestId('va-pairs-download')).toBeDisabled()
  {
    const res = await request.get('/api/stt/compare/pairs.jsonl')
    expect(res.status()).toBe(200)
    expect((await res.text()).trim()).toBe('')
  }
  await shot(page, 'your-data')

  // The phone: a stacked list, nothing wider than the screen.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(takes).toHaveAttribute('data-layout', 'stacked')
  await expect(summary).toHaveAttribute('data-layout', 'rows')
  await expect(takes.locator('.va-badges').first()).toBeVisible()
  const overflow = await page.evaluate(() => {
    const pane = document.getElementById('voice-accuracy')
    const scrollers = [document.documentElement, pane, pane?.closest('.settings-pane')].filter((el): el is HTMLElement => !!el)
    return scrollers.map((el) => el.scrollWidth - el.clientWidth)
  })
  for (const extra of overflow) expect(extra, 'no sideways scroll at 390 px').toBeLessThanOrEqual(1)
  // The chart is drawn at the pane's width there, never wider than its box.
  const fit = await page.evaluate(() => {
    const svg = document.querySelector('#voice-accuracy [data-testid="va-trend-chart"]')!.getBoundingClientRect()
    const box = document.querySelector('#voice-accuracy .va-trend-box')!.getBoundingClientRect()
    return { svg: svg.right, box: box.right, vb: document.querySelector('#voice-accuracy [data-testid="va-trend-chart"]')!.getAttribute('viewBox') }
  })
  expect(fit.svg, `chart right edge (viewBox ${fit.vb})`).toBeLessThanOrEqual(fit.box + 1)
  // Stacked, the row keeps its Details key.
  await expect(takes.locator(`[data-testid="va-take-row"][data-take="${paired}"]`).getByTestId('va-take-details')).toBeVisible()
  // Each consent tick on its label's first line, the label in full beside it.
  const ticks = await page.evaluate(() => [...document.querySelectorAll('#voice-accuracy .settings-checkbox-row')].map((row) => {
    const box = row.querySelector('.settings-checkbox-input')!.getBoundingClientRect()
    const label = row.querySelector('.settings-checkbox-label') as HTMLElement
    const l = label.getBoundingClientRect()
    return { boxRight: box.right, labelLeft: l.left, topGap: Math.abs(l.top - box.top), cut: label.scrollWidth > label.clientWidth + 1 }
  }))
  expect(ticks.length).toBeGreaterThan(0)
  for (const t of ticks) {
    expect(t.labelLeft, 'the label sits beside its tick').toBeGreaterThan(t.boxRight)
    expect(t.topGap, 'the tick is on the label\'s first line').toBeLessThanOrEqual(4)
    expect(t.cut, 'the label is never cut').toBe(false)
  }
  // The switches line up at the right whatever their state's words.
  const rights = await page.evaluate(() => [...document.querySelectorAll('#voice-accuracy [data-testid^="va-switch-"]')].map((el) => Math.round(el.getBoundingClientRect().right)))
  expect(new Set(rights).size, `switch right edges ${rights.join(', ')}`).toBe(1)
  await shot(page, 'phone')

  // The dialog opened on a phone is on top of everything: nothing (the top bar) sits over its Close.
  {
    const phoneRow = takes.locator(`[data-testid="va-take-row"][data-take="${paired}"]`)
    await phoneRow.scrollIntoViewIfNeeded()
    await phoneRow.getByTestId('va-take-details').click()
    await expect(dialog).toBeVisible()
    const close = dialog.getByTestId('va-take-dialog-close')
    await expect(close).toBeVisible()
    expect(await closeOnTop(page), 'the element at the centre of the Close is the Close').toBe(true)
    await close.click()
    await expect(dialog).toHaveCount(0)
  }

  // At 320 px the dialog is a sheet the height of the screen, and its five-way engine switch wraps.
  await page.setViewportSize({ width: 320, height: 640 })
  const narrowRow = takes.locator(`[data-testid="va-take-row"][data-take="${paired}"]`)
  await narrowRow.scrollIntoViewIfNeeded()
  await narrowRow.getByTestId('va-take-details').click()
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAttribute('data-sheet', 'true')
  await expect(dialog.getByTestId('va-take-detail')).toBeVisible()
  {
    const fit = await dialogFits(page)
    expect(fit.top).toBeGreaterThanOrEqual(0)
    expect(fit.bottom).toBeLessThanOrEqual(fit.vh)
    expect(fit.bottom - fit.top, 'a full-height sheet').toBeGreaterThanOrEqual(fit.vh - 2)
    for (const extra of fit.extra) expect(extra, 'nothing in the sheet scrolls sideways at 320 px').toBeLessThanOrEqual(1)
  }
  expect(await closeOnTop(page), 'the element at the centre of the Close is the Close at 320 px').toBe(true)
  await dialog.getByTestId('va-take-dialog-close').click()
  await expect(dialog).toHaveCount(0)
})
