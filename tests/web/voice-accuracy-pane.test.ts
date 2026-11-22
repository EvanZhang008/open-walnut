/**
 * Settings › Diagnostics › Voice Accuracy (experiment stt_compare): the narrow
 * layout (the engine columns never scroll sideways: a pane too narrow for them,
 * or a phone, gets the stacked list), the consent ticks (every engine or judge
 * that sends anything has its own tick saying what is sent, to whom and why,
 * unticked until the user ticks it), the engine states and their fixes, the
 * words of the summary and the run, and the run states a recording's cells show.
 */
import { describe, expect, it } from 'vitest'
import { createElement as h } from '../../web/node_modules/react/index.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'
import { CONSENT_ROWS } from '../../src/core/stt/compare/engines.js'
import type { CompareEngineRow, CompareEngines, CompareTake } from '../../web/src/api/stt-compare.js'
import { VoiceAccuracyEngines } from '../../web/src/components/settings/sections/VoiceAccuracyEngines.js'
import { VoiceAccuracyTakes } from '../../web/src/components/settings/sections/VoiceAccuracyTakes.js'
import {
  ENGINE_COL, TAKE_COL_MIN, STATE_WORDS, consentWords, judgeBlocker, keyProblem, lastRunWords, markedLowest, matrixFits, runButtonWords, runPlan, runPlanWords,
  summaryModel,
  stateWords, summaryMetrics, takeCell, takeText, takesLayout, whereItRuns,
} from '../../web/src/components/settings/sections/voice-accuracy-model.js'
import { mergeRefreshed } from '../../web/src/components/settings/sections/useVoiceAccuracy.js'
import type { Config } from '../../src/core/types.js'

const row = (id: string, sends: CompareEngineRow['sends'], extra: Partial<CompareEngineRow> = {}): CompareEngineRow => ({
  id, label: id, kind: id === 'judge' ? 'judge' : 'engine', runsOn: sends === 'nothing' ? 'local' : 'cloud', sends,
  state: sends === 'nothing' ? 'ready' : 'needs-consent', enabled: true, allow_upload: false, ...extra,
})

const ENGINES: CompareEngineRow[] = [
  row('in-use', 'nothing'),
  row('whisper-large-v2', 'nothing'),
  row('elevenlabs-scribe', 'audio'),
  row('haiku-cleanup', 'text', { after: 'in-use' }),
  row('judge', 'text'),
]

const take = (over: Partial<CompareTake> = {}): CompareTake => ({
  id: 'web-1', source: 'web', at: '2026-11-20T08:03:00.000Z', durationSec: 42, format: 'webm',
  inUseText: 'the words as Walnut wrote them then, shown in full however long they are',
  results: {
    'in-use': { text: 'a', ms: 2300, at: 'x' },
    'whisper-large-v2': { text: 'b', ms: 13900, at: 'x' },
    'elevenlabs-scribe': { error: 'HTTP 401', ms: 10, at: 'x' },
  },
  scores: {
    'in-use': { edits: 0, n: 100, cjkEdits: 0, cjkN: 50, latEdits: 0, latN: 50, termsHit: 1, termsNeed: 1 },
    'whisper-large-v2': { edits: 12, n: 100, cjkEdits: 6, cjkN: 50, latEdits: 6, latN: 50, termsHit: 0, termsNeed: 1 },
  },
  run: {},
  ...over,
})

