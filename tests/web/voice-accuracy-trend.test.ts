/**
 * Voice Accuracy's Over time chart (VoiceAccuracyTrend.tsx): one line per engine that has a
 * point, the in-use engine first; each point names its day, value and recordings; the metric
 * switch (Overall, Chinese, English, Time) redraws the lines from the same days; fewer than two
 * days says so instead of a chart; and the day labels never crowd each other.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { parseHTML } from 'linkedom'
import { act, createElement } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'
import type { CompareTrendDay, CompareTrendPoint } from '../../web/src/api/stt-compare'
import { VoiceAccuracyTrend, labelIndexes } from '../../web/src/components/settings/sections/VoiceAccuracyTrend'
import { trendDays, trendLines, trendWords } from '../../web/src/components/settings/sections/voice-accuracy-model'

const point = (mixed: number, takes: number, medianMs: number, over: Partial<CompareTrendPoint> = {}): CompareTrendPoint =>
  ({ mixed, cjk: mixed * 2, latin: mixed / 2, terms: null, takes, medianMs, ...over })

const TREND: CompareTrendDay[] = [
  { day: '2026-11-20', engines: { 'in-use': point(0.1, 4, 2000) } },
  { day: '2026-11-21', engines: { 'whisper-large-v2': point(0.2, 1, 9000), 'in-use': point(0.05, 6, 1500) } },
  { day: '2026-11-22', engines: { 'in-use': point(0.08, 5, 1800, { cjk: null }), 'haiku-cleanup': point(0.04, 5, 600) } },
]
const NAMES: Record<string, string> = { 'in-use': 'In use', 'whisper-large-v2': 'Whisper large-v2', 'haiku-cleanup': 'In use + Haiku clean-up' }

describe('trend lines', () => {
  it('puts the in-use engine first and keeps only engines and days with a point', () => {
    const { days, lines } = trendLines(TREND, ['whisper-large-v2', 'in-use', 'haiku-cleanup'], 'mixed')
    expect(lines.map((l) => l.id)).toEqual(['in-use', 'whisper-large-v2', 'haiku-cleanup'])
    expect(days).toEqual(['2026-11-20', '2026-11-21', '2026-11-22'])
    expect(lines[0]!.points.map((p) => [p.day, p.value, p.takes])).toEqual([['2026-11-20', 0.1, 4], ['2026-11-21', 0.05, 6], ['2026-11-22', 0.08, 5]])
    // Chinese: the in-use engine had none on the 22nd, so that day is only the clean-up's.
    const cjk = trendLines(TREND, [], 'cjk')
    expect(cjk.lines[0]!.points.map((p) => p.day)).toEqual(['2026-11-20', '2026-11-21'])
    // Time is in seconds.
    expect(trendLines(TREND, [], 'ms').lines[0]!.points[0]!.value).toBe(2)
    expect(trendWords(2, 'ms')).toBe('2.0 s')
    expect(trendWords(0.6, 'ms', true)).toBe('+0.6 s')
    expect(trendWords(0.05, 'mixed')).toBe('5.0%')
  })

  it('counts the days that have any point', () => {
    expect(trendDays(TREND)).toBe(3)
    expect(trendDays([{ day: '2026-11-20', engines: {} }, TREND[0]!])).toBe(1)
  })

  it('labels the first and last day, and none closer than the gap', () => {
    expect(labelIndexes([0, 10, 20, 70, 100, 140])).toEqual([0, 3, 5])
    expect(labelIndexes([0, 300])).toEqual([0, 1])
    expect(labelIndexes([50])).toEqual([0])
  })
})

let win: Window & typeof globalThis
let root: ReturnType<typeof createRoot>
let host: HTMLElement

beforeAll(() => {
  const dom = parseHTML('<html><body></body></html>')
  win = dom.window as unknown as Window & typeof globalThis
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
})
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
})

const render = async (trend: CompareTrendDay[]) => {
  await act(async () => {
    root.render(createElement(VoiceAccuracyTrend, {
      trend, order: ['in-use', 'whisper-large-v2', 'haiku-cleanup'], nameOf: (id: string) => NAMES[id] ?? id, adds: (id: string) => id === 'haiku-cleanup',
    }))
  })
  // The metric is kept like any view choice: every case starts on Overall.
  if (q('va-trend-mixed')) await pick('va-trend-mixed')
}
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`)
const all = (id: string) => [...host.querySelectorAll(`[data-testid="${id}"]`)]
async function pick(testId: string) {
  const input = q(testId)!.querySelector('input')!
  const setChecked = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'checked')?.set
  await act(async () => {
    setChecked?.call(input, true)
    input.dispatchEvent(new win.Event('click', { bubbles: true }))
  })
}

describe('VoiceAccuracyTrend', () => {
  it('draws one line per engine, the in-use one on top, each point with its day, value and recordings', async () => {
    await render(TREND)
    expect(q('va-trend-empty')).toBeNull()
    const lines = all('va-trend-line')
    // Drawn last, so it sits on top of the others.
    expect(lines.map((l) => l.getAttribute('data-engine'))).toEqual(['haiku-cleanup', 'whisper-large-v2', 'in-use'])
    expect(lines[2]!.getAttribute('data-lead')).toBe('true')
    expect(lines[2]!.querySelectorAll('circle').length).toBe(3)
    // One point is no line, only its dot.
    expect(lines[1]!.querySelector('path')).toBeNull()
    const titles = [...host.querySelectorAll('circle title')].map((t) => t.textContent)
    expect(titles).toContain('In use, Nov 21: 5.0%, 6 recordings')
    expect(titles).toContain('Whisper large-v2, Nov 21: 20.0%, 1 recording')
    // Axis words: the days and the percentages.
    const ticks = [...host.querySelectorAll('.va-trend-tick')].map((t) => t.textContent)
    expect(ticks).toContain('Nov 20')
    expect(ticks).toContain('Nov 22')
    expect(ticks.some((t) => /^\d+%$/.test(t ?? ''))).toBe(true)
    // The latest day reads out under the chart by default.
    const readout = q('va-trend-readout')!
    expect(readout.getAttribute('data-day')).toBe('2026-11-22')
    expect(readout.textContent).toContain('In use 8.0%, 5 recordings')
    expect(readout.textContent).toContain('In use + Haiku clean-up 4.0%, 5 recordings')
    // The svg scales with its box: a viewBox and the full width.
    const svg = q('va-trend-chart')!
    expect(svg.getAttribute('width')).toBe('100%')
    expect(svg.getAttribute('viewBox')).toMatch(/^0 0 \d+ 180$/)
  })

  it('redraws the lines for the metric picked, with seconds for Time', async () => {
    await render(TREND)
    const before = host.querySelector('[data-engine="in-use"] path')!.getAttribute('d')
    await pick('va-trend-cjk')
    expect(host.querySelector('.va-trend-box')!.getAttribute('data-metric')).toBe('cjk')
    const inUse = host.querySelector('[data-engine="in-use"]')!
    expect(inUse.querySelectorAll('circle').length).toBe(2)
    expect(inUse.querySelector('path')!.getAttribute('d')).not.toBe(before)
    await pick('va-trend-ms')
    const values = [...host.querySelectorAll('[data-engine="in-use"] circle')].map((c) => c.getAttribute('data-value'))
    expect(values).toEqual(['2.0 s', '1.5 s', '1.8 s'])
    expect([...host.querySelectorAll('.va-trend-tick')].some((t) => / s$/.test(t.textContent ?? ''))).toBe(true)
    expect(q('va-trend-readout')!.textContent).toContain('In use + Haiku clean-up +0.6 s')
  })

  it('needs two days with a point before it draws', async () => {
    await render([TREND[0]!])
    expect(q('va-trend-empty')!.textContent).toContain('Needs two days of scored dictations')
    expect(q('va-trend-chart')).toBeNull()
    expect(q('va-trend-mixed')).toBeNull()
  })

  it('says so when the metric picked has nothing on these days', async () => {
    await render(TREND.map((d) => ({ day: d.day, engines: Object.fromEntries(Object.entries(d.engines).map(([k, p]) => [k, { ...p, latin: null }])) })))
    await pick('va-trend-latin')
    expect(q('va-trend-none')!.textContent).toContain('No English words in these dictations')
    expect(q('va-trend-chart')).toBeNull()
    // The switch stays, so another metric is one click away.
    expect(q('va-trend-mixed')).not.toBeNull()
  })
})
