/**
 * Turning one message into one task, and keeping that answer stable when it is asked twice.
 *
 * Two rules carry this file, and both are about the same worry from opposite ends.
 *
 * IDEMPOTENCE. "Make a task from this mail" is a button, an agent tool and an HTTP route, and all
 * three get pressed twice: a double click, a retry after a route hit its response budget, an agent
 * that re-reads its own transcript. So the ledger is consulted first and a second ask is answered
 * with the SAME task id and `created: false`. The one case that does create again is a task the
 * human deleted, because refusing there would leave a message that can never be turned into a task
 * again, and pointing at a dead id would show the console a pill that opens nothing.
 *
 * Idempotence has to hold for asks that OVERLAP, not just for asks that follow one another, and a
 * read-then-create is not idempotent on its own: two calls landing together both read an empty
 * ledger, both create, and one of the two tasks is orphaned with nothing pointing at it. Two things
 * close that, in this order. `inFlight` makes a second ask for the same message WAIT for the first
 * and report its answer, which is what the button, the route and the tool all actually want. And
 * `claimMessageTask` is a conditional insert that answers with the winner, so the database decides
 * even if a caller ever reaches this class from somewhere the map does not cover.
 *
 * UNTRUSTED TEXT. A subject, a display name and a snippet were all typed by whoever sent the mail.
 * Every one of them is control-stripped, and every one that lands in a field Walnut renders as
 * MARKDOWN is escaped as well: the description's provenance lines and its quoted snippet. A message
 * therefore cannot put a heading, a link, an image or an `<external-content>` tag into a task, which
 * matters because that task is later read by an agent that CAN act. The TITLE is the exception and
 * is deliberately left as typed, because nothing renders a task title as markdown; see `taskTitleOf`.
 *
 * The provenance block is written by hand rather than through a template helper: every line in it
 * is either Walnut's own words or a field that has been through `escapeMarkdown`, and keeping that
 * visible in one place is what makes the property checkable by reading.
 */
import { escapeMarkdown, quotedMarkdown } from './render.js'
import { oneLine, truncateUtf8 } from './untrusted.js'
import type { MailMessageDto } from './contract.js'
import type { MailEvents } from './events.js'
import type { MailStore } from './store.js'

/** Every task made from a message carries this, so the board can filter for them. */
export const MAIL_TASK_TAG = 'mail'

/** The subject, trimmed to this. A title is a row in a list. */
export const TASK_TITLE_CHARS = 120

/** How much body text rides the optional note. Past this the human opens the mail. */
export const TASK_NOTE_MAX_BYTES = 2 * 1024

export const NO_SUBJECT = '(no subject)'

/** What the description's backlink reads as. Walnut's own words, so it is never escaped. */
export const MAIL_LINK_LABEL = 'open in Mail'

/**
 * The ledger's key for one message.
 *
 * The RFC `Message-ID` when the message has one, because that is the only handle that survives the
 * things that change a provider handle: a folder move, a re-sync after eviction, the same mail
 * arriving in a second account. `cache:[...]` is the fallback and it is not optional: the column
 * defaults to `''`, so without it every Message-ID-less message in the install would collide on one
 * primary key and share a single task. JSON rather than a joining character for the same reason
 * `pairKey` in the console does it: an account id and a message id both legitimately contain
 * colons, so `a:b` + `c` and `a` + `b:c` have to stay two keys.
 *
 * BOTH forms are prefixed, and that is not decoration. A `Message-ID` is a header, which means a
 * sender chooses it: one spelled exactly `cache:["acct","uid-9"]` would otherwise land on the key
 * of somebody else's Message-ID-less message and take over its task.
 */
export function messageTaskKey(accountId: string, rfcMessageId: string, messageId: string): string {
  const rfc = oneLine(rfcMessageId ?? '')
  return rfc ? `rfc:${rfc}` : `cache:${JSON.stringify([accountId, messageId])}`
}

/** The same key, from a DTO. */
export function keyOfMessage(message: MailMessageDto): string {
  return messageTaskKey(message.accountId, message.rfcMessageId, message.messageId)
}

/**
 * Where the console opens this message.
 *
 * `/mail`, not `/apps/mail`: the Mail console is a CORE app registered at `/mail`, and `/apps/:id`
 * is the host for plugin-provided Apps. Percent-encoded because both ids are provider strings and
 * routinely contain `&`, `#`, a space and a colon.
 */
export function mailAccountLink(accountId: string): string {
  return `/mail?account=${encodeURIComponent(accountId)}`
}