describe('Voice Accuracy: the takes never scroll sideways', () => {
  it('fits the matrix only when every engine column has room beside the take column', () => {
    const need = TAKE_COL_MIN + 4 * ENGINE_COL
    expect(matrixFits(need + 200, 4)).toBe(true)
    expect(matrixFits(need, 4)).toBe(false)
    expect(matrixFits(0, 4)).toBe(false) // not measured yet: stacked, never a too-wide grid
    expect(matrixFits(need + 200, 6)).toBe(false) // more engines need more room
  })

  it('stacks on a phone whatever the width, and when the pane is too narrow', () => {
    expect(takesLayout(1200, 4, false)).toBe('matrix')
    expect(takesLayout(1200, 4, true)).toBe('stacked')
    expect(takesLayout(500, 4, false)).toBe('stacked')
  })

  it('renders the stacked list with one tag per engine and the take text in full', () => {
    const html = renderToStaticMarkup(h(VoiceAccuracyTakes, {
      takes: [take()], total: 1, hasMore: false, byDay: [],
      engines: ENGINES.filter((e) => e.kind === 'engine'), judge: ENGINES[4],
      onMore: () => {}, onRetry: async () => null, onJudge: async () => null,
    }))
    // Unmeasured (as on the first server render): the stacked list, no grid of columns.
    expect(html).toContain('data-layout="stacked"')
    expect(html).not.toContain('class="va-grid')
    expect(html).toContain('class="va-badges"')
    expect(html.match(/settings-tag\b/g)?.length).toBe(4)
    expect(html).toContain('the words as Walnut wrote them then, shown in full however long they are')
    // The preview says where its words come from.
    expect(html).toContain('Engine text: ')
    expect(html).toContain('Failed')
    // The lowest rate is named in words, not only by the tag's colour.
    expect(html).toContain('In use 0.0% · 2.3 s · Lowest')
    expect(html).toContain('Recordings')
    // The user's word is "recordings" (the code's ids may still say take).
    expect(html.replace(/<[^>]+>/g, ' ')).not.toMatch(/\btakes?\b/i)
  })
})

describe('Voice Accuracy: a take cell says where the engine is', () => {
  it('shows a live run state over what is stored, the failure, and what has not run', () => {
    const t = take({ run: { 'whisper-large-v2': { state: 'running' }, 'haiku-cleanup': { state: 'queued' } } })
    expect(takeCell(t, { id: 'in-use' })).toMatchObject({ text: '0.0%', sub: '2.3 s' })
    expect(takeCell(t, { id: 'whisper-large-v2' })).toMatchObject({ text: 'Running', tone: 'muted' })
    expect(takeCell(t, { id: 'haiku-cleanup', after: 'in-use' })).toMatchObject({ text: 'Queued' })
    expect(takeCell(t, { id: 'elevenlabs-scribe' })).toMatchObject({ text: 'Failed', tone: 'error', error: 'HTTP 401' })
    expect(takeCell(take({ results: {} }), { id: 'in-use' })).toMatchObject({ text: 'Not run' })
    const failedNow = take({ run: { 'in-use': { state: 'failed', error: 'the recording is gone' } } })
    expect(takeCell(failedNow, { id: 'in-use' })).toMatchObject({ text: 'Failed', error: 'the recording is gone' })
  })

  it('marks the lowest value only when it leads the next by half a point', () => {
    expect(markedLowest([{ id: 'a', value: 0.017 }, { id: 'b', value: 0.032 }])).toBe('a')
    expect(markedLowest([{ id: 'a', value: 0.017 }, { id: 'b', value: 0.02 }])).toBeUndefined()
    expect(markedLowest([{ id: 'a', value: 0.01 }, { id: 'b', value: null }])).toBeUndefined()
  })
})

