/**
 * The fields of a bucket destination: Cloudflare R2 (account, bucket, an R2
 * API token's key pair) or Amazon S3 (bucket, region, credential source).
 * Rarely needed settings (folder in the bucket, a custom S3-compatible
 * endpoint) sit behind one Advanced row.
 */
import { SettingsDisclosure, SettingsRow } from '../../SettingsSection'
import { SecretInput } from '../../inputs/SecretInput'
import { SegmentedControl } from '../../inputs/SegmentedControl'
import type { BackupDestinationConfig } from './backup-model'

interface Props {
  dest: BackupDestinationConfig
  onChange: (next: BackupDestinationConfig) => void
  profiles: string[]
}

function TextRow({ id, label, value, onChange, placeholder, help, mono }: {
  id: string
  label: string
  value: string | undefined
  onChange: (v: string) => void
  placeholder?: string
  help?: string
  mono?: boolean
}) {
  return (
    <SettingsRow
      label={label}
      htmlFor={id}
      help={help}
      control={
        <input id={id} type="text" data-no-draft="autosave" autoComplete="off" spellCheck={false}
          className={`settings-input settings-input--short${mono ? ' settings-input--mono' : ''}`}
          value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
      }
    />
  )
}

export function R2Fields({ dest, onChange }: Props) {
  const set = (patch: Partial<BackupDestinationConfig>) => onChange({ ...dest, ...patch })
  return (
    <>
      <TextRow id="backup-r2-account" label="Account ID" value={dest.account_id} onChange={(v) => set({ account_id: v })}
        placeholder="e.g. 32 letters and digits" />
      <TextRow id="backup-r2-bucket" label="Bucket" value={dest.bucket} onChange={(v) => set({ bucket: v })} placeholder="e.g. walnut-backup" />
      <TextRow id="backup-r2-access-key" label="Access key ID" value={dest.access_key_id} onChange={(v) => set({ access_key_id: v })} />
      <SettingsRow
        label="Secret access key"
        htmlFor="backup-r2-secret"
        control={<SecretInput id="backup-r2-secret" value={dest.secret_access_key ?? ''} onChange={(v) => set({ secret_access_key: v })} />}
      />
      <SettingsDisclosure id="backup-r2-help" label="Where to find these in Cloudflare" data-testid="backup-r2-help">
        <ol className="settings-steps" data-testid="backup-r2-steps">
          <li>
            Open the <a href="https://dash.cloudflare.com/?to=/:account/r2/overview" target="_blank" rel="noreferrer">R2 page of your Cloudflare dashboard</a>.
            The first time, Cloudflare asks you to add a card to turn R2 on; the free tier is 10 GB.
          </li>
          <li>Choose <b>Create bucket</b>, name it (for example <code>walnut-backup</code>), keep the defaults.</li>
          <li>Back on the R2 page choose <b>Manage API tokens</b>, then <b>Create Account API token</b>.</li>
          <li>Pick <b>Object Read &amp; Write</b>, limit it to that bucket, and create it.</li>
          <li>Copy the <b>Access Key ID</b> and <b>Secret Access Key</b> into the rows above (Cloudflare shows the secret once).</li>
          <li>Choose <b>Test and save</b> below.</li>
          <li>The <b>Account ID</b> is on the same page, under Account details.</li>
        </ol>
      </SettingsDisclosure>
      <SettingsDisclosure id="backup-r2-advanced" label="Advanced" summary={advancedSummary(dest)} data-testid="backup-r2-advanced">
        <TextRow id="backup-r2-prefix" label="Folder in the bucket" value={dest.prefix} onChange={(v) => set({ prefix: v })}
          placeholder="Default: walnut-backup" />
        <TextRow id="backup-r2-endpoint" label="Custom endpoint" value={dest.endpoint} onChange={(v) => set({ endpoint: v })}
          placeholder="e.g. https://<account>.eu.r2.cloudflarestorage.com"
          help="Only for an EU bucket or another S3-compatible service." />
      </SettingsDisclosure>
    </>
  )
}

