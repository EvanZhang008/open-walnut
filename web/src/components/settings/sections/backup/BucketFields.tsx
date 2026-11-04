/**
 * The fields of a bucket destination: Cloudflare R2 (account, bucket, an R2
 * API token's key pair) or Amazon S3 (bucket, region, credential source).
 * Rarely needed settings (folder in the bucket, a custom S3-compatible
 * endpoint) sit behind one Advanced row.
 */
import { SettingsDisclosure, SettingsRow } from '../../SettingsSection'
import { KeyInput } from './KeyInput'
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
        placeholder={dest.endpoint?.trim() ? 'Not needed with an endpoint' : '32 letters and digits'}
        help={dest.endpoint?.trim() ? undefined : 'Not needed when you set a custom endpoint under Advanced.'} />
      <TextRow id="backup-r2-bucket" label="Bucket" value={dest.bucket} onChange={(v) => set({ bucket: v })} placeholder="e.g. my-walnut-backup" />
      <TextRow id="backup-r2-access-key" label="Access key ID" value={dest.access_key_id} onChange={(v) => set({ access_key_id: v })} />
      <SettingsRow
        label="Secret access key"
        htmlFor="backup-r2-secret"
        control={<KeyInput id="backup-r2-secret" value={dest.secret_access_key ?? ''} onChange={(v) => set({ secret_access_key: v })} />}
      />
      <SettingsDisclosure id="backup-r2-help" label="Where to find these in Cloudflare" data-testid="backup-r2-help">
        <ol className="settings-steps" data-testid="backup-r2-steps">
          <li>
            Open the <a href="https://dash.cloudflare.com/?to=/:account/r2/overview" target="_blank" rel="noreferrer">R2 page of your Cloudflare dashboard</a>.
            The first time, Cloudflare asks you to add a card to turn R2 on; the free tier is 10 GB.
          </li>
          <li>Copy the <b>Account ID</b> (on the R2 page, under Account details) into the first row.</li>
          <li>Choose <b>Create bucket</b>, name it (for example <code>walnut-backup</code>), keep the defaults.</li>
          <li>Back on the R2 page choose <b>Manage API tokens</b>, then <b>Create Account API token</b>.</li>
          <li>Pick <b>Object Read &amp; Write</b>, limit it to that bucket, and create it.</li>
          <li>Copy the <b>Access Key ID</b> and <b>Secret Access Key</b> into the rows above (Cloudflare shows the secret once).</li>
          <li>Choose <b>Test and save</b> below.</li>
        </ol>
      </SettingsDisclosure>
      <SettingsDisclosure id="backup-r2-advanced" label="Advanced" summary={advancedSummary(dest)} data-testid="backup-r2-advanced">
        <TextRow id="backup-r2-prefix" label="Folder in the bucket" value={dest.prefix} onChange={(v) => set({ prefix: v })}
          placeholder="Optional" help="Empty: a folder named walnut-backup." />
        <TextRow id="backup-r2-endpoint" label="Custom endpoint" value={dest.endpoint} onChange={(v) => set({ endpoint: v })}
          placeholder="https://..."
          help="Only for an EU bucket (https://<account ID>.eu.r2.cloudflarestorage.com) or another S3-compatible service." />
      </SettingsDisclosure>
    </>
  )
}

