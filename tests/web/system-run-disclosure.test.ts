/**
 * A run of runtime rows the reader opened stays open when its saved twin replaces the live run
 * (systemRunDisclosureId, web/src/components/sessions/fold-steps.ts), and the idle compaction's
 * inline setting keeps what it said about its own save (IdleCompactSetting).
 *
 * 2026-11-16, nightly compact-context: the reader opened "Compacted by Walnut while idle" while
 * it was the live run; the history was read again, the saved run took its place, and it was
 * closed, because the live run's first row ("Compacting this idle session ...") and the saved
 * one's ("Walnut sent /compact ...") have different words and the open state was kept by them.
 * Then "set to 99%" vanished as soon as the row's own save came back as config:changed.
 *
 * The class: a run whose live rows and saved rows say the same thing in different words. Each
 * Walnut compaction (WALNUT_COMMANDS) is checked running and ended, so a new one is covered when
 * it appears; the next compaction must still start closed (notice-rows-start-closed).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'

const api = vi.hoisted(() => ({
  config: { session: { idle_compaction: { enabled: true } } } as { session: { idle_compaction: { enabled?: boolean; limit_percent?: number } } },
  handlers: new Map<string, Set<(data: unknown) => void>>(),
  /** A PUT that answers only when released, so the echo can come first. */
  holdPut: null as null | Promise<void>,
  reason: null as null | { lineUuid: string },
  failRead: false,
  /** A PUT the server refuses, after another place set this value. */
  failPut: null as null | { limit_percent: number },
}))
vi.mock('@/api/config', () => ({
  fetchConfig: async () => structuredClone(api.config),
  fetchFreshConfig: async () => { if (api.failRead) throw new Error('offline'); return structuredClone(api.config) },
  updateConfig: async (c: { session: typeof api.config.session }) => {
    if (api.failPut) {
      api.config = { session: { idle_compaction: { enabled: true, ...api.failPut } } }
      throw new Error('refused')
    }
    api.config = structuredClone(c) as typeof api.config
    // The server's broadcast of the write: it reaches the page before or after the PUT's answer.
    for (const h of api.handlers.get('config:changed') ?? []) h({ key: 'session' })
    if (api.holdPut) await api.holdPut
    return { ok: true }
  },
  updateConfigKeys: async () => ({ ok: true }),
}))
vi.mock('@/api/sessions', () => ({
  fetchSession: async () => (api.reason ? { idleCompactionLog: [{ ...api.reason, tokens: 400_000, threshold: 360_000, limitPercent: 80, compactsAt: 450_000, source: 'model' }] } : null),
}))
vi.mock('@/hooks/useWebSocket', async () => {
  const react = await import('../../web/node_modules/react/index.js')
  return {
    useEvent: (name: string, cb: (data: unknown) => void) => {
      const ref = react.useRef(cb)
      ref.current = cb
      react.useEffect(() => {
        const h = (d: unknown) => ref.current(d)
        if (!api.handlers.has(name)) api.handlers.set(name, new Set())
        api.handlers.get(name)!.add(h)
        return () => { api.handlers.get(name)!.delete(h) }
      }, [name])
    },
  }
})

let doc: Document
let SM: typeof import('../../web/src/components/sessions/SessionMessage')
let FS: typeof import('../../web/src/components/sessions/fold-steps')
let RD: typeof import('../../web/src/components/sessions/row-disclosure')
let ICL: typeof import('../../web/src/components/sessions/IdleCompactLine')
let MemoryRouter: typeof import('../../web/node_modules/react-router-dom').MemoryRouter
beforeAll(async () => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  Object.assign(globalThis, { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true })
  doc = dom.document as unknown as Document
  SM = await import('../../web/src/components/sessions/SessionMessage')
  FS = await import('../../web/src/components/sessions/fold-steps')
  RD = await import('../../web/src/components/sessions/row-disclosure')
  ICL = await import('../../web/src/components/sessions/IdleCompactLine')
  ;({ MemoryRouter } = await import('../../web/node_modules/react-router-dom'))
})
afterEach(() => {
  api.config = { session: { idle_compaction: { enabled: true } } }
  api.handlers.clear()
  api.holdPut = null
  api.reason = null
  api.failRead = false
  api.failPut = null
  RD.__resetRowDisclosuresForTests()
})

const SIZE = '400K → 18K tokens'
type Member = { variant: string; message: string; detail?: string; key?: string; id?: string; text?: string }
/** A saved row as the history gives it, mapped the way the timeline maps it. */
const saved = (text: string, systemVariant: string, systemDetail?: string, msgId?: string): Member =>
  SM.systemGroupMemberFromHistory({ role: 'system', text, systemVariant, ...(systemDetail ? { systemDetail } : {}), ...(msgId ? { msgId } : {}), timestamp: '2026-11-16T17:07:54Z' } as never)

