/**
 * The phone's twin of answer-box-pictures-guard.test.ts: every iOS box whose words go to an AI
 * takes pictures, as the chat composer does (2026-11-03, the user: "the follow up in org thread or
 * anywhere ... should be able to copy pictures"). A letter's reply and decision note and a
 * question's "Other" answer took text only.
 *
 * The members are read from source, so a new box fails here until it is decided: every Swift file
 * under ios-native/Walnut that draws a text input (TextField, TextEditor, the letter reply
 * field) either takes pictures (the chat's ComposerBar, or ReplyPictureButton from
 * Views/Shared/ReplyPictures.swift) or is listed below with why it stays text only.
 * And the sends the picture boxes feed carry the pictures on the wire.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const IOS = path.resolve(import.meta.dirname, '../../ios-native/Walnut')

/** Files whose text inputs write to an AI but stay text only, and why. */
const TEXT_ONLY_TO_AI: Record<string, string> = {
  'Views/Chat/ChatView.swift': "a system alert's one text field (the first message of a chat not started yet); the chat that opens next takes pictures",
  'Views/Sessions/Changes/DiffReviewViews.swift': "a line comment on a diff goes in the review message, text in the web diff's exact format; the session's composer takes pictures",
  'Views/Sessions/NewSessionSheet.swift': "a new session's optional first message rides the start route, which carries text only; the session's composer takes pictures",
  'Views/Sessions/SessionComposerSheets.swift': "a fork's optional first message rides the fork route, which carries text only; the fork's composer takes pictures",
  'Views/Sessions/SessionExtrasSheets.swift': "a side question is asked of the live CLI through its side-question channel, which carries text only",
  'Views/Sessions/SessionQueueViews.swift': "a queued message is edited through the queue route's PATCH, which carries text only; pictures are added when the message is composed",
  'Views/Settings/RoutineEditor.swift': "a routine's form: the message it sends is stored with the routine and sent at each run by the routines route, which carries text only (as the web's routine form)",
}

/** Files whose text inputs never reach an AI as a message, and what they hold. */
const NOT_TO_AI: Record<string, string> = {
  'Views/Calendar/CalendarCreateSheet.swift': 'a calendar event',
  'Views/Calendar/CalendarRows.swift': 'a calendar event',
  'Views/Chat/ChatDrawer.swift': "a chat's title",
  'Views/Inbox/InboxItemConfirmation.swift': "a mail item's task title and goal, kept on the item before any session exists",
  'Views/Inbox/InboxItemTaskSelector.swift': 'a task search',
  'Views/Notes/NoteEditorView.swift': 'a note (its editor takes pictures of its own)',
  'Views/Notes/NotesView.swift': 'a note search',
  'Views/Passwords/PasswordsSetupView.swift': 'the master password and Secret Key, which open the vault on this phone and never go to an AI',
  'Views/Sessions/AgentMemorySheet.swift': "a task's agent memory, a document the agent reads, not a message",
  'Views/Sessions/SessionLifecycleDialogs.swift': "a session's title",
  'Views/Sessions/SessionPathPicker.swift': 'a folder path',
  'Views/SetupView.swift': 'the pairing address and code',
  'Views/Tasks/TaskDetailSheet.swift': "a task's fields",
  'Views/Tasks/TaskFieldEditorSheet.swift': "a task's description or note, a document the task keeps, not a message",
  'Views/Tasks/TaskProjectPicker.swift': 'a project search or a new project name',
}

