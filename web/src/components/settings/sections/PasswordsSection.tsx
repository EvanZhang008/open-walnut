/**
 * Settings → Passwords: auto-lock, what an agent gets when it asks, a new master password,
 * the recovery kit, whether agents may ask while nobody unlocked, export, and Lock everywhere. Changing the vault itself needs this
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
import { onVaultSessionChange, vaultApi, VaultApiError, type AgentsSwitch, type RecoveryKit, type VaultStatus } from '@/api/vault'
import { downloadRecoveryKit, RecoveryKitCard } from '@/components/passwords/LockScreens'
import '@/styles/passwords.css'

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
  const [newKit, setNewKit] = useState<RecoveryKit | null>(null)
  // Every new vault key comes with a new recovery code: save the kit and show it until confirmed.
  const gotKit = (kit: RecoveryKit) => { setNewKit(kit); downloadRecoveryKit(kit) }

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
        <SettingsGroup heading="Agents" footer={<>An item can say otherwise in its own settings. Every ask, use and refusal is listed in Passwords, Agent Activity.</>}>
          <SettingsRow
            label="When an agent asks for a password"
            help={needUnlock ?? (agents === 'off' ? 'No agent gets any password.' : agents === 'allow' ? 'Given at once. Items marked sensitive still ask for Face ID or Touch ID.' : 'You approve each use on your Mac or phone.')}
            control={<SegmentedControl<AgentsSwitch> id="pw-agents-switch" aria-label="When an agent asks for a password" value={agents ?? 'ask'} disabled={!unlocked || !agents || busy === 'switch'}
              options={[{ value: 'ask', label: 'Ask me first' }, { value: 'allow', label: 'Give it without asking' }, { value: 'off', label: 'Never' }]}
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
                const r = await vaultApi.changePassword(oldPw, newPw, status.kdf)
                setOldPw(''); setNewPw(''); setNewPw2('')
                if (r.recoveryKit) gotKit(r.recoveryKit)
                return `Master password changed, and your other windows were locked.${r.recoveryKit ? ' Your recovery code changed too: save the new kit below, the old one no longer works.' : ''}`
              })}>Change master password</SettingsButton>}
          />
        </SettingsGroup>
      )}

      {newKit && (
        <SettingsGroup heading="Save your new recovery kit" footer={<>The old recovery code no longer works. Walnut keeps no copy of this one: save it before you leave this page.</>}>
          <div style={{ padding: '4px 16px 14px' }} data-testid="pw-settings-kit">
            <RecoveryKitCard kit={newKit} confirmLabel="Done, I saved it" onConfirmed={() => { setNewKit(null); setNote('Recovery kit saved.'); refresh() }} />
          </div>
        </SettingsGroup>
      )}

      {status?.setUp && (
        <SettingsGroup heading="Recovery and advanced" footer={<>These need your master password. An export holds every password in plain text: keep it only as long as you need it. Keep the recovery kit away from this computer.</>}>
          <SettingsRow label="Master password" htmlFor="pw-confirm" help={needUnlock} control={<input id="pw-confirm" type="password" data-no-draft="secret" autoComplete="current-password" className="settings-input settings-input--short" disabled={!unlocked} value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} />} />
          <SettingsRow
            label="Recovery kit"
            help={!status.hasRecovery
              ? 'No recovery code yet: if you forget your master password, nothing opens this vault. Make a kit now.'
              : status.recoveryUnsaved && !newKit
                ? 'Your recovery code changed and the new kit was never saved: make a new one now.'
                : 'Makes a new recovery code (and a new vault key). The one in your old kit stops working.'}
            control={<SettingsButton busy={busy === 'kit'} disabled={!unlocked || !confirmPw}
              onClick={() => void run('kit', async () => {
                const kit = await vaultApi.newRecoveryKit(confirmPw, status.kdf)
                setConfirmPw('')
                gotKit(kit)
                return 'Downloaded a new recovery kit. Confirm below once it is saved; the old recovery code no longer works.'
              })}>Make a new recovery kit</SettingsButton>}
          />
          <SettingsRow
            label="Agents can ask while Passwords is locked"
            htmlFor="pw-agents-away"
            help="Off: only while Passwords is open in a window. On: a key stays on this Mac so they can ask any time (you still approve each use), and any program running as you could read the vault."
            control={<ToggleSwitch id="pw-agents-away" checked={!!status.agentsWhileAway} disabled={!unlocked || !confirmPw || busy === 'agents'}
              onChange={(v) => void run('agents', async () => {
                const { recoveryKit, ...next } = await vaultApi.setAgentsWhileAway(v, confirmPw, status.kdf)
                setStatus({ ...next, unlocked: true, autoLockMinutes: status.autoLockMinutes, waitMs: 0 })
                setConfirmPw('')
                if (recoveryKit) gotKit(recoveryKit)
                return v ? 'Agents can ask while Passwords is locked.' : `Agents can ask only while Passwords is open. A new vault key was made.${recoveryKit ? ' Your recovery code changed with it: save the new kit below, the old one no longer works.' : ''}`
              })} />}
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
