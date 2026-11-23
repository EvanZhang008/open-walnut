/**
 * MicInput (web/src/components/common/BoxMic.tsx) makes its owner's plain submits wait for words
 * still being dictated: an Enter handled in the owner's own onKeyDown, an onBlur that saves, a
 * form's implicit submit, and onEnter. Dozens of rename and add boxes save on blur and close the
 * box; before this, leaving one mid-dictation saved half the words and unmounted the box under its
 * own recording, so the rest was thrown away.
 *
 * Real React and the real MicInput, send gate (useSendAfterDictation) and box writer
 * (useBoxDictation), mounted over linkedom. Only the recorder is a stand-in: MicButton is mocked
 * with a control the test drives (start, the final words, a refine, an error, a discard). The
 * owners below are the patterns the app's boxes use (EditableSessionTitle, KanbanLaneHead,
 * NotesTreePanel: save on Enter in onKeyDown and on blur, then close; OrgEditableName: onEnter
 * plus onBlur; TierSeparatorRow: a form). The browser walk of the same flows is the main task's.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act, useState, useEffect } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'

type Outcome = { error: string | null }
interface MicProps {
  onTranscribe: (t: string) => void
  onDraft?: (t: string) => void
  onRefine?: (final: string, provisional: string) => boolean | void
  onSettled?: () => void
  controlRef?: { current: unknown }
}

/** The stand-in recorder: busy while "recording or transcribing", its waiters answered by the test. */
const rec = vi.hoisted(() => ({
  props: null as MicProps | null,
  busy: false,
  finishes: 0,
  discards: 0,
  waiters: [] as Array<(o: Outcome) => void>,
}))

vi.mock('@/utils/log', () => ({ log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }))
vi.mock('@/components/common/MicButton', async () => {
  const React = await import('../../web/node_modules/react/index.js')
  function MicButton(props: MicProps) {
    rec.props = props
    React.useEffect(() => {
      if (!props.controlRef) return
      props.controlRef.current = {
        busy: () => rec.busy,
        finish: () => {
          rec.finishes += 1
          if (!rec.busy) return Promise.resolve({ error: null })
          return new Promise<Outcome>((resolve) => { rec.waiters.push(resolve) })
        },
        discard: () => {
          rec.discards += 1
          rec.busy = false
          const waiting = rec.waiters.splice(0)
          for (const w of waiting) w({ error: 'discarded' })
        },
      }
      return () => { props.controlRef!.current = null }
    }, [props.controlRef])
    return React.createElement('button', { type: 'button', className: 'mic-btn', 'data-testid': 'mic' })
  }
  return { MicButton }
})

const { MicInput } = await import('../../web/src/components/common/BoxMic')
const { overlayLayerHandlers } = await import('../../web/src/hooks/useOverlayLayer')

let win: Window & typeof globalThis
beforeAll(() => {
  const dom = parseHTML('<!DOCTYPE html><html><body><button id="outside">elsewhere</button></body></html>')
  win = dom.window as unknown as Window & typeof globalThis
  // linkedom has no KeyboardEvent: a plain Event carrying a key event's fields.
  class KeyEvt extends (dom.window as unknown as { Event: typeof Event }).Event {
    key: string; code: string; keyCode: number; isComposing: boolean
    shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean
    constructor(type: string, init: KeyboardEventInit & { keyCode?: number } = {}) {
      super(type, init)
      this.key = init.key ?? ''; this.code = init.code ?? ''; this.keyCode = init.keyCode ?? 0
      this.isComposing = init.isComposing ?? false
      this.shiftKey = !!init.shiftKey; this.altKey = !!init.altKey; this.ctrlKey = !!init.ctrlKey; this.metaKey = !!init.metaKey
    }
  }
  Object.assign(dom.window, { KeyboardEvent: KeyEvt })
  // linkedom's input has no selection API; the box writer places the caret after the final words.
  const inputProto = Object.getPrototypeOf(dom.document.createElement('input')) as Record<string, unknown>
  if (typeof inputProto.setSelectionRange !== 'function') {
    Object.assign(inputProto, {
      setSelectionRange(this: { selectionStart?: number; selectionEnd?: number }, from: number, to: number) { this.selectionStart = from; this.selectionEnd = to },
    })
  }
  Object.assign(dom.document, { hasFocus: () => true })
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.document,
    Element: (dom.window as unknown as { Element: unknown }).Element,
    Node: (dom.window as unknown as { Node: unknown }).Node,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
  })
  // The overlay stack (the send gate's Esc is a layer on it) listens on the window it found at import,
  // and there was none then: put its capture listeners on this one.
  dom.window.addEventListener('keydown', overlayLayerHandlers.keydown as unknown as EventListener, true)
  dom.window.addEventListener('pointerdown', overlayLayerHandlers.pointerdown as unknown as EventListener, true)
})