describe('a run keeps its open state from its live rows to its saved ones', () => {
  it('every Walnut compaction, running and ended, and the CLI\'s own', async () => {
    const { WALNUT_COMMANDS } = await import('../../src/core/sessions/walnut-commands')
    const { COMPACTED_MESSAGE, COMPACTING_MESSAGE } = await import('@open-walnut/compaction-notice')
    const { idleCompactNote } = await import('../../src/core/sessions/idle-compaction')
    const liveNote = idleCompactNote({ tokens: 400_000, threshold: 360_000, limitPercent: 80, compactsAt: 450_000, source: 'model' }, 1)
    expect(WALNUT_COMMANDS.length).toBeGreaterThan(1)
    for (const c of WALNUT_COMMANDS) {
      // Live: Walnut's note while it sends (the idle one is a Walnut line, the context one a plain
      // note), then the CLI's compaction. Saved: the line that stands for Walnut's command.
      const note = { variant: 'info', message: c.source === 'idle-compact' ? liveNote : 'Walnut is compacting this conversation so it fits again.' }
      const running = [note, { variant: 'compact', message: COMPACTING_MESSAGE }]
      // The saved notice reads as a compaction, as the live rows do.
      expect(FS.systemRunDisclosureId([saved(c.notice, 'info', undefined, `cmd-${c.source}`), saved('Context compacting', 'compact')]), c.source).toBe(FS.systemRunDisclosureId(running))
      expect(FS.systemRunDisclosureId(running)).toBe(FS.COMPACTION_PENDING_RUN_ID)
      const live = [...running, { variant: 'compact', message: COMPACTED_MESSAGE, detail: SIZE, id: `boundary-${c.source}` }]
      const rows = [saved(c.notice, 'info', undefined, `cmd-${c.source}`), saved(COMPACTED_MESSAGE, 'compact', SIZE, `boundary-${c.source}`)]
      expect(FS.systemRunDisclosureId(live), c.source).toBe(FS.systemRunDisclosureId(rows))
    }
    const cli = FS.systemRunDisclosureId([{ variant: 'compact', message: COMPACTING_MESSAGE }, { variant: 'compact', message: COMPACTED_MESSAGE, detail: SIZE, id: 'b-cli' }])
    expect(cli).toBe(FS.systemRunDisclosureId([saved(COMPACTED_MESSAGE, 'compact', SIZE, 'b-cli')]))
  })

  it('two compactions of the same size, or with no numbers, are two runs', async () => {
    const { COMPACTED_MESSAGE } = await import('@open-walnut/compaction-notice')
    for (const detail of [SIZE, 'auto']) {
      const a = FS.systemRunDisclosureId([saved(COMPACTED_MESSAGE, 'compact', detail, 'b-1')])
      const b = FS.systemRunDisclosureId([saved(COMPACTED_MESSAGE, 'compact', detail, 'b-2')])
      expect(a, detail).not.toBe(b)
    }
  })

  it('a long notice: the saved row cut to its first words is the same run', () => {
    const text = `Restart recovery: ${'the session was resumed where it stopped, '.repeat(6)}and it answers now.`
    const row = saved(text, 'info')
    expect(row.message.length).toBeLessThan(text.length)
    expect(FS.systemRunDisclosureId([row])).toBe(FS.systemRunDisclosureId([{ variant: 'info', message: text }]))
    expect(FS.systemRunDisclosureId([{ variant: 'info', message: 'one' }])).not.toBe(FS.systemRunDisclosureId([{ variant: 'info', message: 'two' }]))
  })

  const drawer = () => {
    const host = doc.createElement('div')
    doc.body.appendChild(host)
    const root = createRoot(host)
    const draw = (runs: [string, Member[]][]) => act(async () => {
      root.render(createElement(MemoryRouter, null, createElement(RD.RowDisclosureScope.Provider, { value: 'sid-1' },
        ...runs.map(([key, members]) => createElement('div', { key, 'data-run': key }, createElement(SM.SystemGroupRun, { members }))))))
    })
    const body = (key: string) => host.querySelector(`[data-run="${key}"] .tool-run-body`)
    const open = (key: string) => act(async () => { (host.querySelector(`[data-run="${key}"] .tool-run-toggle`) as HTMLElement).click() })
    const done = async () => { await act(async () => { root.unmount() }); host.remove() }
    return { host, draw, body, open, done }
  }

  it('opened while it compacts, it is open when the saved run takes its place, straight to why it ran', async () => {
    const { IDLE_COMPACT_HISTORY_TEXT } = await import('../../src/core/sessions/prompt-cache')
    const { COMPACTED_MESSAGE, COMPACTING_MESSAGE } = await import('@open-walnut/compaction-notice')
    api.reason = { lineUuid: 'line-1' }
    const { host, draw, body, open, done } = drawer()
    const live: Member[] = [
      { variant: 'info', message: 'Compacting this idle session before its prompt cache expires in about 1 min: 400K tokens.', key: 'stream-system-4' },
      { variant: 'compact', message: COMPACTING_MESSAGE, key: 'stream-system-5' },
    ]
    await draw([['live', live]])
    expect(body('live')).toBeNull()
    await open('live')
    // The boundary comes in the live run, then the history is read again: another element, the saved rows.
    await draw([['live', [...live, { variant: 'compact', message: COMPACTED_MESSAGE, detail: SIZE, key: 'stream-system-6', id: 'line-2' }]]])
    expect(body('live')).not.toBeNull()
    await draw([['saved', [saved(IDLE_COMPACT_HISTORY_TEXT, 'info', undefined, 'line-1'), saved(COMPACTED_MESSAGE, 'compact', SIZE, 'line-2')]]])
    expect(body('saved'), 'the run the reader opened closed when its saved rows came').not.toBeNull()
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(host.querySelector('[data-testid="idle-compact-why"]')?.textContent).toContain('Why: 400K tokens')
    await done()
  })

  it('an opened run that still compacts, swapped for another element, hands its state over and leaves none behind', async () => {
    const { COMPACTING_MESSAGE } = await import('@open-walnut/compaction-notice')
    const { draw, body, open, done } = drawer()
    const running = (k: string): Member[] => [{ variant: 'info', message: `Compacting this idle session before its prompt cache expires in about ${k} min.`, key: `n-${k}` }, { variant: 'compact', message: COMPACTING_MESSAGE, key: `c-${k}` }]
    await draw([['one', running('1')]])
    await open('one')
    // The same run drawn by another element in the same commit (live to saved): still open.
    await draw([['other', running('1')]])
    expect(body('other')).not.toBeNull()
    // It goes away before it ends (the panel closed, or it scrolled out), and a later compaction runs.
    await draw([])
    await draw([['next', running('2')]])
    expect(body('next'), 'a later compaction opened by itself').toBeNull()
    await done()
  })

  it('the next compaction starts closed: one of the same size, and one that fails as an earlier one did', async () => {
    const { IDLE_COMPACT_HISTORY_TEXT } = await import('../../src/core/sessions/prompt-cache')
    const { COMPACTED_MESSAGE, COMPACTING_MESSAGE, COMPACTION_FAILED_MESSAGE } = await import('@open-walnut/compaction-notice')
    const { draw, body, open, done } = drawer()
    const first: Member[] = [{ variant: 'info', message: 'Compacting this idle session before its prompt cache expires in about 1 min.', key: 's1' }, { variant: 'compact', message: COMPACTING_MESSAGE, key: 's2' }]
    const ended = [...first, { variant: 'compact', message: COMPACTED_MESSAGE, detail: SIZE, key: 's3', id: 'b-1' }]
    await draw([['a', first]])
    await open('a')
    await draw([['a', ended]])
    expect(body('a')).not.toBeNull()
    const second: Member[] = [saved(IDLE_COMPACT_HISTORY_TEXT, 'info', undefined, 'cmd-2'), { variant: 'compact', message: COMPACTING_MESSAGE, key: 't2' }]
    await draw([['a', ended], ['b', second]])
    expect(body('b'), 'a compaction still running opened by itself').toBeNull()
    await draw([['a', ended], ['b', [...second, saved(COMPACTED_MESSAGE, 'compact', SIZE, 'b-2')]]])
    expect(body('b'), 'a compaction of the same size opened by itself').toBeNull()
    expect(body('a')).not.toBeNull()
    // An earlier failure the reader opened, then the next compaction fails the same way.
    const failed = (k: string): Member[] => [{ variant: 'compact', message: COMPACTING_MESSAGE, key: `f-${k}` }, { variant: 'compact', message: COMPACTION_FAILED_MESSAGE, detail: 'context unchanged', key: `g-${k}` }]
    await draw([['f1', failed('1')]])
    await open('f1')
    await draw([['f1', failed('1')], ['f2', failed('2').slice(0, 1)]])
    await draw([['f1', failed('1')], ['f2', failed('2')]])
    expect(body('f2'), 'a failed compaction opened by itself').toBeNull()
    await done()
  })

  it('an error after the boundary keeps the run known by its boundary', async () => {
    const { COMPACTED_MESSAGE } = await import('@open-walnut/compaction-notice')
    const id = FS.systemRunDisclosureId([saved(COMPACTED_MESSAGE, 'compact', SIZE, 'b-9'), saved('API Error: 500', 'error', undefined, 'e-1')])
    expect(id).toBe(FS.systemRunDisclosureId([saved(COMPACTED_MESSAGE, 'compact', SIZE, 'b-9')]))
  })
})

