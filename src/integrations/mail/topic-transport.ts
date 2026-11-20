/**
 * The mail plugin's side of the topics mail bridge (core/topics/topic-mail-port.ts).
 *
 * Sending goes through the plugin's ONE send path, never around it: a draft (origin `agent`),
 * then `approvals.requestSend`, which is where the user's Approvals switch is read. Switch off
 * (the default): the mail goes out now through the ledger and is listed under Settings, General
 * as sent unasked, unless its text reads as personal, which still waits for him. Switch on: a
 * letter asks him first, and nothing leaves until he taps Send. The threading headers are the
 * bridge's own (the previous mail it sent to that person), shape-checked like any reply's.
 *
 * Receiving is a tap on the poll's arrival capture: the same arrivals the router intake reads,
 * handed over as a lazy loader that reads the cache only when a bridge is listening. Each arrival
 * carries its `Precedence` / `Auto-Submitted` from the cached envelope, so the bridge can drop an
 * automatic reply. A reply the bridge takes (posts in a topic) never reaches the router intake and
 * is not announced as new mail: it was delivered twice before, in the topic and minutes later to a
 * member task by the Mail router (review 2026-11-20).
 */
import type { MailApprovals } from './approvals.js'
import type { MailIncomingCapture, SendDto } from './contract.js'
import type { MailDrafts } from './drafts.js'
import type { MailSends } from './sends.js'
import type { MailService } from './service.js'
import type { MailStore } from './store.js'
import type { MessagePayload } from './service-dto.js'
import { plainTextOf } from '../../lib/message-text.js'
import { canonicalMessageId } from '../../core/topics/topic-mail-text.js'
import {
  topicMailArrivals, topicMailListening,
  type TopicMailIncoming, type TopicMailSendOutcome, type TopicMailTransport,
} from '../../core/topics/topic-mail-port.js'

const BATCH = 200

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200)

function outcomeOfSend(draftId: string, send: Pick<SendDto, 'state' | 'providerMessageId' | 'error'>): TopicMailSendOutcome {
  switch (send.state) {
    case 'sent': return { draftId, state: 'sent', ...(send.providerMessageId ? { messageId: send.providerMessageId } : {}) }
    case 'failed': return { draftId, state: 'failed', ...(send.error ? { error: send.error } : {}) }
    case 'unknown': return { draftId, state: 'unknown' }
    default: return { draftId, state: 'waiting' }
  }
}

export function createTopicMailTransport(deps: {
  service: Pick<MailService, 'listAccounts' | 'capabilitiesFor' | 'readMessage'>
  drafts: Pick<MailDrafts, 'create' | 'get' | 'discard'>
  approvals: Pick<MailApprovals, 'requestSend'>
  sends: Pick<MailSends, 'list'>
}): TopicMailTransport {
  return {
    async accounts() {
      const accounts = await deps.service.listAccounts()
      return Promise.all(accounts.map(async (one) => ({
        accountId: one.accountId,
        address: one.address,
        canSend: one.state === 'active' && (one.capabilities?.send
          ?? await deps.service.capabilitiesFor(one.accountId).then((c) => !!c.send).catch(() => false)),
      })))
    },

    async send(mail) {
      const inReplyTo = canonicalMessageId(mail.inReplyTo)
      const references = (mail.references ?? []).map((one) => canonicalMessageId(one)).filter(Boolean)
      const draft = await deps.drafts.create({
        accountId: mail.accountId,
        to: [mail.to],
        subject: mail.subject,
        bodyMarkdown: mail.text,
        origin: 'agent',
        ...(inReplyTo ? { reply: { inReplyTo, references, subject: mail.subject } } : {}),
      })
      try {
        const asked = await deps.approvals.requestSend(draft.draftId, draft.revision)
        return asked.sent ? outcomeOfSend(draft.draftId, asked.sent) : { draftId: draft.draftId, state: 'waiting' }
      } catch (error) {
        // Nothing was sent (the account went away, the draft was refused): no draft is left behind.
        await deps.drafts.discard(draft.draftId).catch(() => undefined)
        throw error
      }
    },

    async sendState(draftId) {
      const draft = await deps.drafts.get(draftId).catch(() => null)
      if (!draft || draft.state === 'discarded') return { draftId, state: 'discarded' }
      if (draft.state === 'sent') {
        const sends = await deps.sends.list({ draftId, limit: 10 })
        const sent = sends.find((one) => one.state === 'sent')
        return outcomeOfSend(draftId, sent ?? { state: 'sent' })
      }
      if (draft.state === 'failed') return { draftId, state: 'failed', ...(draft.error ? { error: draft.error } : {}) }
      if (draft.state === 'unknown') return { draftId, state: 'unknown' }
      // pending_approval, approved, sending, or composing after the user chose Edit: his to finish.
      return { draftId, state: 'waiting' }
    },

    async drop(draftId) {
      await deps.drafts.discard(draftId).catch(() => undefined)
    },

    async bodyText(accountId, messageId) {
      const read = await deps.service.readMessage(accountId, messageId)
      return read.body ? plainTextOf(read.body) : ''
    },
  }
}