export function S3Fields({ dest, onChange, profiles }: Props) {
  const set = (patch: Partial<BackupDestinationConfig>) => onChange({ ...dest, ...patch })
  const auth = dest.auth ?? { method: 'aws_chain' as const }
  const setAuth = (patch: Partial<NonNullable<BackupDestinationConfig['auth']>>) => set({ auth: { ...auth, ...patch } })
  const custom = Boolean(dest.endpoint?.trim())
  /** Keys typed before the endpoint (or after removing it) move with it, never left behind unseen. */
  const setEndpoint = (v: string) => {
    const nowCustom = Boolean(v.trim())
    if (nowCustom && !custom && !dest.access_key_id && !dest.secret_access_key && auth.method === 'access_keys') {
      return set({ endpoint: v, access_key_id: auth.aws_access_key_id, secret_access_key: auth.aws_secret_access_key })
    }
    if (!nowCustom && custom && (dest.access_key_id || dest.secret_access_key) && !auth.aws_access_key_id && !auth.aws_secret_access_key) {
      return set({ endpoint: v, auth: { ...auth, method: 'access_keys', aws_access_key_id: dest.access_key_id, aws_secret_access_key: dest.secret_access_key } })
    }
    set({ endpoint: v })
  }
  return (
    <>
      <TextRow id="backup-s3-bucket" label="Bucket" value={dest.bucket} onChange={(v) => set({ bucket: v })} placeholder="e.g. my-walnut-backup" />
      <TextRow id="backup-s3-region" label="Region" value={dest.region} onChange={(v) => set({ region: v })} placeholder="e.g. us-west-2" />
      {!custom && (
        <SettingsRow
          label="Credentials"
          help={auth.method === 'profile' ? 'A named profile from ~/.aws on this computer.'
            : auth.method === 'access_keys' ? 'An access key ID and secret that may use this bucket.'
            : 'The AWS sign-in already set up on this computer (aws configure, SSO or environment).'}
          control={
            <SegmentedControl
              id="backup-s3-auth"
              aria-label="Credentials"
              value={auth.method ?? 'aws_chain'}
              onChange={(v) => setAuth({ method: v })}
              options={[
                { value: 'access_keys', label: 'Access keys', testId: 'backup-auth-access_keys' },
                { value: 'profile', label: 'AWS profile', title: 'A profile from ~/.aws', testId: 'backup-auth-profile' },
                { value: 'aws_chain', label: 'This computer', title: 'The AWS sign-in already set up on this computer', testId: 'backup-auth-aws_chain' },
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
      {(custom || auth.method === 'access_keys') && (
        // One pair of key fields: with an endpoint they are that service's keys, without one AWS keys.
        <>
          <SettingsRow label="Access key ID" htmlFor="backup-s3-access-key" indent={!custom} control={
            <input id="backup-s3-access-key" type="text" data-no-draft="autosave" autoComplete="off"
              className="settings-input settings-input--short"
              value={(custom ? dest.access_key_id : auth.aws_access_key_id) ?? ''}
              onChange={(e) => custom ? set({ access_key_id: e.target.value }) : setAuth({ aws_access_key_id: e.target.value })} />
          } />
          <SettingsRow label="Secret access key" htmlFor="backup-s3-secret" indent={!custom} control={
            <KeyInput id="backup-s3-secret" value={(custom ? dest.secret_access_key : auth.aws_secret_access_key) ?? ''}
              onChange={(v) => custom ? set({ secret_access_key: v }) : setAuth({ aws_secret_access_key: v })} />
          } />
        </>
      )}
      {!custom && auth.method === 'access_keys' && (
        <SettingsDisclosure id="backup-s3-help" label="Where to find these in AWS" data-testid="backup-s3-help">
          <ol className="settings-steps" data-testid="backup-s3-steps">
            <li>Open <a href="https://s3.console.aws.amazon.com/s3/bucket/create" target="_blank" rel="noreferrer">S3: Create bucket</a>, name it (for example <code>my-walnut-backup</code>), keep the defaults, and note its Region.</li>
            <li>Open <a href="https://console.aws.amazon.com/iam/home#/users" target="_blank" rel="noreferrer">IAM: Users</a>, choose <b>Create user</b> (no console access), and give it the <b>AmazonS3FullAccess</b> permission (or one limited to that bucket).</li>
            <li>On the user choose <b>Security credentials</b>, then <b>Create access key</b> (use: Application running outside AWS).</li>
            <li>Copy the <b>Access key ID</b> and <b>Secret access key</b> into the rows above (AWS shows the secret once), then choose <b>Test and save</b>.</li>
          </ol>
        </SettingsDisclosure>
      )}
      <SettingsDisclosure id="backup-s3-advanced" label="Advanced" summary={advancedSummary(dest)} data-testid="backup-s3-advanced">
        <TextRow id="backup-s3-prefix" label="Folder in the bucket" value={dest.prefix} onChange={(v) => set({ prefix: v })} placeholder="Optional" help="Empty: a folder named walnut-backup." />
        <TextRow id="backup-s3-endpoint" label="S3-compatible endpoint" value={dest.endpoint} onChange={setEndpoint}
          placeholder="https://s3.example.com" help="For MinIO, Backblaze B2 and other S3-compatible services. Its keys go in the key rows above." />
      </SettingsDisclosure>
    </>
  )
}

/** What is set under Advanced, so a custom endpoint is never hidden behind a closed row. */
function advancedSummary(dest: BackupDestinationConfig): string | undefined {
  const parts: string[] = []
  const endpoint = dest.endpoint?.trim()
  if (endpoint) parts.push(/^https?:\/\/[^\s/]+/.test(endpoint) ? `Endpoint ${endpoint.replace(/^https?:\/\//, '')}` : 'Endpoint set (check it)')
  const prefix = dest.prefix?.trim()
  if (prefix && prefix !== 'walnut-backup') parts.push(`Folder ${prefix}`)
  return parts.length ? parts.join(', ') : undefined
}
