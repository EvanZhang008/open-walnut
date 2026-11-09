/**
 * Every disclosure a session's timeline draws starts closed, Walnut's notice
 * rows above all (compaction, recovery, restart, folder moved, wait notes, the
 * envelopes a session received): one line, opened only by the reader's click,
 * never by itself after a compaction, a reload or a history refetch (2026-11-09,
 * the user, of the idle compaction row that opened with its reason and its
 * setting: "why ths automaticlaly open after compact, no, auto hide cusotmer cna
 * open if needed").
 *
 * The class: a disclosure's initial state in a row component. This walks every
 * component a row can draw (the import closure of the row renderers, as
 * row-disclosure-ratchet.test.ts does) and reads the initial value of every
 * `useRowDisclosure` / `useDetailsDisclosure`; one that is not the closed
 * literal fails unless it is listed below with why it is no notice row. Then it
 * renders every system notice variant, alone and in a run, and checks that
 * nothing in them is open.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'

// An opened idle compaction row reads its reason and its setting: no server here.
vi.mock('@/api/sessions', () => ({ fetchSession: async () => null }))
vi.mock('@/api/config', () => ({ fetchConfig: async () => ({}), fetchFreshConfig: async () => ({}), updateConfig: async () => ({}) }))

let doc: Document
let SM: typeof import('../../web/src/components/sessions/SessionMessage')
let MemoryRouter: typeof import('../../web/node_modules/react-router-dom').MemoryRouter
beforeAll(async () => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  Object.assign(globalThis, { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true })
  doc = dom.document as unknown as Document
  // After the document exists: the markdown sanitizer binds to it at import.
  SM = await import('../../web/src/components/sessions/SessionMessage')
  ;({ MemoryRouter } = await import('../../web/node_modules/react-router-dom'))
})

const WEB = join(__dirname, '../../web/src')
const ROOTS = [
  'components/sessions/SessionMessage.tsx',
  'components/sessions/StreamingBlockView.tsx',
  'components/sessions/LaneTimeline.tsx',
  'components/sessions/WorkflowTranscriptModal.tsx',
  'components/sessions/SessionChatHistory.tsx',
]

/** `file:state:initial` → why that disclosure may start open (none of them is a notice row). */
const STARTS_OPEN: Record<string, string> = {
  'components/sessions/SessionMessage.tsx:collapsed:false': "a file edit's diff, inside its tool card, which starts closed",
  'components/sessions/SessionMessage.tsx:expanded:!isLarge': "a small diff shown whole, inside its tool card, which starts closed",
  'components/sessions/SessionMessage.tsx:open:true': "the plan card: the session's plan, the agent's own content, not a notice",
  'components/sessions/SessionMessage.tsx:open:useSoleCall()': 'the one tool card inside a tool run the reader opened by a click',
  'components/sessions/BashToolCall.tsx:open:useSoleCall()': 'the one command card inside a tool run the reader opened by a click',
  'components/sessions/IdleCompactLine.tsx:open:!!inOpenedRun': 'true only inside a notice run the reader opened by a click; alone it starts closed',
}

function resolveImport(from: string, spec: string): string | null {
  let base: string
  if (spec.startsWith('@/')) base = join(WEB, spec.slice(2))
  else if (spec.startsWith('.')) base = normalize(join(dirname(from), spec))
  else return null
  for (const ext of ['.tsx', '/index.tsx']) if (existsSync(base + ext)) return base + ext
  return null
}

function rowComponentFiles(): string[] {
  const seen = new Set<string>()
  const stack = ROOTS.map((r) => join(WEB, r))
  while (stack.length) {
    const f = stack.pop()!
    if (seen.has(f)) continue
    seen.add(f)
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/g)) {
      const r = resolveImport(f, m[1])
      if (r && r.includes('/components/')) stack.push(r)
    }
  }
  return [...seen].map((f) => relative(WEB, f)).sort()
}

/** The call's top-level arguments, from the `(` at `open`. */
function argsAt(src: string, open: number): string[] {
  const args: string[] = []
  let depth = 0
  let start = open + 1
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      depth--
      if (depth === 0) { args.push(src.slice(start, i).trim()); return args }
    } else if (c === ',' && depth === 1) { args.push(src.slice(start, i).trim()); start = i + 1 }
  }
  throw new Error('unbalanced call')
}

