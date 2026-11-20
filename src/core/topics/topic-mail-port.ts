/**
 * The port between the topics mail bridge (core) and the mail plugin.
 *
 * The kernel never imports the mail plugin, so the plugin fills this port at activation, the same
 * way it registers its router source (core/router/source-registry.ts): a transport that sends
 * through the plugin's ONE send path (draft, the approval ledger with the user's Approvals switch,
 * one `provider.send`), and a tap that hands over each poll's new inbox arrivals. Nothing here
 * opens a connection of its own.
 *
 * The tap is lazy on purpose: the plugin calls `topicMailArrivals` with a loader, and the loader
 * (a cache read) runs only when a bridge is listening AND decides the topics flag is on, so an
 * install with topics off pays nothing per poll.
 */

export interface TopicMailAccount {
  accountId: string
  address: string
  /** The account can send (an outgoing server is configured). */
  canSend: boolean
}

export interface TopicMailOutgoing {
  accountId: string
  to: { name?: string; address: string }
  subject: string
  /** Plain text; it is also the text/plain part of the mail. */
  text: string
  /** The previous mail's Message-ID, so the reply threads. */
  inReplyTo?: string
  references?: string[]
}

/**
 * Where one send stands.
 *
 * `waiting`: a letter asks the user first (Approvals on, or the text reads as personal), or the
 * attempt is still running. `sent` carries the Message-ID the transport stamped. `failed`: the
 * transport refused before taking the message, so a retry is safe. `unknown`: it may have gone out,
 * so it is never retried. `discarded`: the user said no (or the draft is gone).
 */
export type TopicMailSendState = 'waiting' | 'sent' | 'failed' | 'unknown' | 'discarded'

export interface TopicMailSendOutcome {
  draftId: string
  state: TopicMailSendState
  messageId?: string
  error?: string
}

export interface TopicMailIncoming {
  accountId: string
  /** The mail cache's own id (what `bodyText` takes). */
  messageId: string
  /** The RFC Message-ID header, when the mail had one. */
  rfcMessageId: string
  /** The sender's address, as the mail says it. */
  from: string
  subject: string
  inReplyTo?: string
  references: string[]
  /**
   * `Precedence` / `Auto-Submitted` as the provider's listing carried them (lowercased; an older
   * responder's `X-Autoreply` reads as `autoSubmitted: auto-replied`). An automatic mail is never
   * posted (topic-mail-inbound.ts).
   */
  bulkHeaders?: { precedence?: string; autoSubmitted?: string }
}

export interface TopicMailTransport {
  accounts(): Promise<TopicMailAccount[]>
  send(mail: TopicMailOutgoing): Promise<TopicMailSendOutcome>
  /** Where an earlier send stands now. */
  sendState(draftId: string): Promise<TopicMailSendOutcome>
  /** Drop a failed draft so it does not linger in the Mail console; never throws. */
  drop(draftId: string): Promise<void>
  /** The arrival's plain text (fetched once when the cache has no body yet). */
  bodyText(accountId: string, messageId: string): Promise<string>
}

/** Answers the cache ids of the arrivals it takes (a reply posted in a topic): the plugin's router never sees those. */
export type TopicMailArrivalListener = (accountId: string, load: () => Promise<TopicMailIncoming[]>) => Promise<readonly string[]> | void

let transport: TopicMailTransport | null = null
const listeners = new Set<TopicMailArrivalListener>()

/** Called by the mail plugin at activation; the returned function withdraws it at teardown. */
export function registerTopicMailTransport(next: TopicMailTransport): () => void {
  transport = next
  return () => { if (transport === next) transport = null }
}

export function topicMailTransport(): TopicMailTransport | null {
  return transport
}

/** The bridge's subscription to new mail. */
export function onTopicMailArrivals(listener: TopicMailArrivalListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Whether anything listens; the plugin skips building the loader when nothing does. */
export function topicMailListening(): boolean {
  return listeners.size > 0
}

/** How long the poll waits for the bridge's claims (state and topic reads only, no network). */
export const TOPIC_MAIL_CLAIM_WAIT_MS = 15_000

/**
 * Called by the mail plugin for each poll's new arrivals; resolves to the cache ids the listeners
 * took. Never throws: a listener that fails or takes longer than `waitMs` takes nothing (the mail
 * then goes to the router as before: a reply seen twice beats a reply lost).
 */
export async function topicMailArrivals(accountId: string, load: () => Promise<TopicMailIncoming[]>, waitMs = TOPIC_MAIL_CLAIM_WAIT_MS): Promise<Set<string>> {
  const claims: Array<Promise<readonly string[]>> = []
  for (const listener of listeners) {
    try {
      const answer = listener(accountId, load)
      if (answer) claims.push(Promise.resolve(answer).catch(() => []))
    } catch { /* a listener reports its own failures */ }
  }
  const taken = new Set<string>()
  if (claims.length === 0) return taken
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<readonly string[]>((resolve) => { timer = setTimeout(() => resolve([]), waitMs); timer.unref?.() })
  try {
    for (const ids of await Promise.all(claims.map((one) => Promise.race([one, late])))) for (const id of ids) taken.add(id)
  } finally {
    clearTimeout(timer)
  }
  return taken
}
