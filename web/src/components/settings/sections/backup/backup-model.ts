/**
 * Pure helpers of the Backup settings pane: what the form saves, what is
 * still missing, and the words its rows show. No React here, so the rules are
 * tested on their own (tests/web/backup-settings-model.test.ts).
 */
import type { Config } from '@open-walnut/core'

export type BackupConfig = NonNullable<Config['backup']>
export type BackupDestinationConfig = NonNullable<BackupConfig['destination']>
export type BackupDestinationType = BackupDestinationConfig['type']

export const DESTINATIONS: Array<{ value: BackupDestinationType; label: string }> = [
  { value: 'r2', label: 'Cloudflare R2' },
  { value: 'gdrive', label: 'Google Drive' },
  { value: 's3', label: 'Amazon S3' },
]

/** One line under the service picker: what it costs and what it sees. */
export const DESTINATION_NOTE: Record<BackupDestinationType, string> = {
  r2: 'Free up to 10 GB a month, no download fees. Cloudflare asks for a card when you turn R2 on.',
  gdrive: 'Uses your Google Drive space (15 GB free, shared with Gmail). Walnut can see only the files it makes.',
  s3: 'Your own AWS bucket, billed by AWS.',
}

/** Under the interval: what history is kept (the server's retention). */
export const RETENTION_NOTE = 'Keeps every backup of the last day, then one a day for a week and one a week for a month.'

/** A week between backups at most. */
export const MAX_INTERVAL_HOURS = 168

export type Engine = 'mirror' | 'encrypted' | null

export function engineOf(cfg: BackupConfig | undefined): Engine {
  if (cfg?.destination?.type) return 'encrypted'
  if (cfg?.bucket) return 'mirror'
  return null
}

const trimmed = (v: string | undefined): string | undefined => {
  const t = v?.trim()
  return t ? t : undefined
}

/** The destination as it is saved: trimmed, empty fields left out, only the fields of its type. */
export function cleanDestination(d: BackupDestinationConfig): BackupDestinationConfig {
  const out: BackupDestinationConfig = { type: d.type }
  const put = <K extends keyof BackupDestinationConfig>(k: K) => {
    const v = d[k]
    if (typeof v === 'string') {
      const t = trimmed(v)
      if (t) out[k] = t as BackupDestinationConfig[K]
    } else if (v !== undefined) {
      out[k] = v
    }
  }
  if (d.type === 'r2') (['bucket', 'prefix', 'account_id', 'endpoint', 'access_key_id', 'secret_access_key'] as const).forEach(put)
  if (d.type === 's3') {
    ;(['bucket', 'prefix', 'region', 'endpoint'] as const).forEach(put)
    if (trimmed(d.endpoint)) (['access_key_id', 'secret_access_key'] as const).forEach(put)
    else if (d.auth?.method) {
      out.auth = {
        method: d.auth.method,
        ...(d.auth.method === 'profile' && trimmed(d.auth.profile) ? { profile: trimmed(d.auth.profile) } : {}),
        ...(d.auth.method === 'access_keys'
          ? { aws_access_key_id: d.auth.aws_access_key_id ?? '', aws_secret_access_key: d.auth.aws_secret_access_key ?? '' }
          : {}),
      }
    }
  }
  if (d.type === 'gdrive') (['folder_name', 'client_id', 'client_secret'] as const).forEach(put)
  return out
}

