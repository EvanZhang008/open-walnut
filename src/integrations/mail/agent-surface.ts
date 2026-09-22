/**
 * The eight mail operations an agent can perform, as ONE implementation.
 *
 * `tools.ts` registers these for the Personal AI's tool list and `ops.ts` registers the same
 * eight for the op catalogue. Neither of them holds any logic: two registrations, one behaviour,
 * so a rule fixed for a tool is fixed for the op in the same edit.
 *
 * Three contracts this file keeps, and each one is the reason a line here looks the way it does:
 *
 * - It calls the SAME service functions the routes call, never HTTP. The validation a draft gets
 *   (address grammar, header-injection refusal, per-account `send`) is the validation the
 *   console gets, because it is literally the same code.
 * - Every answer is TEXT, and a failure is a plain sentence rather than a throw. A tool that
 *   throws hands the model a stack trace to reason about; a sentence tells it what to do next.
 * - Nothing here can send, and nothing here can leave a mailing list. The write surface is a draft
 *   and two requests, and a request produces a letter for the human. Both the send and the
 *   unsubscribe ladder are executed by the approval path itself, so there is no entry point on this
 *   side of the wall for a body's text to reach.
 * - The one thing here that WRITES outside mail is `mail_to_task`, and everything it writes into
 *   the task is escaped first (see `message-tasks.ts`). A task is read later by an agent that can
 *   act, so a subject able to plant an instruction in a task description would be the same
 *   injection as one in a tool result, just with a longer fuse.
 *
 * What an answer LOOKS like lives next door in `agent-format.ts`: the shape checks for fields
 * printed outside the block, the per-field caps, and the table. Kept apart because they answer a
 * different question and because this file is the one a reviewer reads to check the six flows.
 */
import {
  accountLabel,
  addressList,
  ADDRESS_SHAPE,
  ATTACHMENTS_LISTED,
  bodyErrorSentence,
  AUTHORED_MAX_BYTES,
  clipChars,
  envelopeTable,
  FILENAME_CHARS,
  flagSummary,
  isoOf,
  LIST_SNIPPET_CHARS,
  MESSAGE_ID_CHARS,
  NAME_CHARS,
  SUBJECT_CHARS,
  THREAD_SNIPPET_CHARS,
} from './agent-format.js'
import { plainTextOf } from './bodies.js'
import {
  decodeMessageCursor,
  MailServiceError,
  type DraftDto,
  type MailAccountDto,
  type MailMessageDto,
  type MessagePageCursor,
} from './contract.js'
import { replyHeaders } from './drafts.js'
import type { MailApprovals } from './approvals.js'
import type { MailDrafts } from './drafts.js'
import type { MailMessageTasks } from './message-tasks.js'
import type { MailService } from './service.js'
import type { MailUnsubscribe } from './unsubscribe.js'
import {
  AGENT_READ_MAX_BYTES,
  isCacheKey,
  isRfcMessageId,
  NOT_A_USABLE_ID,
  truncateUtf8,
  wrapUntrusted,
} from './untrusted.js'

/** A list page. Higher than this and one tool result crowds out the conversation. */
export const MAX_LIST_LIMIT = 50
const DEFAULT_LIST_LIMIT = 20

/** Messages one `mail_thread` answers with. A thread longer than this is summarized, and says so. */
const THREAD_MAX = 200

export interface MailAgentDeps {
  service: MailService
  drafts: MailDrafts
  approvals: MailApprovals
  /** The message-to-task ledger, so the tool and the console cannot disagree about a duplicate. */
  tasks: MailMessageTasks
  /**
   * The unsubscribe ledger, reached for exactly ONE thing: `requestFromAgent`, which sends a letter.
   *
   * Never `run`. The whole of this surface's relationship with leaving a list is asking about it, the
   * same way its relationship with sending a mail is asking about it (see `mailUnsubscribeRequest`).
   */
  unsubscribe: MailUnsubscribe
  /** Read per call, not captured: a plugin instance outlives any one request. */
  replica: () => boolean
}

/**
 * A refusal the model can act on.
 *
 * Thrown internally so a handler reads as one straight line, and turned back into text at the
 * edge. Never surfaced as an exception: see the file comment.
 */
