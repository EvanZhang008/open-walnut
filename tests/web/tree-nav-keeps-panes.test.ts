/**
 * Tree Mode keeps its pages through every move (2026-11-04, the user: "in tree
 * mode i use comment it fallback to regular mode", "after click here it go to
 * single panel mode, what? tree mode is already multi panel", "nonon even
 * comment stay the same tree mode").
 *
 * The class: an action in Tree Mode that navigates the question stack, or
 * changes how many pages the split shows, as a side effect. Three ratchets:
 *  1. Every via the code navigates the stack with is placed: a cut
 *     (CUTTING_VIAS: the reader ends a level on purpose) or a move along the
 *     trail, which useTreeSplit.retarget turns into a focus or a slide. A new
 *     via fails here until it is placed below, with why.
 *  2. The comment flow (the pill's Quote / Comment, the panel's add) never
 *     navigates, opens a card or switches the view.
 *  3. Only the reader's own close turns the split down to fewer pages.
 * The behavior itself is walked in the browser by
 * tests/e2e/browser/session-tree-panes-keep.spec.ts.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { CUTTING_VIAS, SLIDE_VIAS, paneCount, retargetNav } from '@/utils/tree-split-state'
import { ROOT_THREAD_KEY } from '@/utils/thread-tree'

const WEB = path.resolve(__dirname, '../../web/src')

function sources(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(full))
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push({ file: path.relative(WEB, full), text: fs.readFileSync(full, 'utf8') })
  }
  return out
}

/** Moves along the trail: each keeps the pages on screen (a focus or a slide). */
const MOVES: Record<string, string> = {
  map: 'a row of the question map (Main included)',
  drawer: 'a row of the question list',
  crumb: 'a crumb of the one-page header',
  sliver: 'the sliver bar of a page',
  'asked-from': 'an Asked-from card under an answer',
  'path-bar-list': 'a pick from a segment\'s list',
  mark: 'a passage mark in a reply',
  pin: 'a pin jump into a question',
  insert: 'a composer insert for the session itself (it goes to Main)',
  'quote-head': 'the page\'s quote head (back to the passage it was asked about)',
  ask: 'Ask here: a new page on top (never a level on the trail)',
  'same-passage': 'Ask on a passage that already has its question',
  draft: 'a draft Ask reopened (a pending page: never retargeted)',
  sibling: 'a swap with the sibling page above the right one (a sibling: never a level on the trail)',
  model: '/model with no page of Main on screen: Main comes into view, its composer has the picker',
}

