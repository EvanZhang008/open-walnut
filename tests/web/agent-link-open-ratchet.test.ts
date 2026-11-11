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
 *  - a NEW file renders agent markdown and is not listed below, with how its links open (found
 *    from the AST: a direct call, or a call of any wrapper, hook or alias of one, across files);
 *  - a listed "hook" surface stops calling useEntityClickHandler and using the handler it returns;
 *  - code outside the shared handlers reads a file or letter link (a second, private opener);
 *  - the app stops mounting the fallback and its viewer, or the fallback stops listening in
 *    the capture phase (a surface's stopPropagation would swallow the click again);
 *  - the hook swallows a file click again when it has no opener;
 *  - the Board's frame stops sending paths and letters up, or its host stops opening them.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { ModuleGraph, readSources, renderingFiles, usesHook } from './agent-guard-ast'

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

/**
 * What renders agent markdown (and so draws `a.file-link` / `a.letter-link`): these definitions,
 * and every function, hook or alias that calls one, followed through imports to a fixed point
 * (`renderMarkdown` in ChatMessage, `useRenderedMarkdown`, ...), so a wrapper never hides a surface.
 */
const key = (rel: string, name: string) => `${path.resolve(WEB, rel)}#${name}`
const SEEDS = [
  key('utils/markdown', 'renderMarkdownWithRefs'), key('utils/markdown', 'renderToolResultWithRefs'),
  key('utils/markdown', 'renderUserMessage'), key('utils/markdown', 'filePathsToHtml'),
  key('../../src/lib/agent-html-refs', 'linkAgentHtml'),
  key('components/chat/RichBlocks', 'RichMarkdown'), key('components/common/AgentText', 'AgentText'),
  key('components/inbox/LetterBody', 'LetterBody'),
]

/** The renderer and the shared handlers themselves. */
const SHARED = new Set(['utils/markdown.ts', 'hooks/useEntityClickHandler.ts', 'utils/open-anywhere.ts', 'components/board/board-runtime.frame.js'])
const GRAPH = new ModuleGraph(readSources(WEB), WEB)
const DERIVED = renderingFiles(GRAPH, SEEDS, new Set([...SHARED].map((f) => path.join(WEB, f))))

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
  'components/org/OrgBrief.tsx': 'hook',
  // The Brief's opener (OrgBrief passes it to useEntityClickHandler): renders a block only to find a path's writers.
  'components/org/useBriefFileOpener.tsx': 'renderer',
  'components/common/AgentText.tsx': 'hook',
  'components/inbox/LetterEnvelopeRow.tsx': 'renderer',
  'components/board/TaskBoardPane.tsx': 'renderer',
  'components/board/BoardStatusView.tsx': 'renderer',
  'components/org/OrgTaskRail.tsx': 'renderer',
  'components/tasks/AnsweredForLine.tsx': 'renderer',
  'components/board/kanban/KanbanCard.tsx': 'renderer',
  'components/board/kanban/KanbanCardDetail.tsx': 'renderer',
  'components/inbox/EmailItem.tsx': 'renderer',
  'components/sessions/SearchAnswerCard.tsx': 'renderer',
  'components/sessions/BackgroundTasksPanel.tsx': 'renderer',
  'components/sessions/SessionRecapTip.tsx': 'renderer',
  'components/sessions/LatestUpdatePopover.tsx': 'renderer',
  'components/tasks/AgentSearchPanel.tsx': 'renderer',
  'components/tasks/ProjectDetailPane.tsx': 'renderer',
  'components/tasks/StatusSections.tsx': 'renderer',
  'components/tasks/WaitingChip.tsx': 'renderer',
  'components/sessions/SessionTaskbar.tsx': 'renderer',
  'popout/PopoutExtTasks.tsx': 'renderer',
  'apps/mail/MailGroupLine.tsx': 'renderer',
  'components/settings/sections/HostProfileDisclosure.tsx': 'renderer',
  'components/chat/SuggestCard.tsx': 'fallback',
  'components/chat/SuggestSegments.tsx': 'fallback',
  'components/sessions/WorkflowTranscriptModal.tsx': 'renderer',
  // An earlier session's rows: its own id, host and cwd (task sessions) or no writer (chat-earlier).
  'components/sessions/TaskEarlierSessions.tsx': 'renderer',
  'components/sessions/ChatEarlierBlock.tsx': 'renderer',
  // A markdown file's own preview: the file's links, opened by the app fallback too.
  'components/common/FileContentView.tsx': 'fallback',
  'components/inbox/LetterBody.tsx': 'renderer',
  'components/inbox/LetterThread.tsx': 'renderer',
  'components/chat/RichBlocks.tsx': 'renderer',
  'components/sessions/diffMarkdownBlocks.ts': 'renderer',
  'hooks/useEntityLabels.ts': 'renderer',
  // Found through the wrappers (`renderMarkdown`, `useRenderedMarkdown`, `markdownBlocksWithLines`).
  'components/sessions/SessionOutboundCard.tsx': 'hook',
  'components/sessions/InjectedBannerRow.tsx': 'renderer',
  'components/sessions/SessionProvenanceCard.tsx': 'renderer',
  'components/common/ClaudeStreamView.tsx': 'renderer',
  'components/chat/SubagentBlock.tsx': 'renderer',
  'components/context/ContextInspectorPanel.tsx': 'renderer',
  'components/sessions/SideQuestionDrawer.tsx': 'renderer',
  'components/sessions/SessionDiffView.tsx': 'fallback',
  'components/sessions/SessionPanel.tsx': 'fallback',
}

