/**
 * The mail plugin's trigger template: "new mail in the inbox", optionally from
 * one sender or with a subject word.
 *
 * It reads the plugin's own cache, which the sync loop keeps fresh, so a check
 * costs one indexed read and never a provider call. The cursor is the newest
 * arrival time seen, one per account (each account syncs on its own clock, so
 * one that catches up late must not fall behind another's cursor); each run
 * looks a little behind it (mail can land with an older timestamp than the
 * last one) and the daemon's seen ids drop what was already delivered. Nothing
 * from before the trigger was armed ever fires: the first run only records the
 * time, and the lookback never reaches behind it. A date in the future (the
 * sender sets it) counts as now, so it cannot push the cursor past real mail.
 */
import type { MailStore } from './store.js'
import type { MailAccountDto } from './contract.js'
import { toDto } from './service-dto.js'

/** How far behind the cursor each run looks; repeats inside it are dropped by item id. */
const LOOKBACK_MS = 30 * 60_000
const PAGE = 100
const MAX_ITEMS = 50

export interface MailTriggerDeps {
  store: Pick<MailStore, 'listMessages' | 'mailboxesByRole'>
  listAccounts(): Promise<MailAccountDto[]>
}

interface Cursor {
  /** When the trigger was armed: nothing older fires. */
  armedAt: number
  /** Newest arrival seen, per account id. */
  since: Record<string, number>
}

function cursorOf(state: unknown): Cursor | null {
  const raw = state as { armedAt?: unknown; since?: unknown } | null
  if (!raw || typeof raw !== 'object') return null
  // The first shape kept one number for every account; it was set at arming.
  if (typeof raw.since === 'number' && Number.isFinite(raw.since)) return { armedAt: raw.since, since: {} }
  if (typeof raw.armedAt !== 'number' || !Number.isFinite(raw.armedAt)) return null
  const since: Record<string, number> = {}
  if (raw.since && typeof raw.since === 'object') {
    for (const [account, at] of Object.entries(raw.since as Record<string, unknown>)) {
      if (typeof at === 'number' && Number.isFinite(at)) since[account] = at
    }
  }
  return { armedAt: raw.armedAt, since }
}

function matches(text: string, needle: string): boolean {
  return !needle || text.toLowerCase().includes(needle.toLowerCase())
}

function describeFilters(params: Record<string, string>, accountName: string): string {
  const parts: string[] = []
  if (params.from) parts.push(`from "${params.from}"`)
  if (params.subject) parts.push(`with "${params.subject}" in the subject`)
  return `${parts.length ? `New mail ${parts.join(' ')}` : 'New mail'} in ${accountName ? `the ${accountName} inbox` : 'the inbox'}`
}

export function createMailTriggerTemplate(deps: MailTriggerDeps) {
  return {
    id: 'new-mail',
    title: 'New mail',
    description: 'Fires when new mail arrives in the inbox, optionally only from a sender or with a word in the subject.',
    every: '5m',
    maxFiresPerDay: 96,
    // The plugin's own read ops (mail_list, mail_read) already answer sessions on other hosts.
    remote: true,
    examples: ['from: receipts@', 'subject: invoice'],
    params: [
      { key: 'account', label: 'Account', description: 'Leave empty for every account', options: true, placeholder: 'All accounts' },
      { key: 'from', label: 'From', description: 'Part of the sender address or name', placeholder: 'alice@example.com' },
      { key: 'subject', label: 'Subject contains', placeholder: 'invoice' },
    ],
    async prepare(params: Record<string, string>) {
      const accounts = await deps.listAccounts()
      let accountName = ''
      if (params.account) {
        const wanted = params.account.toLowerCase()
        const account = accounts.find((a) => a.accountId.toLowerCase() === wanted || a.address.toLowerCase() === wanted
          || a.displayName.toLowerCase() === wanted)
        if (!account) {
          throw new Error(`No mail account "${params.account}". Accounts: ${accounts.map((a) => a.address).join(', ') || 'none'}`)
        }
        params = { ...params, account: account.accountId }
        accountName = account.address
      }
      const what = describeFilters(params, accountName)
      return {
        params,
        label: what,
        description: `${what}. Each new message is handed to the session with its sender, subject and preview.`,
        prompt: `${what}. For each new message (sender, subject and preview are in the items): read it with mail_read when the `
          + 'preview is not enough, then do what it needs. Tell the user only about mail that needs them.',
      }
    },
    async options(key: string, query: string) {
      if (key !== 'account') return []
      const accounts = await deps.listAccounts()
      return accounts
        .filter((a) => matches(`${a.address} ${a.displayName}`, query))
        .map((a) => ({ value: a.accountId, label: a.address, ...(a.displayName && a.displayName !== a.address ? { hint: a.displayName } : {}) }))
    },
    async check(params: Record<string, string>, input: { state: unknown; now: string }) {
      const nowMs = Date.parse(input.now) || Date.now()
      const cursor = cursorOf(input.state)
      if (!cursor) return { fire: false, state: { armedAt: nowMs, since: {} } }
      const roleRows = await deps.store.mailboxesByRole('inbox')
      const pairs = roleRows
        .filter((row) => !params.account || row.account_id === params.account)
        .map((row) => ({ accountId: row.account_id, mailboxId: row.mailbox_id }))
      const rows = pairs.length ? await deps.store.listMessages({ pairs, limit: PAGE }) : []
      const arrivals = rows.map((row) => {
        const m = toDto(row)
        return { m, at: Math.min(m.receivedAt ?? m.sentAt, nowMs) }
      })
      const floorOf = (account: string) => Math.max((cursor.since[account] ?? cursor.armedAt) - LOOKBACK_MS, cursor.armedAt)
      const fresh = arrivals
        .filter(({ m, at }) => {
          if (at <= floorOf(m.accountId)) return false
          const from = `${m.from?.name ?? ''} <${m.from?.address ?? ''}>`
          return matches(from, params.from ?? '') && matches(m.subject ?? '', params.subject ?? '')
        })
        .sort((a, b) => a.at - b.at)
      // Oldest first, and with more than a fire carries the cursor stops at the
      // last one sent, so the next check carries the rest.
      const sent = fresh.slice(0, MAX_ITEMS)
      const cap = fresh.length > MAX_ITEMS ? sent[sent.length - 1]!.at : nowMs
      const since = { ...cursor.since }
      for (const { m, at } of arrivals) {
        if (at <= cap && at > (since[m.accountId] ?? cursor.armedAt)) since[m.accountId] = at
      }
      return {
        fire: sent.length > 0,
        items: sent.map(({ m, at }) => ({
          id: `${m.accountId}/${m.messageId}`.slice(0, 190),
          title: `${m.from?.name || m.from?.address || 'unknown'}: ${m.subject || '(no subject)'}`.slice(0, 160),
          accountId: m.accountId,
          messageId: m.messageId,
          from: m.from?.address ?? '',
          subject: m.subject ?? '',
          preview: (m.snippet ?? '').slice(0, 240),
          at: new Date(at).toISOString(),
        })),
        state: { armedAt: cursor.armedAt, since },
      }
    },
  }
}
