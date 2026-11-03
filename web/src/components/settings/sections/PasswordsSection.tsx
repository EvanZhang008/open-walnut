/**
 * Settings → Passwords: auto-lock, whether agents may ask while nobody unlocked, a new
 * master password, export, and Lock everywhere. Changing the vault itself needs this
 * window unlocked (the Passwords app); auto-lock is a plain config value.
 */
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Config } from '@open-walnut/core'
import { SectionCard } from '../inputs/SectionCard'
import { ToggleSwitch } from '../inputs/ToggleSwitch'
import { SettingsGroup, SettingsRow } from '../SettingsSection'
import { SettingsButton } from '../inputs/SettingsButton'
import { NumberInput } from '../inputs/NumberInput'
import { SegmentedControl } from '../inputs/SegmentedControl'
import { useSettingsAutoSave } from '../inputs/useSettingsAutoSave'
import { onVaultSessionChange, vaultApi, VaultApiError, type AgentsSwitch, type VaultStatus } from '@/api/vault'
import { downloadRecoveryKit } from '@/components/passwords/LockScreens'

interface Props {
  config: Config
  onSave: (partial: Partial<Config>) => Promise<void>
}

export function PasswordsSection({ config, onSave }: Props) {
  const navigate = useNavigate()
  const savedMinutes = config.passwords?.auto_lock_minutes ?? 15
  const [minutes, setMinutes] = useState(savedMinutes)
  const [status, setStatus] = useState<VaultStatus | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState('')
  const [oldPw, setOldPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [newPw2, setNewPw2] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [agents, setAgents] = useState<AgentsSwitch | null>(null)

  const refresh = useCallback(() => {
    vaultApi.status().then((st) => {
      setStatus(st)
      if (st.unlocked) vaultApi.agentPolicy().then((p) => setAgents(p.agents)).catch(() => setAgents(null))
      else setAgents(null)
    }).catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])
  useEffect(() => { refresh() }, [refresh])
  useEffect(() => onVaultSessionChange(refresh), [refresh])

  useSettingsAutoSave({
    current: String(minutes),
    baseline: String(savedMinutes),
    save: () => onSave({ passwords: { ...(config.passwords ?? {}), auto_lock_minutes: Math.max(1, Math.min(720, minutes)) } }),
  })

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

  const unlocked = !!status?.unlocked
  const state = !status ? 'Checking…' : !status.setUp ? 'Not set up yet' : unlocked ? `Unlocked in this window · ${status.itemCount ?? 0} items` : `Locked · ${status.itemCount ?? 0} items`
  const needUnlock = !unlocked ? 'Unlock Passwords in this window to change this.' : undefined

  return (
    <SectionCard id="passwords" title="Passwords" onSave={async () => {}} showSave={false}>
      <SettingsGroup footer={<>Your vault is encrypted on this Mac, outside the synced data folder. Opening it needs your master password; the cloud companion never carries it.</>}>
        <SettingsRow
          label="Vault"
          help={state}
          control={<SettingsButton onClick={() => navigate('/passwords')}>{status?.setUp ? 'Open Passwords' : 'Set up'}</SettingsButton>}
        />
        <SettingsRow
          label="Lock after"
          htmlFor="pw-autolock"
          help="A window's unlock ends after this long unused. A restart locks every window."
          control={<NumberInput id="pw-autolock" min={1} max={720} unit="minutes" value={minutes} onChange={(v) => setMinutes(v ?? 15)} />}
        />
        <SettingsRow
          label="Lock every window now"
          control={<SettingsButton busy={busy === 'lock'} disabled={!status?.setUp} onClick={() => void run('lock', async () => { await vaultApi.lock(true); return 'Every window is locked.' })}>Lock all</SettingsButton>}
        />
      </SettingsGroup>

      {status?.setUp && (
        <SettingsGroup heading="Agents" footer={<>Each item also has its own setting (ask, without asking, never). Every ask, use and refusal is listed in Passwords, Agent Activity.</>}>
          <SettingsRow
            label="Agents may use passwords"
            help={needUnlock ?? (agents === 'off' ? 'No agent gets any item.' : agents === 'allow' ? 'Items set to ask are given at once; sensitive ones still ask for Face ID or Touch ID.' : 'Each item decides: you approve on your Mac or phone, or it is given without asking, or never.')}
            control={<SegmentedControl<AgentsSwitch> id="pw-agents-switch" aria-label="Agents may use passwords" value={agents ?? 'ask'} disabled={!unlocked || !agents || busy === 'switch'}
              options={[{ value: 'off', label: 'Off' }, { value: 'ask', label: 'Ask each time' }, { value: 'allow', label: 'Without asking' }]}
              onChange={(v) => void run('switch', async () => { setAgents((await vaultApi.setAgentsSwitch(v)).agents) })} />}
          />
        </SettingsGroup>
      )}

      {status?.setUp && (
        <SettingsGroup heading="Master password">
          <SettingsRow label="Current" htmlFor="pw-old" control={<input id="pw-old" type="password" data-no-draft="secret" autoComplete="current-password" className="settings-input settings-input--short" disabled={!unlocked} value={oldPw} onChange={(e) => setOldPw(e.target.value)} />} />
          <SettingsRow label="New" htmlFor="pw-new" control={<input id="pw-new" type="password" data-no-draft="secret" autoComplete="new-password" className="settings-input settings-input--short" disabled={!unlocked} value={newPw} onChange={(e) => setNewPw(e.target.value)} />} />
          <SettingsRow label="Confirm new" htmlFor="pw-new2" help={newPw2 && newPw !== newPw2 ? 'The two new passwords differ.' : needUnlock} control={<input id="pw-new2" type="password" data-no-draft="secret" autoComplete="new-password" className="settings-input settings-input--short" disabled={!unlocked} value={newPw2} onChange={(e) => setNewPw2(e.target.value)} />} />
          <SettingsRow
            label=""
            control={<SettingsButton busy={busy === 'password'} disabled={!unlocked || !oldPw || newPw.length < 10 || newPw !== newPw2}
              onClick={() => void run('password', async () => {
                await vaultApi.changePassword(oldPw, newPw, status.kdf)
                setOldPw(''); setNewPw(''); setNewPw2('')
                return 'Master password changed, and your other windows were locked. Your Secret Key stays the same.'
              })}>Change master password</SettingsButton>}
          />
        </SettingsGroup>
      )}

      {status?.setUp && (
        <SettingsGroup heading="Needs your master password" footer={<>An export holds every password in plain text: keep it only as long as you need it. The recovery kit holds your Secret Key: keep it away from this computer.</>}>
          <SettingsRow label="Master password" htmlFor="pw-confirm" help={needUnlock} control={<input id="pw-confirm" type="password" data-no-draft="secret" autoComplete="current-password" className="settings-input settings-input--short" disabled={!unlocked} value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} />} />
          <SettingsRow
            label="Let agents ask while you are away"
            htmlFor="pw-agents-away"
            help="Keeps a key on this Mac so a task can use an item you approve on your phone even when no window is unlocked. Any program running as you on this Mac could then read the vault without the master password. Off: agents can ask only while a window has Passwords unlocked."
            control={<ToggleSwitch id="pw-agents-away" checked={!!status.agentsWhileAway} disabled={!unlocked || !confirmPw || busy === 'agents'}
              onChange={(v) => void run('agents', async () => {
                setStatus({ ...(await vaultApi.setAgentsWhileAway(v, confirmPw, status.kdf)), unlocked: true, autoLockMinutes: status.autoLockMinutes, waitMs: 0 })
                setConfirmPw('')
                return v ? 'Agents may ask while you are away.' : 'Agents can ask only while Passwords is unlocked. A new vault key was made.'
              })} />}
          />
          <SettingsRow
            label="Recovery kit"
            help="Your Secret Key again, as the kit you saved at setup."
            control={<SettingsButton busy={busy === 'kit'} disabled={!unlocked || !confirmPw}
              onClick={() => void run('kit', async () => {
                downloadRecoveryKit(await vaultApi.secretKey(confirmPw, status.kdf))
                setConfirmPw('')
                return 'Saved the recovery kit.'
              })}>Download recovery kit</SettingsButton>}
          />
          <SettingsRow
            label="Export"
            control={
              <span style={{ display: 'inline-flex', gap: 8 }}>
                {(['csv', 'json'] as const).map((fmt) => (
                  <SettingsButton key={fmt} busy={busy === `export-${fmt}`} disabled={!unlocked || !confirmPw}
                    onClick={() => void run(`export-${fmt}`, async () => {
                      const r = await vaultApi.exportAll(confirmPw, status.kdf, fmt)
                      setConfirmPw('')
                      const url = URL.createObjectURL(new Blob([r.text], { type: fmt === 'csv' ? 'text/csv' : 'application/json' }))
                      const a = document.createElement('a')
                      a.href = url; a.download = r.fileName; a.click()
                      window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
                      return `Saved ${r.fileName}.`
                    })}>Export {fmt.toUpperCase()}</SettingsButton>
                ))}
              </span>
            }
          />
        </SettingsGroup>
      )}

      {error && <p className="settings-test-result" data-kind="fail" role="alert">{error}</p>}
      {note && <p className="settings-test-result" data-kind="ok" role="status">{note}</p>}
    </SectionCard>
  )
}