let root: ReturnType<typeof createRoot> | null = null
let host: HTMLElement | null = null
beforeEach(() => {
  rec.props = null; rec.busy = false; rec.finishes = 0; rec.discards = 0; rec.waiters = []
  ;(document as unknown as { hasFocus: () => boolean }).hasFocus = () => true
})
afterEach(async () => {
  if (root) await act(async () => { root!.unmount() })
  host?.remove()
  root = null; host = null
})

async function mount(node: unknown) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root!.render(node as never) })
}
async function rerender(node: unknown) { await act(async () => { root!.render(node as never) }) }
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 5)) })

const input = () => host!.querySelector('input') as HTMLInputElement | null
const micButton = () => host!.querySelector('[data-testid="mic"]') as HTMLElement
const outside = () => document.getElementById('outside') as HTMLElement

/**
 * A key press in the box. linkedom does not propagate a document's events to its window, so the
 * window's capture phase (where the send gate's Esc listener sits, ahead of every element) is
 * played first: the same press is dispatched to the window, and reaches the box only if no
 * window listener stopped it.
 */
async function key(el: Element, k: string, extra: Record<string, unknown> = {}) {
  const Key = (win as unknown as { KeyboardEvent: new (t: string, i: object) => Event }).KeyboardEvent
  const init = { key: k, bubbles: true, cancelable: true, keyCode: k === 'Enter' ? 13 : 0, ...extra }
  const atWindow = new Key('keydown', init)
  let stopped = false
  const stop = atWindow.stopPropagation.bind(atWindow)
  const stopNow = atWindow.stopImmediatePropagation.bind(atWindow)
  Object.assign(atWindow, { stopPropagation: () => { stopped = true; stop() }, stopImmediatePropagation: () => { stopped = true; stopNow() } })
  const ev = new Key('keydown', init)
  await act(async () => {
    ;(win as unknown as EventTarget).dispatchEvent(atWindow)
    if (!stopped) el.dispatchEvent(ev)
  })
  return stopped ? atWindow : ev
}
function focusEvt(el: Element, type: 'focusout' | 'focusin', relatedTarget: Element | null) {
  const ev = new (win as unknown as { Event: typeof Event }).Event(type, { bubbles: true })
  Object.assign(ev, { relatedTarget })
  return act(async () => { el.dispatchEvent(ev) })
}
const blurTo = (to: Element | null) => focusEvt(input()!, 'focusout', to)
const focusBox = () => focusEvt(input()!, 'focusin', null)
function pointerDown(el: Element) {
  const ev = new (win as unknown as { Event: typeof Event }).Event('pointerdown', { bubbles: true })
  Object.assign(ev, { button: 0 })
  return act(async () => { el.dispatchEvent(ev) })
}

/** Start a recording that has already streamed `draft` into the box as a live preview (onDraft:
 *  the span the final words replace). */
async function record(draft = '') {
  rec.busy = true
  if (draft) await act(async () => { rec.props!.onDraft!(draft) })
}
/** The recording ends the real recorder's way: the final words land over the preview
 *  (onTranscribe), a whole-clip refine may swap them (onRefine), then its waiters hear. */
