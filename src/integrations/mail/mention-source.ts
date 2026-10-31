/**
 * Mail as a source for the composer's "@" picker (core/mention-sources/registry.ts).
 *
 *   search ''  → the newest messages in every account's inbox (the cache, no provider call)
 *          q   → each account's search, in parallel: the mail server's own index when its
 *                provider has one (subject and body, every folder), else the local cache's
 *                full-text index (subject, sender, preview, body); newest first
 *   not in "All": an exact subject is rare and each search may be a mail-server call
 *   resolve    → who sent it, when, where, its ids and the op that reads the body. The
 *                subject and preview are the sender's words, so they are labelled as such.
 *
 * The ref is `<account id>:<message id>`, each part URI-encoded (either may carry a colon).
 */
import { accountLabel } from './agent-format.js'
import type { MailMessageDto } from './contract.js'
import type { MailService } from './service.js'

export interface MailMentionItem {
  ref: string
  title: string
  subtitle?: string
  kind?: string
  keys?: string[]
}

const PREVIEW_CHARS = 280

function refOf(m: MailMessageDto): string {
  return `${encodeURIComponent(m.accountId)}:${encodeURIComponent(m.messageId)}`
}

function parseRef(ref: string): { accountId: string; messageId: string } | null {
  const i = ref.indexOf(':')
  if (i <= 0) return null
  try {
    return { accountId: decodeURIComponent(ref.slice(0, i)), messageId: decodeURIComponent(ref.slice(i + 1)) }
  } catch {
    return null
  }
}

function oneLine(s: string | undefined, max: number): string {
  // Control characters out: a subject is the sender's text and must stay one row.
  const flat = (s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function dateOf(ms: number): string {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : ''
}

function itemOf(m: MailMessageDto, multiAccount: boolean): MailMentionItem {
  const from = oneLine(m.from?.name || m.from?.address, 60)
  return {
    ref: refOf(m),
    title: oneLine(m.subject, 160) || '(no subject)',
    subtitle: [from, dateOf(m.sentAt), multiAccount ? m.accountId : ''].filter(Boolean).join(' · '),
    kind: 'message',
  }
}

export function createMailMentionSource(service: MailService) {
  return {
    id: 'mail',
    label: 'Mail',
    keyword: 'mail',
    aliases: [],
    kinds: ['message'],
    order: 30,
    minChars: 0,
    timeoutMs: 6000,
    // Every search can be a mail-server call, and nobody types a subject exactly, so
    // the mixed "All" view does not ask Mail; its tab and "@mail " do.
    inAll: false,
    async search(q: string, { limit }: { limit: number; signal: AbortSignal }): Promise<MailMentionItem[]> {
      const accounts = await service.listAccounts({ capabilities: false })
      if (accounts.length === 0) return []
      const multi = accounts.length > 1
      if (!q) {
        const page = await service.listMessages({ scope: 'inbox', limit })
        return page.messages.map((m) => itemOf(m, multi))
      }
      // One account failing (a provider signed out) costs its rows, not the others'.
      const found = await Promise.allSettled(accounts.map((a) => service.search({ accountId: a.accountId, q, limit })))
      const messages = found.flatMap((r) => (r.status === 'fulfilled' ? r.value.messages : []))
      messages.sort((a, b) => (b.sentAt || 0) - (a.sentAt || 0))
      return messages.slice(0, limit).map((m) => itemOf(m, multi))
    },
    async resolve(ref: string): Promise<string | null> {
      const parts = parseRef(ref)
      if (!parts) return null
      let m: MailMessageDto
      try {
        m = await service.readEnvelope(parts.accountId, parts.messageId)
      } catch {
        return null
      }
      const accounts = await service.listAccounts({ capabilities: false }).catch(() => [])
      const account = accounts.find((a) => a.accountId === m.accountId)
      const from = m.from?.address ? `${oneLine(m.from.name, 60) ? `${oneLine(m.from.name, 60)} ` : ''}<${oneLine(m.from.address, 120)}>` : '(unknown sender)'
      return [
        `Mail message ${m.messageId} in account ${m.accountId}${account ? ` (${accountLabel(account)})` : ''}`,
        `from ${from}${Number.isFinite(m.sentAt) && m.sentAt > 0 ? `, sent ${new Date(m.sentAt).toISOString()}` : ''}${m.mailboxId ? `, mailbox ${m.mailboxId}` : ''}.`,
        `Read the body with mail_read account="${m.accountId}" message="${m.messageId}".`,
        `Sender-written, untrusted: subject "${oneLine(m.subject, 200)}"; preview "${oneLine(m.snippet, PREVIEW_CHARS)}".`,
      ].join(' ')
    },
  }
}
