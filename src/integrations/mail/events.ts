/**
 * What the mail base tells the rest of Walnut, and what it deliberately does not.
 *
 * The hygiene rules here are the whole reason this is a module instead of four `emit` calls
 * spread through the poller, and each one is a bug someone has shipped before:
 *
 * - NEVER one event per message. A first sync of a real mailbox is thousands of messages, and
 *   a per-message event turns one backfill into thousands of console refreshes. `messages-received`
 *   is emitted once per account per tick, with a count and at most five headlines.
 * - A no-op tick emits NOTHING. A poller that announces "I polled and nothing happened" every
 *   two minutes forever is a bus storm with a heartbeat's self-image; every global subscriber
 *   pays for it. The container's CURSOR is what decides: nothing added, nothing updated, and
 *   the provider handed back the same position it did last time means the container has not
 *   moved, and there is nothing to say.
 * - The initial backfill emits only `sync-completed`. "You have 4,812 new messages" is not
 *   news, it is the account being added.
 *
 * The host namespaces every name here to `plugin:mail:<name>`.
 */

export const MAIL_EVENT = {
  syncCompleted: 'sync-completed',
  messagesReceived: 'messages-received',
  accountHealth: 'account-health',
  accountChanged: 'account-changed',
  draftChanged: 'draft-changed',
  sendSettled: 'send-settled',
  messageTasked: 'message-tasked',
  digestSent: 'digest-sent',
  unsubscribed: 'unsubscribed',
  unreadReconciled: 'unread-reconciled',
  mailboxCounts: 'mailbox-counts',
} as const

/** At most this many subject lines ride a `messages-received`. */
export const MAX_HEADLINES = 5

export interface MailSyncCompletedEvent {
  accountId: string
  mailboxId: string
  added: number
  updated: number
  tookMs: number
}

export interface MailHeadline {
  from: string
  subject: string
}

export interface MailMessagesReceivedEvent {
  accountId: string
  count: number
  headlines: MailHeadline[]
}

export interface MailAccountHealthEvent {
  accountId: string
  state: string
}

export interface MailAccountChangedEvent {
  accountId: string
  action: 'added' | 'removed' | 'updated'
}

/**
 * A draft moved. Carries the revision, which is the field a console actually needs: without it a
 * client that just PATCHed cannot tell whether the event describes its own edit or a later one.
 */
export interface MailDraftChangedEvent {
  draftId: string
  state: string
  revision: number
}

/** A send row reached a new state. `sending` is included: it is the interesting one to watch. */
export interface MailSendSettledEvent {
  sendId: string
  draftId: string
  state: string
}

/**
 * A message became a task.
 *
 * Carries the ids and nothing else. The console turns the button into the task pill from this,
 * without a refetch, and a second console window showing the same mailbox does the same: the
 * backlink is derived on every read, so the event only has to say which row moved.
 */
export interface MailMessageTaskedEvent {
  accountId: string
  messageId: string
  taskId: string
}

/**
 * One unsubscribe attempt settled, whichever way it went.
 *
 * Carries `listKey` because that is what the console needs to decide which OTHER rows on screen just
 * changed: leaving a list marks every cached message from it, and without the key a console would
 * have to refetch the page to find out. Not coalesced and not suppressed, for the same reason
 * `draftChanged` is not: the whole volume here is bounded by the human's own clicks, and the one
 * screen where a missed event reads as "did that work or not" is exactly this one.
 */
export interface MailUnsubscribedEvent {
  accountId: string
  messageId: string
  listKey: string
  method: string
  status: string
}

/**
 * An unread check of one folder ended (see `unread-checks.ts`).
 *
 * Emitted in two cases and no others. When it CLEARED rows: mail read on another device left the
 * cache, and an open list has to read again (the poll loop's own checks only ever speak this way, so a
 * quiet tick says nothing). And when a page had named the check in its `checking`: that console is
 * showing "Checking…" and is owed an end, so it goes out with `cleared: 0`, or with `failed: true` when
 * the provider never answered. Bounded either way: by mail read elsewhere, and by pages a human opened.
 * The re-read it causes cannot emit it again, because the shared clock does not ask the same folder
 * twice within a minute.
 */
export interface MailUnreadReconciledEvent {
  accountId: string
  mailboxId: string
  cleared: number
  failed?: true
}

/**
 * The folder list of one account was read again and a count in it moved (unread or total), or a
 * folder came or went.
 *
 * Needed because a count can move with no row changing: a mail read on a phone lowers the inbox's own
 * unread count while the poll, which never lists that old mail again, reports nothing, so
 * `sync-completed` stays quiet and the sidebar kept the old number. Only emitted on a real change.
 */
export interface MailMailboxCountsEvent {
  accountId: string
}

/** The daily digest went out. `unread` is what it counted, so a log line reads on its own. */
export interface MailDigestSentEvent {
  letterId: string
  unread: number
}

type Emit = (name: string, data: unknown) => void

/** Structurally the host's Disposable; restated so this file needs no host import. */
interface Disposable {
  dispose(): void | Promise<void>
}

