/**
 * A web page the Mac app replaces ends with it (2026-11-11: the page process a recycle replaced
 * was still running its page, its timers and its socket to the server, at 1.7 GB, 17 minutes
 * after the swap, so the app held two pages). Every function that puts a web view into a window
 * where one may already be must hand the old one to WebContentProcess.retireReplacedPage, which
 * unloads its page and ends its process once the new page has loaded.
 *
 * 2026-11-18: ending the old page with WebKit's `_killWebContentProcess` left the process running
 * (logged as "ended") until it died hours later in a batch, and kernel_task kept its graphics
 * memory. The retire closes the page (`_close`) and reports what really happened; the native test
 * tests/desktop/replaced-page-process-tests.swift proves the process ends.
 *
 * Enumerated from the source: every `contentView = <web view>` in the Mac app, by the function it
 * sits in. A new place that swaps a web view in fails here until it retires the old one, or is
 * listed below as one that only ever fills a new window.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
const swiftFiles = execFileSync('git', ['ls-files', 'desktop/*.swift'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)

/** Functions that put a web view only into a window they just made, each with why nothing is replaced. */
const NEW_WINDOW_ONLY: Record<string, string> = {
  'desktop/main.swift:webView': 'createWebViewWith: a link opened in its own window makes a new window for its web view; nothing was in it',
}

interface Site { file: string; fn: string; body: string; line: string }

function sites(): Site[] {
  const out: Site[] = []
  for (const file of swiftFiles) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    // Web views a function makes, by name: `let x = WKWebView(` or `x = WKWebView(`.
    const fns = [...src.matchAll(/\bfunc\s+(\w+)/g)].map((m) => ({ name: m[1], at: m.index! }))
    fns.forEach((f, i) => {
      const body = src.slice(f.at, fns[i + 1]?.at ?? src.length)
      const views = new Set([...body.matchAll(/(?:let|var)?\s*(\w+)\s*=\s*WKWebView\s*\(/g)].map((m) => m[1]))
      for (const m of body.matchAll(/\bcontentView\s*=\s*(\w+)/g)) {
        if (views.has(m[1])) out.push({ file, fn: f.name, body, line: m[0] })
      }
    })
  }
  return out
}

describe('a web view the Mac app replaces is retired', () => {
  it('finds the places that swap a web view into a window', () => {
    const names = sites().map((s) => `${s.file}:${s.fn}`)
    expect(names).toContain('desktop/main.swift:loadWebUI')
    expect(names).toContain('desktop/main.swift:recyclePopout')
  })

  it('every one retires the old page, or only fills a new window', () => {
    const bad = sites().filter((s) => !(`${s.file}:${s.fn}` in NEW_WINDOW_ONLY) && !s.body.includes('retireReplacedPage('))
    expect(bad.map((s) => `${s.file}:${s.fn} (${s.line})`), 'hand the old web view to WebContentProcess.retireReplacedPage, or list a new-window-only function with why').toEqual([])
  })

  it('the list names only functions that exist', () => {
    const names = new Set(sites().map((s) => `${s.file}:${s.fn}`))
    expect(Object.keys(NEW_WINDOW_ONLY).filter((n) => !names.has(n))).toEqual([])
  })
})

describe('a retired page is closed, never "killed"', () => {
  const stripped = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

  it('no Mac app source calls _killWebContentProcess, which leaves the process running', () => {
    expect(swiftFiles.filter((f) => stripped(f).includes('_killWebContentProcess'))).toEqual([])
  })

  it('the retire closes the page and reports the checked outcome', () => {
    const src = stripped('desktop/WebContentProcess.swift')
    const retire = src.slice(src.indexOf('static func retireReplacedPage'), src.indexOf('static func close('))
    expect(retire).toContain('close(old)')
    expect(retire).toContain('endIfStillRunning(')
  })
})

