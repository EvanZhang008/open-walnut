/**
 * The input agents got from the old relay, end to end in the extension's own command code
 * (packages/browser-extension/src/agent.ts, agent-trusted.ts, agent-drag.ts, agent-dialog.ts,
 * agent-page.ts) against a fake browser: the page's answers and the debugger's commands and events
 * are faked, everything between them is the real code.
 *   - drag: real input only, top frame only, pointer moves or the browser's own drag and drop;
 *   - a trusted scroll is the wheel at the element; a trusted type at a point clicks it first, and
 *     slowly types a key at a time;
 *   - a click by its words finds the best match across frames; text all_frames gives each frame;
 *   - a page dialog a trusted step opened is read and answered, the debugger held until then, and
 *     nothing else reaches the page meanwhile; the step stops where the dialog cut it (no more
 *     keys, a drag's button let go); a dialog whose hold ran out is the person's to answer;
 *   - a drag, and OK on a confirm that deletes, wait for the person's yes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Listener = (source: { tabId?: number }, method: string, params?: Record<string, unknown>) => void
type PageAnswer = (op: string, args: Record<string, unknown>, frameId: number) => unknown
const fake = {
  session: {} as Record<string, unknown>,
  events: [] as Listener[],
  log: [] as Array<[string, Record<string, unknown> | undefined]>,
  pageLog: [] as Array<{ op: string; args: Record<string, unknown>; frameId: number }>,
  page: (() => ({})) as PageAnswer,
  onSend: (() => undefined) as (method: string, params?: Record<string, unknown>) => unknown,
  frames: [] as Array<{ frameId: number; href: string }>,
  trusted: true,
  /** Whether the page's script answers (a dialog holds it when not). */
  checkAnswers: true,
  /** The page's ops, the cursor's messages and the debugger's commands, in the order they went out. */
  order: [] as string[],
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
      if (msg.type === 'agent-check') return fake.checkAnswers ? { ok: true, walnut: false, href: PAGE_URL, doc: 'doc-1' } : undefined
      if (msg.type === 'agent-cursor') fake.order.push(`cursor ${JSON.stringify(msg)}`)
      if (msg.type !== 'agent') return { ok: true }
      const frameId = opts?.frameId ?? 0
      fake.order.push(`page ${msg.op} ${JSON.stringify(msg.args ?? {})}`)
      fake.pageLog.push({ op: msg.op!, args: msg.args ?? {}, frameId })
      try {
        return { ok: true, result: await fake.page(msg.op!, msg.args ?? {}, frameId) }
      } catch (err) {
        return { ok: false, error: { message: (err as Error).message, code: (err as { code?: string }).code ?? 'page_error' } }
      }
    },
  },
  scripting: {
    executeScript: async () => [
      { frameId: 0, result: { href: PAGE_URL, w: 1200, h: 800, kids: fake.frames.length } },
      ...fake.frames.map((f) => ({ frameId: f.frameId, result: { href: f.href, w: 300, h: 200, kids: 0 } })),
    ],
  },
  windows: { get: async () => ({ state: 'normal', focused: false }), onRemoved: ev() },
  permissions: { contains: async (p: { permissions?: string[] }) => (p.permissions?.includes('debugger') ? fake.trusted : true), onRemoved: ev() },
  debugger: {
    attach: async () => { fake.log.push(['attach', undefined]) },
    detach: async () => { fake.log.push(['detach', undefined]) },
    sendCommand: async (_t: unknown, method: string, params?: Record<string, unknown>) => {
      fake.log.push([method, params])
      fake.order.push(`${method} ${String(params?.type ?? '')}`)
      return (await fake.onSend(method, params)) ?? {}
    },
    onEvent: { addListener: (fn: Listener) => fake.events.push(fn), removeListener() {} },
    onDetach: ev(),
  },
  downloads: { onCreated: ev(), onChanged: ev(), onDeterminingFilename: ev(), search: async () => [] },
}
;(globalThis as any).fetch = async () => { throw new Error('no network in this test') }

const agent = await import('../../../packages/browser-extension/src/agent')
const { walnutCheck } = await import('../../../packages/browser-extension/src/agent-shared')
const { debuggerHeld, dropDebugger, holdDebugger } = await import('../../../packages/browser-extension/src/cdp')
const dialogs = await import('../../../packages/browser-extension/src/agent-dialog')
walnutCheck.isWalnutPage = async () => false

