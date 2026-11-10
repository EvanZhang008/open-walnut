/**
 * Real input on a page Chrome does not draw (packages/browser-extension/src/agent-delivery.ts;
 * 2026-11-10, in the person's own Chrome): with Walnut's agent window covered by their other
 * windows, the page is hidden and Chrome drops what its debugger sends while answering "ok". A
 * default click said `trusted: true` and the page received nothing. Guards, against a fake browser
 * (the page's answers and the debugger are faked, the rest is the real command code):
 *   - every step that can send the debugger's input (INPUT_OPS, read from the source) ends, on a
 *     hidden page and on a page that dropped the input, with the page's events doing it (a default
 *     step: `trusted: false` and why) or a refusal that says how to fix it (asked by name), never
 *     a bare success;
 *   - a hidden page is never sent the debugger's input at all, and no window is raised;
 *   - every debugger step is classified (input or not), and every switch case of trustedAct that
 *     sends input checks its delivery: a new trusted action added without it fails here;
 *   - the page side counts only trusted events, at the step's own point for a mouse step.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

type Listener = (source: { tabId?: number }, method: string, params?: Record<string, unknown>) => void
type PageAnswer = (op: string, args: Record<string, unknown>, frameId: number) => unknown
const fake = {
  session: {} as Record<string, unknown>,
  log: [] as Array<[string, Record<string, unknown> | undefined]>,
  pageLog: [] as Array<{ op: string; args: Record<string, unknown>; frameId: number }>,
  page: (() => ({})) as PageAnswer,
  /** The page reports itself hidden (agent-check). */
  hidden: false,
  /** What the delivery probe saw: 0 = the input was dropped. */
  seen: 1,
  windowCalls: [] as string[],
}
const ev = () => ({ addListener() {}, removeListener() {} })
const PAGE_URL = 'https://shop.example.test/checkout'
const tab = () => ({ id: 7, windowId: 3, active: true, url: PAGE_URL, title: 'Checkout', status: 'complete' })
;(globalThis as any).chrome = {
  runtime: { id: 'test', getURL: (p: string) => `chrome-extension://test/${p}`, getManifest: () => ({ version: '0' }), onMessage: ev() },
  storage: {
    session: { get: async (k: string) => ({ [k]: fake.session[k] }), set: async (o: Record<string, unknown>) => { Object.assign(fake.session, o) }, remove: async () => undefined },
    local: { get: async () => ({ agentControl: true }), set: async () => {} },
    onChanged: ev(),
  },
  tabs: {
    onCreated: ev(), onRemoved: ev(), onUpdated: ev(),
    get: async () => tab(), query: async () => [tab()], update: async () => tab(), create: async () => tab(),
    sendMessage: async (_tabId: number, msg: { type: string; op?: string; args?: Record<string, unknown> }, opts?: { frameId?: number }) => {
      if (msg.type === 'agent-check') return { ok: true, walnut: false, href: PAGE_URL, doc: 'doc-1', ...(fake.hidden ? { hidden: true } : {}) }
      if (msg.type !== 'agent') return { ok: true }
      const frameId = opts?.frameId ?? 0
      fake.pageLog.push({ op: msg.op!, args: msg.args ?? {}, frameId })
      if (msg.op === 'probe_read') return { ok: true, result: { armed: pageOps('locate').concat(pageOps('drag_points')).some((p) => p.args.probe === msg.args?.probe), seen: fake.seen } }
      try {
        return { ok: true, result: await fake.page(msg.op!, msg.args ?? {}, frameId) }
      } catch (err) {
        return { ok: false, error: { message: (err as Error).message, code: (err as { code?: string }).code ?? 'page_error' } }
      }
    },
  },
  scripting: { executeScript: async () => [{ frameId: 0, result: { href: PAGE_URL, w: 1200, h: 800, kids: 0 } }] },
  windows: {
    get: async () => ({ state: 'normal', focused: false }), onRemoved: ev(),
    // Never: the agent window is not raised or focused to make the page visible.
    update: async (id: number, o: Record<string, unknown>) => { fake.windowCalls.push(`update ${id} ${JSON.stringify(o)}`); return {} },
  },
  permissions: { contains: async () => true, onRemoved: ev() },
  debugger: {
    attach: async () => { fake.log.push(['attach', undefined]) },
    detach: async () => { fake.log.push(['detach', undefined]) },
    sendCommand: async (_t: unknown, method: string, params?: Record<string, unknown>) => { fake.log.push([method, params]); return {} },
    onEvent: { addListener: (_fn: Listener) => undefined, removeListener() {} },
    onDetach: ev(),
  },
  downloads: { onCreated: ev(), onChanged: ev(), onDeterminingFilename: ev(), search: async () => [] },
}
;(globalThis as any).fetch = async () => { throw new Error('no network in this test') }

