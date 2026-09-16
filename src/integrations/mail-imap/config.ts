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
import type { SmtpSecurity, SmtpSettings } from './smtp.js'

export const PROVIDER_ID = 'imap'

export interface ImapStoredAccount extends Record<string, unknown> {
  address: string
  imap_host: string
  imap_port: number
  imap_tls: 'tls' | 'starttls'
  /**
   * The outgoing half, and it is OPTIONAL on purpose.
   *
   * Reading needs a host and a password; sending needs a second server the human may not know or
   * may not want to give. An account with no `smtp_host` reports `send: false` from
   * `accountCapabilities`, so the console hides the button and the base refuses the approval
   * letter rather than offering a Send that is certain to fail.
   */
  smtp_host?: string
  smtp_port?: number
  smtp_tls?: 'tls' | 'starttls' | 'none'
  display_name?: string
  /** Mailbox path to role, for a server whose folder names this code cannot guess. */
  roles?: Record<string, string>
  /**
   * THIS account's outgoing server files its own Sent copy, so this plugin must not add a second.
   *
   * Per account because it is a fact about one server, not about the box: Gmail files its own copy
   * and a self-hosted server does not, and one flag for both is wrong for one of them. Absent means
   * "whatever the plugin-level `server_saves_sent` says", which is what keeps an account added
   * before this existed behaving exactly as it did. Setup stamps it from the known-service table
   * (setup-presets.ts), so nobody has to know this about their own mail host.
   */
  server_saves_sent?: boolean
}

interface ImapPluginConfig extends Record<string, unknown> {
  accounts?: Record<string, ImapStoredAccount>
  /** Put a copy of every sent message in the Sent folder over IMAP. Default true. */
  append_sent?: boolean
  /**
   * The outgoing server files its own Sent copy, so Walnut must NOT add a second one.
   *
   * Default false, because most SMTP servers do nothing of the kind. Gmail is the exception every
   * user runs into: it saves a copy of anything sent through its own SMTP, so leaving this false
   * on a Gmail account puts two copies of every message in Sent.
   */
  server_saves_sent?: boolean
}

/** What to do about the Sent folder, read from the plugin's config. */
export interface SentCopyPolicy {
  appendSent: boolean
  serverSavesSent: boolean
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
  /** Present only when this account has outgoing mail configured. Absent means it cannot send. */
  smtp?: SmtpSettings
  displayName: string
  roles: Record<string, string>
}

function toSmtp(stored: ImapStoredAccount): SmtpSettings | undefined {
  const host = stored.smtp_host?.trim()
  if (!host) return undefined
  const security: SmtpSecurity = stored.smtp_tls === 'tls'
    ? 'tls'
    : stored.smtp_tls === 'none' ? 'none' : 'starttls'
  const port = Number(stored.smtp_port)
  return {
    host,
    // 587 with STARTTLS is what nearly every provider documents, and it is the default the setup
    // form suggests. 465 is implicit TLS; 25 is for a server that asked for no encryption.
    port: Number.isFinite(port) && port > 0 ? Math.floor(port) : security === 'tls' ? 465 : 587,
    security,
  }
}

function toEntry(localId: string, stored: ImapStoredAccount): ImapAccountEntry | undefined {
  if (!stored?.address || !stored.imap_host) return undefined
  const port = Number(stored.imap_port)
  const smtp = toSmtp(stored)
  return {
    accountId: `${PROVIDER_ID}:${localId}`,
    settings: {
      address: stored.address,
      host: stored.imap_host,
      port: Number.isFinite(port) && port > 0 ? Math.floor(port) : 993,
      tls: stored.imap_tls === 'starttls' ? 'starttls' : 'tls',
    },
    ...(smtp ? { smtp } : {}),
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
   * The Sent-folder policy for one account.
   *
   * `append_sent` stays plugin wide: it is a preference about how the human wants their own Sent
   * folder to look. `server_saves_sent` is a FACT about one outgoing server, so the account's own
   * value wins and the plugin-level flag is only its default. One flag for the whole box was
   * necessarily wrong for a box holding both a Gmail account (files its own copy) and a self-hosted
   * one (does not), and the human had no way to tell which way to set it.
   */
  async sentCopyPolicy(accountId?: string): Promise<SentCopyPolicy> {
    const config = await this.walnut.config.get<ImapPluginConfig>()
    const own = accountId ? config.accounts?.[localIdOf(accountId)]?.server_saves_sent : undefined
    return {
      appendSent: config.append_sent !== false,
      serverSavesSent: typeof own === 'boolean' ? own : config.server_saves_sent === true,
    }
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
    smtpHost?: string
    smtpPort?: number
    smtpSecurity?: SmtpSecurity
    /**
     * This server files its own Sent copy. Omitted means "leave whatever this account already said",
     * so a re-save that does not know the answer cannot quietly take a stamped fact away.
     */
    serverSavesSent?: boolean
  }): Promise<ImapAccountEntry> {
    const localId = localIdFor(input.address)
    const accountId = `${PROVIDER_ID}:${localId}`
    const config = await this.walnut.config.get<ImapPluginConfig>()
    const stored: ImapStoredAccount = {
      address: input.address,
      imap_host: input.host,
      imap_port: input.port,
      imap_tls: input.tls,
      // Written only when the human gave them. An absent `smtp_host` is what makes this account
      // read-only, and re-saving without the fields is how they take sending away again.
      ...(input.smtpHost
        ? {
          smtp_host: input.smtpHost,
          smtp_port: input.smtpPort ?? (input.smtpSecurity === 'tls' ? 465 : 587),
          smtp_tls: input.smtpSecurity ?? 'starttls',
        }
        : {}),
      ...(input.displayName ? { display_name: input.displayName } : {}),
      ...(config.accounts?.[localId]?.roles ? { roles: config.accounts[localId].roles! } : {}),
      ...(typeof input.serverSavesSent === 'boolean'
        ? { server_saves_sent: input.serverSavesSent }
        : typeof config.accounts?.[localId]?.server_saves_sent === 'boolean'
          ? { server_saves_sent: config.accounts[localId].server_saves_sent! }
          : {}),
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
