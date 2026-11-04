/**
 * The older S3 copy (files uploaded as they are, no encryption), kept for
 * the people who set it up before encrypted backups: same fields as before,
 * and one row offering the switch to encrypted backups in the same bucket.
 */
import { SettingsRow, SettingsNotice } from '../../SettingsSection'
import { SecretInput } from '../../inputs/SecretInput'
import { SegmentedControl } from '../../inputs/SegmentedControl'
import { SettingsButton } from '../../inputs/SettingsButton'
import type { BackupConfig } from './backup-model'

export type LegacyFields = Pick<BackupConfig, 'bucket' | 'region' | 'prefix' | 'auth'>

interface Props {
  value: LegacyFields
  onChange: (next: LegacyFields) => void
  profiles: string[]
  onSwitch: () => void
}

export function LegacyS3Fields({ value, onChange, profiles, onSwitch }: Props) {
  const auth = value.auth ?? { method: 'aws_chain' as const }
  const set = (patch: Partial<LegacyFields>) => onChange({ ...value, ...patch })
  const setAuth = (patch: Partial<NonNullable<LegacyFields['auth']>>) => set({ auth: { ...auth, ...patch } })
  const input = (id: string, v: string | undefined, onV: (s: string) => void, placeholder: string) => (
    <input id={id} type="text" data-no-draft="autosave" className="settings-input settings-input--short"
      value={v ?? ''} onChange={(e) => onV(e.target.value)} placeholder={placeholder} />
  )
  return (
    <>
      <SettingsNotice kind="warn" action={<SettingsButton variant="primary" onClick={onSwitch} data-testid="backup-legacy-switch">Switch to encrypted</SettingsButton>}>
        This is the older S3 copy: files go to the bucket unencrypted. Encrypted backups keep a dated history and are unreadable without your key.
      </SettingsNotice>
      <SettingsRow label="Bucket" htmlFor="backup-bucket" control={input('backup-bucket', value.bucket, (s) => set({ bucket: s }), 'my-walnut-backup')} />
      <SettingsRow label="Region" htmlFor="backup-region" control={input('backup-region', value.region ?? 'us-west-2', (s) => set({ region: s }), 'us-west-2')} />
      <SettingsRow label="Prefix" htmlFor="backup-prefix" help="Folder inside the bucket; use a distinct prefix per machine."
        control={input('backup-prefix', value.prefix ?? 'walnut', (s) => set({ prefix: s }), 'walnut')} />
      <SettingsRow label="Credentials" control={
        <SegmentedControl id="backup-auth-method" aria-label="Credentials method" value={auth.method ?? 'aws_chain'} onChange={(v) => setAuth({ method: v })}
          options={[
            { value: 'aws_chain', label: 'Default chain', title: 'The default AWS credential chain', testId: 'backup-auth-aws_chain' },
            { value: 'profile', label: 'AWS profile', title: 'A profile from ~/.aws', testId: 'backup-auth-profile' },
            { value: 'access_keys', label: 'Access keys', testId: 'backup-auth-access_keys' },
          ]} />
      } />
      {auth.method === 'profile' && (
        <SettingsRow label="Profile" htmlFor="backup-profile" indent control={profiles.length > 0 ? (
          <select id="backup-profile" className="settings-select" value={auth.profile ?? ''} onChange={(e) => setAuth({ profile: e.target.value })}>
            <option value="">Choose a profile</option>
            {profiles.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        ) : input('backup-profile', auth.profile, (s) => setAuth({ profile: s }), 'default')} />
      )}
      {auth.method === 'access_keys' && (
        <>
          <SettingsRow label="Access key ID" htmlFor="backup-access-key" indent control={
            <input id="backup-access-key" type="text" data-no-draft="autosave" autoComplete="off" className="settings-input settings-input--short settings-input--mono"
              value={auth.aws_access_key_id ?? ''} onChange={(e) => setAuth({ aws_access_key_id: e.target.value })} />
          } />
          <SettingsRow label="Secret access key" htmlFor="backup-secret-key" indent control={
            <SecretInput id="backup-secret-key" value={auth.aws_secret_access_key ?? ''} onChange={(v) => setAuth({ aws_secret_access_key: v })} />
          } />
        </>
      )}
    </>
  )
}