export function mailDeepLink(accountId: string, messageId: string): string {
  return `${mailAccountLink(accountId)}&message=${encodeURIComponent(messageId)}`
}

/**
 * The task's title: the subject, on one line, bounded, and NOT escaped.
 *
 * Not escaped because a task title is rendered as a plain text node everywhere Walnut shows one (the
 * board row, the card head, the pill in the mail reader), so escaping it does not defuse anything:
 * it just publishes the backslashes. A subject of `Q&A [urgent]` became `Q&amp;A \[urgent\]` on the
 * board, which is a worse answer than the honest one and hides what the mail actually said.
 *
 * Control characters and newlines still go (`oneLine`), because a title is one line by construction
 * and a smuggled newline is how a one-line field starts pretending to be two.
 */
export function taskTitleOf(subject: string): string {
  const one = oneLine(subject ?? '')
  if (!one) return NO_SUBJECT
  return one.length <= TASK_TITLE_CHARS ? one : `${one.slice(0, TASK_TITLE_CHARS)}...`
}

export interface MessageProvenance {
  message: MailMessageDto
  accountLabel: string
}

/** `Name <address>`, or just the address. Escaped, because the name is the sender's own text. */
function senderLine(message: MailMessageDto): string {
  const name = oneLine(message.from?.name ?? '')
  const address = oneLine(message.from?.address ?? '')
  const plain = name ? `${name} <${address}>` : address
  return escapeMarkdown(plain) || '(no sender)'
}

/**
 * Local time, spelled out, without a timezone library.
 *
 * The human reading this task is on the box that made it, so the instant is rendered in ITS zone: a
 * UTC string on a task that says "Sent: 03:00" for a mail that arrived at eight in the evening is
 * the sort of small wrongness that makes a provenance block untrustworthy.
 */
