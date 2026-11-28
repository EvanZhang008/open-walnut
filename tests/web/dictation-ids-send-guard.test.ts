/**
 * The class of the 2026-11-22 Voice Accuracy review: the text a person sent after a dictation was
 * paired with its take by how alike the texts were, so two alike dictations swapped and an edited
 * or late send paired nothing. A send now names the recordings dictated into it with the
 * composer's own text (`dictationIds`, `dictationText`; `dictation` on the server's sends) and the
 * server pairs each exactly (src/core/stt/compare/sent-text.ts).
 *
 * These checks parse every call of the send paths of a person's message (tests/helpers/send-call-scan.ts):
 * on the web every sendSessionMessage call, on the server every call of the shared send functions
 * (FUNNELS), however it is reached (a dynamic import too). A call whose source is a person's must
 * carry the dictation in its own argument object; a call whose source is a variable must say where
 * the source comes from. Either may instead be a KNOWN call site (its file and a piece of its own
 * text) that says why it carries none. A KNOWN entry that matches no call, or more than one, fails.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { propOf, sendCalls, spreads, topLevel, type SendCall } from '../helpers/send-call-scan'

const ROOT = path.resolve(__dirname, '../..')
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...walk(p)) }
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(path.relative(ROOT, p))
  }
  return out
}

interface Source { file: string; source: string }
const sourcesOf = (dir: string): Source[] => walk(path.join(ROOT, dir)).map((file) => ({ file, source: read(file) }))

/** A call site: its file, and a piece of its own text (or a pattern for one that spans lines). */
interface Known { file: string; anchor: string | RegExp; why: string; funnel?: string }
const holds = (k: Known, c: SendCall) => c.file === k.file && (typeof k.anchor === 'string' ? c.text.includes(k.anchor) : k.anchor.test(c.text))
const at = (c: SendCall) => `${c.file}:${c.line}`

/** The KNOWN entry a call matches: same file, its anchor in the call's own text. */
const knownOf = (known: readonly Known[], c: SendCall) => known.find((k) => holds(k, c))

// ---------------------------------------------------------------- server

/** The shared send functions, with the place of the argument that holds the options. */
const FUNNELS: Record<string, number> = { sendMessageToSession: 3, deliverToSession: 2, performSessionSend: 1, runLaneTurn: 4 }
const PERSON = /'(ui|mobile|cli|web-api|api-v1|chat|human-inbox|side-thread|cloud-fallback)'/