/** The cached `bulkHeaders`, only its two string fields (a hand-edited or older blob carries anything). */
function bulkHeadersOf(raw: unknown): TopicMailIncoming['bulkHeaders'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const { precedence, autoSubmitted } = raw as Record<string, unknown>
  const out = {
    ...(typeof precedence === 'string' && precedence ? { precedence } : {}),
    ...(typeof autoSubmitted === 'string' && autoSubmitted ? { autoSubmitted } : {}),
  }
  return Object.keys(out).length ? out : undefined
}

async function incomingOf(store: Pick<MailStore, 'messagesByIds'>, accountId: string, ids: string[]): Promise<TopicMailIncoming[]> {
  const out: TopicMailIncoming[] = []
  for (let at = 0; at < ids.length; at += BATCH) {
    for (const row of await store.messagesByIds(accountId, ids.slice(at, at + BATCH))) {
      let payload: Pick<MessagePayload, 'from' | 'inReplyTo' | 'references' | 'bulkHeaders'> = {}
      try { payload = row.payload ? JSON.parse(row.payload) : {} } catch { /* an unreadable blob: headers only */ }
      out.push({
        accountId,
        messageId: row.message_id,
        rfcMessageId: row.rfc_message_id,
        from: payload.from?.address || row.from_addr,
        subject: row.subject,
        ...(payload.inReplyTo ? { inReplyTo: payload.inReplyTo } : {}),
        references: Array.isArray(payload.references) ? payload.references.filter((one) => typeof one === 'string') : [],
        ...(bulkHeadersOf(payload.bulkHeaders) ? { bulkHeaders: bulkHeadersOf(payload.bulkHeaders)! } : {}),
      })
    }
  }
  return out
}

/** The poll's arrival capture, with the topics bridge told first; what the bridge takes is left out of it. */
export function tapTopicMailArrivals(
  capture: MailIncomingCapture,
  store: Pick<MailStore, 'messagesByIds'>,
  log?: { warn(message: string, meta?: Record<string, unknown>): void },
): MailIncomingCapture {
  return async (accountId, headlines, opts) => {
    if (!topicMailListening()) return capture(accountId, headlines, opts)
    const ids = [...new Set(headlines.flatMap((one) => (one.messageId ? [one.messageId] : [])))]
    if (ids.length === 0) return capture(accountId, headlines, opts)
    const taken = await topicMailArrivals(accountId, () => incomingOf(store, accountId, ids).catch((error) => {
      log?.warn('topic mail could not read the new arrivals', { accountId, error: reason(error) })
      return []
    }))
    if (taken.size === 0) return capture(accountId, headlines, opts)
    const rest = headlines.filter((one) => !one.messageId || !taken.has(one.messageId))
    const finish = await capture(accountId, rest, opts)
    // "Keep the ingested ones" (void) would announce the taken replies too: name the rest instead.
    return async () => (await finish()) ?? rest
  }
}
