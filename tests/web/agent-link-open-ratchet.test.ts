/**
 * Ratchet: a path or a letter in agent text opens on click on EVERY surface that renders it
 * (2026-11-02, the user on a Thread card's video path: "I can't seem to click the mp4 why?").
 *
 * The cause was a class, not one card: the shared renderer draws every path as `a.file-link`
 * on every surface, but only the surfaces that passed a file opener to useEntityClickHandler
 * opened one; the hook swallowed the click everywhere else (Thread cards, triage, outbound
 * cards) and surfaces with no hook at all (the Brief, cards, drawers) did nothing. Now the
 * opener is the app's (web/src/utils/open-anywhere.ts): the hook falls back to it, and a
 * capture-phase fallback opens what no surface claimed, so a surface cannot lose it.
 *
 * Fails when:
 *  - a NEW file renders agent markdown and is not listed below, with how its links open;
 *  - a listed "hook" surface stops using useEntityClickHandler;
 *  - code outside the shared handlers reads a file or letter link (a second, private opener);
 *  - the app stops mounting the fallback and its viewer, or the fallback stops listening in
 *    the capture phase (a surface's stopPropagation would swallow the click again);
 *  - the hook swallows a file click again when it has no opener;
 *  - the Board's frame stops sending paths and letters up, or its host stops opening them.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const WEB = path.resolve('web/src')
const read = (rel: string) => fs.readFileSync(path.join(WEB, rel), 'utf-8')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(tsx?|js)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(path.relative(WEB, p).split(path.sep).join('/'))
  }
  return out
}
const FILES = walk(WEB)

/** What renders agent markdown (and so draws `a.file-link` / `a.letter-link`). */
const RENDERS = /renderMarkdownWithRefs\(|renderToolResultWithRefs\(|renderUserMessage\(|<RichMarkdown\b|<LetterBody\b|filePathsToHtml\(|linkifyPathsInCode\(/

/** The renderer and the shared handlers themselves. */
const SHARED = new Set(['utils/markdown.ts', 'hooks/useEntityClickHandler.ts', 'utils/open-anywhere.ts'])

/**
 * Every surface, and how a path or letter in it opens:
 *  hook      its click handler is useEntityClickHandler (its own opener, else the app's);
 *  fallback  no handler of its own: the app-level capture fallback opens it;
 *  renderer  a building block; the surface that mounts it is listed itself.
 */
const SURFACES: Record<string, 'hook' | 'fallback' | 'renderer'> = {
  'components/chat/ChatMessage.tsx': 'hook',
  'components/sessions/SessionMessage.tsx': 'hook',
  'components/sessions/StreamingBlockView.tsx': 'hook',
  'components/org/OrgThreads.tsx': 'hook',
  'components/triage/TriagePanel.tsx': 'hook',
  'components/inbox/LetterView.tsx': 'hook',
  'components/org/OrgBrief.tsx': 'fallback',
  'components/chat/SuggestCard.tsx': 'fallback',
  'components/chat/SuggestSegments.tsx': 'fallback',
  'components/sessions/WorkflowTranscriptModal.tsx': 'fallback',
  // A markdown file's own preview: the file's links, opened by the app fallback too.
  'components/common/FileContentView.tsx': 'fallback',
  'components/inbox/LetterBody.tsx': 'renderer',
  'components/inbox/LetterThread.tsx': 'renderer',
  'components/chat/RichBlocks.tsx': 'renderer',
  'components/sessions/diffMarkdownBlocks.ts': 'renderer',
  'hooks/useEntityLabels.ts': 'renderer',
}

describe('every surface that renders agent text opens its paths and letters', () => {
  it('each file that renders agent markdown is listed with how its links open', () => {
    const found = FILES.filter((f) => !SHARED.has(f) && RENDERS.test(fs.readFileSync(path.join(WEB, f), 'utf-8')))
    const unlisted = found.filter((f) => !(f in SURFACES))
    expect(unlisted, 'a new surface renders agent markdown: list it in SURFACES (hook, fallback or renderer)').toEqual([])
    const gone = Object.keys(SURFACES).filter((f) => !found.includes(f))
    expect(gone, 'listed surfaces that no longer render agent markdown: drop them from SURFACES').toEqual([])
  })

  it('a hook surface still clicks through useEntityClickHandler', () => {
    for (const [f, how] of Object.entries(SURFACES)) {
      if (how === 'hook') expect(read(f), f).toMatch(/useEntityClickHandler\(/)
    }
  })

  it('nothing but the shared handlers reads a file or letter link (no second, private opener)', () => {
    const LINK_READ = /closest\(\s*['"`][^'"`]*a\.(file|letter)-link|dataset\.(filePath|relPath|letterId)\b/
    const readers = FILES.filter((f) => !SHARED.has(f) && LINK_READ.test(fs.readFileSync(path.join(WEB, f), 'utf-8')))
    expect(readers).toEqual([])
  })
})

describe('the app-level opener', () => {
  const app = read('App.tsx')
  const anywhere = read('utils/open-anywhere.ts')
  const hook = read('hooks/useEntityClickHandler.ts')

  it('App mounts the fallback and the viewer, in the main window and in a pop-out', () => {
    expect(app).toMatch(/useAgentLinkClickFallback\(\)/)
    expect((app.match(/<AnywhereFileViewer \/>/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  it('the fallback listens in the capture phase and opens only what no surface claimed', () => {
    expect(anywhere).toMatch(/document\.addEventListener\('click', onClick, true\)/)
    expect(anywhere).toMatch(/if \(!claimed\.has\(e\)\) openAgentLink\(anchor\)/)
    expect(anywhere).toContain("'a.file-link, a.letter-link'")
  })

  it('the hook claims a file click and opens it even with no opener of its own', () => {
    expect(hook).toContain('claimAgentLinkClick(e.nativeEvent)')
    expect(hook).toMatch(/onFileOpen \?\? \(/)
    expect(hook).not.toMatch(/if \(!onFileOpen\) return/)
  })

  it('a letter link opens the notification center on that letter', () => {
    expect(anywhere).toContain("OPEN_CENTER_EVENT = 'notification:open-center'")
    // The center already opens a letter named on that event (its return-to-letter path).
    expect(read('components/common/NotificationPanel.tsx')).toMatch(/addEventListener\('notification:open-center', restore\)/)
    expect(read('components/layout/Sidebar.tsx')).toMatch(/addEventListener\(OPEN_CENTER_EVENT, handleOpenCenter\)/)
    // A pop-out has no center: the app's window opens it.
    expect(app).toMatch(/useOpenLetterRequests\(isPopoutPath\(location\.pathname\)\)/)
  })

  it('the renderer keeps the letter link through the sanitizer', () => {
    const md = read('utils/markdown.ts')
    expect(md).toMatch(/SANITIZE_ATTRS = \[[^\]]*'data-letter-id'/)
    expect(md).toMatch(/parsed = linkLetterIds\(parsed\)/)
  })
})

describe('the Board frame (its own document, so it sends them up)', () => {
  it('the frame sends a clicked path or letter; the host opens them', () => {
    const frame = read('components/board/board-runtime.frame.js')
    expect(frame).toContain("send({ t: 'wn-board:open-file'")
    expect(frame).toContain("send({ t: 'wn-board:open-letter'")
    const pane = read('components/board/TaskBoardPane.tsx')
    expect(pane).toMatch(/case 'wn-board:open-file':[\s\S]{0,200}openFileAnywhere\(/)
    expect(pane).toMatch(/case 'wn-board:open-letter':[\s\S]{0,200}openLetterAnywhere\(/)
  })
})