const act = (action: string, args: Record<string, unknown> = {}) => agent._actForTesting({ id: 'c', action, args: { tab: 7, ...args }, allow: { any: true, sites: [] } }) as Promise<Record<string, any>>
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code)
const emit = (method: string, params: Record<string, unknown>) => fake.events.forEach((fn) => fn({ tabId: 7 }, method, params))
const methods = () => fake.log.map((l) => l[0])
const mouse = () => fake.log.filter((l) => l[0] === 'Input.dispatchMouseEvent').map((l) => l[1]!)
const pageOps = (op: string) => fake.pageLog.filter((p) => p.op === op)

beforeEach(() => {
  fake.session = { agentWindow: 3, agentTabs: { 7: { owner: 'task:A' } } }
  fake.log = []
  fake.pageLog = []
  fake.page = () => ({})
  fake.onSend = () => undefined
  fake.frames = []
  fake.trusted = true
  fake.checkAnswers = true
  fake.order = []
  dialogs._resetDialogsForTesting()
  dropDebugger(7)
})

describe('drag', () => {
  const ends = () => ({ from: { x: 10, y: 20, what: 'item "Card A"' }, to: { x: 110, y: 70, what: 'list "Done"' } })

  it('from a ref to a ref: the page finds both ends, the debugger presses, moves and releases, then lets go', async () => {
    fake.page = (op) => (op === 'drag_points' ? ends() : {})
    const r = await act('drag', { ref: 'e3', to_ref: 'e9', steps: 3 })
    expect(r).toMatchObject({ dragged: 'item "Card A" to list "Done"', from: { x: 10, y: 20 }, to: { x: 110, y: 70 }, trusted: true, tab: 7 })
    expect(r.native).toBeUndefined()
    expect(pageOps('drag_points')[0].args).toMatchObject({ ref: 'e3', to_ref: 'e9' })
    const m = mouse()
    expect(m[0]).toEqual({ type: 'mouseMoved', x: 10, y: 20 })
    expect(m[1]).toMatchObject({ type: 'mousePressed', x: 10, y: 20, buttons: 1 })
    expect(m.slice(2, 5).every((x) => x.type === 'mouseMoved' && x.buttons === 1)).toBe(true)
    expect(m.at(-1)).toMatchObject({ type: 'mouseReleased', x: 110, y: 70, buttons: 0 })
    expect(methods()[0]).toBe('attach')
    expect(methods().at(-1)).toBe('detach')
    expect(debuggerHeld(7)).toBe(false)
  })

  it('from a point to a point', async () => {
    fake.page = (op) => (op === 'drag_points' ? ends() : {})
    await act('drag', { x: 10, y: 20, to_x: 110, to_y: 70 })
    expect(pageOps('drag_points')[0].args).toMatchObject({ x: 10, y: 20, to_x: 110, to_y: 70 })
  })

  it('a page with the browser\'s own drag and drop gets its drag data dropped on the end', async () => {
    fake.page = (op) => (op === 'drag_points' ? ends() : {})
    const data = { items: [{ mimeType: 'text/plain', data: 'card-a' }], dragOperationsMask: 1 }
    let sent = false
    fake.onSend = (method, p) => {
      if (!sent && method === 'Input.dispatchMouseEvent' && p?.type === 'mouseMoved' && p.buttons === 1) { sent = true; emit('Input.dragIntercepted', { data }) }
      return undefined
    }
    const r = await act('drag', { ref: 'e3', to_ref: 'e9' })
    expect(r.native).toBe(true)
    expect(fake.log.filter((l) => l[0] === 'Input.dispatchDragEvent').map((l) => l[1]!.type)).toEqual(['dragEnter', 'dragOver', 'drop'])
    expect(fake.log.filter((l) => l[0] === 'Input.setInterceptDrags').map((l) => l[1]!.enabled)).toEqual([true, false])
  })

  it('is real input: refused with the switch off, in a frame, or without both ends', async () => {
    fake.page = (op) => (op === 'drag_points' ? ends() : {})
    fake.trusted = false
    expect(await code(act('drag', { ref: 'e3', to_ref: 'e9' }))).toBe('trusted_off')
    fake.trusted = true
    expect(await code(act('drag', { ref: 'e3', to_ref: 'f2:e9' }))).toBe('trusted_frame')
    expect(await code(act('drag', { ref: 'f2:e3', to_ref: 'e9' }))).toBe('trusted_frame')
    expect(await code(act('drag', { ref: 'e3' }))).toBe('bad_request')
    expect(methods().filter((m) => m === 'attach')).toEqual([])
  })

  it('a drag whose ends are not on screen together is the page\'s refusal, and nothing is pressed', async () => {
    fake.page = (op) => { if (op === 'drag_points') throw Object.assign(new Error('Both ends of the drag must be on screen together'), { code: 'drag_offscreen' }); return {} }
    expect(await code(act('drag', { ref: 'e3', to_ref: 'e99' }))).toBe('drag_offscreen')
    expect(mouse()).toEqual([])
  })
})