/** A call of the question stack's navigation (an object's method), and the split's own steps. */
const NAV_CALL = /\.(?:popTo|pushTo|back|leavePending|dropDraft|popToVisibleAncestor)\([^;]{0,140}/g
const OWN_STEP = /\b(?:navigate|goTo|leavePending|back|pushTo|popTo)\([^;]{0,140}/g
const OWN_FILES = new Set(['hooks/useThreadStack.ts', 'hooks/useTreeSplit.ts'])

describe('every via the stack is navigated with is placed', () => {
  const found = new Map<string, string[]>()
  for (const { file, text } of sources(WEB)) {
    const calls = [...(text.match(NAV_CALL) ?? []), ...(OWN_FILES.has(file) ? text.match(OWN_STEP) ?? [] : [])]
    for (const call of calls) {
      if (/^\.back\(\s*\)/.test(call)) continue
      for (const lit of call.match(/'([a-z][a-z0-9-]*)'/g) ?? []) {
        const via = lit.slice(1, -1)
        const at = found.get(via) ?? []
        at.push(file)
        found.set(via, at)
      }
    }
  }

  it('finds the navigations (the scan reads the code)', () => {
    for (const via of ['map', 'esc', 'path-bar-list', 'pair-left', 'close-right']) expect(found.has(via), via).toBe(true)
  })

  it('each one is a cut or a move along the trail, never both', () => {
    const unplaced = [...found.keys()].filter((v) => !CUTTING_VIAS.has(v) && !SLIDE_VIAS.has(v) && !(v in MOVES))
    expect(unplaced, `navigation vias with no place (add to MOVES with why, or to CUTTING_VIAS): ${unplaced.map((v) => `${v} in ${found.get(v)!.join(', ')}`).join('; ')}`).toEqual([])
    for (const v of Object.keys(MOVES)) expect(CUTTING_VIAS.has(v) || SLIDE_VIAS.has(v), v).toBe(false)
  })

  it('Cmd+[ / Cmd+] and a segment off the pages slide: they go as asked, and the pages on screen stay as many', () => {
    // 2026-11-05, macOS WebKit: read as a move onto a level on screen, Cmd+[ only focused it.
    const trail = [ROOT_THREAD_KEY, 'q1', 'q1.1', 'q1.1.1']
    for (const via of SLIDE_VIAS) {
      const r = retargetNav({ path: trail, trail, panes: 3, room: 3, toPath: trail.slice(0, 3), via })
      expect(r, via).toBeNull()
      expect(paneCount({ cap: 3, width: 1400, pathLength: 3 })).toBe(3)
    }
  })

  it('every move onto a level on screen keeps the pages: Main from the map, a list or a chip', () => {
    const trail = [ROOT_THREAD_KEY, 'q1', 'q1.1']
    for (const via of Object.keys(MOVES)) {
      for (const [path, panes] of [[trail.slice(0, 2), 2], [trail, 3]] as const) {
        for (let t = 0; t < path.length - 1; t++) {
          const r = retargetNav({ path, trail, panes, room: panes, toPath: trail.slice(0, t + 1), via })
          expect(r, `${via} to level ${t} with ${panes} pages`).toEqual({ kind: 'focus', key: trail[t] })
        }
      }
    }
  })
})

describe('the comment flow never leaves the view', () => {
  const read = (file: string) => fs.readFileSync(path.join(WEB, file), 'utf8')
  /** The body of the first function-ish block starting at `marker` (balanced braces). */
  function blockAt(text: string, marker: string): string {
    const at = text.indexOf(marker)
    expect(at, `marker ${marker}`).toBeGreaterThanOrEqual(0)
    // The body: the first brace after the arrow (a destructured parameter has braces too).
    const arrow = text.indexOf('=>', at)
    const open = text.indexOf('{', arrow >= 0 ? arrow : at)
    let depth = 0
    for (let i = open; i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}' && --depth === 0) return text.slice(at, i + 1)
    }
    throw new Error(`unbalanced block at ${marker}`)
  }
  const NAVIGATES = /\b(?:popTo|pushTo|back|requestCard|setViewMode|openDrawer|openSplit|closePane|withPaneCap)\(/

  it('the panel\'s comment add stays on the page it was made on', () => {
    const add = blockAt(read('components/sessions/SessionPanel.tsx'), 'add: ({ pageKey, ...input }) =>')
    expect(add).not.toMatch(NAVIGATES)
    expect(add).toContain('thread: head')
  })

  it('the pill\'s Quote / Comment keeps the passage without a move', () => {
    const bar = read('components/sessions/QuotePinSelectionBar.tsx')
    for (const marker of ['const keepPassage = useCallback(', 'const addComment = useCallback(', 'const quoteInChat = useCallback(']) {
      expect(blockAt(bar, marker), marker).not.toMatch(NAVIGATES)
    }
    expect(bar).toContain('pageKey: commentPage')
  })

  it('the long-passage fallback (a quote into the composer) never pops Tree Mode back to Main', () => {
    const quote = blockAt(read('components/sessions/SessionPanel.tsx'), 'const quoteInChat = useCallback(')
    expect(quote).not.toMatch(/\bpopTo\(|\brequestCard\(/)
  })

  it('a page sends only the comments made on it', () => {
    const panel = read('components/sessions/SessionPanel.tsx')
    expect(blockAt(panel, 'const withComments = useCallback(')).toContain('commentPageOfRef.current(c) === page')
    expect(panel).toMatch(/pending=\{ownPendingComments\}/)
  })
})

describe('only the reader\'s own close shows fewer pages', () => {
  it('withPaneCap is called by the split\'s own close, open and ask, nowhere else', () => {
    const calls: string[] = []
    for (const { file, text } of sources(WEB)) {
      if (file === 'utils/tree-split-state.ts') continue
      const n = (text.match(/\bwithPaneCap\(/g) ?? []).length
      if (n) calls.push(`${file}:${n}`)
    }
    expect(calls).toEqual(['hooks/useTreeSplit.ts:3'])
    const hook = fs.readFileSync(path.join(WEB, 'hooks/useTreeSplit.ts'), 'utf8')
    // The ask can only raise it; a close lowers it (to the pages right of the closed one); open raises it.
    expect(hook).toMatch(/paneCap\(prev\) > 1 \? prev : withPaneCap\(prev, MAX_PANES\)/)
    expect(hook).toMatch(/withPaneCap\(prev, move\.panes\)/)
  })
})

describe('only the main conversation\'s composer is the full one (2026-11-05)', () => {
  it('every Tree Mode page composer says which it is: light, unless it is Main\'s', () => {
    const left = fs.readFileSync(path.join(WEB, 'components/sessions/TreeSplitLeft.tsx'), 'utf8')
    // TreeSplitLeft draws the pages beside the panel's own: one ChatInput, light unless given Main's controls.
    expect(left.match(/<ChatInput\b/g)?.length).toBe(1)
    expect(left).toMatch(/light=\{!p\.fullComposer\}\s+\{\.\.\.p\.fullComposer\}/)
    const panel = fs.readFileSync(path.join(WEB, 'components/sessions/SessionPanel.tsx'), 'utf8')
    // The panel's own composer is light on a question's page, and Main's page gets the full controls.
    expect(panel).toMatch(/const ownComposerLight = treeMode && threads\.stack\.api\.currentKey !== ROOT_THREAD_KEY;/)
    expect(panel).toMatch(/light=\{ownComposerLight\}/)
    expect(panel).toMatch(/key === ROOT_THREAD_KEY && mainFullComposer \? \{ fullComposer: mainFullComposer \}/)
    expect(panel.match(/fullComposer[=:]/g)?.length).toBe(1)
    // A light composer draws no "+" menu and no controls slot.
    const input = fs.readFileSync(path.join(WEB, 'components/chat/ChatInput.tsx'), 'utf8')
    expect(input).toMatch(/\{!light && \(\s*<div className="chat-plus-group"/)
    expect(input).toMatch(/\{!sendBlocked && !light && controlsSlot\}/)
  })

  it('every Tree Mode page composer offers Stop only for its own page\'s turn', () => {
    const panel = fs.readFileSync(path.join(WEB, 'components/sessions/SessionPanel.tsx'), 'utf8')
    // The side pages, the sibling and the panel's own composer: three, each by its page.
    expect(panel.match(/isStreaming=\{pageStreaming\(/g)?.length).toBe(3)
    expect(panel).toMatch(/isStreaming=\{pageStreaming\(key\)\}/)
    expect(panel).toMatch(/isStreaming=\{pageStreaming\(treeSibling\.key\)\}/)
    expect(panel).toMatch(/isStreaming=\{pageStreaming\(threads\.stack\.api\.currentKey\)\}/)
    // Every <TreeSplitLeft is one of those pages.
    expect(panel.match(/<TreeSplitLeft\b/g)?.length).toBe(2)
  })
})

describe('a panel state marks only the panel\'s own composer (2026-11-05)', () => {
  // A panel-wide state (unread, say) drawn on `.session-panel-input` ringed every
  // Tree Mode page's composer red at once, which read as an error. Every such
  // rule names the panel's own composer, or says it means them all (none does).
  it('every `.session-panel.<state> ... .session-panel-input` rule leaves the Tree Mode pages out', () => {
    const dir = path.join(WEB, 'styles')
    const bad: string[] = []
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.css'))) {
      const text = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
      for (const m of text.matchAll(/([^{}]+)\{/g)) {
        for (const sel of m[1].split(',')) {
          // The phone's layer is a layout, not a state, and it shows one page.
          if (sel.includes('.is-phone-layer')) continue
          if (/\.session-panel\.[\w-]+[^,]*\.session-panel-input(?!:not\(\.tree-split-input\))/.test(sel)) bad.push(`${file}: ${sel.trim()}`)
        }
      }
    }
    expect(bad).toEqual([])
  })
})
