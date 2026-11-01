/**
 * Every box a person answers in, in their own words, is Walnut's AnswerBox
 * (web/src/components/common/AnswerBox.tsx): the composer's look, growing with the text, no native
 * resize grip, the composer's mic inside. 2026-10-31, the user, on the Org rail's answer box
 * (translated): "add the voice box ... don't use the native one ... use our Walnut input bar".
 *
 * The members are read from source: every web file with a raw <textarea> is classified here, so a
 * new one fails until it is decided. An answer box uses AnswerBox and draws no raw <textarea>; a
 * composer (a message to a session, a mail body) keeps its own box but must carry the mic; a form
 * or an editor says why it is neither. And no one-line <input> asks for an answer in words.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const WEB_SRC = path.resolve(import.meta.dirname, '../../web/src')

type Kind = { kind: 'answer' } | { kind: 'composer' } | { kind: 'form'; why: string }
const ANSWER: Kind = { kind: 'answer' }
const COMPOSER: Kind = { kind: 'composer' }
const form = (why: string): Kind => ({ kind: 'form', why })

const BOXES: Record<string, Kind> = {
  // Answers in words.
  'components/org/OrgInlineAnswer.tsx': ANSWER,
  'components/inbox/LetterView.tsx': ANSWER,
  'components/common/PermissionAnswerForm.tsx': ANSWER,
  'components/sessions/PromptCards.tsx': ANSWER,
  'apps/mail/MailGroupCard.tsx': ANSWER,
  'apps/mail/MailCorrectStepWhere.tsx': ANSWER,
  'components/inbox/ItemConfirmation.tsx': ANSWER,
  'components/org/OrgThreads.tsx': ANSWER,
  // Composers: a message to a session or a person, with their own send row.
  'components/chat/ChatInput.tsx': COMPOSER,
  'components/org/OrgComposerBar.tsx': COMPOSER,
  'components/sessions/ThreadCommentCard.tsx': COMPOSER,
  'components/sessions/QuotePinSelectionBar.tsx': ANSWER,
  'components/board/kanban/KanbanCardComposer.tsx': COMPOSER,
  'apps/mail/compose/ComposerPanel.tsx': COMPOSER,
  'components/sessions/SessionChatHistory.tsx': COMPOSER,
  'components/sessions/SessionDiffView.tsx': COMPOSER,
  'components/transfer/TransferDialog.tsx': COMPOSER,
  'components/sessions/TriggerPickerPopover.tsx': COMPOSER,
  // Forms and editors: settings, code, instructions, never an answer to an ask.
  'components/common/AnswerBox.tsx': form('the shared box itself'),
  'components/agents/AgentForm.tsx': form("an agent's instructions"),
  'components/commands/CommandForm.tsx': form("a command's prompt text"),
  'components/common/AppErrorBoundary.tsx': form('a crash report to copy'),
  'components/common/CollapsibleUrlEditor.tsx': form('a note editor'),
  'components/notes/RawMarkdownView.tsx': form('a raw markdown editor'),
  'components/org/AgentMemoryPanel.tsx': form("an agent's memory editor"),
  'components/org/OrgNodeEditor.tsx': form("a VP's instructions editor"),
  'components/repositories/RepoForm.tsx': form("a repository's settings"),
  'components/routines/RoutineComposer.tsx': form("a routine's prompt"),
  'components/routines/RoutineForm.tsx': form("a routine's settings"),
  'components/sessions/SessionCommitRepo.tsx': form('a commit message'),
  'components/settings/CopyDiagnostics.tsx': form('diagnostics text to copy'),
  'components/settings/sections/MessageHintsGroup.tsx': form("a hint's text"),
  'components/settings/sections/PluginConfigCards.tsx': form("a plugin's settings"),
  'components/settings/sections/RemoteHostsSection.tsx': form("a host's setup script"),
  'components/settings/sections/cloud/CloudManualPaste.tsx': form('a setup script to paste'),
  'components/tasks/PhoneTaskDetailHead.tsx': form("a task's title"),
  'components/tasks/TaskForm.tsx': form("a task's fields"),
  'components/board/kanban/KanbanCardEditor.tsx': form("a card's fields"),
  'components/board/board-items.frame.js': form("the Board frame's hidden mark field; the note is written in BoardReplyDock (ChatInput)"),
}

/** One-line inputs inside an answer surface that take a name, not an answer: [a piece of the tag, why]. */
const NAME_INPUTS: [string, string][] = [
  ['data-testid="mail-group-card-name"', "a mail group's new name"],
  ['data-testid="mail-correct-new-group"', "a new mail group's name"],
  ['`${field}title`', "the task's title"],
]