describe('Voice Accuracy: consent ticks', () => {
  const engines: CompareEngines = { engines: ENGINES, nightly: false, hasElevenLabsKey: false }
  const reload = async () => {}
  const html = renderToStaticMarkup(h(VoiceAccuracyEngines, { engines, saveError: null, save: async () => true, reload }))

  it('gives every row of the server registry that sends anything its own tick, saying what goes where', () => {
    // Under a local and a cloud dictation engine: the in-use row sends audio under the second.
    for (const config of [{ stt: { engine: 'mlx' } }, { stt: { engine: 'openai' } }] as Config[]) {
      for (const e of CONSENT_ROWS) {
        const place = e.place(config)
        const words = consentWords({ id: e.id, label: e.label, sends: place.sends })
        if (place.sends === 'nothing') { expect(words, e.id).toBeNull(); continue }
        expect(words, e.id).toMatch(place.sends === 'audio' ? /recordings/ : /text/)
        expect(words, e.id).toMatch(e.id === 'elevenlabs-scribe' ? /ElevenLabs/ : e.id === 'in-use' ? /cloud engine/ : /the AI model Walnut uses/)
        expect(words, e.id).not.toMatch(/Claude|this Mac/)
      }
    }
    expect(consentWords({ id: 'in-use', label: 'In use', sends: 'audio' })).toMatch(/recordings/)
  })

  it('says where each engine runs in words true for any computer, the in-use one by what dictation uses', () => {
    for (const e of ENGINES) expect(whereItRuns(e), e.id).not.toMatch(/this Mac|Claude/)
    expect(whereItRuns({ ...ENGINES[0]!, runsOn: 'cloud', sends: 'audio' })).toMatch(/cloud service/)
    expect(whereItRuns(ENGINES[0]!)).toMatch(/nothing leaves it/)
    expect(whereItRuns(ENGINES[2]!)).toMatch(/usage-based billing/)
    expect(STATE_WORDS['may-cost'].word).toBe('Could cost money')
  })

  it('draws a tick, unticked, for each sending engine and the judge, and none for engines on this computer', () => {
    for (const id of ['elevenlabs-scribe', 'haiku-cleanup', 'judge']) {
      const tick = new RegExp(`<input[^>]*data-testid="va-consent-${id}"[^>]*>`).exec(html)?.[0]
      expect(tick, id).toBeTruthy()
      expect(tick, id).not.toMatch(/checked/)
    }
    expect(html).not.toContain('va-consent-in-use')
    expect(html).not.toContain('va-consent-whisper-large-v2')
    // The words are the shared checkbox's own label, never restyled for this pane.
    expect(html).not.toContain('va-consent"')
    expect(html.match(/class="settings-checkbox-label"/g)?.length).toBe(3)
  })

  it('shows a ticked consent as ticked, and each row its state in words', () => {
    const ticked = renderToStaticMarkup(h(VoiceAccuracyEngines, {
      engines: { ...engines, engines: ENGINES.map((e) => (e.id === 'judge' ? { ...e, allow_upload: true, state: 'ready' } : e)) },
      saveError: null, save: async () => true, reload,
    }))
    expect(/<input[^>]*data-testid="va-consent-judge"[^>]*>/.exec(ticked)?.[0]).toMatch(/checked/)
    // The state matches the tick: an upload, or a sending of text, that is not allowed yet.
    expect(html).toContain('Upload not allowed')
    expect(html).toContain('Sending not allowed')
    expect(html).not.toContain('Needs your consent')
    expect(html).toContain('ElevenLabs API key')
    // The switch says what it does.
    expect(html).toContain('aria-label="Include elevenlabs-scribe in comparisons"')
  })

  it('says what each tick sends, to whom and why, with the task titles capped', () => {
    for (const e of ENGINES) {
      const words = consentWords(e)
      if (!words) continue
      expect(words, e.id).toMatch(/, (to|so) /)
      if (/task titles/.test(words)) expect(words, e.id).toMatch(/up to 80 task titles/)
    }
    expect(whereItRuns(ENGINES[2]!)).toBe('Your recordings are sent to ElevenLabs. Walnut uses only the included quota, keeps the last 10%, and uploads nothing while usage-based billing is on.')
    expect(whereItRuns(ENGINES[4]!)).toMatch(/doesn't listen/)
    // The judge reads each engine's own transcript, never the Haiku clean-up (judge.ts judgeTexts): the words say so.
    const judge = ENGINES.find((e) => e.id === 'judge')!
    expect(consentWords(judge)).toMatch(/each engine's own text \(its direct transcript, not the cleaned-up version\)/)
    expect(consentWords(judge)).not.toMatch(/every engine's/)
    expect(whereItRuns(judge)).toMatch(/not the Haiku clean-up/)
  })

  it('names the key\'s permission and where to get one, and keeps the model id as secondary detail', () => {
    const withModel = renderToStaticMarkup(h(VoiceAccuracyEngines, {
      engines: { ...engines, engines: ENGINES.map((e) => (e.id === 'elevenlabs-scribe' ? { ...e, label: 'ElevenLabs Scribe', model: 'scribe_v3' } : e)) },
      saveError: null, save: async () => true, reload,
    }))
    // Said before the key is made: Speech to Text, and read access to the subscription Walnut checks.
    expect(withModel).toContain('give it Speech to Text and read access to User')
    expect(withModel).toContain('subscription')
    expect(withModel).toMatch(/<a[^>]*href="https:\/\/elevenlabs\.io\/app\/settings\/api-keys"[^>]*data-testid="va-elevenlabs-key-link"/)
    expect(withModel).toContain('Model: scribe_v3')
    expect(withModel).not.toContain('ElevenLabs Scribe (scribe_v3)')
  })

  it('shows a not-ready engine as Not ready with its fix: Set up dictation, or the Whisper model\'s path, check and download', () => {
    const notReady = renderToStaticMarkup(h(VoiceAccuracyEngines, {
      engines: {
        ...engines,
        engines: ENGINES.map((e) => (e.id === 'in-use'
          ? { ...e, state: 'not-installed' as const, detail: 'No voice engine is set up', fix: 'set-up-dictation' as const }
          : e.id === 'whisper-large-v2'
            ? { ...e, state: 'not-installed' as const, detail: 'It needs /home/u/.local/share/whisper-cpp/ggml-large-v2.bin (or ggml-large-v2-q5_0.bin in the same folder)', fix: 'download-whisper' as const }
            : e)),
      },
      saveError: null, save: async () => true, reload,
    }))
    expect(notReady).toContain('Not ready')
    expect(notReady).not.toContain('Not installed')
    expect(notReady).toMatch(/data-testid="va-setup-in-use"[^>]*>.*Set up dictation/)
    expect(notReady).toContain('/home/u/.local/share/whisper-cpp/ggml-large-v2.bin')
    expect(notReady).toContain('data-testid="va-whisper-check"')
    expect(notReady).toContain('data-testid="va-whisper-download"')
    // A switched-off engine offers no fix (it is not meant to run).
    const off = renderToStaticMarkup(h(VoiceAccuracyEngines, {
      engines: { ...engines, engines: [{ ...ENGINES[0]!, enabled: false, state: 'off' as const, fix: 'set-up-dictation' as const }] },
      saveError: null, save: async () => true, reload,
    }))
    expect(off).not.toContain('va-setup-in-use')
    expect(STATE_WORDS['not-installed'].word).toBe('Not ready')
    expect(stateWords({ state: 'needs-consent', sends: 'audio' }).word).toBe('Upload not allowed')
    expect(stateWords({ state: 'needs-consent', sends: 'text' }).word).toBe('Sending not allowed')
  })

  it('saves the API key only on its Save button or Enter: no save on blur, and a half-typed key is refused', () => {
    expect(keyProblem('')).toBeTruthy()
    expect(keyProblem('sk_12')).toMatch(/does not look like an API key/)
    expect(keyProblem('has a space in it')).toBeTruthy()
    expect(keyProblem('fake-key-for-tests-0006')).toBeNull()
  })
})

describe('Voice Accuracy: the words of the summary and the run', () => {
  it('names every summary number, with no per-row recording count', () => {
    const row = { id: 'haiku-cleanup', mixed: 0.032, cjk: 0.032, latin: 0.15, terms: 0.95, medianMs: 3100, takes: 43, scoredTakes: 43 }
    expect(summaryMetrics(row, true)).toEqual([
      { label: 'Chinese', value: '3.2%' },
      { label: 'English', value: '15.0%' },
      { label: 'Your terms recognized', value: '95%' },
      { label: 'Median extra time', value: '3.1 s' },
    ])
    expect(summaryMetrics({ ...row, id: 'in-use', cjk: null, terms: null }, false).map((m) => m.label)).toEqual(['English', 'Median time'])
  })

  it('tells the judge switched off apart from the judge not allowed to send, each with its way to the setting', () => {
    expect(judgeBlocker({ state: 'ready' })).toBeNull()
    expect(judgeBlocker({ state: 'off' })).toEqual({ text: 'The AI judge is off.', fix: 'Turn it on' })
    expect(judgeBlocker({ state: 'needs-consent' })).toEqual({ text: "Sending texts to the AI judge isn't allowed.", fix: "Review what's sent" })
    expect(judgeBlocker(undefined)).toBeNull()
  })

  it('says what a run will do: hear again with N engines, only re-score, or nothing and why', () => {
    const hear = runPlan(ENGINES.map((e) => (e.id === 'judge' ? { ...e, state: 'ready' as const } : e)))
    expect(hear).toEqual({ kind: 'hear', engines: ['in-use', 'whisper-large-v2'], judge: true })
    expect(runPlanWords(hear)).toMatch(/^Hears them again with 2 engines \(in-use, whisper-large-v2\), then the AI judge estimates the errors/)
    // The clean-up's upload allowed is not enough: it is ready only when its server state says so.
    const onlyHaiku = ENGINES.map((e) => ({ ...e, state: e.id === 'judge' ? 'ready' as const : 'not-installed' as const, allow_upload: true }))
    expect(runPlan(onlyHaiku)).toEqual({ kind: 'judge-only' })
    expect(runPlanWords({ kind: 'judge-only' })).toMatch(/only asks the AI judge again/)
    // A run that can only ask the judge is named for what it does.
    expect(runButtonWords({ kind: 'judge-only' })).toBe('Estimate errors')
    expect(runButtonWords(hear)).toBe('Run comparison')
    // Without the judge, earlier guesses still score new texts: the words never say nothing is scored.
    const noJudge = runPlanWords({ kind: 'hear', engines: ['In use'], judge: false })
    expect(noJudge).toMatch(/no new guesses: a recording that already has one is scored against it/)
    const nothing = runPlan(ENGINES.map((e) => ({ ...e, state: 'not-installed' as const })))
    expect(nothing.kind).toBe('nothing')
    expect(runPlanWords(nothing)).toMatch(/nothing can run/)
  })

  it('says in place how many recordings the last run compared, or why none', () => {
    const ended = { running: false, done: 4, total: 4, queued: 0, finishedAt: '2026-11-22T03:00:00.000Z' }
    expect(lastRunWords({ ...ended, takes: 3 })).toBe('The last run compared 3 recordings.')
    expect(lastRunWords({ ...ended, takes: 1 })).toBe('The last run compared 1 recording.')
    // The recordings it really compared, not the ones it planned.
    expect(lastRunWords({ ...ended, takes: 5, compared: 5 })).toBe('The last run compared 5 recordings.')
    expect(lastRunWords({ ...ended, takes: 5, compared: 2 })).toBe('The last run compared 2 of the 5 recordings it planned; the rest were stopped or skipped.')
    expect(lastRunWords({ ...ended, takes: 0 })).toMatch(/^The last run found nothing to compare/)
    expect(lastRunWords({ ...ended, takes: 2, running: true })).toBeNull()
    expect(lastRunWords({ running: false, done: 0, total: 0, queued: 0 })).toBeNull()
  })

  it('names the model a summary row was made with as recorded, mixed, or not recorded', () => {
    expect(summaryModel({ models: ['mlx qwen3-asr-1.7b'], unrecorded: 0 })).toEqual({ words: 'mlx qwen3-asr-1.7b', mixed: false })
    expect(summaryModel({ models: ['a', 'b'], unrecorded: 0 })).toEqual({ words: 'mixed models: a, b', mixed: true })
    expect(summaryModel({ models: ['a'], unrecorded: 3 })).toEqual({ words: 'mixed models: a, model not recorded', mixed: true })
    expect(summaryModel({ models: [], unrecorded: 4 })).toEqual({ words: 'model not recorded', mixed: false })
    // An older server sends neither field.
    expect(summaryModel({})).toEqual({ words: 'model not recorded', mixed: false })
  })

  it('labels the row preview with its source', () => {
    expect(takeText(take({ sentText: 'what I sent' }))).toEqual({ source: 'Probably sent', text: 'what I sent' })
    expect(takeText(take()).source).toBe('Engine text')
  })
})

describe('Voice Accuracy: the list read again during a run', () => {
  const t = (i: number) => take({ id: `rec-${String(i).padStart(3, '0')}`, at: new Date(Date.UTC(2026, 10, 21) - i * 60_000).toISOString() })
  it('keeps the takes loaded past the read, with their cursor, and takes the fresh ones', () => {
    const loaded = { takes: Array.from({ length: 250 }, (_, i) => t(i)), total: 400, nextCursor: 'rec-249' }
    const freshTakes = Array.from({ length: 200 }, (_, i) => ({ ...t(i), inUseText: 'fresh' }))
    const merged = mergeRefreshed(loaded, { takes: freshTakes, total: 401, nextCursor: 'rec-199' })
    expect(merged.takes).toHaveLength(250)
    expect(merged.takes[0]!.inUseText).toBe('fresh')
    expect(merged.takes[249]!.id).toBe('rec-249')
    expect(merged.nextCursor).toBe('rec-249')
    expect(merged.total).toBe(401)
    // A short list is the fresh read as it is.
    expect(mergeRefreshed({ takes: [t(0)], total: 1 }, { takes: [t(1), t(0)], total: 2 }).takes).toHaveLength(2)
  })
})