describe('a web view the Mac app lets go of is closed first', () => {
  // 2026-11-20: a page dropped without a close (a popout window that closed, the quick bar's
  // panel torn down) dies later and its graphics memory is charged to the kernel until the app quits.
  const stripped = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  // A retire closes the page too (WebContentWatchdog.retireReplacedPage hands it to WebContentProcess).
  const closes = (body: string) => /WebContentProcess\.close\(|\bretireReplacedPage\(/.test(body)

  function letGo(): { at: string; ok: boolean }[] {
    const out: { at: string; ok: boolean }[] = []
    for (const file of swiftFiles) {
      const src = stripped(file)
      // Web views a type holds strongly; a weak reference never keeps a page.
      const held = [...src.matchAll(/^(?!.*\bweak\b).*\bvar\s+(\w+)\s*:\s*WKWebView[!?]?\s*(?:$|=)/gm)].map((m) => m[1])
      const fns = [...src.matchAll(/\bfunc\s+(\w+)/g)].map((m) => ({ name: m[1], at: m.index! }))
      fns.forEach((f, i) => {
        const body = src.slice(f.at, fns[i + 1]?.at ?? src.length)
        const drops = held.some((v) => new RegExp(`\\b${v}\\s*=\\s*nil\\b`).test(body))
        const windowCloses = f.name === 'windowWillClose' && /WKWebView/.test(body)
        if (drops || windowCloses) out.push({ at: `${file}:${f.name}`, ok: closes(body) })
      })
    }
    return out
  }

  it('finds the places that let a web view go', () => {
    const at = letGo().map((s) => s.at)
    expect(at).toContain('desktop/main.swift:loadWebUI')
    expect(at).toContain('desktop/main.swift:windowWillClose')
    expect(at).toContain('desktop/QuickBarPanel.swift:tearDown')
  })

  it('every one closes the page (WebContentProcess.close) or retires it', () => {
    expect(letGo().filter((s) => !s.ok).map((s) => s.at), 'close the web view with WebContentProcess.close before dropping it').toEqual([])
  })
})

describe('a page process is ended only by a deliberate swap', () => {
  // 2026-11-21: every page process the app ended while it ran left the graphics it held charged to
  // kernel_task until the app quit, even closed and released first; a page loaded again in its own
  // process was measured flat. So the app swaps processes only where a new process is the point,
  // and everything else (a deploy, memory before a reload was seen not to help, a server found
  // again after a restart) loads the page again in the process it has.
  const stripped = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  /** Functions that end a live page process, each with why a new process is the point. */
  const SWAPS: Record<string, string> = {
    'desktop/main.swift:loadWebUI': 'the swap itself, reached with newProcess: true (recycleWebContent) or for a page built for another port',
    'desktop/main.swift:recyclePopout': 'a popout window\'s watchdog swap, asked by WebContentPolicy.replacesProcess like the main window\'s',
    'desktop/DemoApp.swift:run': 'the separate demo app starting or resetting its demo: a new demo server, never a deploy of the person\'s',
    'desktop/DemoApp.swift:webView': 'the demo app\'s page whose demo server is gone (failed provisional navigation)',
    'desktop/main.swift:windowWillClose': 'a popout window the person closed: its page goes with it',
    'desktop/QuickBarPanel.swift:tearDown': 'the quick bar\'s page, hidden longer than it is kept: it goes with the panel',
  }

  function enders(): string[] {
    const out: string[] = []
    for (const file of swiftFiles) {
      if (file === 'desktop/WebContentProcess.swift' || file === 'desktop/WebContentWatchdog.swift') continue
      const src = stripped(file)
      const fns = [...src.matchAll(/\bfunc\s+(\w+)/g)].map((m) => ({ name: m[1], at: m.index! }))
      fns.forEach((f, i) => {
        const body = src.slice(f.at, fns[i + 1]?.at ?? src.length)
        if (/\bretireReplacedPage\(|WebContentProcess\.close\(/.test(body)) out.push(`${file}:${f.name}`)
      })
    }
    return out
  }

  it('every function that ends a page process is a listed swap', () => {
    expect(enders().filter((n) => !(n in SWAPS)), 'reload the page in its process instead, or list the swap with why a new process is the point').toEqual([])
    expect(Object.keys(SWAPS).filter((n) => !enders().includes(n)), 'the list names only functions that end a page process').toEqual([])
  })

  it('only a recycle asks loadWebUI for a new process; a server found again reuses the page', () => {
    const src = stripped('desktop/main.swift')
    // Every call's arguments, cut at its matching parenthesis.
    const calls = [...src.matchAll(/\bloadWebUI\(/g)].filter((m) => !src.slice(Math.max(0, m.index! - 5), m.index!).includes('func')).map((m) => {
      let depth = 1, i = m.index! + m[0].length
      while (i < src.length && depth > 0) { if (src[i] === '(') depth++; else if (src[i] === ')') depth--; i++ }
      return { at: m.index!, args: src.slice(m.index! + m[0].length, i - 1) }
    })
    expect(calls.length).toBeGreaterThan(1)
    const asking = calls.filter((c) => /newProcess:/.test(c.args))
    expect(asking.map((c) => c.args), 'newProcess is passed only as the literal true').toEqual(asking.map((c) => c.args).filter((a) => /newProcess:\s*true\s*$/.test(a)))
    expect(asking).toHaveLength(1)
    const fnOf = (at: number) => [...src.slice(0, at).matchAll(/\bfunc\s+(\w+)/g)].pop()?.[1]
    expect(fnOf(asking[0].at)).toBe('recycleWebContent')
    const load = src.slice(src.indexOf('func loadWebUI('), src.indexOf('func recycleWebContent('))
    const reuse = load.indexOf('if !newProcess, let page = webView, webViewPort == port')
    expect(reuse, 'loadWebUI loads an existing page for this port again').toBeGreaterThan(-1)
    expect(reuse).toBeLessThan(load.indexOf('let replaced = webView'))
    expect(load).toContain('webViewPort = port')
    // The watchdog hears it as the same process loading its page again, not a new process.
    const reuseBranch = load.slice(reuse, load.indexOf('return', reuse))
    expect(reuseBranch).toContain('pageReloaded(webView: page')
    expect(reuseBranch).not.toContain('.attach(')
  })
})
