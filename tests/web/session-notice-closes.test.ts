// The × of a session panel's own notices (web/src/components/sessions/session-panel-closes.ts,
// ClosableNotice.tsx) and of the chat's quiet lines (web/src/components/chat/ChatRowLines.tsx):
// closed, a notice stays hidden for the same words; new words, or the trouble clearing and coming
// back, show it again; a loading session never forgets what was closed.
import { beforeEach, describe, expect, it } from 'vitest'
import { createElement } from '../../web/node_modules/react/index.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'
import { dismissNotice, isNoticeDismissed, resetNoticeDismissCache } from '../../web/src/utils/notice-dismiss'
import { panelNoticeSignatures, type PanelNoticeFacts } from '../../web/src/components/sessions/session-panel-closes'
import { ClosableNotice } from '../../web/src/components/common/ClosableNotice'
import { SendFailedNote, TurnInterruptedRow } from '../../web/src/components/chat/ChatRowLines'

class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}

beforeEach(() => {
  ;(globalThis as { localStorage?: unknown }).localStorage = new MemStorage()
  ;(globalThis as { window?: unknown }).window ??= { addEventListener() {}, removeEventListener() {} }
  resetNoticeDismissCache()
})

const facts = (session: PanelNoticeFacts['session'], over: Partial<PanelNoticeFacts> = {}): PanelNoticeFacts => ({
  session, provedReachable: false, historyLoading: false, returnedEmpty: false, ...over,
})
const rec = (over: Record<string, unknown>) => ({ process_status: 'idle', mode: 'default', ...over }) as unknown as PanelNoticeFacts['session']

describe('session panel notice signatures', () => {
  it('say nothing is known while the session loads, so a reload keeps what was closed', () => {
    expect(panelNoticeSignatures(facts(null))).toEqual({ error: undefined, idle: undefined, empty: undefined, denial: undefined, folderGone: undefined })
  })

  it('an error is its words and its state: reconnecting or proved reachable reads as new words', () => {
    const err = rec({ process_status: 'error', errorMessage: 'Connection lost: unable to reach remote host' })
    const plain = panelNoticeSignatures(facts(err)).error
    const reconnecting = panelNoticeSignatures(facts(rec({ process_status: 'error', errorMessage: 'Connection lost: unable to reach remote host', activity: 'Reconnecting' }))).error
    const reachable = panelNoticeSignatures(facts(err, { provedReachable: true })).error
    expect(new Set([plain, reconnecting, reachable]).size).toBe(3)
    // Not in error any more: null, which forgets the closed words.
    expect(panelNoticeSignatures(facts(rec({ process_status: 'running' }))).error).toBeNull()
  })

  it('the idle auto-stop, returned-empty, Auto refusal and folder-gone notices have a signature only while they show', () => {
    expect(panelNoticeSignatures(facts(rec({ process_status: 'stopped', errorMessage: 'No output for 30 min' }))).idle).toBe('idle:30')
    expect(panelNoticeSignatures(facts(rec({ process_status: 'stopped', errorMessage: 'Other' }))).idle).toBeNull()
    expect(panelNoticeSignatures(facts(rec({ process_status: 'stopped' }), { returnedEmpty: true })).empty).toBe('empty')
    expect(panelNoticeSignatures(facts(rec({ process_status: 'stopped' }), { returnedEmpty: true, historyLoading: true })).empty).toBeUndefined()
    expect(panelNoticeSignatures(facts(rec({ process_status: 'running' }), { returnedEmpty: true })).empty).toBeNull()
    const denial = { tools: ['Bash', 'Write'], at: '2026-11-27T10:00:00.000Z' }
    expect(panelNoticeSignatures(facts(rec({ mode: 'auto', autoPermissionDenial: denial }))).denial).toBe('2026-11-27T10:00:00.000Z:Bash,Write')
    expect(panelNoticeSignatures(facts(rec({ mode: 'default', autoPermissionDenial: denial }))).denial).toBeNull()
    const cwdGone = { cwd: '/work/gone', at: '2026-11-27T10:00:00.000Z', history: 'found' }
    expect(panelNoticeSignatures(facts(rec({ cwdGone }))).folderGone).toBe('/work/gone')
    expect(panelNoticeSignatures(facts(rec({ cwdGone, archived: true }))).folderGone).toBeNull()
  })
})

describe('ClosableNotice', () => {
  const draw = (signature: string | null | undefined) => renderToStaticMarkup(createElement(ClosableNotice, {
    scope: 'session-idle:s1', signature, children: () => createElement('div', { className: 'shown' }, 'Auto-stopped'),
  }))

  it('draws the notice for words not closed, nothing for words closed, and new words again', () => {
    expect(draw('idle:30')).toContain('shown')
    dismissNotice('session-idle:s1', 'idle:30')
    expect(draw('idle:30')).toBe('')
    expect(draw('idle:45')).toContain('shown')
    expect(isNoticeDismissed('session-idle:s1', 'idle:30')).toBe(true)
  })

  it('draws nothing while it has nothing to say or does not know yet', () => {
    expect(draw(null)).toBe('')
    expect(draw(undefined)).toBe('')
  })
})

describe('chat lines with their ×', () => {
  it('"Turn interrupted" has its close and stays out once closed, by its id', () => {
    const row = () => renderToStaticMarkup(createElement(TurnInterruptedRow, { id: 'msg-1', time: '10:00' }))
    expect(row()).toContain('data-testid="chat-interrupt-close"')
    dismissNotice('chat-interrupt', 'msg-1')
    expect(row()).toBe('')
  })

  it('a send that failed says why with Retry and its close', () => {
    const out = renderToStaticMarkup(createElement(SendFailedNote, { reason: 'the picture is no longer on the server', onRetry: () => {} }))
    expect(out).toContain('Not sent: the picture is no longer on the server')
    expect(out).toContain('>Retry</button>')
    expect(out).toContain('data-testid="chat-send-failed-close"')
  })
})