describe('timeline disclosures start closed', () => {
  const files = rowComponentFiles()

  it('walks the notice row components', () => {
    for (const f of ['components/sessions/SessionMessage.tsx', 'components/sessions/IdleCompactLine.tsx', 'components/sessions/InjectedBannerRow.tsx', 'components/sessions/SessionProvenanceCard.tsx']) {
      expect(files, `${f} is not reached from the row renderers`).toContain(f)
    }
  })

  it('every disclosure starts closed, or says why it is no notice row', () => {
    const offenders: string[] = []
    const seen = new Set<string>()
    let calls = 0
    for (const f of files) {
      const src = readFileSync(join(WEB, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      for (const m of src.matchAll(/const \[(\w+),\s*set\w*\]\s*=\s*useRowDisclosure\(/g)) {
        if (f.endsWith('row-disclosure.ts')) continue
        calls++
        const args = argsAt(src, m.index! + m[0].length - 1)
        const initial = (args[1] ?? '').replace(/\s+/g, ' ')
        const closed = /collaps/i.test(m[1]) ? 'true' : 'false'
        if (initial === closed) continue
        const key = `${f}:${m[1]}:${initial}`
        if (STARTS_OPEN[key]) { seen.add(key); continue }
        offenders.push(`${key} (a timeline row starts closed: pass ${closed})`)
      }
    }
    expect(calls).toBeGreaterThan(8)
    expect(offenders).toEqual([])
    expect(Object.keys(STARTS_OPEN).filter((k) => !seen.has(k)), 'stale STARTS_OPEN entries').toEqual([])
    // useDetailsDisclosure has no initial of its own: it must stay closed.
    const details = readFileSync(join(WEB, 'components/sessions/row-disclosure.ts'), 'utf8')
    expect(details).toMatch(/useDetailsDisclosure[\s\S]*?useRowDisclosure\(id, false\)/)
  })

  it('every system notice renders closed, alone and in a run', async () => {
    const { SystemLineCollapsible, SystemGroupRun } = SM
    const { CLI_ERROR_VARIANT } = await import('../../web/src/components/sessions/fold-steps')
    const prompt = await import('../../src/core/sessions/prompt-cache')
    // The variants a history row can carry, read from the type itself.
    const types = readFileSync(join(WEB, 'types/session.ts'), 'utf8')
    const union = types.match(/systemVariant\?:\s*([^;]+);/)![1]
    const variants = [...union.matchAll(/'([^']+)'/g)].map((m) => m[1]).concat(CLI_ERROR_VARIANT)
    expect(variants).toEqual(expect.arrayContaining(['compact', 'error', 'info']))
    const messages = [
      prompt.IDLE_COMPACT_HISTORY_TEXT,
      'Compacting this idle session before its prompt cache expires',
      'Compacted by Walnut while the session was idle',
      'Session restarted after the host came back',
    ]
    const longDetail = 'x'.repeat(400)
    for (const variant of variants) {
      for (const message of messages) {
        for (const detail of [undefined, longDetail]) {
          const one = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SystemLineCollapsible, { variant, message, detail, time: '10:00', noticeId: `n-${variant}` })))
          expect(one, `${variant} ${message}`).not.toContain('aria-expanded="true"')
          expect(one).not.toContain('idle-compact-body')
          expect(one).not.toContain('tool-run-body')
          const run = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SystemGroupRun, {
            members: [
              { variant, message, detail, time: '10:00', key: `a-${variant}` },
              { variant: 'compact', message: 'Context compacted', detail: '462K → 34K tokens', time: '10:01', key: `b-${variant}` },
            ],
          })))
          expect(run, `run ${variant} ${message}`).not.toContain('tool-run-body')
          expect(run).not.toContain('idle-compact-line')
        }
      }
    }
  })

  it('a click opens them: the idle compaction row alone, and its run straight to why it ran', async () => {
    const host = doc.createElement('div')
    doc.body.appendChild(host)
    const root = createRoot(host)
    const { IDLE_COMPACT_HISTORY_TEXT } = await import('../../src/core/sessions/prompt-cache')
    const click = async (el: Element | null) => { expect(el).not.toBeNull(); await act(async () => { (el as HTMLElement).click() }) }
    // Alone: one line, its reason only after a click.
    await act(async () => { root.render(createElement(MemoryRouter, null, createElement(SM.SystemLineCollapsible, { variant: 'info', message: IDLE_COMPACT_HISTORY_TEXT, noticeId: 'alone-1' }))) })
    expect(host.querySelector('.idle-compact-toggle')!.getAttribute('aria-expanded')).toBe('false')
    expect(host.querySelector('.idle-compact-body')).toBeNull()
    await click(host.querySelector('.idle-compact-toggle'))
    expect(host.querySelector('.idle-compact-body')).not.toBeNull()
    // In a run: closed; the reader's one click shows the line with why it ran.
    await act(async () => { root.render(createElement(MemoryRouter, null, createElement(SM.SystemGroupRun, { members: [
      { variant: 'info', message: IDLE_COMPACT_HISTORY_TEXT, key: 'run-a' },
      { variant: 'compact', message: 'Context compacted', detail: '462K → 34K tokens', key: 'run-b' },
    ] }))) })
    expect(host.querySelector('.tool-run-body')).toBeNull()
    await click(host.querySelector('.tool-run-toggle'))
    expect(host.querySelector('.idle-compact-toggle')!.getAttribute('aria-expanded')).toBe('true')
    await click(host.querySelector('.tool-run-toggle'))
    expect(host.querySelector('.tool-run-body')).toBeNull()
    await act(async () => { root.unmount() })
    host.remove()
  })
})