type Kind = 'person' | 'variable' | 'walnut'
/** Whose a call's source is: a person's (a literal person source in it), a variable's, or Walnut's own (a literal or a constant). */
function kindOf(opts: string | undefined): Kind {
  if (opts === undefined) return 'walnut' // no options: no source, an agent's
  if (!opts.trim().startsWith('{')) return 'variable' // the caller's options passed through
  const source = propOf(opts, 'source')
  if (source === undefined) return spreads(opts) ? 'variable' : 'walnut'
  if (PERSON.test(source)) return 'person'
  return /['"`]|\b[A-Z][A-Z0-9_]{2,}\b/.test(source) ? 'walnut' : 'variable'
}

/** Its options name the dictation: a `dictation` property, or a spread that writes one (`...(d ? { dictation: d } : {})`). */
function carriesDictation(opts: string | undefined): boolean {
  if (!opts?.trim().startsWith('{')) return false
  if (propOf(opts, 'dictation') !== undefined) return true
  const t = opts.trim()
  return topLevel(t.slice(1, t.lastIndexOf('}'))).some((e) => e.startsWith('...') && /\{\s*dictation\b/.test(e))
}

/** Server send calls that carry no dictation although a person's source may reach them, and why. */
const SRC_KNOWN: Known[] = [
  // A person's source, no recordings named: paired by text (`text-similarity`) when at all.
  { file: 'src/core/human-inbox/letter-ops.ts', anchor: "source: human.by ? 'peer' : 'human-inbox'", why: "a letter's answer: the inbox reply box names no recordings yet" },
  { file: 'src/core/org/thread-reply.ts', anchor: 'sendMessageToSession(sid, prepared.displayText', why: "a reply on an Org thread: the thread's reply box names no recordings yet" },
  { file: 'src/core/org/thread-follow.ts', anchor: 'sendMessageToSession(s.claudeSessionId, prepared.displayText', why: 'a thread moved to the team that now does it: its words were sent (and paired) before' },
  { file: 'src/core/sessions/session-lifecycle.ts', anchor: 'sendMessageToSession(session.claudeSessionId, message', why: 'the HTTP send of the CLI and scripts: no dictation' },
  { file: 'src/core/sessions/session-extras.ts', anchor: 'sendMessageToSession(actualPlanSessionId, planMessage', why: 'a plan approval sent over HTTP: Walnut writes its words' },
  { file: 'src/core/sessions/side-thread-manager.ts', anchor: 'sendMessageToSession(threadSessionId, prepared.enqueueText', why: 'a side-thread question: its drawer composer has no draft key, so no recordings are known' },
  { file: 'src/web/routes/session-send-v1.ts', anchor: "source: routeSource('mobile', req)", why: "the phone app's send: its takes are phone recordings, paired by text" },
  { file: 'src/providers/daemon-connection.ts', anchor: /^sendMessageToSession\(sessionId, message, \{\s*source: 'mobile',/, why: "the phone's message relayed by the companion: paired by text" },
  { file: 'src/web/routes/chat.ts', anchor: 'runLaneTurn(agentId, conversationId, sessionMessage', why: 'the HTTP chat route (POST /api/chat): its client names no recordings yet, paired by text' },
  { file: 'src/web/routes/cloud-chat-fallback.ts', anchor: 'runLaneTurn(agentId, conversationId, text', why: "the person's chat on the companion: its recordings are the companion's, not this server's" },
  // A source in a variable: where it comes from.
  { file: 'src/core/sessions/session-send-core.ts', anchor: 'source: opts.source', why: 'inside deliverToSession: its callers are scanned', funnel: 'deliverToSession' },
  { file: 'src/core/sessions/session-send-core.ts', anchor: 'deliverToSession(target.session', why: 'inside performSessionSend (performPlainSend): its callers are scanned', funnel: 'performSessionSend' },
  { file: 'src/core/sessions/session-send-core.ts', anchor: 'source: answerSource', why: "a session's answer to another session (programSendSource): an agent's" },
  { file: 'src/core/sessions/lane-turn.ts', anchor: 'caught.message', why: 'inside runLaneTurn: its callers are scanned', funnel: 'runLaneTurn' },
  { file: 'src/core/sessions/lane-turn.ts', anchor: 'sendMessageToSession(sid, text, { source: opts.source, messageId })', why: "a message joining runLaneTurn's turn: runLaneTurn's callers are scanned", funnel: 'runLaneTurn' },
  { file: 'src/core/sessions/context-full-recovery.ts', anchor: 'sendMessageToSession(id, text, opts)', why: "the recovery's deps: its sends are Walnut's notes (CONTEXT_*_SOURCE)" },
  { file: 'src/core/sessions/endpoint-wait.ts', anchor: 'sendMessageToSession(sid, text, opts)', why: "the endpoint wait's deps: Walnut's continue notes" },
  { file: 'src/core/sessions/auto-recover-env.ts', anchor: 'sendMessageToSession(sessionId, message, opts)', why: "the restart recovery's deps: Walnut's resume notes" },
  { file: 'src/core/sessions/usage-limit-wait.ts', anchor: 'sendMessageToSession(sid, text, opts)', why: "the usage-limit wait's deps: Walnut's continue note (AUTO_CONTINUE_SOURCE)" },
  { file: 'src/core/sessions/safeguard-switch.ts', anchor: 'sendMessageToSession(id, text, opts)', why: "the safeguard switch's deps: Walnut's notes" },
  { file: 'src/core/sessions/idle-compaction.ts', anchor: 'sendMessageToSession(id, text, opts)', why: "the idle compaction's deps: Walnut's quiet turn" },
  { file: 'src/core/session-auto-continue.ts', anchor: 'sendMessageToSession(sessionId, message, opts)', why: "auto continue's deps: Walnut's continue notes" },
  { file: 'src/core/sessions/reply-outbox.ts', anchor: 'source: owed.source', why: 'a reply owed to an asking session: an agent\'s' },
  { file: 'src/core/sessions/task-session-claim.ts', anchor: /^performSessionSend\(\{\s*to: record\.claudeSessionId/, why: "a start's first message into a task's existing conversation (quick-start, task-start): a start names no recordings yet" },
  { file: 'src/core/boards/board-delivery.ts', anchor: 'callerSid: opts.callerSid', why: "a Board's text to a task: Walnut's or an agent's" },
  { file: 'src/web/routes/messages-v1.ts', anchor: 'to: str(b.to)', why: 'the HTTP /messages route of the CLI and agents: no dictation' },
  { file: 'src/core/task-news.ts', anchor: 'eventRowId(newsKey)', why: "a watcher's news: the watcher's source" },
  { file: 'src/web/routes/quick-input-v1.ts', anchor: /^sendMessageToSession\(sessionId, text, \{\s*source,/, why: "the quick bar: its own dictation names no recordings yet (paired by text)" },
  { file: 'src/web/routes/api-v1.ts', anchor: 'runLaneTurn(agentId, conversationId, message', why: "the phone's Ask Walnut turn: phone takes are paired by text" },
]

/** The server send calls a person's source may reach that carry no dictation and are not KNOWN. */
function srcMissing(sources: readonly Source[], known: readonly Known[]): string[] {
  const out: string[] = []
  for (const { file, source } of sources) {
    for (const [name, pos] of Object.entries(FUNNELS)) {
      for (const c of sendCalls(file, source, name)) {
        const opts = c.args[pos - 1]
        const kind = kindOf(opts)
        if (kind === 'walnut' || carriesDictation(opts) || knownOf(known, c)) continue
        out.push(`${at(c)} (${name}, ${kind} source)`)
      }
    }
  }
  return out
}

function srcCalls(sources: readonly Source[]): SendCall[] {
  return sources.flatMap(({ file, source }) => Object.keys(FUNNELS).flatMap((name) => sendCalls(file, source, name)))
}

// ---------------------------------------------------------------- web

/** Web sends of a person's message to a session that carry no dictation, and why. */
const WEB_KNOWN: Known[] = [
  { file: 'web/src/components/chat/AskObjectDrawer.tsx', anchor: 'sendSessionMessage({ sessionId, message })', why: 'a preset question, or a first question another launch already sent, sent again into a remembered session' },
  { file: 'web/src/components/org/ask-main.ts', anchor: 'sendSessionMessage({ sessionId, message })', why: "a quick action's words, written by Walnut" },
  { file: 'web/src/components/drawing/DrawingAssistant.tsx', anchor: 'message: request.text', why: "the person's words go inside a request Walnut writes (drawingAssistantAsk): the sent text is no transcript of a take" },
]

/** Its own argument object names the dictation: the RPC's fields, or the helper that writes them. */
function webCarries(c: SendCall): boolean {
  const arg = c.args[0]
  if (!arg?.trim().startsWith('{')) return false
  return propOf(arg, 'dictationIds') !== undefined || /(^|[{,]\s*)\.\.\.dictationField\(/.test(arg.trim())
}

function webMissing(sources: readonly Source[], known: readonly Known[]): string[] {
  return sources
    .filter((s) => s.file !== 'web/src/api/session-send.ts')
    .flatMap(({ file, source }) => sendCalls(file, source, 'sendSessionMessage'))
    .filter((c) => !webCarries(c) && !knownOf(known, c))
    .map(at)
}

// ---------------------------------------------------------------- the checks

const SRC = sourcesOf('src')
const WEB = sourcesOf('web/src')

describe("a person's send carries the recordings dictated into it", () => {
  it('every web send of a person\'s message carries the dictation in its own argument object, or is a KNOWN call site', () => {
    expect(webMissing(WEB, WEB_KNOWN), 'pass ...dictationField(...) (utils/dictation-takes.ts) from the box the words came from, or add the call to WEB_KNOWN with why').toEqual([])
    const calls = WEB.filter((s) => s.file !== 'web/src/api/session-send.ts').flatMap(({ file, source }) => sendCalls(file, source, 'sendSessionMessage'))
    expect(calls.length).toBeGreaterThan(5)
    for (const k of WEB_KNOWN) expect(calls.filter((c) => holds(k, c)).length, `${k.file} "${k.anchor}": one call`).toBe(1)
  })

  it('every server send a person\'s source may reach carries the dictation, or is a KNOWN call site', () => {
    expect(srcMissing(SRC, SRC_KNOWN), 'pass `dictation` (stt/dictation-ids.ts) from the request, or add the call to SRC_KNOWN with why').toEqual([])
    const calls = srcCalls(SRC)
    for (const k of SRC_KNOWN) {
      expect(calls.filter((c) => holds(k, c)).length, `${k.file} "${k.anchor}": one call`).toBe(1)
      // A call that only passes its caller's source on lives in a funnel whose own callers are scanned.
      if (k.funnel) {
        expect(FUNNELS[k.funnel], `${k.funnel} is a scanned funnel`).toBeDefined()
        expect(read(k.file)).toMatch(new RegExp(`function ${k.funnel}\\s*\\(`))
      }
    }
    // The web composer's RPC and an engine switch's held message are carriers.
    const carriers = calls.filter((c) => carriesDictation(c.args[FUNNELS.sendMessageToSession! - 1]) && /^sendMessageToSession/.test(c.text)).map((c) => c.file)
    expect(carriers).toEqual(expect.arrayContaining(['src/web/routes/session-chat.ts', 'src/core/sessions/engine-switch.ts', 'src/core/sessions/engine-switch-resume.ts']))
  })

  it('the scan catches a new call in an exempted file: a direct one, through a dynamic import, with a source in a variable', () => {
    const letters = 'src/core/human-inbox/letter-ops.ts'
    const plant = (code: string) => [{ file: letters, source: `${read(letters)}\n${code}\n` }]
    expect(srcMissing(plant("async function planted() { await sendMessageToSession(sid, words, { source: 'ui' }) }"), SRC_KNOWN)).toHaveLength(1)
    expect(srcMissing(plant("async function planted() { await (await import('../session-message-queue.js')).sendMessageToSession(sid, words, { source: 'human-inbox', taskId }) }"), SRC_KNOWN)).toEqual([expect.stringMatching(/^src\/core\/human-inbox\/letter-ops\.ts:\d+ \(sendMessageToSession, person source\)$/)])
    expect(srcMissing(plant('async function planted(from: string) { await sendMessageToSession(sid, words, { source: from }) }'), SRC_KNOWN)).toEqual([expect.stringMatching(/variable source/)])
    expect(srcMissing(plant('async function planted(o: object) { await deliverToSession(target, { ...o, busText: t, enqueueText: t }) }'), SRC_KNOWN)).toEqual([expect.stringMatching(/deliverToSession, variable source/)])
    // A call carrying the dictation, or Walnut's own source, needs nothing.
    expect(srcMissing(plant("async function planted() { await sendMessageToSession(sid, words, { source: 'ui', dictation }) }"), SRC_KNOWN)).toEqual([])
    expect(srcMissing(plant("async function planted() { await sendMessageToSession(sid, words, { source: 'walnut-notify' }) }"), SRC_KNOWN)).toEqual([])
    // A comment naming the function is no call.
    expect(srcMissing(plant("// sendMessageToSession(sid, words, { source: 'ui' })"), SRC_KNOWN)).toEqual([])
    // On the web: a second send in an exempted file, and one that only builds the ids nearby.
    const drawer = 'web/src/components/chat/AskObjectDrawer.tsx'
    const plantWeb = (code: string) => [{ file: drawer, source: `${read(drawer)}\n${code}\n` }]
    expect(webMissing(plantWeb('async function planted() { await sendSessionMessage({ sessionId, message: words }) }'), WEB_KNOWN)).toHaveLength(1)
    expect(webMissing(plantWeb('async function planted() { const f = dictationField(d); await sendSessionMessage({ sessionId, message: words }) }'), WEB_KNOWN)).toHaveLength(1)
    expect(webMissing(plantWeb('async function planted() { await sendSessionMessage({ sessionId, message: words, ...dictationField(d) }) }'), WEB_KNOWN)).toEqual([])
  })

  it('the composers note each take only once its final text landed, and claim it at the send with their own text', () => {
    const hook = read('web/src/hooks/useSpeechToText.ts')
    expect(hook).toMatch(/if \(landed && result\.recordingId\) onTakeRef\.current\?\.\(result\.recordingId, finalText\);/)
    expect(hook.match(/onTakeRef\.current\?\.\(/g)?.length).toBe(2) // the stop, a Retry (which always writes)
    expect(read('web/src/components/common/MicButton.tsx')).toMatch(/\.\.\.\(onTake \? \{ onTake \} : \{\}\)/)
    const input = read('web/src/components/chat/ChatInput.tsx')
    expect(input).toMatch(/onTake=\{\(id, words\) => noteDictatedTake\(draftKeyRef\.current, id, words\)\}/)
    expect(input).toMatch(/const dictation = claimDictation\(sentKey, boxText\);/)
    expect(input).toMatch(/dispatchSend\(onSend, text, attachments\.items, cur\);/)
    expect(input).toMatch(/dispatchSend\(onInterruptSend, text, attachments\.items, cur\);/)
    expect(read('web/src/components/common/BoxMic.tsx')).toMatch(/onTake=\{\(id, words\) => noteDictatedTake\(takesBox, id, words\)\}/)
    expect(read('web/src/hooks/useSessionSend.ts').match(/dictationField\((opts\?|failedMsg)\.draftOrigin\?\.dictation\)/g)?.length).toBe(3)
  })

  it("every queued event of a person's send names the row's dictation to the listener that pairs it", () => {
    const emits = SRC.flatMap(({ file, source }) => sendCalls(file, source, 'bus\\.emit')).filter((c) => /EventNames\.SESSION_MESSAGE_QUEUED/.test(c.args[0] ?? ''))
    const quiet: Known[] = [{ file: 'src/providers/claude-code-session.ts', anchor: "source: 'session-start'", why: "a launch's first message (source session-start, no person's send)" }]
    expect(emits.filter((c) => !/dictationEventFields\(/.test(c.args[1] ?? '') && !knownOf(quiet, c)).map(at)).toEqual([])
    // From the row, so a resend that collapses onto it names them too.
    expect(read('src/core/session-message-queue.ts')).toMatch(/\.\.\.dictationEventFields\(msg\.dictation\),/)
    expect(read('src/core/stt/learn-from-sends.ts')).toMatch(/noteSentWithDictations\(data\.message, dictationOf\(data\)\)/)
    expect(read('src/web/routes/session-chat.ts')).toMatch(/const dictation = dictationOf\(data\)/)
  })
})
