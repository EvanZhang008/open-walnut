/**
 * A scroller that is, or holds, a size container loses its scroll in WebKit (the Mac app's engine)
 * when an ancestor goes `display: none` and comes back: measured on Playwright's WebKit, a scroller
 * at 2000px came back at 0 with `container: x / inline-size` on itself or on a box inside it, and
 * kept 2000px with the container on an ancestor (2026-11-24). Mail's narrow drill hides its panes
 * that way to keep their state, and since a49ff1ac4b put the rows' container on `.mail-rows` the
 * list came back at its top after reading a message (mail-grouping-narrow.webkit.spec.ts).
 *
 * Two checks over the source:
 *   - every rule that scrolls and declares a size container is one of the few listed below (their
 *     count only falls); a new one fails, so its author puts the container on an ancestor;
 *   - in Mail, every size container is listed with why it sits outside the drill panes' scrollers.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const WEB = path.resolve(__dirname, '../../web/src')

function cssFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return cssFiles(p)
    return e.name.endsWith('.css') ? [p] : []
  })
}

interface Rule { file: string; selector: string; body: string }

function rules(): Rule[] {
  return cssFiles(WEB).flatMap((file) => {
    const css = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
      file: path.relative(WEB, file), selector: m[1].trim().replace(/\s+/g, ' '), body: m[2],
    }))
  })
}

const SIZE_CONTAINER = /(?:^|[;\s])container(?:-type)?\s*:\s*(?!normal\b)[^;]+/
const SCROLLS = /overflow(?:-[xy])?\s*:\s*[^;]*\b(?:auto|scroll)\b/

/** Scrollers that are size containers already, not yet checked for a display: none ancestor. Only falls. */
const KNOWN: readonly string[] = [
  'styles/board-status.css :: .board-status',
  'styles/draft-v6.css :: .draft-v6-body',
  'styles/globals.css :: .session-diff-tree',
  'styles/session-servers.css :: .session-web-card',
]

describe('a scroller is never a size container (WebKit drops its scroll across display: none)', () => {
  it('only the listed rules both scroll and declare a size container', () => {
    const found = rules()
      .filter((r) => SIZE_CONTAINER.test(r.body) && SCROLLS.test(r.body))
      .map((r) => `${r.file} :: ${r.selector}`)
      .sort()
    expect(found.filter((f) => !KNOWN.includes(f)), 'put the size container on an ancestor of the scroller').toEqual([])
    expect(KNOWN.filter((k) => !found.includes(k)), 'a listed rule is fixed: take it off KNOWN').toEqual([])
  })

  it('Mail keeps its size containers off the scrollers of the panes the narrow drill hides', () => {
    // Each one, and why it is outside every scroller. A new one fails here until it is listed.
    const OUTSIDE: Record<string, string> = {
      'apps/mail/mail.css :: .mail-list-pane': 'the list pane itself, the scroller\'s ancestor',
      'apps/mail/mail-compose.css :: .mail-accounts-pane > .mail-pane-head': 'the pane head, above the folders scroller',
    }
    const found = rules().filter((r) => r.file.startsWith('apps/mail/') && SIZE_CONTAINER.test(r.body)).map((r) => `${r.file} :: ${r.selector}`).sort()
    expect(found).toEqual(Object.keys(OUTSIDE).sort())
  })
})