const agent = await import('../../../packages/browser-extension/src/agent')
const { walnutCheck } = await import('../../../packages/browser-extension/src/agent-shared')
const { dropDebugger, _setLingerMsForTesting } = await import('../../../packages/browser-extension/src/cdp')
const dialogs = await import('../../../packages/browser-extension/src/agent-dialog')
const trusted = await import('../../../packages/browser-extension/src/agent-trusted')
const { DROPPED_WHY, HIDDEN_WHY } = await import('../../../packages/browser-extension/src/agent-delivery')
walnutCheck.isWalnutPage = async () => false

const act = (action: string, args: Record<string, unknown> = {}) => agent._actForTesting({ id: 'c', action, args: { tab: 7, ...args }, allow: { any: true, sites: [] } }) as Promise<Record<string, any>>
const settle = (p: Promise<Record<string, any>>) => p.then((r) => ({ ok: r }), (e: { code?: string; message?: string }) => ({ err: e }))
function pageOps(op: string) { return fake.pageLog.filter((p) => p.op === op) }
const input = () => fake.log.filter((l) => /^Input\.dispatch/.test(l[0]))

const point = { x: 30, y: 40, what: 'button "Next"' }
const answers: PageAnswer = (op) => {
  if (op === 'locate') return point
  if (op === 'drag_points') return { from: { x: 10, y: 20, what: 'card' }, to: { x: 110, y: 70, what: 'list' } }
  return { [op === 'click' ? 'clicked' : op === 'type' ? 'typed' : op === 'press' ? 'pressed' : op === 'hover' ? 'hovered' : 'scrolled']: 'by the page' }
}

/** Every step that can take the debugger's input, with the arguments it needs; one per INPUT_OPS. */
const STEPS: Record<string, Record<string, unknown>> = {
  click: { ref: 'e5' },
  hover: { ref: 'e5' },
  type: { ref: 'e2', text: 'ab' },
  press: { key: 'Tab' },
  scroll: { direction: 'down' },
  drag: { ref: 'e3', to_ref: 'e9' },
}

beforeEach(() => {
  fake.session = { agentWindow: 3, agentTabs: { 7: { owner: 'task:A' } } }
  fake.log = []
  fake.pageLog = []
  fake.page = answers
  fake.hidden = false
  fake.seen = 1
  fake.windowCalls = []
  dialogs._resetDialogsForTesting()
  dropDebugger(7)
  _setLingerMsForTesting(0)
})

