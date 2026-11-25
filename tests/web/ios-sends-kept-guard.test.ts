/**
 * Guard: every place the phone sends a person's words to an agent keeps them until a server has
 * them, or gives them back to the person to send again.
 *
 * 2026-11-25 (Evan): "when mac is unavilable, the action button send to COE thing jsut fail and the
 * request won't be save I can't retyr etc it jsut lost". The Action Button's note met a 501 on
 * `/org/main` and then a 503 for the CEO's session, and read as a refusal nothing sent again; a
 * words-only send on a session page lived only in memory, so an app that ended lost it. The rule
 * now: either the server holds the words (the companion's queue), or the phone keeps them (on disk,
 * in the box they were typed in, or as the button tapped) with a way to send them again.
 *
 * Each call below is one way out of the phone for words, listed with how its words are kept. A new
 * call (a new file, or another call in a listed file) fails here until it is listed with how it
 * keeps its words; a call that went lowers its count. The server half is
 * tests/web/routes/cloud-send-503-ratchet.test.ts.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
const APP = path.join(ROOT, 'ios-native')
/** Where the calls are defined, or a demo server answers them: no person's send there. */
const SKIP = [/\/Walnut\/API\//, /\/Walnut\/Demo\//, /\/WalnutTests\//, /\/WalnutUITests\//]

/** The API calls that carry a person's words to an agent. */
const SENDS = [
  'sendSessionMessage', 'sendMessage', 'joinMessage', 'launchSession', 'launchAsk', 'startTask',
  'replyToLetter', 'answerLetter', 'sendThreadFollowUp', 'askSideQuestion', 'answerConversationQuestion',
  'contentCeo', 'talkSend', 'talkLaunch', 'respondSessionPermission',
]

type Kept = { count: number; how: string }
/** `<call> <file>` → how many calls there are, and how their words are kept. */
const KEPT: Record<string, Kept> = {
  'sendSessionMessage Walnut/Stores/SessionConversationStore.swift': {
    count: 1, how: 'every send on disk until accepted (PendingFileSends, words alone too), put back when the page opens, retried on the ladder, then "Not sent - tap to retry"',
  },
  'talkSend Walnut/Talk/TalkMainSender.swift': {
    count: 1, how: 'the Action Button take is on disk first (TalkOutbox); a Mac or computer away waits and goes out by itself with no try limit (TalkReason.waitsForComputer)',
  },
  'talkLaunch Walnut/Talk/TalkMainSender.swift': { count: 1, how: 'the same take on disk (TalkOutbox); a start whose answer was lost says it may have arrived' },
  'sendMessage Walnut/Stores/ChatStore.swift': {
    count: 1, how: 'a direct send on disk until accepted (PendingFileSends under its chat key), back as "tap to retry"; banked sends in the durable queue',
  },
  'joinMessage Walnut/Stores/ChatStore.swift': { count: 1, how: 'a send into the running turn goes back in the durable queue when the turn cannot take it, else a failed bubble' },
  'answerConversationQuestion Walnut/Stores/ChatStore.swift': { count: 1, how: 'the answer stays in the composer when it is not taken' },
  'launchSession Walnut/Views/Sessions/NewSessionChatView.swift': { count: 1, how: 'the first message is kept (NewSessionLaunchWords) and given back to the composer on a refusal' },
  'launchSession Walnut/Views/Sessions/NewSessionSheet.swift': { count: 1, how: 'the sheet stays open with its first message on a failure' },
  'launchAsk Walnut/Views/Chat/ChatView.swift': { count: 2, how: 'a node\'s first words are kept per node (orgFirstMessageKey) until its chat starts' },
  'startTask Walnut/Views/Chat/ChatView.swift': { count: 1, how: 'the same per-node first words (orgFirstMessageKey)' },
  'replyToLetter Walnut/Stores/LetterReplyStore.swift': { count: 2, how: 'pending replies on disk with Retry under the same clientId; the companion holds them for the Mac' },
  'replyToLetter Walnut/Views/Tasks/ActionNeededView.swift': { count: 1, how: 'the reply box keeps its words on a failure (failureNote), same clientId on the next try' },
  'replyToLetter Walnut/Stores/InboxStore.swift': { count: 1, how: 'no caller sends through it (letters reply through LetterReplyStore); a failure is returned to the caller' },
  'answerLetter Walnut/Stores/InboxStore.swift': { count: 1, how: 'an option tapped: on a failure the buttons stay armed to tap again' },
  'answerLetter Walnut/Views/Tasks/ActionNeededView.swift': { count: 1, how: 'an option tapped: the item reopens with "Not sent. Try again."' },
  'sendSessionMessage Walnut/Views/Tasks/ActionNeededView.swift': { count: 3, how: 'words: the reply box keeps them (failureNote); an option: the item reopens with "Not sent. Try again."' },
  'respondSessionPermission Walnut/Views/Tasks/ActionNeededView.swift': { count: 3, how: 'the reply box keeps its words, or the item reopens' },
  'respondSessionPermission Walnut/Stores/SessionLifecycleController.swift': { count: 1, how: 'the prompt card comes back (pendingPermissions restored, the answer returns false) to answer again' },
  'sendThreadFollowUp Walnut/Views/Org/OrgThreadsStore.swift': { count: 1, how: 'the follow-up box keeps its draft on a failure ("Not sent. Your words and pictures are still here."); a choice stays on its card' },
  'askSideQuestion Walnut/Views/Sessions/SessionExtrasSheets.swift': { count: 1, how: 'the question stays in its field until answered' },
  'contentCeo Walnut/Views/Inbox/ContentActionButtons.swift': { count: 1, how: 'the note and pictures stay in their draft (ComposerDrafts) until they reached the CEO' },
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (!['DerivedData', 'build', '.build'].includes(e.name)) walk(p, out) } else if (e.name.endsWith('.swift')) out.push(p)
  }
  return out
}

