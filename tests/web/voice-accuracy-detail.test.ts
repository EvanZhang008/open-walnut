/**
 * Settings \u203a Diagnostics \u203a Voice Accuracy, an opened recording and the matrix, rendered as the app
 * renders them (2026-11-22 review, ui 6):
 *  - the engine's text reads exactly as the engine wrote it (its text, and so a copy, is the
 *    original), words the guess has and the engine lacks are separate marks listed apart, never
 *    put into the line ("thesecond oneis"), and a legend says what each mark means;
 *  - Play recording and Recalculate estimated errors sit at the top, one engine's text at a time
 *    beside the AI's guess, the model a result was made with is named, and a recording that is
 *    gone says so instead of throwing;
 *  - the matrix's header and every row (by recording and by day) share one column template, the
 *    header sticks, and every number is named with its engine for a screen reader.
 * English, Chinese (as escapes) and mixed texts.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { act, createElement, useState } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'
import { wordDiff } from '../../src/core/stt/compare/score.js'

const api = vi.hoisted(() => ({ fetchCompareTake: vi.fn(), fetchCompareAudio: vi.fn() }))
vi.mock('@/api/stt-compare', async (importOriginal) => ({ ...(await importOriginal<object>()), ...api }))
vi.mock('@/utils/log', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
// A wide pane: the matrix.
vi.mock('@/hooks/useElementWidth', () => ({ useElementWidth: () => 1200 }))
vi.mock('@/hooks/usePhoneLayout', () => ({ usePhoneLayout: () => false }))
// A view choice in component state, as the store would keep it in one tab.
vi.mock('@/utils/view-memory', () => ({ usePageView: (_p: string, _n: string, d: unknown) => useState(d) }))

import type { CompareEngineRow, CompareTake, CompareTakeDetail } from '../../web/src/api/stt-compare'
import { DiffText, VoiceAccuracyTakeDetail } from '../../web/src/components/settings/sections/VoiceAccuracyTakeDetail'
import { VoiceAccuracyTakes } from '../../web/src/components/settings/sections/VoiceAccuracyTakes'
import { clockTime } from '../../web/src/utils/time'

const GUESS = 'Walnut test take 0: the second one is Tailscale, is the pairing related to it'
const TEXTS = {
  'in-use': 'Walnut test take 0: the second one is tail skill, is the pairing related to it',
  'whisper-large-v2': 'Walnut test take 0: second is tail scale, is pairing related to it',
}

const engine = (id: string, label: string, extra: Partial<CompareEngineRow> = {}): CompareEngineRow => ({
  id, label, kind: 'engine', runsOn: 'local', sends: 'nothing', state: 'ready', enabled: true, allow_upload: false, ...extra,
})
const ENGINES = [engine('in-use', 'In use'), engine('whisper-large-v2', 'Whisper large-v2')]
const JUDGE: CompareEngineRow = { ...engine('judge', 'AI judge', { kind: 'judge', runsOn: 'cloud', sends: 'text', state: 'needs-consent' }) }

async function detailOf(): Promise<CompareTakeDetail> {
  return {
    id: 'rec-1', source: 'web', at: '2026-11-18T10:30:00.000Z', durationSec: 46, format: 'webm',
    results: {
      'in-use': { text: TEXTS['in-use'], ms: 2300, at: 'x', model: 'mlx qwen3-asr-1.7b' },
      'whisper-large-v2': { text: TEXTS['whisper-large-v2'], ms: 13900, at: 'x', model: 'ggml-large-v2-q5_0.bin' },
    },
    reference: { text: GUESS, judge: 'test-judge-model', at: 'x' },
    scores: {
      'in-use': { edits: 2, n: 15, cjkEdits: 0, cjkN: 0, latEdits: 2, latN: 15, termsHit: 0, termsNeed: 1 },
      'whisper-large-v2': { edits: 5, n: 15, cjkEdits: 0, cjkN: 0, latEdits: 5, latN: 15, termsHit: 0, termsNeed: 1 },
    },
    run: {},
    diffs: {
      'in-use': await wordDiff(TEXTS['in-use'], GUESS),
      'whisper-large-v2': await wordDiff(TEXTS['whisper-large-v2'], GUESS),
    },
  }
}

let root: ReturnType<typeof createRoot>
let host: HTMLElement
let win: Window & typeof globalThis

beforeAll(() => {
  const dom = parseHTML('<html><body></body></html>')
  win = dom.window as unknown as Window & typeof globalThis
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  globalThis.requestAnimationFrame ??= ((cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number)
})
beforeEach(async () => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  api.fetchCompareTake.mockResolvedValue(await detailOf())
})
afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
  vi.clearAllMocks()
})

const q = (id: string) => host.querySelector(`[data-testid="${id}"]`)
const render = async (el: ReturnType<typeof createElement>) => { await act(async () => { root.render(el) }) }

describe('Voice Accuracy: an engine text with its differences marked', () => {
  const cases: Array<[string, string, string]> = [
    ['English, words left out', TEXTS['whisper-large-v2'], GUESS],
    ['English, one stretch heard wrong', TEXTS['in-use'], GUESS],
    // "we pushed it to the environment today", one character wrong and one left out.
    ['Chinese', '\u6211\u4eec\u660e\u5929\u63a8\u73af\u5883\u3002', '\u6211\u4eec\u4eca\u5929\u63a8\u5230\u73af\u5883\u3002'],
    ['mixed', '\u6211\u4eec\u628adeploy meant\u63a8\u5230 staging \u73af\u5883\uff0ccheck\u4e00\u4e0b pot\u3002',
      '\u6211\u4eec\u628a deployment \u63a8\u5230 staging \u73af\u5883\uff0c\u7136\u540e check \u4e00\u4e0b pod\u3002'],
  ]
  for (const [name, hyp, guess] of cases) {
    it(`${name}: the line's text is the engine's own, every space kept, no mark holding a space`, async () => {
      await render(createElement(DiffText, { segments: await wordDiff(hyp, guess), fallback: hyp, testId: 'line' }))
      const line = q('line')!
      expect(line.textContent).toBe(hyp)
      for (const mark of line.querySelectorAll('mark')) expect(mark.textContent).toBe(mark.textContent!.trim())
      // A missing stretch is an empty mark in the line (its caret is CSS), and its words are listed apart.
      for (const gap of line.querySelectorAll('.va-diff-missing')) {
        expect(gap.textContent).toBe('')
        expect(gap.getAttribute('aria-label')).toMatch(/^Missing: /)
      }
      if (line.querySelector('.va-diff-missing')) expect(q('va-missing-list')?.textContent).toMatch(/^Missing \(\u2038\): /)
    })
  }

  it('lists the words left out in order, never in the line', async () => {
    await render(createElement(DiffText, { segments: await wordDiff(TEXTS['whisper-large-v2'], GUESS), fallback: '', testId: 'line' }))
    expect(q('line')!.textContent).not.toMatch(/thesecond|oneis/)
    expect(q('va-missing-list')!.textContent).toBe('Missing (\u2038): the \u00b7 one \u00b7 the')
  })
})

describe('Voice Accuracy: an opened recording', () => {
  const open = async (judge: CompareEngineRow | undefined = JUDGE) => {
    await render(createElement(VoiceAccuracyTakeDetail, {
      takeId: 'rec-1', engines: ENGINES, judge, version: 'v1', onRetry: () => {}, onJudge: async () => null,
    }))
  }

  it('puts Play and Recalculate at the top, one engine text beside the guess, and the legend', async () => {
    await open()
    const detail = q('va-take-detail')!
    const order = [...detail.querySelectorAll('[data-testid]')].map((el) => el.getAttribute('data-testid'))
    expect(order.indexOf('va-play')).toBeLessThan(order.indexOf('va-show-in-use'))
    expect(order.indexOf('va-judge-again')).toBeLessThan(order.indexOf('va-detail-in-use'))
    expect(q('va-judge-again')!.textContent).toBe('Recalculate estimated errors')
    // One engine at a time: the first one, beside the AI's guess.
    expect(q('va-detail-in-use')).not.toBeNull()
    expect(q('va-detail-whisper-large-v2')).toBeNull()
    expect(q('va-reference')!.textContent).toBe(GUESS)
    expect(q('va-engine-text')!.textContent).toBe(TEXTS['in-use'])
    expect(q('va-result-model')!.textContent).toBe('Made with mlx qwen3-asr-1.7b')
    const legend = q('va-diff-legend')!
    expect(legend.textContent).toContain("differs from the AI's guess")
    expect(legend.textContent).not.toContain('heard wrong')
    expect(legend.textContent).toContain('extra, not in the guess')
    expect(legend.textContent).toContain('missing, listed under the text')
    expect(legend.querySelector('.va-diff-wrong')).not.toBeNull()
    expect(legend.querySelector('.va-diff-extra')).not.toBeNull()
    expect(legend.querySelector('.va-diff-missing')).not.toBeNull()
  })

  it('switches to another engine with the segmented control', async () => {
    await open()
    const input = q('va-show-whisper-large-v2')!.querySelector('input')!
    const setChecked = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'checked')?.set
    await act(async () => {
      setChecked?.call(input, true)
      input.dispatchEvent(new win.Event('click', { bubbles: true }))
    })
    expect(q('va-detail-whisper-large-v2')).not.toBeNull()
    expect(q('va-detail-in-use')).toBeNull()
    expect(q('va-engine-text')!.textContent).toBe(TEXTS['whisper-large-v2'])
  })

  it('says why errors cannot be recalculated, with the way to the judge, when its sending is not allowed', async () => {
    await open()
    const button = q('va-judge-again')!
    expect(button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true').toBe(true)
    expect(q('va-judge-reason')!.textContent).toBe("Sending texts to the AI judge isn't allowed. Review what's sent")
    await act(async () => { root.unmount() })
    root = createRoot(host)
    await open({ ...JUDGE, state: 'ready' })
    expect(q('va-judge-reason')).toBeNull()
    expect(q('va-judge-again')!.hasAttribute('disabled')).toBe(false)
  })

  it('labels each result by the model recorded on it, and an older result as model not recorded', async () => {
    const d = await detailOf()
    d.results['in-use'] = { text: TEXTS['in-use'], ms: 2300, at: 'x' }
    d.reference = { ...d.reference!, judge: 'unknown' }
    api.fetchCompareTake.mockResolvedValue(d)
    await render(createElement(VoiceAccuracyTakeDetail, {
      takeId: 'rec-1', engines: [engine('in-use', 'In use: mlx (qwen3-asr-1.7b)', { name: 'In use' }), ENGINES[1]!], judge: JUDGE, version: 'v1', onRetry: () => {}, onJudge: async () => null,
    }))
    // Its own name, never the model in use now; the model it recorded, or none.
    expect(q('va-detail-in-use')!.querySelector('.va-detail-head > span')!.textContent).toBe('In use')
    expect(q('va-result-model')!.textContent).toBe('Model not recorded')
    expect(q('va-reference-by')!.textContent).toBe('model not recorded, not checked by a person')
  })

  it('says what was sent is only probably that: matched by text, at the time it was sent', async () => {
    const d = await detailOf()
    Object.assign(d, { sentText: 'the second one is Tailscale ', sentAt: '2026-11-18T10:31:00.000Z', sentMatch: 'text-similarity', sentSimilarity: 0.82 })
    api.fetchCompareTake.mockResolvedValue(d)
    await open()
    expect(q('va-show-sent')!.textContent).toBe('Probably sent')
    const input = q('va-show-sent')!.querySelector('input')!
    const setChecked = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'checked')?.set
    await act(async () => {
      setChecked?.call(input, true)
      input.dispatchEvent(new win.Event('click', { bubbles: true }))
    })
    const at = clockTime('2026-11-18T10:31:00.000Z')
    expect(q('va-sent-heading')!.textContent).toBe(`Probably what you sent (matched by text, ${at})`)
    expect(q('va-sent-heading')!.getAttribute('title')).toContain('82% alike')
    // Kept as sent: the trailing space is still there.
    expect(q('va-engine-text')!.textContent).toBe('the second one is Tailscale ')
  })

  it('a send paired by its recording reads as what was sent, with no "Probably"', async () => {
    const d = await detailOf()
    Object.assign(d, { sentText: 'the second one is Tailscale.', sentAt: '2026-11-18T10:31:00.000Z', sentMatch: 'recording-id', edited: true })
    api.fetchCompareTake.mockResolvedValue(d)
    await open()
    expect(q('va-show-sent')!.textContent).toBe('Sent')
    const input = q('va-show-sent')!.querySelector('input')!
    const setChecked = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'checked')?.set
    await act(async () => {
      setChecked?.call(input, true)
      input.dispatchEvent(new win.Event('click', { bubbles: true }))
    })
    expect(q('va-sent-heading')!.textContent).toBe('What you sent')
    expect(q('va-sent-heading')!.getAttribute('title')).toBeNull()
    expect(q('va-engine-text')!.textContent).toBe('the second one is Tailscale.')
  })

  it('says the recording is no longer available when its audio is gone, and throws nothing', async () => {
    api.fetchCompareAudio.mockResolvedValue(null)
    await open()
    await act(async () => { (q('va-play') as HTMLButtonElement).click() })
    expect(q('va-audio-gone')!.textContent).toBe('Recording is no longer available')
    expect(q('va-play')!.hasAttribute('disabled')).toBe(true)
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })
})

describe('Voice Accuracy: the matrix', () => {
  const take = (id: string): CompareTake => ({
    id, source: 'web', at: '2026-11-18T10:30:00.000Z', durationSec: 16, format: 'webm',
    sentText: 'what was sent',
    results: { 'in-use': { text: 'a', ms: 1400, at: 'x' }, 'whisper-large-v2': { text: 'b', ms: 6700, at: 'x' } },
    scores: {
      'in-use': { edits: 0, n: 10, cjkEdits: 0, cjkN: 0, latEdits: 0, latN: 10, termsHit: 0, termsNeed: 0 },
      'whisper-large-v2': { edits: 3, n: 10, cjkEdits: 0, cjkN: 0, latEdits: 3, latN: 10, termsHit: 0, termsNeed: 0 },
    },
    run: {},
  })
  const props = {
    takes: [take('rec-1'), take('rec-2')], total: 2, hasMore: false,
    byDay: [{ day: '2026-11-18', takes: 2, engines: { 'in-use': { mixed: 0, cjk: null, latin: 0, terms: null }, 'whisper-large-v2': { mixed: 0.3, cjk: null, latin: 0.3, terms: null } }, best: 'in-use' }],
    engines: ENGINES, judge: JUDGE, onMore: () => {}, onRetry: async () => null, onJudge: async () => null,
  }

  it('shares one column template between the header, the recordings and the days, under a sticky header', async () => {
    await render(createElement(VoiceAccuracyTakes, props))
    expect(q('va-takes')!.getAttribute('data-layout')).toBe('matrix')
    const head = q('va-takes-head')!
    expect(head.className).toContain('settings-sticky-head')
    expect(head.closest('.settings-group')!.className).toContain('settings-group-sticky')
    const width = ENGINES.length + 2
    const grids = () => [...host.querySelectorAll('.va-grid')].map((g) => g.children.length)
    expect(grids()).toEqual([width, width, width])
    // Every number is named with its engine (the header is hidden from a screen reader).
    const cells = host.querySelectorAll('[data-testid="va-take-row"] .va-num')
    expect(cells[0]!.textContent).toContain('In use: 0.0%')
    expect(cells[1]!.textContent).toContain('Whisper large-v2: 30.0%')
    // The lowest is a word in the shared badge, under its number.
    expect(cells[0]!.querySelector('.va-num-sub .badge')?.textContent).toBe('Lowest')
    // The preview says it is probably what was sent: a pairing by text, never stated as fact.
    expect(host.querySelector('.va-take-source')!.textContent).toBe('Probably sent: ')

    const day = q('va-view-day')!.querySelector('input')!
    const setChecked = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(day), 'checked')?.set
    await act(async () => {
      setChecked?.call(day, true)
      day.dispatchEvent(new win.Event('click', { bubbles: true }))
    })
    expect(host.querySelectorAll('[data-testid="va-day-row"]').length).toBe(1)
    expect(grids()).toEqual([width, width])
  })

  const dialog = () => document.body.querySelector('[data-testid="va-take-dialog"]')
  const details = (id: string) => host.querySelector(`[data-testid="va-take-details"][data-take="${id}"]`) as HTMLButtonElement

  it('opens a recording in a dialog, never in the row: a click on the row or its Details key', async () => {
    await render(createElement(VoiceAccuracyTakes, props))
    const row = host.querySelector('[data-testid="va-take-row"][data-take="rec-1"]') as HTMLElement
    expect(details('rec-1').className).toBe('btn btn-ghost btn-icon btn-sm')
    expect(details('rec-1').getAttribute('aria-haspopup')).toBe('dialog')
    expect(details('rec-1').getAttribute('aria-label')).toContain('Details')
    await act(async () => { row.click() })
    const box = dialog()!
    expect(box.getAttribute('role')).toBe('dialog')
    expect(box.getAttribute('aria-modal')).toBe('true')
    expect(box.className).toContain('app-modal')
    expect(box.classList.contains('wn-glass')).toBe(true)
    expect(box.classList.contains('wn-glass-frost')).toBe(false)
    // Portalled out of the pane, the row itself holds nothing more.
    expect(host.contains(box)).toBe(false)
    expect(row.querySelector('[data-testid="va-take-detail"]')).toBeNull()
    expect(box.querySelector('[data-testid="va-take-detail"]')).not.toBeNull()
    expect(box.querySelector('[data-testid="va-take-dialog-close"]')!.getAttribute('aria-label')).toBe('Close')
    expect(details('rec-1').getAttribute('aria-expanded')).toBe('true')
    // The close key closes it; the Details key opens it again.
    await act(async () => { (box.querySelector('[data-testid="va-take-dialog-close"]') as HTMLButtonElement).click() })
    expect(dialog()).toBeNull()
    await act(async () => { details('rec-2').click() })
    expect(dialog()!.getAttribute('data-take')).toBe('rec-2')
  })

  it('closes on Escape and gives the focus back to the row it came from', async () => {
    await render(createElement(VoiceAccuracyTakes, props))
    await act(async () => { details('rec-2').click() })
    expect(dialog()).not.toBeNull()
    const focus = vi.fn()
    details('rec-2').focus = focus
    await act(async () => {
      document.dispatchEvent(Object.assign(new win.Event('keydown', { bubbles: true, cancelable: true }), { key: 'Escape' }))
    })
    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(focus).toHaveBeenCalled()
  })

  it('shows a Retry that could not start on that recording\'s row', async () => {
    const failed: CompareTake = { ...take('rec-1'), results: { 'in-use': { error: 'timed out', ms: 10, at: 'x' } }, scores: {} }
    api.fetchCompareTake.mockResolvedValue({ ...failed, diffs: {} })
    await render(createElement(VoiceAccuracyTakes, { ...props, takes: [failed, take('rec-2')], judge: { ...JUDGE, state: 'ready' }, onRetry: async () => 'the experiment is busy' }))
    await act(async () => { details('rec-1').click() })
    await act(async () => { (dialog()!.querySelector('[data-testid="va-retry-in-use"]') as HTMLButtonElement).click() })
    const row = host.querySelector('[data-testid="va-take-row"][data-take="rec-1"]')!
    expect(row.querySelector('[data-testid="va-row-error"]')!.textContent).toBe("Couldn't run it again: the experiment is busy")
    expect(dialog()!.querySelector('[data-testid="va-retry-error"]')!.textContent).toBe("Couldn't run it again: the experiment is busy")
    expect(host.querySelector('[data-testid="va-take-row"][data-take="rec-2"] [data-testid="va-row-error"]')).toBeNull()
  })

  it('draws a state in a number\'s place as the shared status (a dot and its word)', async () => {
    const failed: CompareTake = { ...take('rec-1'), results: { 'in-use': { error: 'timed out', ms: 10, at: 'x' } }, scores: {} }
    await render(createElement(VoiceAccuracyTakes, { ...props, takes: [failed] }))
    const statuses = [...host.querySelectorAll('[data-testid="va-take-row"] .va-num .wn-notice-status')]
    expect(statuses.map((s) => [s.getAttribute('data-tone'), s.textContent])).toEqual([['error', 'Failed'], ['muted', 'Not run']])
  })
})