class Refusal extends Error {}

function refuse(message: string): never {
  throw new Refusal(message)
}

/** The one place a handler's outcome becomes a tool result. */
export async function asText(work: () => Promise<string>): Promise<string> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof Refusal) return error.message
    // A service error's message is Walnut's own words, but its `code` and the text of an
    // unexpected throw can both carry provider output (an IMAP server's rejection line is
    // whatever that server chose to say), so neither is pasted into the answer raw.
    if (error instanceof MailServiceError) return `${error.message} (${clipChars(error.code, 60)})`
    return `Walnut could not finish that mail request: ${clipChars(String(error), 200)}`
  }
}

function str(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  return typeof value === 'string' ? value.trim() : ''
}

function limitOf(input: Record<string, unknown>, fallback: number, max: number): number {
  const raw = Number(input.limit)
  if (!Number.isFinite(raw) || raw <= 0) return fallback
  return Math.min(Math.floor(raw), max)
}

/**
 * Which account this call is about.
 *
 * Defaulting to the only account is what keeps the common case one argument shorter; refusing
 * when there are two is what stops a reply going out of the wrong mailbox. The refusal NAMES the
 * accounts, because a model that is told "account is required" and not which ones exist has to
 * guess or make another call.
 */
async function resolveAccount(
  deps: MailAgentDeps,
  requested: string,
): Promise<MailAccountDto> {
  // The CHEAP shape: this resolves a NAME, and the full one asks every provider what each of its
  // accounts can do. The one tool that needs a real verdict asks `capabilitiesFor` for the one
  // account it is about to send from (see `mailSendDraft`).
  const accounts = await deps.service.listAccounts({ capabilities: false })
  if (accounts.length === 0) {
    refuse('This Walnut has no mail account set up, so there is no mail to read. The user adds one in the Mail app.')
  }
  if (!requested) {
    if (accounts.length === 1) return accounts[0]!
    refuse(
      `This Walnut has ${accounts.length} mail accounts, so name one in "account": `
      + `${accounts.map((one) => `${one.accountId} (${accountLabel(one)})`).join(', ')}.`,
    )
  }
  const found = accounts.find((one) => one.accountId === requested)
    ?? accounts.find((one) => one.address === requested)
  if (found) return found
  refuse(
    `There is no mail account "${requested}". The accounts are: `
    + `${accounts.map((one) => `${one.accountId} (${accountLabel(one)})`).join(', ')}.`,
  )
}

/** A replica does not poll and has no cache, so every one of these has the same answer. */
function assertPrimary(deps: MailAgentDeps): void {
  if (deps.replica()) {
    refuse(
      'Mail runs on the primary Walnut only, and this is the cloud replica, so there is no mailbox '
      + 'here to read. Ask on the primary box instead.',
    )
  }
}

export async function mailList(deps: MailAgentDeps, input: Record<string, unknown>): Promise<string> {
  assertPrimary(deps)
  const account = await resolveAccount(deps, str(input, 'account'))
  const mailboxArg = str(input, 'mailbox')
  const limit = limitOf(input, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT)
  // `inbox` is the word an agent knows; the mailbox ID is whatever the provider calls it, so the
  // role is resolved from the cache rather than guessed at ("INBOX" is only true of IMAP).
  let mailboxId = mailboxArg
  if (mailboxArg.toLowerCase() === 'inbox') {
    const mailboxes = await deps.service.listMailboxes(account.accountId)
    mailboxId = mailboxes.find((one) => one.role === 'inbox')?.mailboxId ?? mailboxArg
  }
  const page = await deps.service.listMessages({
    accountId: account.accountId,
    ...(mailboxId ? { mailboxId } : {}),
    limit,
    ...(pageCursor(str(input, 'before')) ? { before: pageCursor(str(input, 'before'))! } : {}),
  })
  if (page.messages.length === 0) {
    return `No cached messages for ${account.accountId}${mailboxId ? ` in ${mailboxId}` : ''}.`
  }
  const header = `${account.accountId} (${accountLabel(account)})`
    + `${mailboxId ? `, mailbox ${mailboxId}` : ', every mailbox'}`
    + `: ${page.messages.length} message(s), newest first.`
    + (page.nextBefore ? ` More: pass before="${page.nextBefore}".` : '')
  return `${header}\n\n${envelopeTable(account, page.messages, LIST_SNIPPET_CHARS)}`
}