export function S3Fields({ dest, onChange, profiles }: Props) {
  const set = (patch: Partial<BackupDestinationConfig>) => onChange({ ...dest, ...patch })
  const auth = dest.auth ?? { method: 'aws_chain' as const }
  const setAuth = (patch: Partial<NonNullable<BackupDestinationConfig['auth']>>) => set({ auth: { ...auth, ...patch } })
  const custom = Boolean(dest.endpoint?.trim())
  return (
    <>
      <TextRow id="backup-s3-bucket" label="Bucket" value={dest.bucket} onChange={(v) => set({ bucket: v })} placeholder="e.g. my-walnut-backup" />
      <TextRow id="backup-s3-region" label="Region" value={dest.region} onChange={(v) => set({ region: v })} placeholder="e.g. us-west-2" />
      {!custom && (
        <SettingsRow
          label="Credentials"
          control={
            <SegmentedControl
              id="backup-s3-auth"
              aria-label="Credentials"
              value={auth.method ?? 'aws_chain'}
              onChange={(v) => setAuth({ method: v })}
              options={[
                { value: 'aws_chain', label: 'Default chain', title: 'The default AWS credential chain', testId: 'backup-auth-aws_chain' },
                { value: 'profile', label: 'AWS profile', title: 'A profile from ~/.aws', testId: 'backup-auth-profile' },
                { value: 'access_keys', label: 'Access keys', testId: 'backup-auth-access_keys' },
              ]}
            />
          }
        />
      )}
      {!custom && auth.method === 'profile' && (
        <SettingsRow label="Profile" htmlFor="backup-s3-profile" indent control={profiles.length > 0 ? (
          <select id="backup-s3-profile" className="settings-select" value={auth.profile ?? ''} onChange={(e) => setAuth({ profile: e.target.value })}>
            <option value="">Choose a profile</option>
            {profiles.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        ) : (
          <input id="backup-s3-profile" type="text" data-no-draft="autosave" className="settings-input settings-input--short"
            value={auth.profile ?? ''} onChange={(e) => setAuth({ profile: e.target.value })} placeholder="default" />
        )} />
      )}
      {!custom && auth.method === 'access_keys' && (
        <>
          <SettingsRow label="Access key ID" htmlFor="backup-s3-access-key" indent control={
            <input id="backup-s3-access-key" type="text" data-no-draft="autosave" autoComplete="off"
              className="settings-input settings-input--short"
              value={auth.aws_access_key_id ?? ''} onChange={(e) => setAuth({ aws_access_key_id: e.target.value })} />
          } />
          <SettingsRow label="Secret access key" htmlFor="backup-s3-secret" indent control={
            <SecretInput id="backup-s3-secret" value={auth.aws_secret_access_key ?? ''} onChange={(v) => setAuth({ aws_secret_access_key: v })} />
          } />
        </>
      )}
      <SettingsDisclosure id="backup-s3-advanced" label="Advanced" summary={advancedSummary(dest)} data-testid="backup-s3-advanced">
        <TextRow id="backup-s3-prefix" label="Folder in the bucket" value={dest.prefix} onChange={(v) => set({ prefix: v })} placeholder="Default: walnut-backup" />
        <TextRow id="backup-s3-endpoint" label="S3-compatible endpoint" value={dest.endpoint} onChange={(v) => set({ endpoint: v })}
          placeholder="https://s3.example.com" help="For MinIO, Backblaze B2 and other S3-compatible services." />
        {custom && (
          <>
            <TextRow id="backup-s3-ep-access-key" label="Access key ID" value={dest.access_key_id} onChange={(v) => set({ access_key_id: v })} />
            <SettingsRow label="Secret access key" htmlFor="backup-s3-ep-secret" control={
              <SecretInput id="backup-s3-ep-secret" value={dest.secret_access_key ?? ''} onChange={(v) => set({ secret_access_key: v })} />
            } />
          </>
        )}
      </SettingsDisclosure>
    </>
  )
}

/** What is set under Advanced, so a custom endpoint is never hidden behind a closed row. */
function advancedSummary(dest: BackupDestinationConfig): string | undefined {
  const parts: string[] = []
  const endpoint = dest.endpoint?.trim()
  if (endpoint) parts.push(`Endpoint ${endpoint.replace(/^https?:\/\//, '')}`)
  const prefix = dest.prefix?.trim()
  if (prefix && prefix !== 'walnut-backup') parts.push(`Folder ${prefix}`)
  return parts.length ? parts.join(', ') : undefined
}
