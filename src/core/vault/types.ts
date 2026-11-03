/**
 * Vault item model (docs/reference/passwords.md). Pure types, shared by the server,
 * the web app and the browser extension.
 */

export type VaultItemType = 'login' | 'note' | 'card' | 'api_key' | 'identity'

export const VAULT_ITEM_TYPES: readonly VaultItemType[] = ['login', 'note', 'card', 'api_key', 'identity']

/** How an agent may use the item: `never`; `ask` (a person approves each use); `allow` (no prompt). */
export type AgentAccess = 'never' | 'ask' | 'allow'

export interface VaultField {
  name: string
  value: string
  /** A hidden field is shown as dots, like a password. */
  hidden?: boolean
}

export interface PasswordHistoryEntry {
  password: string
  /** When this password stopped being the current one. */
  replacedAt: string
}

/** Everything an item holds once opened. Fields not used by its type stay absent. */
export interface VaultItem {
  id: string
  type: VaultItemType
  title: string
  username?: string
  password?: string
  /** Sites this login belongs to, normalized at save (https:// added, host lower-cased). */
  urls?: string[]
  /** An otpauth:// URI or a bare base32 seed. */
  totp?: string
  notes?: string
  fields?: VaultField[]
  /** Card */
  card?: { holder?: string; number?: string; expMonth?: string; expYear?: string; code?: string; brand?: string }
  /** API key: the env var name a command gets it as (walnut pass run). */
  envName?: string
  /**
   * Passkeys an import brought (Bitwarden `fido2Credentials`), kept as they came so
   * nothing is lost before Walnut can use them.
   */
  passkeys?: Array<Record<string, unknown>>
  tags?: string[]
  favorite?: boolean
  /** A sensitive item needs Face ID / Touch ID when an agent asks for it. */
  sensitive?: boolean
  agentAccess?: AgentAccess
  passwordHistory?: PasswordHistoryEntry[]
  createdAt: string
  updatedAt: string
  /** Last fill or copy. */
  usedAt?: string
  /** In the trash since; purged after TRASH_DAYS. */
  trashedAt?: string
}

/** What a list shows: never a secret (no password, TOTP seed, card number, notes or hidden field). */
export interface VaultItemSummary {
  id: string
  type: VaultItemType
  title: string
  username?: string
  urls?: string[]
  hasPassword: boolean
  hasTotp: boolean
  passkeyCount?: number
  tags?: string[]
  favorite?: boolean
  sensitive?: boolean
  agentAccess: AgentAccess
  /** API key: the env var a command gets it as. */
  envName?: string
  /** Card: last four digits only. */
  cardLast4?: string
  createdAt: string
  updatedAt: string
  usedAt?: string
  trashedAt?: string
  passwordChangedAt?: string
}

/** Fields a client may set; the server owns id, times and history. */
export type VaultItemInput = Omit<VaultItem, 'id' | 'createdAt' | 'updatedAt' | 'passwordHistory' | 'trashedAt' | 'usedAt'>

export const TRASH_DAYS = 30
export const PASSWORD_HISTORY_MAX = 20
export const TITLE_MAX = 200
export const NOTES_MAX = 20_000
export const SECRET_MAX = 4_000

export function summarize(item: VaultItem): VaultItemSummary {
  const last = item.passwordHistory?.[0]?.replacedAt
  const digits = item.card?.number?.replace(/\D/g, '')
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    ...(item.username ? { username: item.username } : {}),
    ...(item.urls?.length ? { urls: item.urls } : {}),
    hasPassword: !!item.password,
    hasTotp: !!item.totp,
    ...(item.passkeys?.length ? { passkeyCount: item.passkeys.length } : {}),
    ...(item.tags?.length ? { tags: item.tags } : {}),
    ...(item.favorite ? { favorite: true } : {}),
    ...(item.sensitive ? { sensitive: true } : {}),
    agentAccess: item.agentAccess ?? 'ask',
    ...(item.envName ? { envName: item.envName } : {}),
    ...(digits && digits.length >= 4 ? { cardLast4: digits.slice(-4) } : {}),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(item.usedAt ? { usedAt: item.usedAt } : {}),
    ...(item.trashedAt ? { trashedAt: item.trashedAt } : {}),
    ...(last ? { passwordChangedAt: last } : {}),
  }
}