/**
 * The paging token, read with the SAME decoder the HTTP edge uses.
 *
 * Never re-implemented here: the token shape (and its one legacy form) is contract.ts to define,
 * and a second parser would drift the day the sort key grows a field. An unparseable token pages
 * from the top rather than failing, which is what the route does too.
 */
function pageCursor(raw: string): MessagePageCursor | undefined {
  return raw ? decodeMessageCursor(raw) : undefined
}

export async function mailSearch(deps: MailAgentDeps, input: Record<string, unknown>): Promise<string> {
  assertPrimary(deps)
  const account = await resolveAccount(deps, str(input, 'account'))
  const q = str(input, 'q')
  if (!q) refuse('mail_search needs a query in "q".')
  const found = await deps.service.search({
    accountId: account.accountId,
    q,
    limit: limitOf(input, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT),
  })
  // Which index answered is part of the ANSWER, not a detail: a cache search only knows the
  // messages Walnut has already pulled, so an empty result means something different in each case.
  const where = found.source === 'provider'
    ? "Searched the mail server's own index."
    : "Searched Walnut's local cache (this provider has no search capability), so only messages already pulled are covered."
  if (found.messages.length === 0) return `${where} Nothing matched "${q}" in ${account.accountId}.`
  return `${where} ${found.messages.length} match(es) for "${q}" in ${account.accountId}, newest first.`
    + `\n\n${envelopeTable(account, found.messages, LIST_SNIPPET_CHARS)}`
}

