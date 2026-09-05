import { CLOUD_MODE } from '../../constants.js'
import type { WalnutServerPluginApi } from '../../core/plugins/server-api.js'
import type { MailDatabase } from './db.js'
import type { MailProviderRegistry } from './provider-registry.js'
import type { MailAccount } from './types.js'

/**
 * The plugin's own HTTP surface, mounted by the host at `/api/plugins/mail/*`.
 *
 * There is deliberately NO `/api/mail` alias. Mail has no existing client to keep working,
 * which is the opposite of calendar's situation, so the plugin path is the only path and
 * nothing has to be deleted later.
 *
 * Two contracts every handler here keeps:
 *
 * - A cache read can be slow, so it can never be unbounded: `MailDatabase` carries a
 *   deadline and a stuck worker becomes a 503 `db_unavailable`. A route that hangs pins one
 *   of the browser's six connections and turns into an app-wide stall.
 * - On a cloud replica the whole base steps aside with 503 `primary_only`. Two boxes polling
 *   one mailbox double-write and double the provider's load. This is the PLUGIN's decision,
 *   read from the host's cloud-mode flag; core has no rule about mail routes.
 */

interface AccountRow extends Record<string, unknown> {
  account_id: string
  provider_id: string
  display_name: string
  address: string
  state: string
  health_json: string | null
  payload: string | null
}

const PRIMARY_ONLY = {
  status: 503,
  json: {
    error: 'primary_only',
    message: 'Mail runs on the primary box only: a replica polling the same mailbox would double every fetch and every write.',
  },
} as const

function unavailable(error: unknown) {
  return {
    status: 503,
    json: {
      error: 'db_unavailable',
      message: error instanceof Error ? error.message : String(error),
    },
  }
}

function parseJson<T>(raw: string | null): T | undefined {
  if (!raw) return undefined
  try { return JSON.parse(raw) as T }
  catch { return undefined }
}

function toAccount(row: AccountRow): MailAccount {
  const payload = parseJson<Partial<MailAccount>>(row.payload) ?? {}
  const health = parseJson<MailAccount['health']>(row.health_json)
  return {
    ...payload,
    accountId: row.account_id,
    providerId: row.provider_id,
    displayName: row.display_name,
    address: row.address,
    state: row.state as MailAccount['state'],
    ...(health ? { health } : {}),
  }
}

export function registerMailRoutes(
  walnut: WalnutServerPluginApi,
  deps: { db: MailDatabase; providers: MailProviderRegistry },
): void {
  const { db, providers } = deps

  walnut.http.route('get', '/accounts', async () => {
    if (CLOUD_MODE) return PRIMARY_ONLY
    try {
      const rows = await db.all<AccountRow>(
        'SELECT account_id, provider_id, display_name, address, state, health_json, payload'
        + ' FROM accounts ORDER BY account_id',
      )
      return { json: { accounts: rows.map(toAccount) } }
    } catch (error) {
      return unavailable(error)
    }
  })

  walnut.http.route('get', '/providers', () => {
    if (CLOUD_MODE) return PRIMARY_ONLY
    return { json: { providers: providers.list() } }
  })

  walnut.http.route('get', '/health', async () => {
    if (CLOUD_MODE) return PRIMARY_ONLY
    const accounts = await db.countOrNull('SELECT COUNT(*) AS n FROM accounts')
    return {
      json: {
        // Reaching this line IS the answer `ok` reports: the plugin is up and serving. The
        // cache's own truth rides `db`, so a broken cache stays diagnosable instead of
        // collapsing into one false boolean that says nothing about which half failed.
        ok: true,
        providers: providers.size,
        accounts: accounts ?? 0,
        db: db.status,
      },
    }
  })
}