describe('scroll inside a box, and typing', () => {
  it('a trusted scroll is the wheel at the element', async () => {
    fake.page = (op) => (op === 'locate' ? { x: 50, y: 60, what: 'list "Results"' } : {})
    const r = await act('scroll', { trusted: true, ref: 'e4', direction: 'down', by: 300 })
    expect(r).toMatchObject({ scrolled: 'down 300 px over list "Results"', trusted: true })
    expect(pageOps('locate')[0].args).toMatchObject({ ref: 'e4' })
    expect(pageOps('locate')[0].args.middle).toBeUndefined()
    expect(mouse()).toEqual([{ type: 'mouseMoved', x: 50, y: 60 }, { type: 'mouseWheel', x: 50, y: 60, deltaX: 0, deltaY: 300 }])
    expect(methods().at(-1)).toBe('detach')
  })

  it('a trusted scroll with no element turns the wheel in the middle of the page', async () => {
    fake.page = (op) => (op === 'locate' ? { x: 600, y: 400, what: 'generic "main"' } : {})
    await act('scroll', { trusted: true, direction: 'up' })
    expect(pageOps('locate')[0].args).toMatchObject({ middle: true })
  })

  it('a scroll without trusted goes to the page with its ref and direction (the page scrolls that box)', async () => {
    fake.page = (op) => (op === 'scroll' ? { scrolled: 'down 1 screen(s); at 400 of 2000', box: 'list "Results" (ul)' } : {})
    const r = await act('scroll', { ref: 'e4', direction: 'down' })
    expect(r.box).toBe('list "Results" (ul)')
    expect(pageOps('scroll')[0].args).toMatchObject({ ref: 'e4', direction: 'down' })
    expect(methods()).toEqual([])
  })

  it('a trusted type at a point: the click there is judged with any Enter as one step, then a click and the keys, one at a time with slowly', async () => {
    fake.page = (op) => (op === 'locate' ? { x: 30, y: 40, what: 'textbox "Name"' } : {})
    const r = await act('type', { trusted: true, x: 30, y: 40, text: 'ab', slowly: true })
    expect(r.typed).toBe('2 characters into textbox "Name", one key at a time')
    const located = pageOps('locate').map((p) => p.args)
    expect(located).toHaveLength(1)
    expect(located[0]).toMatchObject({ x: 30, y: 40, outward: 'click', focus: true })
    expect(located[0].then_enter).toBeUndefined()
    expect(mouse().map((m) => m.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
    const keys = fake.log.filter((l) => l[0] === 'Input.dispatchKeyEvent').map((l) => `${l[1]!.type} ${l[1]!.key}`)
    expect(keys).toEqual(['keyDown a', 'keyUp a', 'keyDown b', 'keyUp b'])
    expect(methods()).toContain('Page.enable')
    // With a submit, the same one ask names the Enter too.
    fake.pageLog = []
    fake.log = []
    await act('type', { trusted: true, x: 30, y: 40, text: 'ab', submit: true })
    expect(pageOps('locate').map((p) => p.args)).toEqual([expect.objectContaining({ outward: 'click', then_enter: true, typing: 'ab' })])
    expect(mouse().map((m) => m.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
  })

  it('slowly types at most 200 characters', async () => {
    fake.page = (op) => (op === 'locate' ? { x: 1, y: 1, what: 'textbox' } : {})
    expect(await code(act('type', { trusted: true, ref: 'e2', text: 'x'.repeat(201), slowly: true }))).toBe('too_long')
    expect(methods().filter((m) => m === 'attach')).toEqual([])
  })

  it('a trusted click on a label from an annotated screenshot names the label to the page', async () => {
    fake.page = (op) => (op === 'locate' ? { x: 5, y: 5, what: 'button "Next"' } : {})
    await act('click', { trusted: true, label: 4 })
    expect(pageOps('locate')[0].args).toMatchObject({ label: 4 })
  })
})

describe('across frames', () => {
  const PAY = 'https://pay.example.test/widget'

  it('click by its words: the best match, here a button inside a frame, is clicked in that frame', async () => {
    fake.frames = [{ frameId: 3, href: PAY }]
    fake.page = (op, _args, frameId) => {
      if (op === 'find') return frameId === 0
        ? { matches: [{ ref: 'e5', role: 'generic', name: 'Pay later options', text: 'Pay later options' }], count: 1 }
        : { matches: [{ ref: 'f3:e2', role: 'button', name: 'Pay later', text: 'Pay later' }], count: 1 }
      if (op === 'click') return { clicked: 'button "Pay later"' }
      return {}
    }
    const r = await act('click', { text: 'Pay later' })
    expect(r).toMatchObject({ clicked: 'button "Pay later"', matched: { ref: 'f3:e2', frame: 'f3', of: 2 } })
    const click = pageOps('click')[0]
    expect(click.frameId).toBe(3)
    expect(click.args).toMatchObject({ ref: 'f3:e2', frame: 'f3' })
    expect(click.args.text).toBeUndefined()
  })

  it('words nothing on the page holds are not_found, and nothing is clicked', async () => {
    fake.page = (op) => (op === 'find' ? { matches: [], count: 0 } : {})
    expect(await code(act('click', { text: 'Nowhere' }))).toBe('not_found')
    expect(pageOps('click')).toEqual([])
  })

  it('a trusted click by words found inside a frame is refused (real input is top frame only)', async () => {
    fake.frames = [{ frameId: 3, href: PAY }]
    fake.page = (op, _a, frameId) => (op === 'find' ? (frameId === 0 ? { matches: [], count: 0 } : { matches: [{ ref: 'f3:e2', role: 'button', name: 'Pay later' }], count: 1 }) : {})
    expect(await code(act('click', { trusted: true, text: 'Pay later' }))).toBe('trusted_frame')
  })

  it('text with all_frames: each frame\'s text on its own, and more of each', async () => {
    fake.frames = [{ frameId: 3, href: PAY }]
    fake.page = (op, _a, frameId) => (op === 'text' ? (frameId === 0 ? { text: 'Checkout', url: PAGE_URL, title: 'Checkout' } : { text: 'Card number', url: PAY, title: 'Pay' }) : {})
    const r = await act('text', { all_frames: true })
    expect(r.frames).toEqual([{ frame: 'top', url: PAGE_URL, text: 'Checkout' }, { frame: 'f3', url: PAY, title: 'Pay', text: 'Card number' }])
    // The text is in frames only, not twice.
    expect(r.text).toBeUndefined()
    expect(pageOps('text').find((p) => p.frameId === 3)!.args.max).toBe(20_000)
    // Without it: the text as before, frames under their heading, 5000 characters each.
    fake.pageLog = []
    const plain = await act('text')
    expect(plain.frames).toBeUndefined()
    expect(pageOps('text').find((p) => p.frameId === 3)!.args.max).toBe(5000)
  })
})

describe('page dialogs', () => {
  const opensPrompt = () => {
    fake.page = (op) => (op === 'locate' ? { x: 20, y: 30, what: 'button "Rename"' } : {})
    fake.onSend = (method, p) => {
      if (method === 'Input.dispatchMouseEvent' && p?.type === 'mouseReleased') {
        emit('Page.javascriptDialogOpening', { type: 'prompt', message: 'New name?', defaultPrompt: 'Untitled', url: PAGE_URL })
        // The page holds the click until the dialog is answered.
        return new Promise(() => {})
      }
      return undefined
    }
  }

  it('a trusted click that opens a prompt answers with it; the debugger stays until the prompt is answered with text', async () => {
    opensPrompt()
    const r = await act('click', { trusted: true, ref: 'e8' })
    expect(r.dialog).toMatchObject({ type: 'prompt', message: 'New name?', default_prompt: 'Untitled' })
    expect(methods()).toContain('Page.enable')
    expect(methods()).not.toContain('detach')
    expect(debuggerHeld(7)).toBe(true)

    expect(await act('dialog', { read: true })).toMatchObject({ open: true, dialog: { type: 'prompt', message: 'New name?' } })
    // Nothing else reaches the page meanwhile: it would only wait for the page.
    expect(await code(act('snapshot'))).toBe('dialog_open')
    expect(await code(act('click', { trusted: true, ref: 'e8' }))).toBe('dialog_open')

    fake.onSend = () => undefined
    const a = await act('dialog', { accept: true, text: 'Q3 report' })
    expect(a).toMatchObject({ dialog: 'accepted', answered: { type: 'prompt', message: 'New name?', with: 'Q3 report' } })
    expect(fake.log.find((l) => l[0] === 'Page.handleJavaScriptDialog')?.[1]).toEqual({ accept: true, promptText: 'Q3 report' })
    expect(methods().filter((m) => m === 'attach')).toHaveLength(1)
    expect(methods().at(-1)).toBe('detach')
    expect(debuggerHeld(7)).toBe(false)
    expect(await act('dialog', { read: true })).toMatchObject({ open: false })
  })

  it('a trusted click that opens no dialog lets the debugger go as before', async () => {
    fake.page = (op) => (op === 'locate' ? { x: 1, y: 2, what: 'button "Go"' } : {})
    const r = await act('click', { trusted: true, ref: 'e1' })
    expect(r.dialog).toBeUndefined()
    expect(methods()).toEqual(['attach', 'Page.enable', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'detach'])
    expect(debuggerHeld(7)).toBe(false)
  })

  it('text goes only to a prompt', async () => {
    dialogs.foldDialogEvent(7, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Delete it?' })
    expect(await code(act('dialog', { accept: true, text: 'yes' }))).toBe('bad_request')
    expect(methods()).toEqual([])
  })

  it('a dialog Walnut never saw open: reading says so, and an answer explains what to do', async () => {
    const r = await act('dialog', { read: true })
    expect(r.open).toBe(false)
    expect(r.note).toMatch(/debugger was on the tab as the dialog opened/)
    fake.onSend = (method) => { if (method === 'Page.handleJavaScriptDialog') throw new Error('No dialog is showing'); return undefined }
    const err = await act('dialog', { accept: true }).catch((e) => e)
    expect(err.code).toBe('no_dialog')
    expect(err.message).toMatch(/with trusted/)
    expect(methods().at(-1)).toBe('detach')
  })

  it('in a tab that records (its debugger held, Page on), a page action that opens a dialog answers with it', async () => {
    dialogs.watchDialogs()
    holdDebugger(7, async () => ({}))
    fake.page = (op) => {
      if (op === 'click') { setTimeout(() => emit('Page.javascriptDialogOpening', { type: 'alert', message: 'Saved' }), 20); return new Promise(() => {}) }
      return {}
    }
    const r = await act('click', { ref: 'e2' })
    expect(r.dialog).toMatchObject({ type: 'alert', message: 'Saved' })
    // The page side stops what it was doing (slow typing types no more keys) once the dialog is answered.
    expect(pageOps('cancel_input')).toHaveLength(1)
    expect(await code(act('text'))).toBe('dialog_open')
  })
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('a step a dialog cut short stops there', () => {
  it('trusted slow typing: no key after the dialog opened, even once the page goes on', async () => {
    fake.page = (op) => (op === 'locate' ? { x: 1, y: 1, what: 'textbox "Code"' } : {})
    let release = () => {}
    let opened = false
    fake.onSend = (method, p) => {
      if (method === 'Input.dispatchKeyEvent' && p?.type === 'keyDown' && !opened) {
        opened = true
        emit('Page.javascriptDialogOpening', { type: 'alert', message: 'Code sent' })
        return new Promise((r) => { release = () => r(undefined) })
      }
      return undefined
    }
    const r = await act('type', { trusted: true, ref: 'e2', text: 'abc', slowly: true })
    expect(r.dialog).toMatchObject({ type: 'alert', message: 'Code sent' })
    release()
    await sleep(200)
    expect(fake.log.filter((l) => l[0] === 'Input.dispatchKeyEvent')).toHaveLength(1)
  })

  it('a drag: the button goes up where the pointer is, the browser\'s drags are its own again, and it moves no more', async () => {
    fake.page = (op) => (op === 'drag_points' ? { from: { x: 10, y: 20, what: 'a' }, to: { x: 110, y: 70, what: 'b' } } : {})
    let release = () => {}
    let opened = false
    fake.onSend = (method, p) => {
      if (method === 'Input.dispatchMouseEvent' && p?.type === 'mouseMoved' && p.buttons === 1 && !opened) {
        opened = true
        emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'Move it?' })
        return new Promise((r) => { release = () => r(undefined) })
      }
      return undefined
    }
    const r = await act('drag', { ref: 'e3', to_ref: 'e9', steps: 3 })
    expect(r.dialog).toMatchObject({ type: 'confirm' })
    const up = mouse().filter((m) => m.type === 'mouseReleased')
    expect(up).toHaveLength(1)
    expect(up[0].x).toBeCloseTo(10 + 100 / 3)
    expect(up[0].y).toBeCloseTo(20 + 50 / 3)
    expect(fake.log.filter((l) => l[0] === 'Input.setInterceptDrags').map((l) => l[1]!.enabled)).toEqual([true, false])
    release()
    await sleep(200)
    expect(mouse().filter((m) => m.type === 'mouseMoved' && m.buttons === 1)).toHaveLength(1)
    expect(mouse().filter((m) => m.type === 'mouseReleased')).toHaveLength(1)
  })
})

describe('a dialog left unanswered is the person\'s', () => {
  const opensPrompt = () => {
    fake.page = (op) => (op === 'locate' ? { x: 20, y: 30, what: 'button "Rename"' } : {})
    fake.onSend = (method, p) => {
      if (method === 'Input.dispatchMouseEvent' && p?.type === 'mouseReleased') {
        emit('Page.javascriptDialogOpening', { type: 'prompt', message: 'New name?', url: PAGE_URL })
        return new Promise(() => {})
      }
      return undefined
    }
  }

  it('each look at it starts the hold again; once it runs out the debugger lets go, and only the person can answer', async () => {
    dialogs._setHoldMsForTesting(1000)
    opensPrompt()
    expect((await act('click', { trusted: true, ref: 'e8' })).dialog).toBeDefined()
    await sleep(600)
    expect((await act('dialog', { read: true })).open).toBe(true)
    await sleep(600)
    // 1200 ms after it opened, 600 after the look: still held, the look started the hold again.
    expect(debuggerHeld(7)).toBe(true)
    await vi.waitFor(() => expect(debuggerHeld(7)).toBe(false), { timeout: 5000 })
    expect(methods().at(-1)).toBe('detach')
    expect(dialogs.orphanOf(7)).toMatchObject({ type: 'prompt', message: 'New name?' })

    // The page still does not answer: everything that needs it is refused at once, saying who can answer.
    fake.checkAnswers = false
    const err = await act('snapshot').catch((e) => e)
    expect(err.code).toBe('dialog_open')
    expect(err.extra).toMatchObject({ only_person: true })
    expect(err.message).toMatch(/only the person can answer/)
    expect(await act('dialog', { read: true })).toMatchObject({ open: true, only_person: true })
    expect(await code(act('dialog', { accept: true, text: 'x' }))).toBe('dialog_person')
    expect(fake.log.find((l) => l[0] === 'Page.handleJavaScriptDialog')).toBeUndefined()

    // The person answered it: the page answers again, and the mark is gone.
    fake.checkAnswers = true
    fake.page = (op) => (op === 'text' ? { text: 'Renamed', url: PAGE_URL } : {})
    expect(await code(act('text'))).toBe('ok')
    expect(dialogs.orphanOf(7)).toBeUndefined()
  })
})

describe('steps that delete wait for the person', () => {
  it('a drag the page holds presses nothing; the yes for it is passed on to the page', async () => {
    const hold = { kind: 'delete', why: '"Delete" deletes something', what: 'click button "Delete"', url: PAGE_URL, sig: 'delete|click button "Delete"|x||' }
    fake.page = (op, args) => (op === 'drag_points' ? (args.outward_ok === hold.sig ? { from: { x: 10, y: 20, what: 'a' }, to: { x: 110, y: 70, what: 'b' } } : { hold }) : {})
    const err = await act('drag', { ref: 'e3', to_ref: 'e9' }).catch((e) => e)
    expect(err.code).toBe('outward_needs_ok')
    expect(err.extra.hold).toMatchObject({ kind: 'delete' })
    expect(mouse()).toEqual([])
    expect(methods().filter((m) => m === 'attach')).toEqual([])
    const r = await act('drag', { ref: 'e3', to_ref: 'e9', outward_ok: hold.sig })
    expect(r.dragged).toBe('a to b')
    expect(pageOps('drag_points').at(-1)!.args.outward_ok).toBe(hold.sig)
  })

  it('OK on a confirm that deletes waits; Cancel, an alert, or a confirm that does nothing do not', async () => {
    dialogs.foldDialogEvent(7, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Delete this project? This cannot be undone.' })
    const err = await act('dialog', { accept: true }).catch((e) => e)
    expect(err.code).toBe('outward_needs_ok')
    expect(err.extra.hold).toMatchObject({ kind: 'delete', what: 'accept the confirm "Delete this project? This cannot be undone."', url: PAGE_URL })
    expect(fake.log.find((l) => l[0] === 'Page.handleJavaScriptDialog')).toBeUndefined()
    // The yes for exactly that answer lets it go.
    const ok = await act('dialog', { accept: true, outward_ok: err.extra.hold.sig })
    expect(ok.dialog).toBe('accepted')
    expect(fake.log.find((l) => l[0] === 'Page.handleJavaScriptDialog')?.[1]).toEqual({ accept: true })

    dialogs.foldDialogEvent(7, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Delete this project?' })
    expect((await act('dialog', { accept: false })).dialog).toBe('dismissed')
    dialogs.foldDialogEvent(7, 'Page.javascriptDialogOpening', { type: 'alert', message: 'Deleted.' })
    expect((await act('dialog', { accept: true })).dialog).toBe('accepted')
    dialogs.foldDialogEvent(7, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Leave this page?' })
    expect((await act('dialog', { accept: true })).dialog).toBe('accepted')
  })
})

describe('annotate and zoom', () => {
  it('work on what is on screen, never with full', async () => {
    expect(await code(act('screenshot', { full: true, annotate: true }))).toBe('bad_request')
    expect(await code(act('zoom', { full: true, x: 0, y: 0, width: 10, height: 10 }))).toBe('bad_request')
  })
})

describe('the agent\'s cursor before real input (page-cursor.ts)', () => {
  /** Where in the order the first of these went out. */
  const first = (re: RegExp) => fake.order.findIndex((o) => re.test(o))

  it.each([
    ['click', { ref: 'e1' }, 'click'],
    ['hover', { ref: 'e1' }, 'move'],
    ['type', { x: 30, y: 40, text: 'ab' }, 'click'],
    ['type', { ref: 'e2', text: 'ab' }, 'move'],
    ['scroll', { ref: 'e4', direction: 'down' }, 'move'],
    ['scroll', { direction: 'down' }, 'move'],
  ])('trusted %s %j: the page draws it (%s) at the point before the debugger acts there', async (action, args, kind) => {
    fake.page = (op) => (op === 'locate' ? { x: 30, y: 40, what: 'button "Go"' } : {})
    await act(action, { trusted: true, ...args })
    expect(pageOps('locate')[0].args.cursor).toBe(kind)
    const input = first(/^Input\.dispatch/)
    expect(input).toBeGreaterThan(-1)
    expect(first(/^page locate .*"cursor"/)).toBeLessThan(input)
  })

  it('a trusted key press or typing into the focus has no point: no cursor asked', async () => {
    fake.page = (op) => (op === 'locate' ? { x: 0, y: 0, what: 'textbox' } : {})
    await act('press', { trusted: true, key: 'a' })
    await act('type', { trusted: true, text: 'ab' })
    expect(pageOps('locate').every((p) => p.args.cursor === undefined)).toBe(true)
  })

  it('a drag: at the start (the page, with its two ends), then along to the end before the button goes down', async () => {
    fake.page = (op) => (op === 'drag_points' ? { from: { x: 10, y: 20, what: 'a' }, to: { x: 110, y: 70, what: 'b' } } : {})
    await act('drag', { ref: 'e3', to_ref: 'e9' })
    const along = first(/^cursor .*"kind":"drag"/)
    expect(fake.order[along]).toContain('"x":110,"y":70')
    expect(along).toBeGreaterThan(first(/^page drag_points/))
    expect(along).toBeLessThan(first(/mousePressed/))
  })
})