export async function mailRead(deps: MailAgentDeps, input: Record<string, unknown>): Promise<string> {
  assertPrimary(deps)
  const account = await resolveAccount(deps, str(input, 'account'))
  const messageId = str(input, 'message')
  if (!messageId) refuse('mail_read needs a message id in "message", as listed by mail_list or mail_search.')
  const read = await deps.service.readMessage(account.accountId, messageId, {
    ...(input.retry === true ? { retry: true } : {}),
  })
  const message = read.message
  // The trusted half: header fields an agent needs in order to act (reply to this address, read
  // that message, quote this date). Every one of them is checked against its SHAPE first, because
  // "outside the block" means "in Walnut's own voice" and these values come from the sender as
  // surely as the body does. A field that fails goes below, inside the block, where the reminder
  // covers it. Everything an outside party TYPED is below regardless.
  const from = ADDRESS_SHAPE.test(message.from.address) ? message.from.address : '(not a usable address)'
  const rfcId = isRfcMessageId(message.rfcMessageId)
    ? message.rfcMessageId
    : (message.rfcMessageId ? NOT_A_USABLE_ID : '(none)')
  const header = [
    `Account: ${account.accountId} (${accountLabel(account)})`,
    `Message: ${isCacheKey(message.messageId) ? message.messageId : NOT_A_USABLE_ID}`,
    `RFC id: ${rfcId}`,
    `From: ${from}`,
    `To: ${addressList(message.to)}`,
    // Cc and Reply-To are printed only when the message HAS them: two more "(none)" lines on every
    // read is a per-turn cost for the absence of information. Reply-To matters for a reply the
    // agent may draft next, since a mailing list or a ticket system routes answers with it.
    ...(message.cc?.length ? [`Cc: ${addressList(message.cc)}`] : []),
    ...(message.replyTo?.length ? [`Reply-To: ${addressList(message.replyTo)}`] : []),
    `Sent: ${isoOf(message.sentAt)}`,
    `Mailbox: ${isCacheKey(message.mailboxId) ? message.mailboxId : NOT_A_USABLE_ID}   Flags: ${flagSummary(message.flags)}`,
    `Attachments: ${message.attachments.length}`,
    // Walnut's own id, from Walnut's own ledger, so it belongs outside the block with the other
    // things the agent may act on. Absent when nobody has made a task from this message.
    ...(message.taskId ? [`Task: ${message.taskId}`] : []),
  ].join('\n')

  const authored: string[] = [`Subject: ${clipChars(message.subject, SUBJECT_CHARS) || '(no subject)'}`]
  if (message.from.name) authored.push(`From name: ${clipChars(message.from.name, NAME_CHARS)}`)
  // A value that failed its shape check is still DATA the agent may need to see; it is shown here
  // rather than dropped, because "the id looks wrong" is a fact about the message.
  if (message.rfcMessageId && !isRfcMessageId(message.rfcMessageId)) {
    authored.push(`Raw Message-ID header (not a usable id): ${clipChars(message.rfcMessageId, MESSAGE_ID_CHARS)}`)
  }
  if (!isCacheKey(message.mailboxId)) {
    authored.push(`Raw mailbox (not a usable id): ${clipChars(message.mailboxId, MESSAGE_ID_CHARS)}`)
  }
  for (const attachment of message.attachments.slice(0, ATTACHMENTS_LISTED)) {
    authored.push(
      `Attachment: ${clipChars(attachment.filename ?? '', FILENAME_CHARS) || '(unnamed)'} `
      + `(${clipChars(attachment.mimeType ?? '', NAME_CHARS) || 'unknown type'}, ${attachment.bytes ?? 0} bytes)`,
    )
  }
  if (message.attachments.length > ATTACHMENTS_LISTED) {
    authored.push(`(${message.attachments.length - ATTACHMENTS_LISTED} more attachments not listed)`)
  }
  authored.push('')
  // Converted HERE rather than by handing `html` to the wrapper: the authored header above is
  // already text, and `plainTextOf` prefers a non-empty text half, so passing both would make
  // the header win and silently drop an html-only body. Same extractor either way, which is the
  // rule that matters (it is the one feeding the FTS index).
  const bodyText = read.body
    ? plainTextOf({ text: read.body.text ?? '', html: read.body.html ?? '' })
    : ''
  // The header lines are cut to their OWN ceiling before the body is measured, so the body always
  // gets at least the remainder of the read budget. Without this a 200 KB subject spent the whole
  // allowance and `mail_read` answered with no body at all, which is the sender choosing what the
  // agent is allowed to see.
  const headerText = truncateUtf8(authored.join('\n'), AUTHORED_MAX_BYTES).text
  const block = wrapUntrusted({
    source: 'mail',
    account: account.accountId,
    message: message.rfcMessageId || message.messageId,
    text: `${headerText}${bodyText}`,
    maxBytes: AGENT_READ_MAX_BYTES,
  })
  const failure = read.bodyError ? `\n\n${bodyErrorSentence(read.bodyError)}` : ''
  const truncated = read.body?.truncated ? '\n\nThe stored body was itself truncated at ingest.' : ''
  return `${header}\n\n${block}${failure}${truncated}`
}

/**
 * A thread, oldest first, from what the cache can connect.
 *
 * `thread_id` is derived at ingest from `References[0]` / `In-Reply-To` / the message's own RFC
 * id, so every provider threads the same way and no provider needs a thread method. It is read
 * back with ONE indexed query (`messages_by_thread`, db.ts v5), so a reply from months ago is
 * found; only a thread longer than THREAD_MAX is shortened, and then the answer says so.
 *
 * `||` and not `??`, matching `threadIdOf` in contract.ts exactly: an EMPTY string is not an id.
 * With `??` every message whose stored thread id was blank collected into one bucket, so a thread
 * lookup answered with a pile of unrelated mail presented as a conversation.
 */
