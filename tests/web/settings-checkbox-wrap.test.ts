/**
 * A settings checkbox row keeps its tick on the label's first line and wraps the label in full
 * beside it, in every pane (SettingsCheckbox, styles/settings-controls.css), and no words in the
 * Voice Accuracy pane can be cut with an ellipsis (UI rule 11).
 * 2026-11-22 review: on a phone each consent tick sat alone on its line and the label under it
 * ended in "...", hiding what gets sent. The pane check renders the whole pane (a recording
 * opened) and matches every rule of the app's CSS that sets `text-overflow: ellipsis` against it;
 * an element is cut unless a rule that sets `text-overflow: clip` also matches it (the shared
 * "whole" variants).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { StrictMode, act, createElement } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'

const WEB = join(__dirname, '../../web/src')

interface Rule { selectors: string[]; body: string }

/** Every style rule of a stylesheet, the ones inside @media and @container blocks too. */
function rulesOf(css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: Rule[] = []
  let i = 0
  const walk = (end: number) => {
    while (i < end) {
      const open = text.indexOf('{', i)
      if (open < 0 || open >= end) { i = end; return }
      const head = text.slice(i, open).trim()
      let depth = 1
      let j = open + 1
      while (j < text.length && depth > 0) { if (text[j] === '{') depth++; else if (text[j] === '}') depth--; j++ }
      if (head.startsWith('@')) {
        if (/^@(media|container|supports|layer)/.test(head)) { i = open + 1; walk(j - 1); }
        i = j
        continue
      }
      out.push({ selectors: splitSelectors(head), body: text.slice(open + 1, j - 1) })
      i = j
    }
  }
  walk(text.length)
  return out
}

function splitSelectors(head: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const c of head) {
    if (c === '(') depth++
    if (c === ')') depth--
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue }
    cur += c
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : cssFiles(path)
    return name.endsWith('.css') ? [path] : []
  })
}

const ALL_RULES = cssFiles(WEB).flatMap((f) => rulesOf(readFileSync(f, 'utf8')))
const declares = (body: string, prop: string, value: RegExp) =>
  body.split(';').some((d) => { const [p, ...v] = d.split(':'); return p?.trim() === prop && value.test(v.join(':').trim()) })

function ruleFor(file: string, selector: string): string {
  const rules = rulesOf(readFileSync(join(WEB, file), 'utf8')).filter((r) => r.selectors.includes(selector))
  expect(rules.length, `${selector} in ${file}`).toBeGreaterThan(0)
  return rules.map((r) => r.body).join(';')
}

describe('the shared checkbox row wraps its label beside the tick', () => {
  it('never cuts the label, and keeps the tick on its first line at the left', () => {
    const label = ruleFor('styles/settings-controls.css', '.settings-checkbox-label')
    expect(declares(label, 'white-space', /^normal$/)).toBe(true)
    expect(declares(label, 'text-overflow', /ellipsis/)).toBe(false)
    expect(declares(label, 'overflow', /hidden/)).toBe(false)
    const row = ruleFor('styles/settings-controls.css', '.settings-row.settings-checkbox-row')
    expect(declares(row, 'flex-wrap', /^nowrap$/)).toBe(true)
    expect(declares(row, 'align-items', /^flex-start$/)).toBe(true)
  })

  it('no stylesheet cuts a checkbox label again in some pane or group', () => {
    const cutting = ALL_RULES.filter((r) => declares(r.body, 'text-overflow', /ellipsis/) && r.selectors.some((s) => /settings-checkbox-label/.test(s)))
    expect(cutting.map((r) => r.selectors.join(', '))).toEqual([])
  })
})