async function finalWords(text: string, refined?: string, error: string | null = null) {
  await act(async () => {
    if (text) rec.props!.onTranscribe(text)
    if (refined) rec.props!.onRefine?.(refined, text)
    rec.busy = false
    rec.props!.onSettled?.()
  })
  await act(async () => {
    const waiting = rec.waiters.splice(0)
    for (const w of waiting) w({ error })
  })
  await flush()
}

/** EditableSessionTitle / KanbanLaneHead / NotesTreePanel: Enter in onKeyDown and blur both save, then the box closes. */
function RenameBox({ saves, initial = '', escapes }: { saves: string[]; initial?: string; escapes?: string[] }) {
  const [editing, setEditing] = useState(true)
  const [value, setValue] = useState(initial)
  if (!editing) return createElement('span', { 'data-testid': 'closed' }, 'closed')
  const save = () => { saves.push(value); setEditing(false) }
  return createElement(MicInput, {
    value, setText: setValue,
    onBlur: save,
    onKeyDown: (e: { key: string; nativeEvent: { isComposing?: boolean }; keyCode: number; preventDefault: () => void }) => {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return
      if (e.key === 'Enter') { e.preventDefault(); save() }
      if (e.key === 'Escape') { escapes?.push(value); setEditing(false) }
    },
  })
}

/** A box that stays open: onEnter and onBlur both save, with no once-guard of its own. */
function OpenBox({ saves, blurs, focuses, target, onKeys }: { saves: string[]; blurs?: string[]; focuses?: number[]; target?: string; onKeys?: string[] }) {
  const [value, setValue] = useState('')
  useEffect(() => { setValue('') }, [target])
  return createElement(MicInput, {
    value, setText: setValue, target,
    onEnter: () => saves.push(`${target ?? ''}:enter:${value}`),
    onBlur: () => (blurs ?? saves).push(`${target ?? ''}:blur:${value}`),
    onFocus: () => focuses?.push(1),
    onKeyDown: (e: { key: string }) => { onKeys?.push(`${target ?? ''}:${e.key}:${value}`) },
  })
}

describe('MicInput: leaving the box mid-dictation', () => {
  it('saves once with the whole words, after they are in, and never unmounts the box under its recording', async () => {
    const saves: string[] = []
    await mount(createElement(RenameBox, { saves }))
    await record('rename this')
    await blurTo(outside())
    // Not yet: the save would have taken the preview and closed the box on its recording.
    expect(saves).toEqual([])
    expect(input()).not.toBeNull()
    expect(rec.discards).toBe(0)
    expect(rec.finishes).toBe(1) // leaving stops the recording
    await finalWords('rename this lane')
    expect(saves).toEqual(['rename this lane'])
    expect(host!.querySelector('[data-testid="closed"]')).not.toBeNull()
  })

  it('a refine that lands with the final words is what the blur saves', async () => {
    const saves: string[] = []
    await mount(createElement(RenameBox, { saves }))
    await record('q three plan')
    await blurTo(outside())
    await finalWords('q three plan', 'Q3 plan')
    expect(saves).toEqual(['Q3 plan'])
  })

  it('the words do not pull focus back into a box the person left (no second blur, no second save)', async () => {
    const saves: string[] = []
    const blurs: string[] = []
    await mount(createElement(OpenBox, { saves, blurs }))
    const focusSpy = vi.fn()
    input()!.focus = focusSpy
    await record('draft words')
    await blurTo(outside())
    await finalWords('draft words done')
    await flush()
    expect(blurs).toEqual([':blur:draft words done'])
    expect(focusSpy).not.toHaveBeenCalled()
  })

  it('a dictation that ends on an error holds the save: the box stays open with its words', async () => {
    const saves: string[] = []
    await mount(createElement(RenameBox, { saves }))
    await record('half of it')
    await blurTo(outside())
    await finalWords('', undefined, 'Transcription failed')
    expect(saves).toEqual([])
    expect(input()!.value).toBe('half of it')
  })

  it('coming back into the box before the words are in cancels the save on blur, and the owner hears no extra focus', async () => {
    const saves: string[] = []
    const blurs: string[] = []
    const focuses: number[] = []
    await mount(createElement(OpenBox, { saves, blurs, focuses }))
    await record('back again')
    await blurTo(outside())
    await focusBox()
    await finalWords('back again soon')
    expect(blurs).toEqual([])
    expect(focuses).toEqual([])
    // A later real leave is heard as usual.
    await blurTo(outside())
    expect(blurs).toEqual([':blur:back again soon'])
  })

  it('with nothing being dictated, a blur passes straight through (a normal save on blur is never lost)', async () => {
    const saves: string[] = []
    await mount(createElement(RenameBox, { saves, initial: 'typed name' }))
    await blurTo(outside())
    expect(saves).toEqual(['typed name'])
    expect(rec.finishes).toBe(0)
  })
})