const INPUT_RE = /\b(?:TextField|TextEditor|LetterReplyField)\s*\(/
/** Source without comments, so a name in a comment neither adds nor approves a box. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
const TAKES_PICTURES_RE = /\b(?:ComposerBar|ReplyPictureButton)\s*\(/

function swiftFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...swiftFiles(full))
    else if (entry.name.endsWith('.swift')) out.push(full)
  }
  return out
}

const read = (rel: string) => fs.readFileSync(path.join(IOS, rel), 'utf8')

describe('every iOS box that writes to an AI takes pictures', () => {
  const files = swiftFiles(IOS).map((f) => path.relative(IOS, f).split(path.sep).join('/'))
  const src = (f: string) => code(fs.readFileSync(path.join(IOS, f), 'utf8'))
  const withInput = files.filter((f) => INPUT_RE.test(src(f)))

  it('each view with a text input takes pictures or says why not', () => {
    const undecided = withInput.filter((f) => {
      return !TAKES_PICTURES_RE.test(src(f)) && !(f in TEXT_ONLY_TO_AI) && !(f in NOT_TO_AI)
    })
    expect(undecided, 'a new text input: take pictures (ReplyPictureButton) or list it with why').toEqual([])
    expect(withInput.length).toBeGreaterThan(15)
  })

  it('catches a new box: an input with no pictures in a file nobody listed', () => {
    const fake = code('struct NewBox: View { var body: some View { TextField("Ask the agent", text: $t) } } // ReplyPictureButton(')
    expect(INPUT_RE.test(fake) && !TAKES_PICTURES_RE.test(fake)).toBe(true)
  })

  it('the lists only name files that still exist, still have an input, and still take none', () => {
    const stale = [...Object.keys(TEXT_ONLY_TO_AI), ...Object.keys(NOT_TO_AI)].filter((f) => {
      if (!withInput.includes(f)) return true
      return TAKES_PICTURES_RE.test(src(f))
    })
    expect(stale).toEqual([])
  })

  it('the boxes made for this take pictures: the letter reply and note, the question card, Talk to CEO', () => {
    const reader = read('Views/Inbox/LetterReaderView.swift')
    expect(reader).toMatch(/ReplyPictureButton\(\s*images: replyPictures/)
    expect(reader).toMatch(/ReplyPictureButton\(\s*images: \$decisionPictures/)
    expect(reader).toMatch(/onPasteImages:/)
    expect(reader).toMatch(/inbox\.answer\([\s\S]{0,120}images: pictures/)
    expect(reader).toMatch(/replies\.beginSend\([\s\S]{0,120}images: pictures/)
    expect(read('Views/Sessions/PermissionRequestCard.swift')).toMatch(/ReplyPictureButton\(/)
    // Talk to CEO: the words and pictures go to Main, whose route takes inline images.
    const ceo = read('Views/Inbox/CeoNoteSheet.swift')
    expect(ceo).toMatch(/onSend\(words, pictures\.wrappedValue\)/)
    // A failed send keeps the pictures as it keeps the words: both live in the draft store,
    // cleared together only once the CEO has them.
    expect(ceo).toMatch(/drafts\.images\(key\)/)
    expect(ceo).not.toMatch(/@State private var pictures/)
    expect(read('Views/Inbox/ContentActionButtons.swift')).toMatch(/if case \.sent = outcome \{ ComposerDrafts\.shared\.clear\(CeoNoteSheet\.draftKey\(item\)\) \}/)
    expect(read('API/WalnutAPIContent.swift')).toMatch(/"\/content\/ceo"[\s\S]{0,120}images: images\.isEmpty \? nil : images/)
    // A question's answer and its pictures go in one request (question-answer-pictures-guard.test.ts).
    expect(read('Views/Sessions/SessionConversationView.swift')).toMatch(/respondPermission\(request, allow: true, answers: answers, images: payloads\)/)
  })

  it('the wire carries them, inline as the chat sends them', () => {
    expect(read('API/WalnutAPILetterReply.swift')).toMatch(/let images: \[ImagePayload\]\?/)
    expect(read('API/WalnutAPIInbox.swift')).toMatch(/"\/human-inbox\/\\\(escape\(id\)\)\/answer"[\s\S]{0,200}images: images\.isEmpty \? nil : images/)
    expect(read('Stores/LetterReplyStore.swift')).toMatch(/SelectedImage\.buildPayloads\(pendingImages\[clientId\]/)
    // An Org thread's Follow up (the user, 2026-11-03: "the follow up in org thread ... should be
    // able to copy pictures") sends them with its words into the node's chat. The words and
    // pictures live in the draft store (`ComposerDrafts`), so a push closing the sheet keeps them.
    const followUp = read('Views/Org/OrgThreadsView.swift')
    expect(followUp).toMatch(/Binding\(get: \{ drafts\.images\(draftKey\) \}/)
    expect(followUp).toMatch(/ReplyPictureButton\(\s*images: images,/)
    expect(followUp).toMatch(/pictures = images\.wrappedValue[\s\S]{0,80}await send\(words, pictures\)/)
    expect(read('Views/Org/OrgThreadsStore.swift')).toMatch(/SelectedImage\.buildPayloads\(images\.map/)
    expect(read('API/WalnutAPIThreads.swift')).toMatch(/images: images\.isEmpty \? nil : images, messageId: messageId, threadId: threadId/)
  })

  it('one rule set: the reply pictures take the chat composer limits', () => {
    const shared = read('Views/Shared/ReplyPictures.swift')
    expect(shared).toMatch(/ComposerBar\.attach\(/)
    expect(shared).toMatch(/ComposerBar\.maxImages/)
  })
})
