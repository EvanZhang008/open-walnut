import { useEffect, useState } from 'react'
import { ApiError, apiGet } from '@/api/client'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { log } from '@/utils/log'
import type { AppComponentProps } from './registry'

/**
 * The Mail console, slice 0: what the base can answer with no provider and no account.
 *
 * It talks to `/api/plugins/mail/*` and nothing else. There is deliberately no `/api/mail`
 * alias: mail has no existing client that needs one, so the plugin path is the only path.
 *
 * The screen is a core app rather than a plugin bundle for reasons that outlive slice 0: a
 * mail reader needs host components a plugin bundle cannot import (sanitized HTML, menu
 * placement, task-ref pills), and the loader has no dev-time esbuild for a plugin's web
 * entry, so every UI change would need a committed bundle. It is gated with `requiresPlugin`,
 * so the row disappears when the plugin is off.
 */

interface MailAccountRow {
  accountId: string
  displayName: string
  address: string
  state: string
}

interface MailProviderRow {
  id: string
  label: string
  capabilities?: { bodies?: string; send?: boolean }
}

/** A state this screen can explain in the user's words, rather than an errno. */
type MailStand = { title: string; detail: string }

/**
 * Both 503s the base can answer are EXPECTED, so they get sentences, not error text.
 *
 * `primary_only` is the normal reading on a cloud replica: the plugin is active there (so the
 * sidebar row shows), and it refuses every route on purpose, because two boxes polling one
 * mailbox double every fetch and every write. `db_unavailable` is the cache still opening or
 * wedged. "Mail is not answering right now: primary_only" is the failure this replaces.
 */
function standIn(err: unknown): MailStand | null {
  if (!(err instanceof ApiError) || err.status !== 503) return null
  const code = (err.body as { error?: string } | undefined)?.error
  if (code === 'primary_only') {
    return {
      title: 'Mail runs on your primary Walnut box',
      detail: 'This is a cloud companion, and it stays out of the mailbox so nothing gets fetched'
        + ' or sent twice. Open Mail on your primary box.',
    }
  }
  if (code === 'db_unavailable') {
    return {
      title: 'The mail cache is not answering yet',
      detail: 'It opens on first use and retries by itself. Give it a moment, then reload.',
    }
  }
  return null
}

export function MailApp(_props: AppComponentProps) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [stand, setStand] = useState<MailStand | null>(null)
  const [accounts, setAccounts] = useState<MailAccountRow[]>([])
  const [providers, setProviders] = useState<MailProviderRow[]>([])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        // quietStatuses: a 503 here is a state this screen renders, not a client-side fault to
        // shout about in the console.
        const [accountsResponse, providersResponse] = await Promise.all([
          apiGet<{ accounts: MailAccountRow[] }>('/api/plugins/mail/accounts', undefined, { quietStatuses: [503] }),
          apiGet<{ providers: MailProviderRow[] }>('/api/plugins/mail/providers', undefined, { quietStatuses: [503] }),
        ])
        if (cancelled) return
        setAccounts(accountsResponse.accounts ?? [])
        setProviders(providersResponse.providers ?? [])
        setStand(null)
        setError(null)
      } catch (err) {
        if (cancelled) return
        const expected = standIn(err)
        if (expected) {
          setStand(expected)
          setError(null)
          return
        }
        const message = err instanceof Error ? err.message : String(err)
        log.warn('mail', 'could not load the mail console', { error: message })
        setError(message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  return (
    <div className="mail-app">
      <div className="page-header">
        <h1 className="page-title">Mail</h1>
        <p className="page-subtitle">Accounts come from mail provider plugins</p>
      </div>

      {loading ? <LoadingSpinner /> : stand ? (
        <div className="empty-state" data-testid="mail-app-stand-in">
          <p>{stand.title}</p>
          <p>{stand.detail}</p>
        </div>
      ) : error ? (
        <div className="empty-state" data-testid="mail-app-error">
          <p>Mail is not answering right now: {error}</p>
        </div>
      ) : accounts.length === 0 ? (
        <div className="empty-state" data-testid="mail-app-empty">
          <p>No mail accounts yet</p>
          <p>
            {providers.length === 0
              ? 'Install a provider plugin (IMAP, for example) and it will add accounts here.'
              : 'A provider plugin adds accounts here. Ready to use: '
                + providers.map((provider) => provider.label).join(', ')}
          </p>
        </div>
      ) : (
        <ul className="mail-app-accounts" data-testid="mail-app-accounts">
          {accounts.map((account) => (
            <li key={account.accountId}>
              <strong>{account.displayName || account.address}</strong>
              <span>{account.address}</span>
              <span>{account.state}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