describe('the class is closed: every debugger step is classified, every input case checks delivery', () => {
  it('TRUSTED_OPS and DEBUGGER_OPS are each input (checked) or no input (with why), never both', () => {
    for (const op of [...trusted.TRUSTED_OPS, ...trusted.DEBUGGER_OPS]) {
      const input = trusted.INPUT_OPS.has(op)
      const none = op in trusted.NO_INPUT_OPS
      expect(input !== none, `${op}: in INPUT_OPS or NO_INPUT_OPS, exactly one`).toBe(true)
    }
    // Every input step has its scenario below, so a new one cannot skip the guard.
    expect(Object.keys(STEPS).sort()).toEqual([...trusted.INPUT_OPS].sort())
  })

  it('each case of trustedAct that sends input arms the probe and checks after it (read from the source)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'packages/browser-extension/src/agent-trusted.ts'), 'utf8')
    const body = src.slice(src.indexOf('switch (c.action) {'))
    const cases = body.split(/\n {6}case '/).slice(1).map((chunk) => ({ name: chunk.slice(0, chunk.indexOf("'")), code: chunk }))
    const sending = cases.filter((x) => /cdp(Click|Hover|Press|Type|Wheel|Drag)\(/.test(x.code))
    expect(sending.map((x) => x.name).sort()).toEqual(['click', 'hover', 'press', 'scroll', 'type'])
    for (const x of sending) {
      expect(trusted.INPUT_OPS.has(x.name), `${x.name} sends input: it must be in INPUT_OPS`).toBe(true)
      expect(x.code, `${x.name} must arm the probe`).toContain('probing(')
      expect(x.code, `${x.name} must check delivery`).toMatch(/await check\(/)
    }
    const drag = fs.readFileSync(path.join(process.cwd(), 'packages/browser-extension/src/agent-drag.ts'), 'utf8')
    expect(drag).toContain('delivery?.check()')
    expect(drag).toContain('probe: delivery.probe')
  })

  it('a step judged again once the debugger attached arms its probe on that last look, right before the input', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'packages/browser-extension/src/agent-trusted.ts'), 'utf8')
    const body = src.slice(src.indexOf('switch (c.action) {'))
    for (const name of ['click', 'press', 'type']) {
      const code = body.split(/\n {6}case '/).find((chunk) => chunk.startsWith(`${name}'`))!
      const agains = code.split('\n').filter((l) => /\bagain\(/.test(l))
      expect(agains.length, `${name} judges again`).toBeGreaterThan(0)
      expect(agains.every((l) => /probing\(|typeProbe/.test(l)), `${name}: the probe rides the recheck`).toBe(true)
    }
  })

  it('every file of the extension that sends the debugger\'s input is one whose steps check delivery (read from the source)', () => {
    const dir = path.join(process.cwd(), 'packages/browser-extension/src')
    // cdp.ts defines the senders; the steps that call them check their delivery.
    const KNOWN: Record<string, string> = {
      'cdp.ts': 'defines cdpClick, cdpType and the rest; sends nothing by itself',
      'agent-trusted.ts': 'every case that sends input checks it (the test above)',
      'agent-drag.ts': 'checks with delivery.check(); its one direct dispatch releases a pressed button after a failure',
    }
    const SENDS = /'Input\.(dispatch\w+|insertText)'|\bcdp(Click|Hover|Press|Type|Wheel|Drag)\(/
    const found = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && SENDS.test(fs.readFileSync(path.join(dir, f), 'utf8'))).sort()
    expect(found, 'a new file sends real input: check its delivery and list it here').toEqual(Object.keys(KNOWN).sort())
  })
})

describe('a hidden page (the agent window covered or minimized)', () => {
  it.each(['click', 'type', 'press', 'hover'])('default %s: the page\'s events do it at once, the answer says trusted false and why, no debugger input', async (op) => {
    fake.hidden = true
    const r = await act(op, STEPS[op])
    expect(r).toMatchObject({ trusted: false, why: HIDDEN_WHY })
    expect(pageOps(op)).toHaveLength(1)
    expect(input()).toEqual([])
    expect(fake.log.map((l) => l[0])).not.toContain('attach')
  })

  it.each(Object.keys(STEPS))('%s asked for real input by name: window_hidden with the fix, nothing sent', async (op) => {
    fake.hidden = true
    const r = await settle(act(op, { ...STEPS[op], trusted: true }))
    expect('err' in r && r.err.code).toBe('window_hidden')
    const msg = 'err' in r ? String(r.err.message) : ''
    expect(msg).toContain('covered or minimized')
    expect(msg).toMatch(op === 'drag' ? /show the window/ : /Drop --trusted .*page events/)
    expect(input()).toEqual([])
    expect(pageOps(op)).toEqual([])
  })

  it('no window is raised, focused or shown to make it visible', async () => {
    fake.hidden = true
    for (const op of Object.keys(STEPS)) await settle(act(op, STEPS[op]))
    expect(fake.windowCalls).toEqual([])
  })
})

describe('a page that dropped the debugger\'s input (it armed the probe and saw none of it)', () => {
  it.each(['click', 'type', 'press', 'hover'])('default %s: sent, seen as dropped, then the page\'s events do it; trusted false and why', async (op) => {
    fake.seen = 0
    const r = await act(op, STEPS[op])
    expect(input().length).toBeGreaterThan(0)
    expect(r).toMatchObject({ trusted: false, why: DROPPED_WHY })
    expect(pageOps(op)).toHaveLength(1)
    // The probe was armed by the last look before the debugger acted, and read after.
    expect(pageOps('locate').some((p) => typeof p.args.probe === 'string' && p.args.probe_kind === op)).toBe(true)
    expect(pageOps('probe_read').length).toBeGreaterThan(0)
  })

  it('a default click on a link that would buy waits for the person on the page path too (the page judges it again before acting)', async () => {
    fake.seen = 0
    const hold = { kind: 'buy', why: 'buys', what: 'click button "Pay"', url: PAGE_URL, sig: 's' }
    fake.page = (op, a) => (op === 'locate' ? point : op === 'click' ? { hold } : answers(op, a, 0))
    const r = await settle(act('click', { ref: 'e5' }))
    expect('err' in r && r.err.code).toBe('outward_needs_ok')
  })

  it.each(Object.keys(STEPS))('%s asked for real input by name: input_dropped with the fix, never a success', async (op) => {
    fake.seen = 0
    const r = await settle(act(op, { ...STEPS[op], trusted: true }))
    expect('err' in r && r.err.code).toBe('input_dropped')
    expect('err' in r ? String(r.err.message) : '').toMatch(/did not receive the real input/)
    expect(pageOps(op)).toEqual([])
  })
})

describe('a drawn page that received the input stays real input', () => {
  it.each(Object.keys(STEPS))('%s: trusted true, the page\'s own step never runs', async (op) => {
    const r = await act(op, { ...STEPS[op], ...(op === 'scroll' || op === 'drag' ? { trusted: true } : {}) })
    expect(r.trusted).toBe(true)
    expect(r.why).toBeUndefined()
    expect(pageOps(op)).toEqual([])
  })

  it('a step that loaded another page (the probe is not in that document) counts as received', async () => {
    fake.seen = 0
    const real = (globalThis as any).chrome.tabs.sendMessage
    ;(globalThis as any).chrome.tabs.sendMessage = async (t: number, msg: { type: string; op?: string }, o?: { frameId?: number }) =>
      (msg.type === 'agent' && msg.op === 'probe_read' ? { ok: true, result: { armed: false, seen: 0 } } : real(t, msg, o))
    try {
      expect(await act('click', { ref: 'e5' })).toMatchObject({ trusted: true })
      expect(pageOps('click')).toEqual([])
    } finally { (globalThis as any).chrome.tabs.sendMessage = real }
  })
})

describe('the page side: only the step\'s own trusted events count', () => {
  it('a step counts only trusted events of its kind; a hover only near its point; a key step whose focus went into a frame proves nothing', async () => {
    const listeners = new Map<string, Array<(e: unknown) => void>>()
    const g = globalThis as any
    const was = { add: g.addEventListener, remove: g.removeEventListener, document: g.document }
    g.addEventListener = (t: string, fn: (e: unknown) => void) => { listeners.set(t, [...(listeners.get(t) ?? []), fn]) }
    g.removeEventListener = (t: string, fn: (e: unknown) => void) => { listeners.set(t, (listeners.get(t) ?? []).filter((f) => f !== fn)) }
    try {
      const { armProbe, readProbe } = await import('../../../packages/browser-extension/src/page-probe')
      const fire = (t: string, e: Record<string, unknown>) => (listeners.get(t) ?? []).forEach((fn) => fn(e))
      armProbe('probeaaa111', 'click', 30, 40)
      fire('mousedown', { isTrusted: false, clientX: 30, clientY: 40 })
      fire('keydown', { isTrusted: true })
      expect(readProbe('probeaaa111', false)).toEqual({ armed: true, seen: 0 })
      // A press of the button counts wherever it lands (a page zoom may move the point a little).
      fire('pointerdown', { isTrusted: true, clientX: 300, clientY: 400 })
      expect(readProbe('probeaaa111', true)).toEqual({ armed: true, seen: 1 })
      // Read and done: disarmed, its listeners gone.
      expect(readProbe('probeaaa111', false)).toEqual({ armed: false, seen: 0 })
      expect([...listeners.values()].flat()).toEqual([])
      // A hover counts only moves near its point: the person's mouse elsewhere is not it.
      armProbe('probeccc333', 'hover', 30, 40)
      fire('mousemove', { isTrusted: true, clientX: 300, clientY: 400 })
      expect(readProbe('probeccc333', false)).toEqual({ armed: true, seen: 0 })
      fire('mousemove', { isTrusted: true, clientX: 31, clientY: 41 })
      expect(readProbe('probeccc333', true)).toEqual({ armed: true, seen: 1 })
      // A key step has no point: any trusted key event of the page counts.
      armProbe('probebbb222', 'type')
      fire('keydown', { isTrusted: true })
      expect(readProbe('probebbb222', true)).toEqual({ armed: true, seen: 1 })
      // Keys that went to an editor's own frame: the top page cannot tell, so not "dropped".
      g.document = { activeElement: { tagName: 'IFRAME' } }
      armProbe('probeddd444', 'press')
      expect(readProbe('probeddd444', true)).toEqual({ armed: false, seen: 0 })
      g.document = { activeElement: { tagName: 'INPUT' } }
      armProbe('probeeee555', 'press')
      expect(readProbe('probeeee555', true)).toEqual({ armed: true, seen: 0 })
      // A probe this document never armed proves nothing.
      expect(readProbe('nosuchprobe1', true)).toEqual({ armed: false, seen: 0 })
    } finally { g.addEventListener = was.add; g.removeEventListener = was.remove; g.document = was.document }
  })
})