describe('the inline idle compaction setting keeps what it said about its own save', () => {
  const mount = async () => {
    const host = doc.createElement('div')
    doc.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => { root.render(createElement(MemoryRouter, null, createElement(ICL.IdleCompactSetting))) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const input = host.querySelector('[data-testid="idle-compact-percent"]') as HTMLInputElement
    expect(input.value).toBe('80')
    // linkedom has no input events React reads: call the field's own handlers, as a key press would.
    const props = () => {
      const key = Object.keys(input).find((name) => name.startsWith('__reactProps$'))!
      return (input as unknown as Record<string, { onChange: (e: unknown) => void; onKeyDown: (e: unknown) => void }>)[key]
    }
    const type = async (value: string) => {
      await act(async () => { props().onChange({ target: { value } }) })
      await act(async () => { props().onKeyDown({ key: 'Enter', preventDefault() {} }) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    }
    const done = async () => { await act(async () => { root.unmount() }); host.remove() }
    return { host, input, type, done }
  }

  for (const order of ['after', 'before'] as const) {
    it(`its echo arriving ${order} the save's answer clears nothing`, async () => {
      let release!: () => void
      if (order === 'before') api.holdPut = new Promise<void>((r) => { release = r })
      const { host, input, type, done } = await mount()
      await type('120')
      if (order === 'before') { await act(async () => { release(); await new Promise((r) => setTimeout(r, 0)) }) }
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(api.config.session.idle_compaction.limit_percent).toBe(99)
      expect(input.value).toBe('99')
      expect(host.textContent, 'the echo of its own save cleared the note').toContain('set to 99%')
      // Not a number: said so, nothing saved, and an echo of the earlier save keeps it.
      await type('abc')
      for (const h of api.handlers.get('config:changed') ?? []) h({ key: 'session' })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(host.textContent).toContain('50% to 99%; it stays at 99%')
      await done()
    })
  }

  it('a change made elsewhere still replaces the value and what was said', async () => {
    const { host, input, type, done } = await mount()
    await type('120')
    expect(host.textContent).toContain('set to 99%')
    api.config = { session: { idle_compaction: { enabled: true, limit_percent: 70 } } }
    await act(async () => { for (const h of api.handlers.get('config:changed') ?? []) h({ key: 'session' }) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(input.value).toBe('70')
    expect(host.textContent).not.toContain('set to 99%')
    await done()
  })

  it('a read that failed is cleared by the next good one, the same value too', async () => {
    const { host, done } = await mount()
    api.failRead = true
    await act(async () => { for (const h of api.handlers.get('config:changed') ?? []) h({ key: 'session' }) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(host.textContent).toContain('Could not read the setting.')
    api.failRead = false
    await act(async () => { for (const h of api.handlers.get('config:changed') ?? []) h({ key: 'session' }) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(host.textContent).not.toContain('Could not read the setting.')
    await done()
  })

  it('a save that failed shows the value in force, not the one from before both, nor the unsaved one', async () => {
    const { host, input, type, done } = await mount()
    // Settings set 70% while this row's save of 99% was refused.
    api.failPut = { limit_percent: 70 }
    await type('120')
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(input.value).toBe('70')
    expect(host.textContent).toContain('Could not save: refused')
    expect(host.textContent).not.toContain('set to 99%')
    // The server down: the save and the read after it fail, and the row shows what it showed.
    api.failPut = null
    api.config = { session: { idle_compaction: { enabled: true, limit_percent: 70 } } }
    const put = await import('@/api/config')
    vi.spyOn(put, 'updateConfig').mockRejectedValueOnce(new Error('offline'))
    vi.spyOn(put, 'fetchFreshConfig').mockResolvedValueOnce(structuredClone(api.config) as never).mockRejectedValueOnce(new Error('offline'))
    await type('120')
    expect(input.value).toBe('70')
    await type('abc')
    expect(host.textContent).toContain('it stays at 70%')
    await done()
  })
})