export async function mailThread(deps: MailAgentDeps, input: Record<string, unknown>): Promise<string> {
  assertPrimary(deps)
  const account = await resolveAccount(deps, str(input, 'account'))
  const messageId = str(input, 'message')
  if (!messageId) refuse('mail_thread needs a message id in "message".')
  const anchor = await deps.service.readEnvelope(account.accountId, messageId)
  const threadId = anchor.threadId || anchor.rfcMessageId || anchor.messageId
  if (!threadId) {
    refuse(
      'This message has no usable thread id (no References, no In-Reply-To, no Message-ID), so '
      + 'Walnut cannot tell which other messages belong with it. Read it on its own with mail_read.',
    )
  }

  const found = new Map<string, MailMessageDto>([[anchor.messageId, anchor]])
  for (const one of await deps.service.threadMessages(account.accountId, threadId, THREAD_MAX)) {
    found.set(one.messageId, one)
  }
  const messages = [...found.values()].sort((a, b) => a.sentAt - b.sentAt || a.messageId.localeCompare(b.messageId))
  // The cap is stated only when it was actually reached: an unconditional hedge on every thread
  // teaches the agent to distrust a complete answer.
  const bound = messages.length > THREAD_MAX
    ? ` Only ${THREAD_MAX} messages of a longer thread are shown.`
    : ''
  // A thread id is a header the sender wrote. Printed above the block it would be Walnut's own
  // voice, so one that fails its shape is named as unusable there and shown as DATA inside.
  //
  // The cache-key spelling is accepted ONLY when the id IS this message's own key, which is the
  // one legitimate non-RFC value `threadIdOf` can produce. Accepting any cache-key-shaped string
  // would wave prose through, because a sentence is a perfectly good one-line string.
  const usable = isRfcMessageId(threadId)
    || (threadId === anchor.messageId && isCacheKey(threadId))
  const label = usable ? threadId : NOT_A_USABLE_ID
  const note = usable ? undefined : `Raw thread id (not a usable id): ${clipChars(threadId, MESSAGE_ID_CHARS)}`
  const shown = messages.slice(0, THREAD_MAX)
  const header = `Thread ${label} in ${account.accountId}: ${shown.length} cached message(s), oldest first.${bound}`
  return `${header}\n\n${envelopeTable(account, shown, THREAD_SNIPPET_CHARS, note)}`
}

const DRAFT_REMINDER =
  'Nothing is sent yet. Call mail_request_send with this draftId and revision, and the user gets '
  + 'a letter showing exactly this draft; only their answer sends it.'

/** What an edit may change. Anything else on an existing draft is a new draft. */
const EDITABLE_FIELDS = ['to', 'cc', 'bcc', 'subject', 'bodyMarkdown'] as const
const FIXED_AT_CREATION = ['account', 'inReplyTo'] as const

function draftJson(draft: DraftDto): string {
  return JSON.stringify({ draftId: draft.draftId, revision: draft.revision, state: draft.state })
}

export async function mailDraft(deps: MailAgentDeps, input: Record<string, unknown>): Promise<string> {
  assertPrimary(deps)
  const draftId = str(input, 'draftId')
  if (draftId) return patchDraft(deps, draftId, input)

  const account = await resolveAccount(deps, str(input, 'account'))
  const capabilities = await deps.service.capabilitiesFor(account.accountId)
  if (!capabilities.send) {
    refuse(
      `The account ${account.accountId} has no outgoing mail configured, so a draft from it could `
      + 'never be sent. The user adds the SMTP settings in the Mail app.',
    )
  }
  // A reply's threading headers and its subject come from the CACHED message, exactly as
  // POST /drafts does: a caller cannot aim a reply into a thread it never read.
  const replyTo = str(input, 'inReplyTo')
  const cached = replyTo
    ? await deps.service.replyTarget(account.accountId, replyTo)
    : undefined
  const reply = cached ? safeReplyHeaders(cached) : undefined
  // Threading dropped because the target's own Message-ID is not one. Said out loud rather than
  // swallowed: the draft is fine, it just will not land in the same thread.
  const unthreaded = cached && !reply
    ? '\nThat message\'s Message-ID header is not a usable id, so this draft carries no threading '
      + 'headers and will start a new thread.'
    : ''
  const draft = await deps.drafts.create({
    accountId: account.accountId,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    // The cached subject still stands in when threading was dropped, so a reply the agent wrote
    // with no subject of its own does not go out blank.
    subject: input.subject ?? (unthreaded ? cached?.subject : undefined),
    bodyMarkdown: input.bodyMarkdown,
    origin: 'agent',
    // No session id: `PluginToolSpec.execute` is handed the tool input and nothing else, so the
    // surface cannot attribute a draft to the session that asked for it. See the proposal in the
    // slice report; `createdBySession` stays null until the platform passes a call context.
    ...(cached && reply ? { reply: { ...reply, subject: cached.subject } } : {}),
  })
  return `${draftJson(draft)}\n${DRAFT_REMINDER}${unthreaded}`
}