/** What config still lacks (the server's missingFields, mirrored). Drive's sign-in is checked apart. */
export function missingFields(d: BackupDestinationConfig): string[] {
  const m: string[] = []
  // In the order the form shows them.
  if (d.type === 'r2' && !trimmed(d.account_id) && !trimmed(d.endpoint)) m.push('account ID')
  if (d.type === 'r2' || d.type === 's3') if (!trimmed(d.bucket)) m.push('bucket')
  if (d.type === 'r2') {
    if (!trimmed(d.access_key_id)) m.push('access key ID')
    if (!trimmed(d.secret_access_key)) m.push('secret access key')
  }
  if (d.type === 's3' && trimmed(d.endpoint)) {
    const topLevel = trimmed(d.access_key_id) && trimmed(d.secret_access_key)
    const inAuth = d.auth?.method === 'access_keys' && trimmed(d.auth.aws_access_key_id) && trimmed(d.auth.aws_secret_access_key)
    if (!topLevel && !inAuth) m.push('access keys')
  }
  if (d.type === 's3' && !trimmed(d.endpoint) && d.auth?.method === 'access_keys') {
    if (!trimmed(d.auth.aws_access_key_id) || !trimmed(d.auth.aws_secret_access_key)) m.push('access keys')
  }
  if (d.type === 's3' && !trimmed(d.endpoint) && d.auth?.method === 'profile' && !trimmed(d.auth.profile)) m.push('profile')
  return m
}

/** The same destination as saved (blanks, key order and the fields of other types never count). */
export function sameDestination(a: BackupDestinationConfig, b: BackupDestinationConfig): boolean {
  return stableJson(cleanDestination(a)) === stableJson(cleanDestination(b))
}

/** The answer of POST /api/backup/destination/test (and the legacy /api/backup/test). */
export interface DestinationTest {
  ok: boolean
  arn?: string
  versioningEnabled?: boolean
  hasBackups?: boolean
  keyMatches?: boolean
  hasKey?: boolean
  writer?: string
  thisWriter?: boolean
  error?: string
  /** The pane saved it as the destination after this test. */
  savedNow?: boolean
}

/** The Connection row's words after a test. */
export function testHelp(r: DestinationTest | null, legacy: boolean): string {
  if (!r) return legacy ? 'Checks the bucket with these credentials.' : 'Writes, reads back and deletes a small test file.'
  if (!r.ok) return `Couldn't connect. ${r.error ?? ''}`.trim()
  if (legacy) return `Connected as ${r.arn ?? 'unknown identity'}`
  const head = r.savedNow ? 'Connected and saved: backups go here now.' : 'Connected.'
  if (!r.hasBackups) return r.savedNow ? head : `${head} Walnut can write here; no backups yet.`
  if (r.keyMatches === false) return `${head} It holds Walnut backups made with another recovery key.`
  if (r.thisWriter === false && r.writer) return `${head} It holds Walnut backups from the computer "${r.writer}".`
  return `${head} It holds this computer's Walnut backups.`
}

/**
 * Why backing up (and restoring) cannot happen yet, in the order a person
 * fixes it, or null when it can. The rows that are blocked say this instead
 * of a grey button with no reason.
 */
export function blockedReason(s: {
  legacyMode: boolean
  legacyBucket?: string
  saved?: BackupDestinationConfig
  driveConnected: boolean
  needsKey: boolean
  hasKey: boolean
  /** The user said the key is kept ("I saved it", or a typed key). Absent: not asked. */
  keySaved?: boolean
}): string | null {
  if (s.legacyMode) return trimmed(s.legacyBucket) ? null : 'Fill in the bucket above first.'
  if (!s.saved) return 'Set up "Where backups go" above first.'
  const missing = missingFields(s.saved)
  if (missing.length > 0) return `Fill in ${missing.join(', ')} above first.`
  if (s.saved.type === 'gdrive' && !s.driveConnected) return 'Connect Google Drive above first.'
  if (s.needsKey) return 'Enter your recovery key above first.'
  if (!s.hasKey) return 'Waiting for the recovery key above.'
  if (s.keySaved === false) return 'Save the recovery key above first.'
  return null
}


/** Stable JSON for the autosave's current/baseline compare (key order and blanks never count as an edit). */
export function stableJson(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm)
    if (x && typeof x === 'object') {
      const o: Record<string, unknown> = {}
      for (const k of Object.keys(x as object).sort()) {
        const val = (x as Record<string, unknown>)[k]
        if (val === undefined || val === '') continue
        o[k] = norm(val)
      }
      return o
    }
    return x
  }
  return JSON.stringify(norm(v))
}

