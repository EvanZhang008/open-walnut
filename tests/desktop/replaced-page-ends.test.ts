/**
 * A web page the Mac app replaces ends with it (2026-11-11: the page process a recycle replaced
 * was still running its page, its timers and its socket to the server, at 1.7 GB, 17 minutes
 * after the swap, so the app held two pages). Every function that puts a web view into a window
 * where one may already be must hand the old one to WebContentWatchdog.retireReplacedPage, which
 * unloads its page and ends its process once the new page has loaded.
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
    expect(bad.map((s) => `${s.file}:${s.fn} (${s.line})`), 'hand the old web view to WebContentWatchdog.retireReplacedPage, or list a new-window-only function with why').toEqual([])
  })

  it('the list names only functions that exist', () => {
    const names = new Set(sites().map((s) => `${s.file}:${s.fn}`))
    expect(Object.keys(NEW_WINDOW_ONLY).filter((n) => !names.has(n))).toEqual([])
  })
})