/**
 * Reply threading headers, with every id shape-checked first.
 *
 * `replyHeaders` copies the target's `Message-ID` and `References` chain into the outgoing mail,
 * and both arrive from the sender of the message being replied to. An id carrying a line break is
 * a header injection on the way OUT, and one carrying prose is a lie about the thread, so an id
 * that is not an id is dropped. Dropping is safe: a reply with no `In-Reply-To` lands as a new
 * thread, which is a cosmetic loss, while forwarding whatever the sender wrote is not.
 */
function safeReplyHeaders(target: { rfcMessageId: string; references?: string[] }): {
  inReplyTo: string
  references: string[]
} | undefined {
  const full = replyHeaders(target)
  if (!isRfcMessageId(full.inReplyTo)) return undefined
  return { inReplyTo: full.inReplyTo, references: full.references.filter((one) => isRfcMessageId(one)) }
}

/**
 * Edit a draft, and keep the outstanding letter honest.
 *
 * The withdraw-then-ask-again dance mirrors `PATCH /drafts/:draftId` in routes-write.ts, and it
 * is not optional: an edit bumps the revision, which makes the letter already in the human's
 * inbox describe text the ledger can no longer approve. Left live, its Send button reads to the
 * human as "I tapped Send and nothing happened".
 */
async function patchDraft(
  deps: MailAgentDeps,
  draftId: string,
  input: Record<string, unknown>,
): Promise<string> {
  const patch: Record<string, unknown> = {}
  for (const field of EDITABLE_FIELDS) {
    if (input[field] !== undefined) patch[field] = input[field]
  }
  // A call that names no field is a READ. `patch` with an empty object is a real edit that bumps
  // the revision (that is how a settled draft gets a fresh ledger key), and an agent asking "what
  // is this draft now" after a stale refusal must not move the number it is asking about.
  if (Object.keys(patch).length === 0) {
    const current = await deps.drafts.get(draftId)
    // A caller that sent `account` or `inReplyTo` with a draftId meant to change something. Those
    // two are fixed at creation (an account change is a different mailbox; a thread change is a
    // different conversation), so answering with a silent read would look like the edit landed.
    const ignored = FIXED_AT_CREATION.filter((field) => input[field] !== undefined)
    if (ignored.length > 0) {
      return `${draftJson(current)}\nNothing to change: ${ignored.join(' and ')} `
        + `${ignored.length === 1 ? 'is' : 'are'} fixed when a draft is created. `
        + 'This is the draft as it stands; create a new draft to change that, or pass to, cc, bcc, '
        + 'subject or bodyMarkdown to edit this one.'
    }
    return `${draftJson(current)}\n${DRAFT_REMINDER}`
  }
  const patched = await deps.drafts.patch(draftId, patch)
  if (!patched.wasPendingApproval) return `${draftJson(patched.draft)}\n${DRAFT_REMINDER}`
  await deps.approvals.withdrawFor(
    patched.previousLetterId,
    'This draft was edited; a fresh letter follows.',
  )
  const again = await deps.approvals.requestSend(draftId, patched.draft.revision)
  return `${draftJson(again.draft)}\n`
    + `The user was already looking at a letter for the old text, so that one was withdrawn and a `
    + `fresh letter (${again.letterId}) went out for this revision. Do not ask again for it.`
}

/**
 * Turn a message into a task, or say which task it already is.
 *
 * A WRITE, but not a destructive one, and idempotent by construction: the ledger answers a second
 * call with the same id and `created: false`, so an agent that loses track of what it has already
 * done cannot produce two tasks for one mail.
 *
 * The answer deliberately carries NO text from the message: the ids and one sentence of Walnut's
 * own. A subject in this result would have to be wrapped, and there is nothing here the agent
 * needs it for, since it either just read the message or can read it now.
 */