export function localTimestamp(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return 'date unknown'
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * The description: where this came from, then what it said.
 *
 * The provenance lines are first because they are the part that makes the task actionable weeks
 * later (who, when, which mailbox, and the link back), and the snippet is quoted underneath so no
 * amount of markdown in it can pretend to be one of those lines.
 */
export function taskDescriptionOf(input: MessageProvenance): string {
  const { message } = input
  const lines = [
    `From: ${senderLine(message)}`,
    `Sent: ${localTimestamp(message.sentAt)}`,
    `Account: ${escapeMarkdown(oneLine(input.accountLabel)) || message.accountId}`,
    // A LINK, not a bare path: this block is rendered as markdown, and a path printed as text is a
    // copy-and-paste job. Nothing untrusted is in it (Walnut's own words plus two percent-encoded
    // ids), so it cannot be the hole the escaping around it exists to close.
    `Open in Mail: [${MAIL_LINK_LABEL}](${mailDeepLink(message.accountId, message.messageId)})`,
  ]
  const snippet = oneLine(message.snippet ?? '')
  if (snippet) lines.push('', quotedMarkdown(snippet))
  return lines.join('\n')
}

/** The note `note: true` appends: the body's plain text, bounded and quoted. */
export function taskNoteOf(text: string): string | null {
  const cut = truncateUtf8(text, TASK_NOTE_MAX_BYTES)
  const trimmed = cut.text.trim()
  if (!trimmed) return null
  const more = cut.shown < cut.total ? '\n\nThe rest of the message is in Mail.' : ''
  return `${quotedMarkdown(trimmed)}${more}`
}

/** Just the task surface this needs, so a test can hand it three functions. */
export interface MessageTaskHost {
  get(id: string): Promise<{ id: string } | null>
  create(input: {
    title: string
    description?: string
    project?: string
    tags?: string[]
  }): Promise<{ id: string }>
  appendNote(id: string, markdown: string): Promise<void>
}

export interface MessageTaskDeps {
  store: MailStore
  events: MailEvents
  tasks: MessageTaskHost
  /**
   * The cached envelope, the account's display name and the body.
   *
   * `accountLabel` is a NAME rather than an account object on purpose: the label is all this file
   * needs, and asking for the account meant calling the whole decorated accounts list, which now
   * makes a provider call per account. One mail becoming one task should not reach a mail server.
   */
  read: {
    message(accountId: string, messageId: string): Promise<MailMessageDto>
    accountLabel(accountId: string): Promise<string>
    bodyText(accountId: string, messageId: string): Promise<string>
  }
  log: { warn(message: string, meta?: Record<string, unknown>): void }
  now?: () => number
}

export interface MessageTaskInput {
  accountId: string
  messageId: string
  /** The human's or the agent's own title. Trusted text, so it is placed as written. */
  title?: string
  project?: string
  note?: boolean
}

export interface MessageTaskResult {
  taskId: string
  created: boolean
  /** True when a note was asked for and there was no body text to put in it. */
  noteSkipped?: boolean
}

export class MailMessageTasks {
  /**
   * The link in progress for one ledger key, while it is in progress.
   *
   * One process owns the plugin, so this is the whole answer for every caller Walnut has: a second
   * ask waits for the first and reports its id instead of creating a second task. Keyed on the
   * LEDGER key rather than on the account/message pair, because the same mail in two mailboxes is
   * one key and therefore one task.
   */
  private readonly inFlight = new Map<string, Promise<MessageTaskResult>>()

  constructor(private readonly deps: MessageTaskDeps) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** The ledger's answer for one message, or `undefined`. Used by the read paths. */
  async taskIdFor(message: MailMessageDto): Promise<string | undefined> {
    const row = await this.deps.store.tasks.getMessageTask(keyOfMessage(message))
    return row?.task_id
  }

  /**
   * Make the task, or hand back the one that already exists.
   *
   * The read comes before the gate so an unknown message is a 404 that creates nothing and waits
   * for nobody. Everything after it is serialized per key: see `inFlight`.
   */
  async link(input: MessageTaskInput): Promise<MessageTaskResult> {
    const message = await this.deps.read.message(input.accountId, input.messageId)
    const key = keyOfMessage(message)
    const running = this.inFlight.get(key)
    if (running) {
      // A FAILED first attempt is not an answer, so the waiter falls through and does the work
      // itself rather than inheriting an error it could have retried past.
      const first = await running.catch(() => null)
      if (first) return { taskId: first.taskId, created: false }
    }
    const attempt = this.linkOne(key, message, input)
      .finally(() => { this.inFlight.delete(key) })
    this.inFlight.set(key, attempt)
    return attempt
  }

  /**
   * One link, with no concurrency left to worry about.
   *
   * The order is deliberate: the ledger, then the task, then the ledger again, and the NOTE LAST. A
   * note needs the body, a body may need the provider, and a provider is the slowest thing in this
   * method: doing it before the create would mean a route that ran out of budget lost the task
   * entirely, while doing it after means the retry finds the task and says `created: false`.
   */
  private async linkOne(
    key: string,
    message: MailMessageDto,
    input: MessageTaskInput,
  ): Promise<MessageTaskResult> {
    const existing = await this.deps.store.tasks.getMessageTask(key)
    if (existing) {
      // The task the ledger points at may be gone: the human deleted it, or a data restore rolled
      // it back. `get` is what tells us, and a dead id is repointed rather than reported.
      const alive = await this.deps.tasks.get(existing.task_id).catch(() => null)
      if (alive) return { taskId: existing.task_id, created: false }
    }

    const accountLabel = await this.deps.read.accountLabel(input.accountId)
    const title = oneLine(input.title ?? '') || taskTitleOf(message.subject)
    const task = await this.deps.tasks.create({
      title,
      description: taskDescriptionOf({ message, accountLabel }),
      ...(input.project ? { project: input.project } : {}),
      tags: [MAIL_TASK_TAG],
    })
    const winner = await this.deps.store.tasks.claimMessageTask({
      key,
      accountId: input.accountId,
      messageId: input.messageId,
      taskId: task.id,
      now: this.now,
      ...(existing ? { replacing: existing.task_id } : {}),
    })
    // Someone else's task holds the key. The one just made is left in place rather than deleted: a
    // task is the human's, deleting one to tidy a race is the more surprising of the two outcomes,
    // and this is reachable only if a caller got past `inFlight`, which no path in Walnut does.
    if (winner !== task.id) {
      this.deps.log.warn('mail lost a race to link a message to a task', {
        taskId: task.id, winner, accountId: input.accountId,
      })
      return { taskId: winner, created: false }
    }
    this.deps.events.messageTasked(input.accountId, input.messageId, task.id)

    if (!input.note) return { taskId: task.id, created: true }
    let noteSkipped = true
    try {
      const note = taskNoteOf(await this.deps.read.bodyText(input.accountId, input.messageId))
      if (note) {
        await this.deps.tasks.appendNote(task.id, note)
        noteSkipped = false
      }
    } catch (error) {
      // The task is already real and already linked, so a body that cannot be fetched is a missing
      // note, never a failed request. The caller is told which of the two it got.
      this.deps.log.warn('mail could not add the message body to a task note', {
        taskId: task.id, error: String(error).slice(0, 200),
      })
    }
    return { taskId: task.id, created: true, ...(noteSkipped ? { noteSkipped } : {}) }
  }
}
