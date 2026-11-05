/**
 * Settings, Passwords, "Sync from another password manager": the sync sources the vault can pull
 * items from, one way (src/core/vault/sources/). A person who never added one sees only an Add
 * button; the vault itself works the same either way. Bitwarden is the only source today.
 */
import { useCallback, useEffect, useState } from 'react'
import type { Config } from '@open-walnut/core'
import { ToggleSwitch } from '../inputs/ToggleSwitch'
import { SettingsGroup, SettingsRow } from '../SettingsSection'
import { SettingsButton } from '../inputs/SettingsButton'
import { onVaultSessionChange, vaultApi, VaultApiError, type BitwardenSyncStatus } from '@/api/vault'

interface Props {
  config: Config
  onSave: (partial: Partial<Config>) => Promise<void>
  unlocked: boolean
  /** Why a change is not possible now (the vault is locked here), if it is not. */
  needUnlock?: string
}

type PasswordsConfig = NonNullable<Config['passwords']> & { sources?: string[] }

export function PasswordSourcesGroup({ config, onSave, unlocked, needUnlock }: Props) {
  const [bw, setBw] = useState<BitwardenSyncStatus | null>(null)
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const passwords = (config.passwords ?? {}) as PasswordsConfig
  const sources = Array.isArray(passwords.sources) ? passwords.sources : []
  // Once Settings wrote the list it decides; an older config counts the daily switch or a past sync.
  const added = Array.isArray(passwords.sources) ? sources.includes('bitwarden') : passwords.bitwarden_daily === true || bw?.added === true

  const refresh = useCallback(() => {
    if (unlocked) vaultApi.bitwardenSync().then(setBw).catch(() => {}) // a failed read keeps what it showed
  }, [unlocked])
  useEffect(() => { refresh() }, [refresh])
  useEffect(() => onVaultSessionChange(refresh), [refresh])

  const run = async (key: string, work: () => Promise<string | void>) => {
    setBusy(key); setError(''); setNote('')
    try {
      const msg = await work()
      if (msg) setNote(msg)
      refresh()
    } catch (err) {
      setError(err instanceof VaultApiError ? err.message : err instanceof Error ? err.message : String(err))
    } finally {
      setBusy('')
    }
  }
  const save = (next: Partial<PasswordsConfig>) => onSave({ passwords: { ...passwords, ...next } as Config['passwords'] })
  const add = () => void run('bw-add', async () => { await save({ sources: [...new Set([...sources, 'bitwarden'])] }) })
  const remove = () => void run('bw-remove', async () => {
    await save({ sources: sources.filter((s) => s !== 'bitwarden'), bitwarden_daily: false })
    return 'Bitwarden is no longer a source. The items it brought stay in your vault.'
  })
  const setDaily = (on: boolean) => void run('bw-daily', async () => {
    await save({ bitwarden_daily: on, sources: [...new Set([...sources, 'bitwarden'])] })
    return on ? 'Walnut syncs from Bitwarden every day at 4:00.' : 'The daily Bitwarden sync is off.'
  })

  if (!added) {
    return (
      <SettingsGroup heading="Sync from another password manager" footer={<>Optional. Your Walnut vault works on its own; a source only copies items into it, one way.</>}>
        <SettingsRow label="Bitwarden" help="Keep a copy of your Bitwarden vault here, synced every day. Needs the Bitwarden CLI (bw) on this Mac."
          control={<SettingsButton busy={busy === 'bw-add'} data-testid="pw-source-add-bitwarden" onClick={add}>Add</SettingsButton>} />
        {error && <p className="settings-test-result" data-kind="fail" role="alert">{error}</p>}
      </SettingsGroup>
    )
  }
  return (
    <SettingsGroup heading="Sync from Bitwarden" footer={<>One way: Bitwarden is the source. Changed items are updated, deleted ones go to the trash, and an item changed on both sides is kept twice (the Walnut copy tagged conflict). Walnut runs <code>bw sync</code> and <code>bw export</code> itself, with BW_SESSION from its environment or this Mac's keychain; the export never touches the disk.</>}>
      <SettingsRow
        label="Sync from Bitwarden daily"
        htmlFor="pw-bw-daily"
        help="At 4:00 every day, while Passwords is unlocked or this Mac's keychain can unlock it."
        control={<ToggleSwitch id="pw-bw-daily" checked={passwords.bitwarden_daily === true} disabled={busy === 'bw-daily'} onChange={setDaily} />}
      />
      <SettingsRow
        label="Sync now"
        help={needUnlock ?? (bw?.last ? `Last sync: ${new Date(bw.last.at).toLocaleString()}, ${bw.summary ?? ''}` : 'Last sync: never.')}
        control={<SettingsButton busy={busy === 'bw-sync'} disabled={!unlocked} data-testid="pw-bw-sync"
          onClick={() => void run('bw-sync', async () => {
            let r
            try { r = await vaultApi.runBitwardenSync() } catch (err) {
              // Many items gone at once: the person confirms Bitwarden really deleted them.
              if (!(err instanceof VaultApiError && err.code === 'sync_mass_trash') || !window.confirm(`${err.message}\n\nMove them to the trash now?`)) throw err
              r = await vaultApi.runBitwardenSync(true)
            }
            return r.report.ok ? `Synced: ${r.summary}.` : `Not synced: ${r.report.error ?? 'unknown'}.`
          })}>Sync now</SettingsButton>}
      />
      <SettingsRow label="Remove this source" help="Stops syncing. Items already copied stay in your vault."
        control={<SettingsButton busy={busy === 'bw-remove'} data-testid="pw-source-remove-bitwarden" onClick={remove}>Remove</SettingsButton>} />
      {note && <p className="settings-test-result" data-kind="ok" role="status">{note}</p>}
      {error && <p className="settings-test-result" data-kind="fail" role="alert">{error}</p>}
    </SettingsGroup>
  )
}