// ── The whole Voice Accuracy pane, rendered ──
const api = vi.hoisted(() => ({
  fetchCompareEngines: vi.fn(), fetchCompareSummary: vi.fn(), fetchCompareTakes: vi.fn(), fetchCompareRun: vi.fn(), fetchCompareTake: vi.fn(),
}))
vi.mock('@/api/stt-compare', async (importOriginal) => ({ ...(await importOriginal<object>()), ...api }))
vi.mock('@/utils/log', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock('@/hooks/useElementWidth', () => ({ useElementWidth: () => 1200 }))

import { VoiceAccuracySection } from '../../web/src/components/settings/sections/VoiceAccuracySection'

const LONG = 'a long text that a narrow phone column would cut if anything in the pane still ended in an ellipsis'
const ENGINE_ROWS = [
  { id: 'in-use', label: 'In use', kind: 'engine', runsOn: 'local', sends: 'nothing', state: 'not-installed', detail: 'No voice engine is set up', fix: 'set-up-dictation', enabled: true, allow_upload: false },
  { id: 'whisper-large-v2', label: 'Whisper large-v2', kind: 'engine', runsOn: 'local', sends: 'nothing', state: 'not-installed', detail: 'It needs /x/ggml-large-v2.bin', fix: 'download-whisper', enabled: true, allow_upload: false },
  { id: 'elevenlabs-scribe', label: 'ElevenLabs Scribe', kind: 'engine', runsOn: 'cloud', sends: 'audio', state: 'needs-consent', model: 'scribe_v3', enabled: true, allow_upload: false },
  { id: 'haiku-cleanup', label: 'In use + Haiku clean-up', kind: 'engine', runsOn: 'cloud', sends: 'text', after: 'in-use', state: 'ready', enabled: true, allow_upload: true },
  { id: 'judge', label: 'AI judge', kind: 'judge', runsOn: 'cloud', sends: 'text', state: 'needs-consent', model: 'judge-model', enabled: true, allow_upload: false },
]
const rates = (mixed: number) => ({ mixed, cjk: mixed, latin: mixed, terms: 0.9 })
const TAKE = {
  id: 'rec-1', source: 'web', at: '2026-11-18T10:30:00.000Z', durationSec: 46, format: 'webm', sentText: LONG,
  results: { 'in-use': { text: LONG, ms: 2300, at: 'x', model: 'm' }, 'haiku-cleanup': { text: LONG, ms: 900, at: 'x' } },
  scores: { 'in-use': { edits: 1, n: 20, cjkEdits: 0, cjkN: 0, latEdits: 1, latN: 20, termsHit: 1, termsNeed: 1 } },
  reference: { text: LONG, judge: 'judge-model', at: 'x' }, run: {},
}

let root: ReturnType<typeof createRoot>
let host: HTMLElement

beforeAll(() => {
  const dom = parseHTML('<html><body></body></html>')
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
})

/** A selector as linkedom can match it: states and pseudo-elements dropped (they never stop text being cut). */
const matchable = (s: string) => s.replace(/::?(hover|focus|focus-visible|focus-within|active|before|after|placeholder|first-child|last-child|empty)\b(\([^)]*\))?/g, '').trim()

function matches(el: Element, selector: string): boolean {
  try { return el.matches(matchable(selector) || '*') } catch { return false }
}

describe('Voice Accuracy: no words in the pane can be cut with an ellipsis', () => {
  it('matches no ellipsis rule of the app without a clip rule beside it, a recording opened', async () => {
    api.fetchCompareRun.mockResolvedValue({ running: false, done: 0, total: 0, queued: 0 })
    api.fetchCompareSummary.mockResolvedValue({
      takes: 1, judged: 1, sharedTakes: 1, byDay: [], judge: { state: 'needs-consent' }, best: 'in-use',
      engines: [{ id: 'in-use', ...rates(0.05), medianMs: 2300, takes: 1, scoredTakes: 1, models: ['a', 'b'] }, { id: 'haiku-cleanup', ...rates(0.2), medianMs: 900, takes: 1, scoredTakes: 1 }],
    })
    api.fetchCompareEngines.mockResolvedValue({ engines: ENGINE_ROWS, nightly: false, hasElevenLabsKey: false })
    api.fetchCompareTakes.mockResolvedValue({ takes: [TAKE], total: 1 })
    api.fetchCompareTake.mockResolvedValue({ ...TAKE, diffs: {} })
    // Inside the settings layout, so rules scoped to it can match.
    const shell = document.createElement('div')
    shell.className = 'settings-layout settings-container'
    shell.setAttribute('data-phone-settings', '')
    host = document.createElement('div')
    host.className = 'settings-pane'
    shell.appendChild(host)
    document.body.appendChild(shell)
    root = createRoot(host)
    await act(async () => { root.render(createElement(StrictMode, null, createElement(VoiceAccuracySection))) })
    await act(async () => { (host.querySelector('[data-testid="va-take-row"]') as HTMLElement).click() })
    // The recording opens in its dialog, portalled out of the pane: its words are checked too.
    const dialog = document.querySelector('[data-testid="va-take-dialog"]')!
    expect(dialog.querySelector('[data-testid="va-take-detail"]')).not.toBeNull()

    const ellipsis = ALL_RULES.filter((r) => declares(r.body, 'text-overflow', /ellipsis/)).flatMap((r) => r.selectors)
    const clip = ALL_RULES.filter((r) => declares(r.body, 'text-overflow', /clip/)).flatMap((r) => r.selectors)
    const cut: string[] = []
    for (const el of [...host.querySelectorAll('*'), dialog, ...dialog.querySelectorAll('*')]) {
      const by = ellipsis.find((s) => matches(el, s))
      if (by && !clip.some((s) => matches(el, s))) cut.push(`<${el.tagName.toLowerCase()} class="${el.getAttribute('class') ?? ''}"> by ${by}`)
    }
    await act(async () => { root.unmount() })
    shell.remove()
    expect(cut).toEqual([])
  })
})