describe('MicInput: focus moving into the box\'s own mic', () => {
  it('is not leaving: no save, and the save comes when focus then goes elsewhere', async () => {
    const saves: string[] = []
    await mount(createElement(RenameBox, { saves, initial: 'keep me' }))
    await blurTo(micButton())
    expect(saves).toEqual([])
    expect(input()).not.toBeNull()
    await focusEvt(outside(), 'focusin', micButton())
    expect(saves).toEqual(['keep me'])
  })

  it('a press on the mic that blurs to nothing (WebKit) stays in the box too', async () => {
    const saves: string[] = []
    await mount(createElement(RenameBox, { saves }))
    // The press and the blur it causes are one task in the browser: dispatch them together.
    await act(async () => {
      const press = new (win as unknown as { Event: typeof Event }).Event('pointerdown', { bubbles: true })
      Object.assign(press, { button: 0 })
      micButton().dispatchEvent(press)
      const out = new (win as unknown as { Event: typeof Event }).Event('focusout', { bubbles: true })
      Object.assign(out, { relatedTarget: null })
      input()!.dispatchEvent(out)
    })
    expect(saves).toEqual([])
    await record('safari')
    // Then a press somewhere else in the page, mid-dictation: a leave, saved with the whole words.
    await pointerDown(outside())
    expect(saves).toEqual([])
    await finalWords('safari dictated name')
    expect(saves).toEqual(['safari dictated name'])
  })

  it('focus coming back from the mic to the box is no blur and no focus for the owner', async () => {
    const saves: string[] = []
    const blurs: string[] = []
    const focuses: number[] = []
    await mount(createElement(OpenBox, { saves, blurs, focuses }))
    await blurTo(micButton())
    await focusBox()
    expect(blurs).toEqual([])
    expect(focuses).toEqual([])
  })

  it('the window losing focus mid-dictation is not leaving; coming back is silent', async () => {
    const saves: string[] = []
    const blurs: string[] = []
    const focuses: number[] = []
    await mount(createElement(OpenBox, { saves, blurs, focuses }))
    await record('other app')
    ;(document as unknown as { hasFocus: () => boolean }).hasFocus = () => false
    await blurTo(null)
    expect(blurs).toEqual([])
    expect(rec.finishes).toBe(0) // the recording goes on
    ;(document as unknown as { hasFocus: () => boolean }).hasFocus = () => true
    await focusBox()
    expect(blurs).toEqual([])
    expect(focuses).toEqual([])
  })
})