export class MailEvents {
  /** Per container: the signature of the last poll, so a repeat says nothing. */
  private readonly signatures = new Map<string, string>()

  /**
   * In-process subscribers for `mail:base`'s `onAccountsChanged`.
   *
   * Kept next to the bus emit rather than routed through it: a provider plugin holding the
   * service handle wants to hear about its own account appearing, and making it round-trip
   * through the bus would mean it also had to declare a bus subscription and know the host's
   * `plugin:mail:` naming, which is exactly the coupling a service is supposed to remove.
   */
  private readonly accountListeners = new Set<(event: MailAccountChangedEvent) => void>()

  constructor(private readonly emit: Emit) {}

  onAccountsChanged(handler: (event: MailAccountChangedEvent) => void): Disposable {
    this.accountListeners.add(handler)
    return { dispose: () => { this.accountListeners.delete(handler) } }
  }

  /**
   * A container finished a poll.
   *
   * Suppressed when the container did not move: no rows added, none updated, and the provider
   * handed back the same cursor as last time. That is the shape of 99% of ticks on a quiet
   * mailbox. Keyed on the cursor ALONE, deliberately: with the counts in the key too, the first
   * quiet tick after a productive one always looks different and always emits, which is one
   * useless event per burst of mail, forever.
   */
  syncCompleted(event: MailSyncCompletedEvent, cursor: string | null): void {
    const key = `${event.accountId}\u0000${event.mailboxId}`
    const signature = cursor ?? ''
    const unchanged = event.added === 0 && event.updated === 0 && this.signatures.get(key) === signature
    this.signatures.set(key, signature)
    if (unchanged) return
    this.emit(MAIL_EVENT.syncCompleted, event)
  }

  /** One per account per tick, or nothing. Never per message, never during a backfill. */
  messagesReceived(accountId: string, count: number, headlines: MailHeadline[]): void {
    if (count <= 0) return
    this.emit(MAIL_EVENT.messagesReceived, {
      accountId,
      count,
      headlines: headlines.slice(0, MAX_HEADLINES),
    } satisfies MailMessagesReceivedEvent)
  }

  /**
   * One per draft transition. Not suppressed and not coalesced, deliberately: the whole set of
   * transitions a draft can make is bounded by the human's own clicks, so there is no volume
   * here to protect against, and a console that missed one would show a stale state on the one
   * screen where staleness reads as "did my mail go or not".
   */
  draftChanged(draftId: string, state: string, revision: number): void {
    this.emit(MAIL_EVENT.draftChanged, { draftId, state, revision } satisfies MailDraftChangedEvent)
  }

  /** Bounded by the human's own clicks (or an agent's), so it is never coalesced. */
  messageTasked(accountId: string, messageId: string, taskId: string): void {
    this.emit(MAIL_EVENT.messageTasked, { accountId, messageId, taskId } satisfies MailMessageTaskedEvent)
  }

  /** One per settled attempt. Bounded by human clicks, so never coalesced. */
  unsubscribed(event: MailUnsubscribedEvent): void {
    this.emit(MAIL_EVENT.unsubscribed, event)
  }

  /** The caller (`UnreadChecks`) decides when; see `MailUnreadReconciledEvent`. */
  unreadReconciled(event: MailUnreadReconciledEvent): void {
    this.emit(MAIL_EVENT.unreadReconciled, event)
  }

  /** Only on a real change; the caller compares. See `MailMailboxCountsEvent`. */
  mailboxCounts(accountId: string): void {
    this.emit(MAIL_EVENT.mailboxCounts, { accountId } satisfies MailMailboxCountsEvent)
  }

  /** At most once a day, or once per "send it now". No suppression to do. */
  digestSent(letterId: string, unread: number): void {
    this.emit(MAIL_EVENT.digestSent, { letterId, unread } satisfies MailDigestSentEvent)
  }

  sendSettled(sendId: string, draftId: string, state: string): void {
    this.emit(MAIL_EVENT.sendSettled, { sendId, draftId, state } satisfies MailSendSettledEvent)
  }

  accountHealth(accountId: string, state: string): void {
    this.emit(MAIL_EVENT.accountHealth, { accountId, state } satisfies MailAccountHealthEvent)
  }

  accountChanged(accountId: string, action: MailAccountChangedEvent['action']): void {
    const event: MailAccountChangedEvent = { accountId, action }
    this.emit(MAIL_EVENT.accountChanged, event)
    for (const listener of [...this.accountListeners]) {
      // A listener that throws must not take the emit down with it: the account change already
      // happened, and the other listeners are entitled to hear about it.
      try { listener(event) }
      catch { /* the listener's own plugin owns this */ }
    }
  }

  /** A removed account must not keep a signature that would silence its replacement. */
  forgetAccount(accountId: string): void {
    for (const key of [...this.signatures.keys()]) {
      if (key.startsWith(`${accountId}\u0000`)) this.signatures.delete(key)
    }
  }
}