describe('every surface that renders agent text opens its paths and letters', () => {
  it('each file that renders agent markdown is listed with how its links open', () => {
    const found = DERIVED.files.map((f) => path.relative(WEB, f).split(path.sep).join('/'))
    const unlisted = found.filter((f) => !(f in SURFACES))
    expect(unlisted, 'a new surface renders agent markdown: list it in SURFACES (hook, fallback or renderer)').toEqual([])
    const gone = Object.keys(SURFACES).filter((f) => !found.includes(f))
    expect(gone, 'listed surfaces that no longer render agent markdown: drop them from SURFACES').toEqual([])
  })

  it('a hook surface still clicks through useEntityClickHandler', () => {
    for (const [f, how] of Object.entries(SURFACES)) {
      if (how === 'hook') expect(usesHook(GRAPH, path.join(WEB, f), key('hooks/useEntityClickHandler', 'useEntityClickHandler')), f).toBe(true)
    }
  })

  it('source-aware overridden clicks reject relative paths from an unknown writer too', () => {
    const handlers = [
      ['components/inbox/LetterThread.tsx', 'file'],
      ['components/inbox/LetterView.tsx', 'sourceFile'],
      ['components/triage/TriagePanel.tsx', 'file'],
    ] as const
    for (const [file, opener] of handlers) {
      expect(read(file), file).toMatch(new RegExp(`useEntityClickHandler\\([\\s\\S]*?${opener}\\.refusesAll[\\s\\S]*?\\);`))
    }
    expect(read('components/org/OrgBrief.tsx')).toContain('useEntityClickHandler(onOpenTask, undefined, onFileOpen.open, undefined, undefined, true)')
    expect(read('components/triage/TriagePanel.tsx')).toContain('{ unknownSource: true }')
    expect(read('components/inbox/LetterEnvelopeRow.tsx')).toContain('unknownSource={!letter.sender?.sessionId}')
    expect(read('components/inbox/EmailItem.tsx')).toContain('sender?.unknownSource ?? (!sender?.sessionId && sender?.host === undefined)')
  })

  it('the derivation follows wrappers, aliases and re-exports across files, and only real calls', () => {
    const v = (files: Record<string, string>) => {
      const g = new ModuleGraph(Object.fromEntries(Object.entries(files).map(([f, t]) => [`/v/${f}`, t])), '/v')
      return renderingFiles(g, ['/v/md#renderRefs', '/v/AgentText#AgentText'], new Set(['/v/md.ts'])).files.map((f) => f.slice(3))
    }
    const md = 'export function renderRefs(t) { return t }\nexport function plain(t) { return t }'
    expect(v({
      'md.ts': md, 'AgentText.tsx': 'export function AgentText() { return null }',
      'wrap.ts': "import { renderRefs as r } from './md'\nexport const html = (t) => r(t)\nexport const alias = html",
      'barrel.ts': "export { alias as shown } from './wrap'\nexport * from './hook'",
      'hook.ts': "import { shown } from './barrel'\nexport function useShown(t) { return shown(t) }",
      'A.tsx': "import { useShown } from './barrel'\nexport const A = () => <div>{useShown('x')}</div>",
      'B.tsx': "import { AgentText as T } from './AgentText'\nexport const B = () => <T text='x' />",
      'C.tsx': "import { plain } from './md'\n// renderRefs( in a comment\nexport const C = () => <div>{plain('x')}</div>",
      'D.tsx': "const renderRefs = (t) => t\nexport const D = () => <div>{renderRefs('x')}</div>",
      'E.tsx': "import { A } from './A'\nexport const E = () => <A />",
    // A comment, a same-named local and a component that only mounts a surface are not renderers.
    })).toEqual(['A.tsx', 'B.tsx', 'hook.ts', 'wrap.ts'])
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

  it('closing a letter a link opened returns to the link: the center it opened goes too', () => {
    expect(anywhere).toMatch(/new CustomEvent\(OPEN_CENTER_EVENT, \{ detail: \{ letterId, link: true \} \}\)/)
    const panel = read('components/common/NotificationPanel.tsx')
    expect(panel).toMatch(/linkPending\.current = \(event as CustomEvent\)\.detail\?\.link === true/)
    expect(panel).toMatch(/if \(linkOpened\.current\) \{ linkOpened\.current = false; onClose\(\); \}/)
    // A letter chosen from the center's own list is the center's, never closed with it.
    expect(panel).toMatch(/const openLetter = useCallback\(\(id: string\) => \{\s*linkOpened\.current = false;/)
  })

  it('the notification center stays above a full-screen surface and below its letter reader', () => {
    const layer = (file: string, selector: string) => {
      const css = read(file).replace(/\/\*[\s\S]*?\*\//g, '')
      const block = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .find((match) => match[1]!.trim() === selector)?.[2]
      expect(block, selector).toBeDefined()
      const z = block?.match(/\bz-index:\s*(\d+)/)?.[1]
      expect(z, selector).toBeDefined()
      return Number(z)
    }
    const fullscreen = layer('styles/globals.css', '.open-walnut-fullscreen')
    const backdrop = layer('styles/globals.css', '.notification-panel-backdrop')
    const center = layer('styles/globals.css', '.notification-panel')
    const reader = layer('styles/human-inbox.css', '.hib-reader-overlay')
    expect(backdrop).toBeGreaterThan(fullscreen)
    expect(center).toBeGreaterThan(backdrop)
    expect(reader).toBeGreaterThan(center)
    expect(read('styles/phone-pages.css')).toMatch(/html body \.notification-panel\.nfc-panel-wide,[\s\S]{0,300}z-index: 9200;/)
    const phoneBar = layer('styles/phone-layout.css', '.app-shell-navigation .phone-topbar[data-layer="notifications"]')
    expect(phoneBar).toBeGreaterThan(center)
    expect(reader).toBeGreaterThan(phoneBar)
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
    expect(pane).toMatch(/case 'wn-board:open-letter':[\s\S]{0,200}openLetterAnywhere\(/)
  })

  it('a clicked path opens on its source task\'s machine, read from the record, never from the frame', () => {
    const frame = read('components/board/board-runtime.frame.js')
    // The frame may still name its row (thread + row id); the host never reads it to pick a machine.
    expect(frame).toMatch(/send\(\{ t: 'wn-board:open-file',/)
    expect(frame).toMatch(/send\(\{ t: 'wn-board:open-ref',/)
    const pane = read('components/board/TaskBoardPane.tsx')
    // Both path cases hand only the path (and line) to openStoredFile: no row, offset or source from the frame.
    for (const c of ["case 'wn-board:open-file':", "case 'wn-board:open-ref':"]) {
      const at = pane.indexOf(c)
      expect(at, c).toBeGreaterThan(0)
      const body = pane.slice(at, pane.indexOf('return;\n', pane.indexOf('openStoredFile(', at)))
      expect(body, c).toMatch(/openStoredFile\(/)
      expect(body, c).not.toMatch(/openBoardFile\(|openFileAnywhere\(|fileSource\(/)
      expect(body, c).not.toMatch(/\bd\.(thread|msg|sourceOffset)\b|str\('(thread|msg|sourceOffset)'\)/)
    }
    expect(pane).not.toMatch(/\bd\.sourceOffset\b/)
    expect(frame).not.toContain("getAttribute('data-walnut-source-offset')")

    // openStoredFile enumerates every trusted copy of the path: the page's own link offsets
    // (from linkAgentHtml over the stored html) and every stored message whose rendered text links it.
    const sStart = pane.indexOf('const openStoredFile = (req: OpenFileRequest) => {')
    expect(sStart).toBeGreaterThan(0)
    const sEnd = pane.indexOf('\n  };\n', sStart)
    expect(sEnd).toBeGreaterThan(sStart)
    const stored = pane.slice(sStart, sEnd)
    expect(pane).toMatch(/linkAgentHtml\(html, \{[\s\S]{0,200}onFileReference: \(offset, path, end\) => \{ paths\.set\(offset, \{ path, end \}\); \}/)
    // The page: each stored reference names every writer of the spans it covers (A, B, A typed parts
    // list A and B, never fail for good); malformed spans or a writer with no machine fail the open.
    expect(stored).toMatch(/for \(const \[offset, reference\] of linkedPage\.paths\)/)
    expect(stored).toContain('const writers = boardReferenceSources(ownerId, board, offset, reference.end);')
    expect(stored).toMatch(/if \(!writers\) \{ ambiguous = true; continue; \}/)
    expect(stored).toMatch(/for \(const writer of writers\) add\(writer, 'Board page'\);/)
    expect(stored).not.toMatch(/boardPathSource\(|sourceOffset|offset, undefined/)
    expect(stored).toMatch(/for \(const \[thread, messages\] of Object\.entries\(payload\?\.threads \?\? \{\}\)\) for \(const message of messages\)/)
    expect(stored).toContain('messagePaths.get(message.text)?.has(req.path)')
    expect(stored).toContain('boardFileSource(ownerId, payload?.threads, thread, message.id, board)')
    // Message paths come from the same Markdown renderer the frame shows, read back as data-file-path.
    expect(pane).toMatch(/renderMarkdownWithRefs\(text, [^\n]*boardText: true/)
    expect(pane).toMatch(/querySelectorAll\('a\[data-file-path\]'\)/)
    // A person's (primary) copy never merges with the owner's agent copy that has no session.
    expect(stored).toMatch(/const key = source\.primary \? 'primary' : `\$\{source\.taskId\}\|\$\{source\.sessionId \?\? ''\}`/)
    // A single reference built by mixed writers, or a path no stored text holds, fails closed.
    // A task writer with no saved session is unknown too: its task's session now may run elsewhere.
    expect(stored).toMatch(/if \(source\.sourceFailure \|\| \(!source\.primary && !source\.sessionId\)\) \{ ambiguous = true; return; \}/)
    expect(stored).toMatch(/if \(ambiguous \|\| sources\.size === 0\) \{ openBoardFile\(req, \{ taskId: ownerId, sourceFailure: true \}\); return; \}/)
    // One source opens at once; several read their machines on this click (the chooser shows at once,
    // pending), then one machine opens there and several ask the user in the parent page, never in the frame.
    expect(stored).toMatch(/if \(choices\.length === 1\) \{ openBoardFile\(req, choices\[0\]!\.source\); return; \}/)
    expect(stored).toContain('openBoardFile(req, choices, { nonce, sourceKey });')
    expect(stored).not.toMatch(/setFileChoices\(\{/)
    expect(read('components/inbox/LetterReader.tsx')).toContain('fileView.sourceOnly')
    expect(read('components/inbox/LetterView.tsx')).toContain("shown?.sender?.host !== undefined ? { sourceOnly: true }")
    expect(read('components/sessions/SessionPanel.tsx')).toContain('{ host: target.host, sourceOnly: target.sourceOnly }')
    // The choice is bound to this document and these threads: a replaced page or thread list hides it.
    expect(pane).toMatch(/\{fileChoices\?\.nonce === nonce && fileChoices\.ownerId === ownerId && fileChoices\.sourceKey === sourceKey && <PathSourceChooser/)
    // Owner, document and sources fence every open in the commit itself (a layout cleanup, never a passive
    // effect), and clear the chooser in the same step; each open also checks the key it was made under.
    expect(pane).toContain('const fileKey = JSON.stringify([ownerId, nonce, sourceKey]);')
    expect(pane).toMatch(/useLayoutEffect\(\(\) => \{\s*fileKeyRef\.current = fileKey;\s*return \(\) => \{ fileSeq\.current\+\+; setFileChoices\(null\); \};\s*\}, \[fileKey\]\);/)
    expect(pane).not.toMatch(/useEffect\(\(\) => \(\) => \{ fileSeq/)
    const use = pane.slice(pane.indexOf('<PathSourceChooser'), pane.indexOf('/>', pane.indexOf('<PathSourceChooser')))
    // A pick only clears the choice (its open keeps the click's fence); Cancel outdates the reads.
    expect(use).toMatch(/onPick=\{\(\) => setFileChoices\(null\)\}\s*onCancel=\{cancelFileChoices\}/)
    expect(use).toContain('hosts={fileChoices.hosts}')
    expect(pane).toContain('const cancelFileChoices = () => { fileSeq.current++; setFileChoices(null); };')
    const chooser = read('components/common/PathSourceChooser.tsx')
    const dialog = chooser.slice(chooser.indexOf('<ConfirmDialog'), chooser.indexOf('onCancel={onCancel}', chooser.indexOf('<ConfirmDialog')) + 'onCancel={onCancel}'.length)
    expect(dialog).toContain('title="Choose the path\'s source"')
    // Each button names its machine first; it clears the choice, then opens through the click that read the machines.
    expect(dialog).toMatch(/onClick=\{\(\) => \{\s*const \{ open \} = pick;\s*onPick\(\);\s*open\(\);/)
    expect(dialog).toContain("{`${hostLabel(pick.host || '__local__')}: ${pick.details.join('; ')}`}")
    expect(dialog).not.toMatch(/sessionId|disabled/)
    // While the machines are read the dialog says so and Cancel works.
    expect(dialog).toContain('Finding the machine each one is on')
    expect(dialog).toMatch(/onConfirm=\{onCancel\}\s*onCancel=\{onCancel\}/)
    expect(frame).toContain('var defineProperty = Object.defineProperty;')
    expect(frame).toContain('var createObject = Object.create;')
    expect(frame).toContain('var descriptor = createObject(null);')
    expect(frame).toContain("defineProperty(msg, 'nonce', descriptor)")
    expect(frame).not.toContain('msg.nonce = NONCE')
    expect(pane).toContain('boardChoiceFileSource(ownerId, choice)')
    expect(read('utils/agent-text-source.ts')).toContain('sourceOnly: true')
    expect(read('components/common/AnywhereFileViewer.tsx')).toContain('req.sourceOnly')
    expect(read('components/common/FileViewer.tsx')).toContain('const lookOnly = picked ? true : sourceOnly;')
    expect(read('components/common/FileViewer.tsx')).toContain('{ host: lookHost, sourceOnly: lookOnly }')
    expect(frame).toContain('var messageSources = new WeakMap()')
    expect(frame).toContain('messageSources.get(node)')
    expect(frame).toContain("var msg = row.getAttribute('data-id') || ''")
    expect(frame).toContain('messageSources.set(row, { thread: thread, msg: msg })')
    expect(frame).not.toContain("a.closest('.wn-msg[data-id]')")
    expect(read('components/board/board-elements.frame.js')).toContain('kit.registerMessageRows(this.wnList, id)')
    // No frame field ever becomes a host or a task id.
    expect(pane).not.toMatch(/\bd\.(host|taskId|task|sessionId|author)\b/)
    expect(pane).not.toMatch(/str\('(host|taskId|task|sessionId|author)'\)[^\n]*openBoardFile/)
    // The only openFileAnywhere calls left are inside openBoardFile, behind its seq guard.
    const start = pane.indexOf('const openBoardFile = useCallback(')
    const end = pane.indexOf('}, [store?.tasks, ownerId]); // eslint-disable-line', start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const opener = pane.slice(start, end)
    const outside = (pane.slice(0, start) + pane.slice(end)).match(/openFileAnywhere\(/g) ?? []
    expect(outside, 'a bare openFileAnywhere outside openBoardFile').toEqual([])
    expect(opener).toMatch(/openFromSource\(src, req, \{\s*lookup: \{ peek: peekSessionRecord, fetch: fetchSession \}/)
    expect(opener).toMatch(/open: \(r\) => \{ if \(current\(\)\) openFileAnywhere\(r\); \}/)
    // A person's text was saved on the primary: it opens there and never borrows the pane's session.
    const primaryAt = opener.indexOf("if (source.primary) { openVia({ host: '__local__' }); return; }")
    expect(primaryAt).toBeGreaterThan(0)
    // The stored session of the post comes next, with no task read.
    const sessionAt = opener.indexOf('if (source.sessionId) { openVia({ sessionId: source.sessionId }); return; }')
    expect(sessionAt).toBeGreaterThan(primaryAt)
    // No saved session: unknown. Never the task's session now, nor the pane's: either may run elsewhere.
    const noneAt = opener.indexOf('failed(NO_SAVED_SESSION);')
    expect(noneAt).toBeGreaterThan(sessionAt)
    expect(opener).not.toMatch(/fetchTask\(|resolveTaskSessionId\(|\bsessionId \?|ownerId === taskId|store\?\.tasks\.find\(\(t\) => t\.id === s(?:ource)?\.taskId\)\s*\?\?/)
    // Several sources: every one's machine is read on this click, fenced like one source; any machine
    // that cannot be told fails the open; copies merged per host, one host opens there with no file probe.
    const among = opener.slice(opener.indexOf('async function openAmong('))
    expect(among.length).toBeGreaterThan(30)
    expect(opener).toContain('if (Array.isArray(target)) { void openAmong(target, bind); return; }')
    expect(among).toContain('if (!s.sessionId) throw new Error(NO_SAVED_SESSION);')
    // Records this page already holds first, with no request: all known and one machine opens with no dialog.
    const knownAt = among.indexOf('try { now = known(); }')
    const pendingAt = among.indexOf('setFileChoices({ req, nonce: bind.nonce, ownerId, sourceKey: bind.sourceKey, hosts: null });')
    const fetchAt = among.indexOf('peekSessionRecord(sid) ?? await fetchSession(sid)')
    expect(among).toMatch(/const record = peekSessionRecord\(sidOf\(s\)\);\s*if \(!record\) return null;/)
    expect(among).toContain('if (now) { offer(now); return; }')
    expect(knownAt).toBeGreaterThan(0)
    expect(pendingAt, 'the pending dialog only once some machine is unknown').toBeGreaterThan(knownAt)
    expect(fetchAt, 'a session read only after the pending dialog shows').toBeGreaterThan(pendingAt)
    expect(among).toContain("if (!record) throw new Error('session not found');")
    expect(among.match(/if \(!current\(\)\) return;/g)?.length).toBe(2)
    expect(among).toContain('const hosts = boardHostChoices(resolved);')
    expect(among).toMatch(/if \(hosts\.length === 1\) \{[\s\S]{0,120}openVia\(\{ host: hosts\[0\]!\.host \}\);/)
    expect(among).toContain('open: () => openVia({ host: h.host })')
    expect(among).not.toMatch(/openFileAnywhere\(|files\/locate|fileExists/)
    expect(opener).toContain("openFileAnywhere({ ...req, sourceFailure: BOARD_SOURCE_UNKNOWN, sourceReason: 'unrecorded' });")
    // A replaced document cancels a lookup just as unmounting does: every check, async ones included, reads both.
    expect(opener).toContain('const key = fileKeyRef.current;')
    expect(opener).toContain('const current = () => mine === fileSeq.current && key === fileKeyRef.current;')
    expect(opener.match(/const current = /g)?.length, 'one fence for the single and the several-source paths').toBe(1)
    // A newer open also drops a source choice still on screen.
    expect(pane).toMatch(/if \(d\.t\.startsWith\('wn-board:open-'\)[^\n]*\) \{ fileSeq\.current\+\+; setFileChoices\(null\); \}/)
  })
})

describe('the Brief (its opener lives in useBriefFileOpener.tsx)', () => {
  const brief = read('components/org/OrgBrief.tsx')
  const opener = read('components/org/useBriefFileOpener.tsx')

  it('OrgBrief opens its paths through the hook and draws its chooser', () => {
    expect(brief).toMatch(/import \{[^}]*\buseBriefFileOpener\b[^}]*\} from '\.\/useBriefFileOpener'/)
    expect(brief).toContain('const onFileOpen = useBriefFileOpener(owner?.id, text, textSources, tasks);')
    expect(brief).toContain('useEntityClickHandler(onOpenTask, undefined, onFileOpen.open, undefined, undefined, true)')
    expect(brief).toContain('{onFileOpen.dialog}')
    // No second opener in the view itself.
    expect(brief).not.toMatch(/openFileAnywhere\(|openFromSource\(|fetchSession\(/)
  })

  it('the hook reads the committed letter, fences every open, and keeps a refused path\'s position', () => {
    expect(opener).toMatch(/const latest = useCommittedRef\(shown\);/)
    expect(opener).not.toMatch(/^ {2}\w+\.current = /m)
    expect(opener).toMatch(/useLayoutEffect\(\(\) => \{\s*setChoices\(null\);\s*return \(\) => \{ seq\.current\+\+; \};\s*\}, \[sourceKey\]\);/)
    expect(opener).toContain('const current = () => mine === seq.current && latest.current.sourceKey === key;')
    expect(opener.match(/const current = /g)?.length).toBe(1)
    expect(opener).toMatch(/if \(current\(\)\) \{\s*openFileAnywhere\(\{\s*\.\.\.req, sourceFailure: sourceFailureText\(reason\), sourceReason: reason,/)
    expect(opener).toMatch(/open: \(r\) => \{ if \(current\(\)\) openFileAnywhere\(r\); \}/)
    expect(opener.match(/openFileAnywhere\(/g)?.length, 'only the two fenced calls').toBe(2)
    expect(opener).toMatch(/<PathSourceChooser[\s\S]*?onPick=\{\(\) => setChoices\(null\)\}\s*onCancel=\{cancel\}/)
    expect(opener).toContain('const cancel = () => { seq.current++; setChoices(null); };')
  })
})