describe('MicInput: Enter mid-dictation', () => {
  it('an owner that saves on Enter in its own onKeyDown saves once, with the whole words, through its latest handler', async () => {
    const saves: string[] = []
    await mount(createElement(RenameBox, { saves }))
    await record('lane')
    const ev = await key(input()!, 'Enter')
    expect(ev.defaultPrevented).toBe(true)
    expect(saves).toEqual([])
    expect(input()).not.toBeNull()
    await finalWords('lane for review')
    expect(saves).toEqual(['lane for review'])
  })

  it('onEnter runs once with the whole words, and a blur while it waits is not a second save', async () => {
    const saves: string[] = []
    await mount(createElement(OpenBox, { saves }))
    await record('ship it')
    await key(input()!, 'Enter')
    await blurTo(outside())
    await finalWords('ship it today')
    expect(saves).toEqual([':enter:ship it today'])
  })

  it('a form box (no onKeyDown save) submits once the words are in', async () => {
    const submits: string[] = []
    function FormBox() {
      const [value, setValue] = useState('')
      return createElement('form', { onSubmit: (e: { preventDefault: () => void }) => { e.preventDefault(); submits.push(value) } },
        createElement(MicInput, { value, setText: setValue }))
    }
    await mount(createElement(FormBox))
    await record('heading')
    await key(input()!, 'Enter')
    expect(submits).toEqual([])
    await finalWords('heading two')
    expect(submits).toEqual(['heading two'])
  })

  it('Esc while it waits cancels it: the words land and nothing is saved, then or later', async () => {
    const saves: string[] = []
    await mount(createElement(RenameBox, { saves }))
    await record('never mind')
    await key(input()!, 'Enter')
    await key(input()!, 'Escape')
    // The Esc was the wait's, not the owner's: the box is still open.
    expect(input()).not.toBeNull()
    await finalWords('never mind that')
    expect(saves).toEqual([])
    expect(input()!.value).toBe('never mind that')
  })

  it('a second Enter while it waits cancels it', async () => {
    const saves: string[] = []
    await mount(createElement(RenameBox, { saves }))
    await record('twice')
    await key(input()!, 'Enter')
    await key(input()!, 'Enter')
    await finalWords('twice pressed')
    expect(saves).toEqual([])
  })

  it('an error holds it', async () => {
    const saves: string[] = []
    await mount(createElement(RenameBox, { saves }))
    await record('broken')
    await key(input()!, 'Enter')
    await finalWords('', undefined, 'Transcription failed')
    expect(saves).toEqual([])
  })

  it('a new target while it waits runs neither the old Enter handler nor the new one', async () => {
    const saves: string[] = []
    const keys: string[] = []
    await mount(createElement(OpenBox, { saves, target: 'lane-a', onKeys: keys }))
    await record('for lane a')
    await key(input()!, 'Enter')
    await rerender(createElement(OpenBox, { saves, target: 'lane-b', onKeys: keys }))
    expect(rec.discards).toBe(1)
    // A discarded recording delivers no words (the real recorder drops them); its waiter already heard.
    await finalWords('')
    expect(saves).toEqual([])
    expect(keys.filter((k) => k.includes('Enter'))).toEqual([])
  })

  it('an IME\'s confirming Enter is never caught: the owner sees it and nothing waits', async () => {
    const keys: string[] = []
    const saves: string[] = []
    await mount(createElement(OpenBox, { saves, onKeys: keys }))
    // Test data: a Japanese word being composed (\u escapes keep the source ASCII).
    await record('\u65e5\u672c')
    const ev = await key(input()!, 'Enter', { isComposing: true })
    expect(ev.defaultPrevented).toBe(false)
    expect(rec.finishes).toBe(0)
    expect(keys).toEqual([':Enter:\u65e5\u672c'])
    expect(saves).toEqual([])
  })

  it('Escape in the box mid-dictation is the owner\'s: it closes the box and no late words or save follow', async () => {
    const saves: string[] = []
    const escapes: string[] = []
    await mount(createElement(RenameBox, { saves, escapes }))
    await record('scrap')
    await key(input()!, 'Escape')
    expect(escapes).toEqual(['scrap'])
    expect(input()).toBeNull()
    expect(rec.discards).toBe(1)
    await finalWords('')
    expect(saves).toEqual([])
  })

  it('with nothing being dictated, Enter goes straight to the owner', async () => {
    const saves: string[] = []
    await mount(createElement(RenameBox, { saves, initial: 'now' }))
    await key(input()!, 'Enter')
    expect(saves).toEqual(['now'])
    expect(rec.finishes).toBe(0)
  })
})