/** Swift without its comments: a call named in a doc comment is not a send. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"])\/\/.*$/gm, '$1')
}

function calls(): Map<string, number> {
  const found = new Map<string, number>()
  for (const file of walk(APP)) {
    const rel = path.relative(APP, file)
    if (SKIP.some((re) => re.test('/' + rel))) continue
    const src = code(fs.readFileSync(file, 'utf8'))
    for (const fn of SENDS) {
      const n = src.split(new RegExp(`\\.${fn}\\(`)).length - 1
      if (n > 0) found.set(`${fn} ${rel}`, (found.get(`${fn} ${rel}`) ?? 0) + n)
    }
  }
  return found
}

describe('every phone send keeps the words until a server has them', () => {
  it('reads the sends from the app source (the scan finds the known ones)', () => {
    const found = calls()
    expect(found.get('sendSessionMessage Walnut/Stores/SessionConversationStore.swift')).toBe(1)
    expect(found.get('talkSend Walnut/Talk/TalkMainSender.swift')).toBe(1)
  })

  it('every send is listed with how its words are kept, and none was added', () => {
    const unlisted = [...calls()].filter(([key, n]) => n > (KEPT[key]?.count ?? 0)).map(([key, n]) => `${key} (${n})`)
    expect(unlisted, 'a new way out for the person\'s words: keep them until a server has them, then list it here').toEqual([])
  })

  it('the list holds no send that is gone (it only shrinks)', () => {
    const found = calls()
    const stale = Object.entries(KEPT).filter(([key, { count }]) => (found.get(key) ?? 0) < count).map(([key]) => key)
    expect(stale, 'a send left the app: lower or remove its entry').toEqual([])
  })

  it('the session page keeps a words-only send on disk, not only one with files', () => {
    const src = fs.readFileSync(path.join(APP, 'Walnut/Stores/SessionConversationStore.swift'), 'utf8')
    const send = src.slice(src.indexOf('func send(_ text: String, images:'), src.indexOf('private func closeRun('))
    expect(send).toContain('PendingFileSends.save(')
    expect(send, 'the save must not hang on the send having files').not.toMatch(/if !files\.isEmpty \{[^}]*PendingFileSends\.save/)
  })

  it('the Action Button reads a Mac that is away as waiting, never as a refusal', () => {
    const src = fs.readFileSync(path.join(APP, 'Walnut/Talk/TalkMainSender.swift'), 'utf8')
    expect(src).toMatch(/isLeaderUnreachable[\s\S]{0,80}TalkReason\.macAway/)
  })
})
