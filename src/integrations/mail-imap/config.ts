/**
 * Where an IMAP account lives on this box: non-secret settings in the plugin's own config,
 * the password in the plugin's own secret store, and nothing anywhere else.
 *
 * This is the provider half of the account-setup contract. The base passes the submitted values
 * straight through and persists NONE of them, so this file is the only writer, and the password
 * exists in exactly one place: `walnut.secrets`, a 0600 file per plugin, outside synced config.
 *
 * Two shapes worth knowing before reading the code:
 *
 * - The ACCOUNT ID is `imap:<localId>` where `localId` is a short hash of the address. Derived
 *   rather than assigned because it has to be stable across a re-add (the cached messages hang
 *   off it) and it must not be the address itself: an account id travels into log lines, event
 *   payloads and directory names.
 * - The CONFIG KEY and the SECRET KEY are the localId, not the full account id. A `:` is not
 *   allowed in a plugin secret key, and a colon in a YAML mapping key is a needless quoting
 *   question, so the prefix is re-attached on the way out instead of being stored twice.
 */
import crypto from 'node:crypto'
import type { WalnutServerPluginApi } from '../../core/plugins/server-api.js'
import type { ImapAccountSettings } from './client.js'

export const PROVIDER_ID = 'imap'

export interface ImapStoredAccount extends Record<string, unknown> {
  address: string
  imap_host: string
  imap_port: number
  imap_tls: 'tls' | 'starttls'
  display_name?: string
  /** Mailbox path to role, for a server whose folder names this code cannot guess. */
  roles?: Record<string, string>
}

interface ImapPluginConfig extends Record<string, unknown> {
  accounts?: Record<string, ImapStoredAccount>
}

export function localIdFor(address: string): string {
  return crypto.createHash('sha1').update(address.trim().toLowerCase()).digest('hex').slice(0, 12)
}

export function accountIdFor(address: string): string {
  return `${PROVIDER_ID}:${localIdFor(address)}`
}

/** The part after the first colon. Ids split on the FIRST separator only. */
export function localIdOf(accountId: string): string {
  const at = accountId.indexOf(':')
  return at > 0 ? accountId.slice(at + 1) : accountId
}

function secretKeyFor(accountId: string): string {
  return `password.${localIdOf(accountId)}`
}

export interface ImapAccountEntry {
  accountId: string
  settings: ImapAccountSettings
  displayName: string
  roles: Record<string, string>
}

function toEntry(localId: string, stored: ImapStoredAccount): ImapAccountEntry | undefined {
  if (!stored?.address || !stored.imap_host) return undefined
  const port = Number(stored.imap_port)
  return {
    accountId: `${PROVIDER_ID}:${localId}`,
    settings: {
      address: stored.address,
      host: stored.imap_host,
      port: Number.isFinite(port) && port > 0 ? Math.floor(port) : 993,
      tls: stored.imap_tls === 'starttls' ? 'starttls' : 'tls',
    },
    displayName: stored.display_name?.trim() || stored.address,
    roles: stored.roles ?? {},
  }
}

type ConfigHost = Pick<WalnutServerPluginApi, 'config' | 'secrets'>

export class ImapAccountStore {
  constructor(private readonly walnut: ConfigHost) {}

  async list(): Promise<ImapAccountEntry[]> {
    const config = await this.walnut.config.get<ImapPluginConfig>()
    return Object.entries(config.accounts ?? {})
      .map(([localId, stored]) => toEntry(localId, stored))
      .filter((entry): entry is ImapAccountEntry => !!entry)
      .sort((a, b) => a.settings.address.localeCompare(b.settings.address))
  }

  async entry(accountId: string): Promise<ImapAccountEntry | undefined> {
    const config = await this.walnut.config.get<ImapPluginConfig>()
    const stored = config.accounts?.[localIdOf(accountId)]
    return stored ? toEntry(localIdOf(accountId), stored) : undefined
  }

  async settings(accountId: string): Promise<ImapAccountSettings | undefined> {
    return (await this.entry(accountId))?.settings
  }

  password(accountId: string): Promise<string | undefined> {
    return this.walnut.secrets.get(secretKeyFor(accountId))
  }

  /**
   * Persist one account and its password.
   *
   * Read-modify-write over the accounts map, because the host's config patch is a SHALLOW merge
   * at the plugin level: patching `{ accounts }` replaces the whole map, so the current map has
   * to be read first. Adding an account is one deliberate human action, so the window is
   * acceptable; two accounts added in the same second from two clients is the case it loses.
   */
  async save(input: {
    address: string
    host: string
    port: number
    tls: 'tls' | 'starttls'
    password: string
    displayName?: string
  }): Promise<ImapAccountEntry> {
    const localId = localIdFor(input.address)
    const accountId = `${PROVIDER_ID}:${localId}`
    const config = await this.walnut.config.get<ImapPluginConfig>()
    const stored: ImapStoredAccount = {
      address: input.address,
      imap_host: input.host,
      imap_port: input.port,
      imap_tls: input.tls,
      ...(input.displayName ? { display_name: input.displayName } : {}),
      ...(config.accounts?.[localId]?.roles ? { roles: config.accounts[localId].roles! } : {}),
    }
    // Secret FIRST: an account row with no password is an account that fails every poll, while a
    // stored password with no row is inert and gets overwritten by the next attempt.
    await this.walnut.secrets.set(secretKeyFor(accountId), input.password)
    await this.walnut.config.patch({ accounts: { ...(config.accounts ?? {}), [localId]: stored } })
    return toEntry(localId, stored)!
  }

  async remove(accountId: string): Promise<void> {
    const localId = localIdOf(accountId)
    const config = await this.walnut.config.get<ImapPluginConfig>()
    const accounts = { ...(config.accounts ?? {}) }
    delete accounts[localId]
    await this.walnut.config.patch({ accounts })
    await this.walnut.secrets.delete(secretKeyFor(accountId))
  }
}