/** One-line inputs whose placeholder reads like an answer but is a setting. */
const NOT_ANSWER_INPUTS: Record<string, string> = {
  'components/settings/sections/SessionsSection.tsx': 'the reply language setting',
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (/\.(tsx|jsx|js)$/.test(e.name)) out.push(path.relative(WEB_SRC, full))
  }
  return out
}
const FILES = walk(WEB_SRC)
const read = (rel: string) => fs.readFileSync(path.join(WEB_SRC, rel), 'utf8')
const withTextarea = FILES.filter((f) => /<textarea\b/.test(read(f)) || /'<textarea\b/.test(read(f)))

describe('every free-text answer box is the AnswerBox', () => {
  it('classifies every file with a raw textarea', () => {
    const unknown = withTextarea.filter((f) => !BOXES[f])
    expect(unknown, 'a new text box: answer (use AnswerBox), composer (with the mic), or a form (say why)').toEqual([])
  })

  it('lists only files that still exist', () => {
    expect(Object.keys(BOXES).filter((f) => !fs.existsSync(path.join(WEB_SRC, f)))).toEqual([])
  })

  it.each(Object.entries(BOXES).filter(([, k]) => k.kind === 'answer').map(([f]) => f))('%s answers in the AnswerBox', (rel) => {
    const src = read(rel)
    expect(src).toMatch(/<AnswerBox\b/)
    expect(src, 'no raw textarea in an answer surface').not.toMatch(/<textarea\b/)
  })

  it('the prompt cards\' and the permission form\'s "other" answers are AnswerBoxes (they were one-line inputs)', () => {
    expect(read('components/sessions/PromptCards.tsx')).toMatch(/function AskOtherInput[\s\S]*?<AnswerBox\b/)
    expect(read('components/common/PermissionAnswerForm.tsx')).toMatch(/function OtherAnswerInput[\s\S]*?<AnswerBox\b/)
    for (const rel of Object.entries(BOXES).filter(([, k]) => k.kind === 'answer').map(([f]) => f)) {
      const src = read(rel)
      const texty = [...src.matchAll(/<input\b/g)].map((m) => src.slice(m.index!, src.indexOf('/>', m.index!) + 2))
        .filter((tag) => !/type=["'](checkbox|radio|hidden|file|range|color)["']/.test(tag))
        .filter((tag) => !NAME_INPUTS.some(([piece]) => tag.includes(piece)))
      expect(texty, `${rel}: an answer surface types words only in its AnswerBox`).toEqual([])
    }
  })

  it.each(Object.entries(BOXES).filter(([, k]) => k.kind === 'composer').map(([f]) => f))('%s carries the mic', (rel) => {
    expect(read(rel)).toMatch(/<(BoxMic|MicField|MicButton|AnswerBox|ChatInput)\b/)
  })

  it('the AnswerBox has the mic and no native resize grip', () => {
    expect(read('components/common/AnswerBox.tsx')).toMatch(/<BoxMic\b/)
    const css = fs.readFileSync(path.join(WEB_SRC, 'styles/answer-box.css'), 'utf8')
    expect(css).toMatch(/\.answer-box-input\s*\{[^}]*resize:\s*none/)
  })

  it('no one-line input asks for an answer in words', () => {
    const offenders: string[] = []
    for (const f of FILES) {
      if (NOT_ANSWER_INPUTS[f]) continue
      const src = read(f)
      // A JSX tag spans lines and its props hold arrows (`=>`): read it up to its `/>`.
      for (const m of src.matchAll(/<input\b/g)) {
        const end = src.indexOf('/>', m.index!)
        const tag = src.slice(m.index!, end < 0 ? m.index! + 400 : end + 2)
        if (/type=["'](checkbox|radio|date|number|file|hidden|range|color|password|email|url|search)["']/.test(tag)) continue
        if (/placeholder=[^>]*\b(answer|reply|your own words|other)\b/i.test(tag)) offenders.push(`${f}: ${tag.slice(0, 120)}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