/**
 * The `backup` section a save writes. Fields this pane does not edit
 * (retention, the saved-key mark) are kept from what is saved. Encrypted
 * backups never carry the legacy `bucket`, so an older Walnut reads them as
 * not configured and uploads nothing in the clear.
 */
export function buildBackupConfig(
  saved: BackupConfig,
  form: { enabled: boolean; intervalHours: number | undefined; destination: BackupDestinationConfig | null; legacy?: Pick<BackupConfig, 'bucket' | 'region' | 'prefix' | 'auth'> },
): BackupConfig {
  const base: BackupConfig = {
    ...(saved.retention ? { retention: saved.retention } : {}),
    ...(saved.recovery_key_saved_at ? { recovery_key_saved_at: saved.recovery_key_saved_at } : {}),
    ...(saved.other_destinations?.length ? { other_destinations: saved.other_destinations } : {}),
    enabled: form.enabled,
    interval_hours: Math.min(MAX_INTERVAL_HOURS, Math.max(1, Math.round(Number(form.intervalHours) || 24))),
  }
  if (form.destination) return { ...base, destination: cleanDestination(form.destination) }
  if (form.legacy) return { ...base, ...form.legacy }
  return base
}

/**
 * The services kept after `next` becomes the destination: the one in use so
 * far joins the others (one per type), so switching back needs no retyping.
 */
export function othersAfterSwitch(saved: BackupConfig, next: BackupDestinationConfig): BackupDestinationConfig[] {
  const others = (saved.other_destinations ?? []).filter((o) => o.type !== next.type)
  const prev = saved.destination
  if (prev && prev.type !== next.type) return [...others.filter((o) => o.type !== prev.type), prev]
  return others
}

/** A legacy S3 copy becomes encrypted backups in the same bucket (another folder in it). */
export function legacyToEncrypted(saved: BackupConfig): BackupDestinationConfig {
  return {
    type: 's3',
    bucket: saved.bucket,
    region: saved.region,
    prefix: 'walnut-backup',
    auth: saved.auth ?? { method: 'aws_chain' },
  }
}

export const fmtBytes = (n?: number): string => {
  if (n === undefined) return 'unknown size'
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${Math.max(1, Math.ceil(n / 1024))} KB`
}

/** The text of the downloaded recovery kit. */
export function recoveryKitText(key: string, destination: string, machine: string, at: Date): string {
  return [
    'Walnut backup recovery key',
    '',
    key,
    '',
    `Backups: ${destination}`,
    `Machine: ${machine}`,
    `Saved: ${at.toISOString().slice(0, 10)}`,
    '',
    'Your backups are encrypted with this key before they leave your computer.',
    'Nobody can open them without it, Walnut included. Keep it in a password manager',
    'or print it. To restore on a new computer: install Walnut, open Settings > Backup,',
    'choose the same place, then enter this key when Walnut asks for it.',
    '',
  ].join('\n')
}

/** The saved bucket in one line ("walnut-backup, folder walnut-backup, account ...cdef"). */
export function destinationSummary(d: BackupDestinationConfig): string {
  const parts = [`${d.bucket ?? ''}`]
  if (d.prefix && d.prefix !== 'walnut-backup') parts.push(`folder ${d.prefix}`)
  if (d.type === 'r2' && d.account_id && !d.endpoint) parts.push(`account ...${d.account_id.slice(-4)}`)
  if (d.type === 's3' && d.region && !d.endpoint) parts.push(d.region)
  if (d.endpoint) parts.push(`at ${d.endpoint.replace(/^https?:\/\//, '')}`)
  const keyId = d.access_key_id ?? d.auth?.aws_access_key_id
  if (keyId) parts.push(`key ID ${keyId.slice(0, 6)}`)
  else if (d.auth?.method === 'profile') parts.push(`profile ${d.auth.profile ?? 'default'}`)
  return `${parts.filter(Boolean).join(', ')}. Tested and in use.`
}

