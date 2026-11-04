/**
 * What Walnut tells the model for the person rides as a message hint, never inside the person's
 * words (2026-11-04, the user: the side panel's "You can act in this tab..." was "some automatic
 * thing", not his; it went into his message, so it read as his and `sentBy: "person"` carried it).
 *
 * Two ways the web put Walnut's words into a message, each guarded here:
 * - a launch whose message folded the object's context in front of the question (AskObjectDrawer,
 *   every "ask about this" surface: a mail, a web page). It is the `object-context` hint now.
 * - text put into a composer for the person. Only text the person reads and may edit before they
 *   send is allowed there (a quote, a task reference, a phrase they finish), each listed with why.
 *   A new caller fails until it is listed, or it sends a hint instead (utils/pending-hints.ts).
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const WEB = path.resolve(__dirname, '../../web/src')

function files(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...files(p))
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}
const rel = (p: string) => path.relative(WEB, p).split(path.sep).join('/')

/** Every place that puts text into a composer, and why that text is the person's to send. */
const COMPOSER_TEXT: Record<string, string> = {
  'components/tasks/QuoteInSessionItem.tsx': 'a task reference the person picked; it shows in the composer and they write around it',
  'utils/wait-until.ts': 'the start of a snooze request the person finishes and sends; shown and editable',
  'pages/MainPage.tsx': 'the same snooze phrase, and text the person dropped into a new chat; shown and editable',
  'components/sessions/SessionChatHistory.tsx': 'the words of a card the person chose to answer from; shown and editable',
  'components/org/OrgNodeDetail.tsx': 'a quote of an ask the person chose to answer; shown and editable',
  'popout/PopoutExtPanel.tsx': 'a quote of the text the person selected on the page; shown and editable (the act note is a hint)',
}
const PLUMBING = new Set(['utils/composer-insert.ts', 'components/sessions/SessionPanel.tsx', 'components/sessions/DraftSessionPanel.tsx'])

describe('Walnut\'s words for the model are hints, not the person\'s words', () => {
  it('every caller that puts text into a composer is listed with why the text is the person\'s', () => {
    const found = files(WEB)
      .filter((f) => /insertIntoSessionComposer\(|seedDraftComposer\(|new CustomEvent<ComposerInsertDetail>\(COMPOSER_INSERT_EVENT/.test(fs.readFileSync(f, 'utf8')))
      .map(rel)
      .filter((f) => !PLUMBING.has(f))
      .sort()
    expect(found).toEqual(Object.keys(COMPOSER_TEXT).sort())
  })

  it('an ask about an object sends the question alone; the context goes as the object-context hint', () => {
    const drawer = fs.readFileSync(path.join(WEB, 'components/chat/AskObjectDrawer.tsx'), 'utf8')
    expect(drawer).toMatch(/message: question,/)
    expect(drawer).toMatch(/hints: objectContextHints\(contextId\)/)
    for (const f of files(WEB)) {
      const src = fs.readFileSync(f, 'utf8')
      // The old folded block: `[Name]\n<context>\n[/Name]` in front of the question.
      expect(src, rel(f)).not.toMatch(/`\[\$\{[^}]+\}\]\\n\$\{[^}]+\}\\n\[\/\$\{/)
      expect(src, rel(f)).not.toMatch(/askObjectFirstMessage/)
    }
  })

  it('the side panel never types Walnut\'s note into the person\'s message', () => {
    const panel = fs.readFileSync(path.join(WEB, 'popout/PopoutExtPanel.tsx'), 'utf8')
    expect(panel).not.toMatch(/insertInto\([^)]*act/i)
    expect(panel).toMatch(/setPendingHints(Source)?\(/)
  })
})