export async function mailToTask(deps: MailAgentDeps, input: Record<string, unknown>): Promise<string> {
  assertPrimary(deps)
  const account = await resolveAccount(deps, str(input, 'account'))
  const messageId = str(input, 'message')
  if (!messageId) {
    refuse('mail_to_task needs a message id in "message", as listed by mail_list or mail_search.')
  }
  const title = str(input, 'title')
  const project = str(input, 'project')
  const result = await deps.tasks.link({
    accountId: account.accountId,
    messageId,
    ...(title ? { title } : {}),
    ...(project ? { project } : {}),
    ...(input.note === true ? { note: true } : {}),
  })
  const sentence = result.created
    ? 'The task holds where the mail came from, a link back to it, and the preview. '
      + 'It is in TODO for the user to pick up.'
    : 'This message already had a task, so nothing new was made and nothing was changed.'
  const noteNote = result.noteSkipped
    ? ' The body could not be added as a note (Walnut has no readable body for this message yet).'
    : ''
  return `${JSON.stringify({ taskId: result.taskId, created: result.created })}\n${sentence}${noteNote}`
}

/**
 * Ask the user to leave a mailing list. The agent's ONLY move on unsubscribing.
 *
 * Read what this does: one call into `requestFromAgent`, which sends a letter. No HTTP request leaves
 * the machine, no draft is written, no mail is sent, and the ladder is not run. Whether the user is
 * taken off the list is decided by them tapping a button, minutes or days later, and Walnut reports
 * back in that letter's own thread.
 *
 * The answer names the letter and the rung, because those are the two facts the model needs in order
 * to say something true to the user ("I have asked you; it will use the sender's one-click link") and
 * to know not to ask again. It carries NO text from the message: the letter shows the user the mail,
 * and a subject repeated here would have to be wrapped for nothing.
 */
export async function mailUnsubscribeRequest(
  deps: MailAgentDeps,
  input: Record<string, unknown>,
): Promise<string> {
  assertPrimary(deps)
  const account = await resolveAccount(deps, str(input, 'account'))
  const messageId = str(input, 'message')
  if (!messageId) {
    refuse('mail_unsubscribe_request needs a message id in "message", as listed by mail_list or mail_search.')
  }
  try {
    const asked = await deps.unsubscribe.requestFromAgent(account.accountId, messageId)
    return `${JSON.stringify({
      letterId: asked.letterId,
      method: asked.method,
      ...(asked.url ? { url: asked.url } : {}),
    })}\nA letter is waiting for the user; nothing has been unsubscribed and nothing was sent.`
      + ' Do not ask again for this message: their answer is what acts, and Walnut reports the outcome'
      + ' in that letter.'
  } catch (error) {
    // `stale` here means "already asked, still waiting" and `unsupported` means "this message offers no
    // way out". Both are sentences the model should repeat to the user rather than retry, so they come
    // back through `asText` as themselves.
    if (error instanceof MailServiceError && (error.code === 'stale' || error.code === 'unsupported')) {
      refuse(error.message)
    }
    throw error
  }
}

export async function mailRequestSend(deps: MailAgentDeps, input: Record<string, unknown>): Promise<string> {
  assertPrimary(deps)
  const draftId = str(input, 'draftId')
  const revision = Number(input.revision)
  if (!draftId) refuse('mail_request_send needs the draftId mail_draft handed back.')
  if (!Number.isInteger(revision) || revision <= 0) {
    refuse('mail_request_send needs the revision mail_draft handed back, so the user approves the text you meant.')
  }
  try {
    const asked = await deps.approvals.requestSend(draftId, revision)
    return JSON.stringify({
      letterId: asked.letterId,
      draftId: asked.draft.draftId,
      // requestSend moves the revision when the previous attempt already settled, so the caller
      // is handed the one the letter is really about rather than the one it sent.
      revision: asked.draft.revision,
      state: asked.draft.state,
    })
      + '\nA letter is on its way to the user; do not ask again for this revision.'
  } catch (error) {
    if (error instanceof MailServiceError && error.code === 'stale') {
      return 'That revision is no longer the current one, so nothing was asked and nothing was sent. '
        + 'Read the draft again (mail_draft with its draftId returns the current revision) and request the send for that revision.'
    }
    throw error
  }
}
