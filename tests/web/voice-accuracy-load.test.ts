/**
 * Settings › Diagnostics › Voice Accuracy's first read, rendered as the app renders it (StrictMode).
 * 2026-11-21: on a fixture server with 46 imported takes the pane stayed on "Reading your compared
 * takes..." forever, every request answered 200. The hook's live flag was only ever cleared (an
 * unmount-only effect): StrictMode's unmount and mount cleared it for good, so every answer was
 * dropped, setLoading(false) included. A read that fails shows why with a Try again, never a spinner.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { StrictMode, act, createElement } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'
import { ApiError } from '../../web/src/api/api-error'

const api = vi.hoisted(() => ({
  fetchCompareEngines: vi.fn(),
  fetchCompareSummary: vi.fn(),
  fetchCompareTakes: vi.fn(),
  fetchCompareRun: vi.fn(),
}))
vi.mock('@/api/stt-compare', async (importOriginal) => ({ ...(await importOriginal<object>()), ...api }))
vi.mock('@/utils/log', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

import { VoiceAccuracySection } from '../../web/src/components/settings/sections/VoiceAccuracySection'

// The answers the failing run's trace shows (46 imported takes, nothing installed on that host).
const RUN = { running: false, done: 0, total: 0, queued: 0 }
const rates = (mixed: number) => ({ mixed, cjk: mixed, latin: mixed, terms: null })
const SUMMARY = {
  takes: 46, judged: 46, sharedTakes: 46,
  engines: [
    { id: 'in-use', ...rates(0.038), medianMs: 2100, takes: 46, scoredTakes: 46 },
    { id: 'whisper-large-v2', ...rates(0.061), medianMs: 9800, takes: 46, scoredTakes: 46 },
    { id: 'haiku-cleanup', ...rates(0.032), medianMs: 1200, takes: 46, scoredTakes: 46 },
  ],
  best: 'haiku-cleanup',
  byDay: [],
  judge: { state: 'ready' },
}
const ENGINES = {
  engines: [
    { id: 'in-use', label: 'In use', kind: 'engine', runsOn: 'local', sends: 'nothing', state: 'not-installed', detail: 'No voice engine is set up', fix: 'set-up-dictation', enabled: true, allow_upload: false },
    { id: 'whisper-large-v2', label: 'Whisper large-v2', kind: 'engine', runsOn: 'local', sends: 'nothing', state: 'not-installed', enabled: true, allow_upload: false },
    { id: 'elevenlabs-scribe', label: 'ElevenLabs Scribe', kind: 'engine', runsOn: 'cloud', sends: 'audio', state: 'needs-consent', enabled: false, allow_upload: false },
    { id: 'haiku-cleanup', label: 'Haiku cleanup', kind: 'engine', runsOn: 'cloud', sends: 'text', after: 'in-use', state: 'ready', enabled: true, allow_upload: true },
    { id: 'judge', label: 'AI judge', kind: 'judge', runsOn: 'cloud', sends: 'text', state: 'ready', enabled: true, allow_upload: true },
  ],
  nightly: false,
  hasElevenLabsKey: false,
}
const TAKES = {
  takes: Array.from({ length: 46 }, (_, i) => ({
    id: `phone-2e6ca2f8-${String(i).padStart(2, '0')}`, source: 'phone', at: `2026-11-${String(20 - (i % 19)).padStart(2, '0')}T08:00:00.000Z`,
    format: 'm4a', results: { 'in-use': { text: 'the words heard then', ms: 2100, at: 'x' } }, imported: 'bench', run: {},
  })),
  total: 46,
}

let root: ReturnType<typeof createRoot>
let host: HTMLElement

beforeAll(() => {
  const dom = parseHTML('<html><body></body></html>')
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
})
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  api.fetchCompareRun.mockResolvedValue(RUN)
  api.fetchCompareSummary.mockResolvedValue(SUMMARY)
  api.fetchCompareEngines.mockResolvedValue(ENGINES)
  api.fetchCompareTakes.mockResolvedValue(TAKES)
})
afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
  vi.clearAllMocks()
})

const render = async () => {
  await act(async () => { root.render(createElement(StrictMode, null, createElement(VoiceAccuracySection))) })
}
const text = () => host.textContent ?? ''
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`)

describe('Voice Accuracy: the first read', () => {
  it('leaves the spinner once the answers land, under StrictMode', async () => {
    await render()
    expect(text()).not.toContain('Reading your compared recordings')
    expect(host.querySelectorAll('[data-testid="va-summary-row"]').length).toBe(3)
    expect(q('va-run-group')).not.toBeNull()
    expect(q('va-data-group')).not.toBeNull()
    expect(q('va-load-retry')).toBeNull()
  })

  it('shows a failed read with Try again, and Try again reads it again', async () => {
    api.fetchCompareEngines.mockRejectedValueOnce(new ApiError(500, 'The engines could not be read'))
    api.fetchCompareEngines.mockRejectedValueOnce(new ApiError(500, 'The engines could not be read'))
    await render()
    expect(text()).not.toContain('Reading your compared recordings')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Couldn't read it: The engines could not be read")
    const retry = q('va-load-retry') as HTMLButtonElement | null
    expect(retry).not.toBeNull()

    await act(async () => { retry!.click() })
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(host.querySelectorAll('[data-testid="va-summary-row"]').length).toBe(3)
  })
})

describe('Voice Accuracy: the summary says what it can and cannot show', () => {
  const summary = () => q('va-summary')!
  it('keeps the stored rates as earlier AI guesses, on the same recordings, with labelled numbers and no per-row count', async () => {
    await render()
    expect(summary().textContent).toContain('Counted against earlier AI guesses of what you said, on the same 46 recordings')
    expect(summary().textContent).toContain("doesn't listen")
    expect(summary().textContent).toContain('Median extra time')
    expect(summary().textContent).toContain('Median time')
    expect(summary().textContent).not.toMatch(/46 takes|\btakes?\b/)
    // The lowest rate carries the word, not a bare dot.
    expect(summary().querySelector('[data-engine="haiku-cleanup"]')?.textContent).toContain('Lowest')
    expect(q('va-judge-off')).toBeNull()
  })

  it('says the judge is off, or not allowed to send, separately, with a way to its setting', async () => {
    api.fetchCompareSummary.mockResolvedValue({ ...SUMMARY, judge: { state: 'needs-consent' } })
    await render()
    expect(q('va-judge-off')?.textContent).toContain("Sending texts to the AI judge isn't allowed.")
    expect(q('va-judge-fix')?.textContent).toBe("Review what's sent")
    // The stored rates stay; no new guesses are made, and scores still use the earlier ones (runner.ts rescore).
    expect(host.querySelectorAll('[data-testid="va-summary-row"]').length).toBe(3)
    expect(q('va-judge-off')?.textContent).toContain('No new AI guesses until it runs.')
    expect(q('va-judge-off')?.textContent).toContain('Scores still use the earlier guesses')
    await act(async () => { root.unmount() })
    root = createRoot(host)
    api.fetchCompareSummary.mockResolvedValue({ ...SUMMARY, judge: { state: 'off' } })
    await render()
    expect(q('va-judge-off')?.textContent).toContain('The AI judge is off.')
    expect(q('va-judge-fix')?.textContent).toBe('Turn it on')
  })

  it('shows no empty percentages when no recording is shared by every engine shown', async () => {
    api.fetchCompareSummary.mockResolvedValue({
      ...SUMMARY, sharedTakes: 0,
      engines: SUMMARY.engines.map((e) => ({ ...e, mixed: null, cjk: null, latin: null, takes: 0 })),
    })
    await render()
    expect(q('va-summary-none-shared')?.textContent).toContain("Can't compare the engines yet.")
    expect(host.querySelectorAll('[data-testid="va-summary-row"]').length).toBe(0)
    expect(summary().textContent).not.toMatch(/%/)
  })

  it('marks an engine whose results mix models, and names them', async () => {
    api.fetchCompareSummary.mockResolvedValue({
      ...SUMMARY, engines: SUMMARY.engines.map((e) => (e.id === 'in-use' ? { ...e, models: ['mlx qwen-a', 'mlx qwen-b'] } : { ...e, models: ['m'] })),
    })
    await render()
    const row = summary().querySelector('[data-engine="in-use"]')!
    expect(row.textContent).toContain('Mixed models')
    expect(row.textContent).toContain('mlx qwen-a, mlx qwen-b')
    expect(summary().querySelector('[data-engine="whisper-large-v2"]')?.textContent).not.toContain('Mixed models')
  })

  it('titles each row by the model its results recorded, never the engine in use now', async () => {
    api.fetchCompareEngines.mockResolvedValue({
      ...ENGINES, engines: ENGINES.engines.map((e) => (e.id === 'in-use' ? { ...e, label: 'In use: mlx (qwen-new)', name: 'In use' } : e)),
    })
    api.fetchCompareSummary.mockResolvedValue({
      ...SUMMARY, engines: SUMMARY.engines.map((e) => (
        e.id === 'in-use' ? { ...e, models: ['mlx qwen-old'], unrecorded: 0 }
          : e.id === 'whisper-large-v2' ? { ...e, models: [], unrecorded: 46 } : { ...e, models: ['m'], unrecorded: 0 })),
    })
    await render()
    const model = (id: string) => summary().querySelector(`[data-engine="${id}"] [data-testid="va-summary-model"]`)?.textContent
    expect(model('in-use')).toBe(' · mlx qwen-old')
    expect(summary().querySelector('[data-engine="in-use"]')!.textContent).not.toContain('qwen-new')
    expect(model('whisper-large-v2')).toBe(' · model not recorded')
  })
})

describe('Voice Accuracy: the engines and the run say what to do', () => {
  it('offers Set up dictation for the engine in use when it is not ready, and says what the run will do', async () => {
    await render()
    expect(q('va-engine-in-use')).not.toBeNull()
    expect(q('va-setup-in-use')?.textContent).toBe('Set up dictation')
    expect(q('va-run-plan')?.getAttribute('data-plan')).toBe('hear')
    expect(q('va-run-plan')?.textContent).toContain('1 engine (Haiku cleanup)')
    expect(text()).toContain('Compare up to 20 recordings not compared yet')
    expect(text()).toContain('Compare automatically every night')
    expect(text()).toContain("At 3:00 on this computer's clock, the recordings of the last 24 hours, following each upload choice")
  })

  it('says why nothing can run, with the way to the engines, and keeps the button from starting nothing', async () => {
    api.fetchCompareEngines.mockResolvedValue({ ...ENGINES, engines: ENGINES.engines.map((e) => ({ ...e, state: e.kind === 'judge' ? 'off' : 'not-installed' })) })
    await render()
    expect(q('va-run-plan')?.getAttribute('data-plan')).toBe('nothing')
    expect(q('va-run-fix')?.textContent).toBe('See the engines')
    expect(q('va-run')?.hasAttribute('disabled') || q('va-run')?.getAttribute('aria-disabled') === 'true').toBe(true)
  })

  it('after a run, says how many recordings it compared', async () => {
    api.fetchCompareRun.mockResolvedValue({ ...RUN, done: 6, total: 6, takes: 3, finishedAt: '2026-11-22T03:00:00.000Z' })
    await render()
    expect(q('va-last-run')?.textContent).toBe('The last run compared 3 recordings.')
  })

  it('names the run "Estimate errors" when no engine is ready and it can only ask the AI judge', async () => {
    api.fetchCompareEngines.mockResolvedValue({ ...ENGINES, engines: ENGINES.engines.map((e) => (e.kind === 'judge' ? e : { ...e, state: 'not-installed' })) })
    await render()
    expect(q('va-run-plan')?.getAttribute('data-plan')).toBe('judge-only')
    expect(q('va-run')?.textContent).toBe('Estimate errors')
  })

  it('states what is kept: at most 500, the oldest dropped, and the normal retention once the experiment is off', async () => {
    await render()
    const limits = q('va-data-limits')!.textContent
    expect(limits).toContain('At most 500 compared recordings')
    expect(limits).toContain('the oldest comparison is dropped')
    expect(limits).toContain('once it is off, they follow that setting again')
  })
})

describe('Voice Accuracy: a run whose progress cannot be read', () => {
  afterEach(() => { vi.useRealTimers() })

  it('keeps reading it, later and later, and recovers; the end counts the recordings really compared', async () => {
    vi.useFakeTimers()
    const RUNNING = { running: true, done: 1, total: 10, takes: 5, compared: 0, queued: 0 }
    let answer: () => Promise<unknown> = async () => RUNNING
    api.fetchCompareRun.mockImplementation(() => answer())
    await render()
    expect(q('va-progress')).not.toBeNull()
    // One read fails: the run still reads as going, says so, and is read again.
    answer = async () => { throw new Error('socket hang up') }
    await act(async () => { await vi.advanceTimersByTimeAsync(1600) })
    expect(q('va-poll-error')?.textContent).toContain('socket hang up')
    expect(q('va-progress')).not.toBeNull()
    const calls = api.fetchCompareRun.mock.calls.length
    // The next try waits longer (3 s after one failure), then the read works again.
    answer = async () => RUNNING
    await act(async () => { await vi.advanceTimersByTimeAsync(1600) })
    expect(api.fetchCompareRun.mock.calls.length).toBe(calls)
    await act(async () => { await vi.advanceTimersByTimeAsync(1600) })
    expect(api.fetchCompareRun.mock.calls.length).toBe(calls + 1)
    expect(q('va-poll-error')).toBeNull()
    // It ends: the pane says how many it really compared, not how many it planned.
    answer = async () => ({ ...RUNNING, running: false, done: 10, compared: 4, finishedAt: '2026-11-22T03:00:00.000Z' })
    await act(async () => { await vi.advanceTimersByTimeAsync(1600) })
    expect(q('va-progress')).toBeNull()
    expect(q('va-last-run')?.textContent).toBe('The last run compared 4 of the 5 recordings it planned; the rest were stopped or skipped.')
  })
})
