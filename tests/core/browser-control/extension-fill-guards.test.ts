/**
 * Guards on the extension's fills, read from its source. The auto-lock comes before every fill
 * (packages/browser-extension/src/background.ts):
 * a message goes through `handle`, which calls lockIfIdle first; the keyboard shortcut and the
 * context menu go through `fillFromBrowser`, which must call it first too. This reads the source:
 * every place in background.ts (and the bg-*.ts modules) that fills a page must sit in one of
 * those two, and each must lock before it checks the vault session, so a new fill path that
 * skips the idle lock fails here. And fill_login refuses a page an agent's script or real input
 * touched since it loaded: every debugger use marks the page first, and the fill checks the mark.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const DIR = path.join(process.cwd(), 'packages/browser-extension/src')
const src = (f: string) => fs.readFileSync(path.join(DIR, f), 'utf8')

/** The top-level function (or listener) a line sits in. */
function enclosing(text: string, at: number): string {
  const before = text.slice(0, at).split('\n')
  for (let i = before.length - 1; i >= 0; i--) {
    const m = /^(?:export )?(?:async )?function (\w+)|^(ext\.[\w?.]+\.addListener)/.exec(before[i])
    if (m) return m[1] ?? m[2]
  }
  return '(top level)'
}

function bodyOf(text: string, name: string): string {
  const start = text.search(new RegExp(`^(?:export )?async function ${name}\\b`, 'm'))
  expect(start, `function ${name}`).toBeGreaterThanOrEqual(0)
  const end = text.indexOf('\n}\n', start)
  return text.slice(start, end)
}

describe('the auto-lock before every fill', () => {
  const bg = src('background.ts')

  it('background.ts fills only inside handle (messages) or fillFromBrowser (shortcut, context menu)', () => {
    const places = [...bg.matchAll(/\bfillFrames\(|\bfillWalletFrame\(/g)].map((m) => enclosing(bg, m.index!))
    expect(places.length).toBeGreaterThan(0)
    for (const p of places) expect(['handle', 'fillFromBrowser']).toContain(p)
  })

  it('handle and fillFromBrowser lock when idle before they read the vault session', () => {
    for (const name of ['handle', 'fillFromBrowser']) {
      const body = bodyOf(bg, name)
      const lock = body.indexOf('lockIfIdle(')
      expect(lock, `${name} calls lockIfIdle`).toBeGreaterThan(0)
      const firstUse = Math.min(...['vaultSession(', 'fillFrames(', 'handleMenu(', 'api.'].map((k) => body.indexOf(k)).filter((i) => i >= 0))
      expect(lock, `${name}: lockIfIdle comes first`).toBeLessThan(firstUse)
    }
  })

  it('the shortcut and the context menu go through fillFromBrowser', () => {
    for (const listener of ['ext.commands?.onCommand.addListener', 'ext.contextMenus?.onClicked.addListener']) {
      const at = bg.indexOf(listener)
      expect(at, listener).toBeGreaterThan(0)
      const body = bg.slice(at, bg.indexOf('\n})\n', at))
      if (/fill/i.test(body)) expect(body).toContain('fillFromBrowser(')
    }
  })

  it('the menu module fills only from handleMenu, which handle reaches after its lock', () => {
    const menu = src('bg-menu.ts')
    const places = [...menu.matchAll(/\bfillFrames\(|\bfillWalletFrame\(/g)].map((m) => enclosing(menu, m.index!))
    for (const p of places) expect(p).toBe('handleMenu')
  })
})

describe('fill_login after an agent touched the page (page_tampered)', () => {
  it('every debugger use in the extension goes through the one run that marks the page first', () => {
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.ts'))
    const callsOf = (re: RegExp) => files.flatMap((f) => [...src(f).matchAll(re)].map((m) => ({ f, at: m.index! })))
    // A step acts through the debugger in one of two ways (agent-debugger.ts): `run`, and `watched`
    // for a step that may open a page dialog (agent-dialog.ts runWatching). Each marks the page
    // before it acts, and nothing else calls what attaches.
    const dbgFile = src('agent-debugger.ts')
    for (const [inner, outer] of [['withDebugger', 'run'], ['runWatching', 'watched']] as const) {
      const uses = callsOf(new RegExp(`(?<!function )\\b${inner}(?:<\\w+>)?\\(`, 'g'))
      expect(uses.map((u) => u.f), inner).toEqual(['agent-debugger.ts'])
      expect(enclosing(dbgFile, uses[0].at), inner).toBe(outer)
      const body = bodyOf(dbgFile, outer)
      expect(body.indexOf('noteTampered('), outer).toBeGreaterThan(0)
      expect(body.indexOf('noteTampered('), outer).toBeLessThan(body.indexOf(`${inner}(`))
    }
    // The debugger is attached in one place: the tab's one shared session (cdp.ts acquireDebugger).
    const attaches = callsOf(/\.attach\(target,/g).map((u) => `${u.f}: ${enclosing(src(u.f), u.at)}`)
    expect(attaches).toEqual(['cdp.ts: acquireDebugger'])
    // Every use of that session is one of these; a new one fails until it is placed here.
    const holders = callsOf(/(?<!function )\bacquireDebugger\(/g).map((u) => `${u.f}: ${enclosing(src(u.f), u.at)}`)
    expect(holders.sort()).toEqual([
      // A recording reads the tab's requests and console; it sends no input, so it marks nothing.
      'agent-net.ts: startRecording',
      // Reached only from watched, after its mark (above).
      'agent-dialog.ts: runWatching',
      // Reached only from run, after its mark (above).
      'cdp.ts: withDebugger',
      // Live pictures of a covered agent window (and an agent's screenshot of one): a picture of
      // the page, no input and no script, so it marks nothing (checked below).
      'agent-live.ts: take',
    ].sort())
    // The picture holder sends Page.captureScreenshot and nothing else.
    const live = src('agent-live.ts')
    const sent = [...live.matchAll(/\bsend(?:Command)?\(\s*'([\w.]+)'/g)].map((m) => m[1])
    expect(sent).toEqual(['Page.captureScreenshot'])
    expect(live).not.toMatch(/\bsend(?:Command)?\(\s*[^'\s]/)
  })

  it('fill_login checks the mark against the document now loaded before it fills', () => {
    const agent = src('agent.ts')
    const at = agent.indexOf("case 'fill_login':")
    const body = agent.slice(at, agent.indexOf('fillFrames(', at))
    expect(body).toContain('tamperedNow(tabId, page.doc)')
    expect(body).toContain("'page_tampered'")
    expect(src('content.ts')).toMatch(/case 'agent-check':.*doc: DOC_ID/)
  })
})
