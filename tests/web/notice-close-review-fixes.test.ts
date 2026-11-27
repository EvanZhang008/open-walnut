/**
 * What a × leaves in place (2026-11-27 review of "every card and notice has its close"): a close
 * never takes away the only controls of what it closes, never leaves a region blank, folds a card
 * that waits on a decision to one line with Show, and a close made on one state never hides a
 * later one. Mounted for real (linkedom + the web app's own React).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'

const fake = vi.hoisted(() => ({
  presence: { answers: false, asOf: 1000, host: 'Build box', hostKey: null, why: null, console: false, source: 'ws' } as Record<string, unknown>,
  resync: { offline: false, macAway: true, syncing: false },
}))

vi.mock('@/utils/local-claude-recheck', () => ({ recheckLocalClaudeNow: async () => {} }))
vi.mock('@/utils/log', () => ({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))
vi.mock('@/hooks/useSystemHealth', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useSystemHealth: () => ({ health: {}, loading: true }),
}))
vi.mock('@/hooks/useLeaderPresence', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useLeaderPresence: () => fake.presence,
  useAwayLine: () => (fake.presence.answers ? null : { line: 'Your Mac is away.', prompts: '' }),
}))
vi.mock('@/hooks/usePhoneResync', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useResyncState: () => fake.resync,
}))

import { AgentWaitNote } from '../../web/src/components/sessions/AgentWaitNote'
import { EngineSignInNote } from '../../web/src/components/sessions/EngineSignInNote'
import { FirstUseSetup, useFirstUseCard } from '../../web/src/components/common/FirstUseSetup'
import { ReloadBanner } from '../../web/src/components/notes/MarkdownEditorPanel'
import { PermissionRequestCard } from '../../web/src/components/sessions/PromptCards'
import { QuickBarFoot } from '../../web/src/components/quickbar/QuickBarFoot'
import { drawingErrorWords } from '../../web/src/components/drawing/drawing-error-line'
import { MacAwayComposer, awaySignature } from '../../web/src/components/layout/AwayLine'
import { PhoneStatusRow } from '../../web/src/components/layout/PhoneStatusRow'
import { StartQueueLine } from '../../web/src/components/tasks/StartQueueLine'
import { PictureStrip } from '../../web/src/components/common/PictureStrip'
import { useImageAttachments, type ImageAttachments } from '../../web/src/components/common/image-attachments'
import { resetNoticeDismissCache, useGroupClose, useKeyedLineClose } from '../../web/src/utils/notice-dismiss'
import type { SystemHealth } from '../../web/src/hooks/useSystemHealth'
import type { LeaderPresenceState } from '../../web/src/api/leader-presence'

const { MemoryRouter } = await import('../../web/node_modules/react-router-dom')

class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}

let win: Window & typeof globalThis
let host: HTMLElement
let root: { render: (n: unknown) => void; unmount: () => void } | null = null
const render = async (node: unknown) => { await act(async () => { root!.render(node) }) }
const q = (sel: string) => host.querySelector(sel)
const click = async (el: Element | null) => {
  expect(el, 'the button is drawn').not.toBeNull()
  await act(async () => { el!.dispatchEvent(new win.Event('click', { bubbles: true })) })
}
const buttons = () => [...host.querySelectorAll('button')].map((b) => b.textContent?.trim()).filter(Boolean)

beforeAll(() => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.document
  g.IS_REACT_ACT_ENVIRONMENT = true
  win = dom.window as unknown as Window & typeof globalThis
  // What the question card's text box asks of a browser (its auto-size and its arm-after-appear).
  const w = win as unknown as Record<string, unknown>
  w.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0)
  w.cancelAnimationFrame = (id: number) => clearTimeout(id)
  g.requestAnimationFrame = w.requestAnimationFrame
  g.cancelAnimationFrame = w.cancelAnimationFrame
  g.getComputedStyle = w.getComputedStyle = () => ({ getPropertyValue: () => '', lineHeight: '20px', paddingTop: '0', paddingBottom: '0', borderTopWidth: '0', borderBottomWidth: '0' })
})
beforeEach(() => {
  ;(globalThis as { localStorage?: unknown }).localStorage = new MemStorage()
  resetNoticeDismissCache()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  if (root) { await act(async () => { root!.unmount() }); root = null }
  document.body.innerHTML = ''
})

describe("a waiting message's note: the × folds the words, the actions stay (M1)", () => {
  it('the agent-wait note keeps Retry and Discard', async () => {
    await render(createElement(AgentWaitNote, { reason: 'Claude Code is not installed.', waitsFor: 'claude_missing', local: false, onRetry: () => {}, onDiscard: () => {} }))
    expect(buttons()).toEqual(expect.arrayContaining(['Retry', 'Discard']))
    await click(q('[data-testid="agent-wait-close"]'))
    expect(q('[data-testid="agent-wait-folded"]')?.textContent).toBe('Waiting to send')
    expect(host.textContent).not.toContain('Claude Code is not installed.')
    expect(buttons(), 'its only Retry and Discard').toEqual(expect.arrayContaining(['Retry', 'Discard']))
  })

  it('the sign-in note keeps Open Settings to sign in, Retry and Discard', async () => {
    const signIn = { engine: 'codex', line: 'Codex is not signed in on Build box.', hostName: 'Build box' } as never
    await render(createElement(MemoryRouter, null, createElement(EngineSignInNote, { signIn, host: 'build', waits: true, onRetry: () => {}, onDiscard: () => {} })))
    await click(q('[data-testid="engine-sign-in-close"]'))
    expect(q('[data-testid="engine-sign-in-folded"]')?.textContent).toBe('Waiting for a sign-in')
    expect(buttons()).toEqual(expect.arrayContaining(['Open Settings to sign in', 'Retry', 'Discard']))
  })
})

describe('the welcome card: closed is no card, so the Ask slot shows its own view (M2)', () => {
  const signIn = {
    hasReadyProvider: true, claudeCliAvailable: true,
    localClaude: { checkedAt: 1, claude: { found: true, version: '2.1.281', kind: 'native', auth: 'not-logged-in', versionOk: true, installMethod: 'native' }, problems: [{ kind: 'claude_not_logged_in', message: 'Claude Code is not signed in.', commands: ['claude'] }] },
  } as unknown as SystemHealth
  // MainPage's shape: the slot gets `setup` only where the card is placed, else its own view.
  function Home({ needs, health, loading }: { needs: boolean; health: SystemHealth; loading: boolean }) {
    const card = useFirstUseCard(needs, true, true, health, loading)
    const setup = card.place === 'slot' ? createElement(FirstUseSetup, { health, loading, onClose: card.close }) : undefined
    return setup ?? createElement('div', { 'data-testid': 'slot-own-view' })
  }
  const home = (needs: boolean, health = signIn, loading = false) => createElement(MemoryRouter, null, createElement(Home, { needs, health, loading }))

  it('closing it gives the slot back, through a reload of health, and a later setup problem shows it again', async () => {
    await render(home(true))
    expect(q('[data-testid="first-use-setup"]')).not.toBeNull()
    await click(q('[data-testid="first-use-close"]'))
    expect(q('[data-testid="first-use-setup"]')).toBeNull()
    expect(q('[data-testid="slot-own-view"]'), 'never a blank slot').not.toBeNull()
    // Health loading again knows nothing: the close is kept.
    await render(home(false, signIn, true))
    await render(home(true))
    expect(q('[data-testid="slot-own-view"]')).not.toBeNull()
    // Setup no longer needed: the close is forgotten, so the same step coming back shows the card.
    await render(home(false))
    await render(home(true))
    expect(q('[data-testid="first-use-setup"]')).not.toBeNull()
  })
})

describe("the agent's question card folds like the permission card, and its × answers nothing (M3)", () => {
  it('folds to "Waiting for your answer" with Show; Show brings the questions back', async () => {
    const input = { questions: [{ question: 'Which colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] }] }
    await render(createElement(MemoryRouter, null, createElement(PermissionRequestCard, { sessionId: 's-fold', requestId: 'r-fold-question', toolName: 'AskUserQuestion', input })))
    expect(host.textContent).toContain('Which colour?')
    expect(buttons(), 'its Dismiss, the one that answers, stays as it was').toContain('Dismiss')
    await click(q('[data-testid="permission-request-close"]'))
    const folded = q('[data-testid="permission-request-folded"]')
    expect(folded?.textContent).toContain('Agent has a question')
    expect(folded?.textContent).toContain('Waiting for your answer')
    expect(folded?.getAttribute('data-prompt-pending'), 'still pending: nothing was answered').toBe('true')
    await click(q('[data-testid="permission-request-show"]'))
    expect(host.textContent).toContain('Which colour?')
  })
})

describe('a note banner that waits on a decision folds to one line with Show (M5)', () => {
  it('the deleted-note banner folds, still counts as unsaved work, and Show brings it back', async () => {
    const pending = { kind: 'deleted', path: 'a.md' } as never
    await render(createElement(ReloadBanner, { pending, onApply: () => {}, onDismiss: () => {} }))
    await click(q('[data-testid="notes-reload-banner-close"]'))
    expect(q('[data-testid="notes-deleted-banner"]')).toBeNull()
    const folded = q('[data-testid="notes-reload-banner-folded"]')
    expect(folded?.textContent).toContain('Not saved')
    expect(folded?.textContent).toContain('this note was deleted or moved')
    expect(q('[data-walnut-unsaved]')).not.toBeNull()
    await click(q('[data-testid="notes-reload-banner-show"]'))
    expect(q('[data-testid="notes-deleted-banner"]')).not.toBeNull()
  })

  it('the conflict banner folds the same way; a plain change on disk just hides', async () => {
    await render(createElement(ReloadBanner, { pending: { kind: 'conflict', path: 'a.md' } as never }))
    await click(q('[data-testid="notes-reload-banner-close"]'))
    expect(q('[data-testid="notes-reload-banner-folded"]')?.textContent).toContain('this note was changed elsewhere')
    await render(createElement(ReloadBanner, { pending: { kind: 'external', path: 'b.md' } as never }))
    await click(q('[data-testid="notes-reload-banner-close"]'))
    expect(host.innerHTML).toBe('')
  })
})

describe('a group close: the connect card stays hidden while the hosts it was closed on connect (M7)', () => {
  let handle: { shown: boolean; close: () => void }
  function Probe({ members }: { members: string[] }) { handle = useGroupClose(members); return null }
  const at = (members: string[]) => render(createElement(Probe, { members }))

  it('a host finishing never brings it back; a new host does; an empty list forgets the close', async () => {
    await at(['a', 'b'])
    expect(handle.shown).toBe(true)
    await act(async () => { handle.close() })
    expect(handle.shown).toBe(false)
    await at(['b'])
    expect(handle.shown, 'a finished and left: still hidden').toBe(false)
    await at(['b', 'c'])
    expect(handle.shown, 'a new host connects: shown').toBe(true)
    await at(['b'])
    expect(handle.shown, 'that close was spent').toBe(true)
    await act(async () => { handle.close() })
    await at([])
    await at(['b'])
    expect(handle.shown, 'the list emptied: the close is forgotten').toBe(true)
  })
})

describe('a keyed line close: a stale note forgets its close once its failure clears (low)', () => {
  let handle: { shown: (k: string) => boolean; close: (k: string) => void }
  function Probe({ lines }: { lines: Map<string, string> }) { handle = useKeyedLineClose(lines); return null }
  it('hides per folder, and the same failure after a good refresh shows again', async () => {
    const failing = new Map([['/a', 'timeout'], ['/b', 'timeout']])
    await render(createElement(Probe, { lines: failing }))
    await act(async () => { handle.close('/a') })
    expect(handle.shown('/a')).toBe(false)
    expect(handle.shown('/b')).toBe(true)
    await render(createElement(Probe, { lines: new Map([['/a', 'timeout'], ['/b', 'timeout']]) }))
    expect(handle.shown('/a'), 'the same failure, a new map: still closed').toBe(false)
    await render(createElement(Probe, { lines: new Map([['/b', 'timeout']]) }))
    await render(createElement(Probe, { lines: new Map([['/a', 'timeout']]) }))
    expect(handle.shown('/a'), 'after a good refresh the next failure says it again').toBe(true)
  })
})

describe("the quick bar's note: its × clears it in the bar (low)", () => {
  const foot = (over: Record<string, unknown>) => createElement(QuickBarFoot, {
    mode: 'send', recording: false, transcribing: false, micLive: false, counting: false, to: null,
    note: null, onCloseNote: () => {}, peopleFailed: false, onRetryPeople: () => {}, typedMode: null, empty: false,
    onMode: () => {}, canCapture: false, ...over,
  } as never)

  it('hands the close to the bar, so the same note said again shows', async () => {
    let closes = 0
    await render(foot({ note: 'Nothing to send yet.', onCloseNote: () => { closes += 1 } }))
    await click(q('[data-testid="qb-foot-note-close"]'))
    expect(closes).toBe(1)
    // The foot keeps no closed text of its own: given the note again, it shows it.
    await render(foot({ note: 'Nothing to send yet.' }))
    expect(host.textContent).toContain('Nothing to send yet.')
  })

  it('the restart line hides until the list loads, and a later failure shows it again', async () => {
    await render(foot({ peopleFailed: true }))
    await click(q('[data-testid="qb-foot-trouble-close"]'))
    expect(host.textContent).not.toContain('Walnut is restarting')
    await render(foot({ peopleFailed: false }))
    await render(foot({ peopleFailed: true }))
    expect(host.textContent).toContain('Walnut is restarting')
  })
})

describe("the drawing's error line keeps its close while a drawing loads (low)", () => {
  const snap = (over: Record<string, unknown>) => ({ state: 'error', error: 'Could not read it', conflict: null, unsaved: false, ...over }) as never
  it('is unknown while loading or switching, its words when it fails, null when all is well', () => {
    expect(drawingErrorWords(null), 'the render that switches drawings').toBeUndefined()
    expect(drawingErrorWords(snap({ state: 'loading', error: null })), 'a reopen or reload').toBeUndefined()
    expect(drawingErrorWords(snap({}))).toBe('Could not read it')
    expect(drawingErrorWords(snap({ state: 'saved', error: null }))).toBeNull()
    expect(drawingErrorWords(snap({ unsaved: true })), 'its own unsaved line says it').toBeNull()
  })
})

describe('the away notices (low)', () => {
  const p = (over: Partial<LeaderPresenceState>): LeaderPresenceState => ({
    answers: false, asOf: 1000, host: 'Build box', hostKey: null, why: null, console: false, source: 'ws', ...over,
  })

  it('one away keeps one key while its copies\' age comes and goes; the Mac answering forgets it', () => {
    expect(awaySignature(p({}))).toBe('mac:Build box')
    expect(awaySignature(p({ asOf: null }))).toBe(awaySignature(p({ asOf: 5000 })))
    expect(awaySignature(p({ answers: true }))).toBeNull()
  })

  it("the composer's notice folds to a line that still says why there is no send", async () => {
    fake.presence = p({}) as never
    await render(createElement(MacAwayComposer))
    await click(q('[data-testid="mac-away-composer-close"]'))
    const line = q('[data-testid="mac-away-composer"]')
    expect(line?.getAttribute('data-folded')).toBe('true')
    expect(line?.textContent).toContain('sending waits until it is back')
  })

  it("the phone's away row keeps its close through one failed check", async () => {
    fake.resync = { offline: false, macAway: true, syncing: false }
    await render(createElement(PhoneStatusRow))
    await click(q('[data-testid="phone-status-close"]'))
    expect(q('[data-testid="phone-status-mac-away"]')).toBeNull()
    // One check timed out: offline for a moment (its own row), then away again.
    fake.resync = { offline: true, macAway: false, syncing: false }
    await render(createElement(PhoneStatusRow))
    fake.resync = { offline: false, macAway: true, syncing: false }
    await render(createElement(PhoneStatusRow))
    expect(q('[data-testid="phone-status-mac-away"]'), 'still closed').toBeNull()
    // Connected again: the next away shows.
    fake.resync = { offline: false, macAway: false, syncing: false }
    await render(createElement(PhoneStatusRow))
    fake.resync = { offline: false, macAway: true, syncing: false }
    await render(createElement(PhoneStatusRow))
    expect(q('[data-testid="phone-status-mac-away"]')).not.toBeNull()
  })
})

describe("the start queue line's × says the start stays queued (low)", () => {
  it('names it on the × of a queued start', () => {
    const task = { id: 't1', start_queue: { queuedAt: '2026-11-27T10:00:00.000Z', host: 'build' } } as never
    const out = renderToStaticMarkup(createElement(StartQueueLine, { task }))
    expect(out).toContain('aria-label="Hide this line: the start stays queued"')
  })
})

describe('the picture strip says again what an add left out again (low)', () => {
  let pictures: ImageAttachments
  function Box() { pictures = useImageAttachments(); return createElement(PictureStrip, { pictures }) }
  const addPdf = () => act(async () => { pictures.add([new File(['x'], 'notes.pdf', { type: 'application/pdf' })]) })

  it('closed, the same thing left out on the next add shows the line again', async () => {
    await render(createElement(Box))
    await addPdf()
    expect(q('[data-testid="picture-strip-notice"]')?.textContent).toContain('notes.pdf')
    await click(q('[data-testid="picture-strip-notice-close"]'))
    expect(q('[data-testid="picture-strip-notice"]')).toBeNull()
    await addPdf()
    expect(q('[data-testid="picture-strip-notice"]')?.textContent).toContain('notes.pdf')
  })
})
