/**
 * Settings → Passwords: how long an unlock lasts ("Keep Passwords unlocked", Forever being the
 * machine key), the keychain unlock, what an agent gets (Any / Ask / Off) and how long an
 * approval lasts, the sync sources (PasswordSourcesGroup.tsx), the browser extension, a new master password, the recovery
 * kit, export, and Lock everywhere. Changing the vault itself needs this window unlocked (the
 * Passwords app); the unlock length and the daily sync are plain config values.
 */
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { Config } from '@open-walnut/core'
import { SectionCard } from '../inputs/SectionCard'
import { ToggleSwitch } from '../inputs/ToggleSwitch'
import { SettingsGroup, SettingsRow } from '../SettingsSection'
import { SettingsButton } from '../inputs/SettingsButton'
import { PasswordSourcesGroup } from './PasswordSourcesGroup'
import { SegmentedControl } from '../inputs/SegmentedControl'
import { onVaultSessionChange, vaultApi, VaultApiError, type AgentsSwitch, type RecoveryKit, type UnlockFor, type VaultStatus } from '@/api/vault'
import { CopyButton, downloadRecoveryKit, RecoveryKitCard } from '@/components/passwords/LockScreens'
import { hintError } from '@/components/passwords/HintField'
import { HintSettings } from '@/components/passwords/HintSettings'
import { HINT_MAX } from '../../../../../src/core/vault/hint'
import { SWITCH } from '@/components/passwords/AgentActivity'
import { GRANT_OPTIONS, UNLOCK_OPTIONS, unlockFootText, unlockOptionLabel } from '@/components/passwords/unlock-words'
import '@/styles/passwords.css'

/** How long a revealed Secret Key stays on screen. */
const SHOWN_KEY_MS = 2 * 60_000

interface Props {
  config: Config
  onSave: (partial: Partial<Config>) => Promise<void>
}

export function PasswordsSection({ config, onSave }: Props) {
  const navigate = useNavigate()
  const [status, setStatus] = useState<VaultStatus | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState('')
  const [oldPw, setOldPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [newPw2, setNewPw2] = useState('')
  const [newHint, setNewHint] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [agents, setAgents] = useState<AgentsSwitch | null>(null)
  const [grantMs, setGrantMs] = useState<number | null>(null)
  // A move to or from Forever (the machine key) waits for the master password here.
  const [foreverTo, setForeverTo] = useState<UnlockFor | null>(null)
  const [foreverPw, setForeverPw] = useState('')
  const [keychain, setKeychain] = useState<{ available: boolean; present: boolean } | null>(null)
  const [newKit, setNewKit] = useState<RecoveryKit | null>(null)
  // The Secret Key shown for setting up another device; hidden again after a short while.
  const [shownKey, setShownKey] = useState('')
  useEffect(() => {
    if (!shownKey) return
    const t = window.setTimeout(() => setShownKey(''), SHOWN_KEY_MS)
    return () => window.clearTimeout(t)
  }, [shownKey])
  // Every new vault key comes with a new recovery code: save the kit and show it until confirmed.
  const gotKit = (kit: RecoveryKit) => { setNewKit(kit); downloadRecoveryKit(kit) }

  const refresh = useCallback(() => {
    vaultApi.status().then((st) => {
      setStatus(st)
      if (st.unlocked) {
        vaultApi.agentPolicy().then((p) => { setAgents(p.agents); setGrantMs(p.grantMs) }).catch(() => {}) // a failed read keeps the switch it showed
      } else { setAgents(null); setGrantMs(null) }
      vaultApi.keychain().then(setKeychain).catch(() => {}) // a failed read keeps what it showed
    }).catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])
  useEffect(() => { refresh() }, [refresh])
  useEffect(() => onVaultSessionChange(refresh), [refresh])

  const saveUnlockFor = (v: UnlockFor) => onSave({ passwords: { ...(config.passwords ?? {}), unlock_for: v } })
  const pickUnlock = (v: UnlockFor) => {
    setError(''); setNote('')
    const isForever = status?.unlockFor === 'always'
    // Forever is the machine key: turning it on or off needs the master password.
    if (v === 'always' || isForever) { if (v !== status?.unlockFor) { setForeverTo(v); setForeverPw('') } return }
    setForeverTo(null)
    void run('unlock', async () => { await saveUnlockFor(v); return 'Saved. A shorter choice also applies to the windows open now; a longer one to the next unlock.' })
  }
  const confirmForever = () => {
    const to = foreverTo
    if (!to || !status) return
    void run('forever', async () => {
      const { recoveryKit } = await vaultApi.setAgentsWhileAway(to === 'always', foreverPw, status.kdf)
      setForeverPw(''); setForeverTo(null)
      await saveUnlockFor(to)
      if (recoveryKit) gotKit(recoveryKit)
      return to === 'always' ? 'Passwords stays unlocked, and agents can use it while you are away.'
        : `The key on this Mac is gone. A new vault key was made.${recoveryKit ? ' Your recovery code changed with it: save the new kit below, the old one no longer works.' : ''}`
    })
  }

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
          label="Keep Passwords unlocked"
          help={status?.unlockFor === 'always'
            ? 'Forever: a key stays on this Mac, so agents can use Passwords while you are away. Any program running as you could read the vault.'
            : `${status ? unlockFootText(status) : ''}${status?.unlockFor === 'restart' ? '' : ' Restarting Walnut keeps it.'} A shorter choice also applies to the windows open now; a longer one to the next unlock.`}
          control={<SegmentedControl<UnlockFor> id="pw-unlock-for" aria-label="Keep Passwords unlocked" value={foreverTo ?? status?.unlockFor ?? '48h'} disabled={!status?.setUp || busy === 'unlock' || busy === 'forever'}
            options={UNLOCK_OPTIONS.map((o) => ({ value: o.value, label: unlockOptionLabel(o, status?.lockAfterIdleMinutes), testId: `pw-unlock-${o.value}` }))}
            onChange={pickUnlock} />}
        />
        {foreverTo && (
          <SettingsRow
            label={foreverTo === 'always' ? 'Keep a key on this Mac' : 'Remove the key from this Mac'}
            htmlFor="pw-forever-pw"
            help={needUnlock ?? (foreverTo === 'always' ? 'Type your master password to keep Passwords unlocked forever.' : 'Type your master password. A new vault key and recovery kit are made.')}
            control={
              <span style={{ display: 'inline-flex', gap: 8 }}>
                <input id="pw-forever-pw" type="password" data-no-draft="secret" autoComplete="current-password" className="settings-input settings-input--short" disabled={!unlocked} value={foreverPw} onChange={(e) => setForeverPw(e.target.value)} />
                <SettingsButton busy={busy === 'forever'} disabled={!unlocked || !foreverPw} onClick={confirmForever} data-testid="pw-forever-confirm">{foreverTo === 'always' ? 'Turn on' : 'Remove'}</SettingsButton>
                <SettingsButton onClick={() => { setForeverTo(null); setForeverPw('') }}>Cancel</SettingsButton>
              </span>
            }
          />
        )}
        {keychain?.available && (
          <SettingsRow
            label="Unlock with this Mac's keychain"
            help={keychain.present
              ? 'On: the keychain item "walnut-vault-master" holds your master password, so Walnut can unlock at start and for the daily sync.'
              : 'Off. To turn it on, add your master password to the keychain: security add-generic-password -s walnut-vault-master -a "$USER" -w'}
            control={keychain.present
              ? <SettingsButton busy={busy === 'keychain'} disabled={!unlocked} onClick={() => void run('keychain', async () => { await vaultApi.removeKeychain(); return 'Removed from the keychain.' })} data-testid="pw-keychain-remove">Remove from keychain</SettingsButton>
              : <span className="settings-test-result" data-kind="neutral">Off</span>}
          />
        )}
        <SettingsRow
          label="Lock every window now"
          control={<SettingsButton busy={busy === 'lock'} disabled={!status?.setUp} onClick={() => void run('lock', async () => { await vaultApi.lock(true); return 'Every window is locked.' })}>Lock all</SettingsButton>}
        />
      </SettingsGroup>

      {status?.setUp && (
        <SettingsGroup heading="Agents" footer={<>An item can say otherwise in its own settings. Every ask, use and refusal is listed in Passwords, Agent Activity.</>}>
          <SettingsRow
            label="When an agent asks for a password"
            help={needUnlock ?? SWITCH.find((o) => o.value === agents)?.help}
            control={<SegmentedControl<AgentsSwitch> id="pw-agents-switch" aria-label="When an agent asks for a password" value={agents ?? 'allow'} disabled={!unlocked || !agents || busy === 'switch'}
              options={SWITCH.map((o) => ({ value: o.value, label: o.label, testId: `pw-switch-${o.value}` }))}
              onChange={(v) => void run('switch', async () => { setAgents((await vaultApi.setAgentsSwitch(v)).agents) })} />}
          />
          <SettingsRow
            label="An approval lasts"
            help={needUnlock ?? 'After you approve an ask, that task may use that item again for this long without asking. Lock all or a new master password ends every grant; Agent Activity ends one.'}
            control={<SegmentedControl<string> id="pw-grant-length" aria-label="An approval lasts" value={String(grantMs ?? 172_800_000)} disabled={!unlocked || grantMs === null || busy === 'grant'}
              options={GRANT_OPTIONS.map((o) => ({ value: String(o.value), label: o.label, testId: `pw-grant-${o.value}` }))}
              onChange={(v) => void run('grant', async () => { setGrantMs((await vaultApi.setGrantLength(Number(v))).grantMs) })} />}
          />
        </SettingsGroup>
      )}

      {status?.setUp && <PasswordSourcesGroup config={config} onSave={onSave} unlocked={unlocked} needUnlock={needUnlock} />}

      {status?.setUp && (
        <SettingsGroup heading="Browser extension">
          <SettingsRow label="Fill and save logins in Chrome and Firefox" help="Install the Walnut extension and connect it to this Walnut."
            control={<Link className="settings-button settings-button-text" to="/settings#browser" data-testid="pw-open-browser-settings">Open</Link>} />
        </SettingsGroup>
      )}

      {status?.setUp && (
        <SettingsGroup heading="Master password">
          <SettingsRow label="Current" htmlFor="pw-old" control={<input id="pw-old" type="password" data-no-draft="secret" autoComplete="current-password" className="settings-input settings-input--short" disabled={!unlocked} value={oldPw} onChange={(e) => setOldPw(e.target.value)} />} />
          <SettingsRow label="New" htmlFor="pw-new" control={<input id="pw-new" type="password" data-no-draft="secret" autoComplete="new-password" className="settings-input settings-input--short" disabled={!unlocked} value={newPw} onChange={(e) => setNewPw(e.target.value)} />} />
          <SettingsRow label="Confirm new" htmlFor="pw-new2" help={newPw2 && newPw !== newPw2 ? 'The two new passwords differ.' : needUnlock} control={<input id="pw-new2" type="password" data-no-draft="secret" autoComplete="new-password" className="settings-input settings-input--short" disabled={!unlocked} value={newPw2} onChange={(e) => setNewPw2(e.target.value)} />} />
          <SettingsRow label="New hint" htmlFor="pw-new-hint" help="Optional. The old hint goes with the old password." error={hintError(newHint, newPw) || undefined}
            control={<input id="pw-new-hint" data-no-draft="secret" autoComplete="off" spellCheck={false} maxLength={HINT_MAX} className="settings-input settings-input--short" disabled={!unlocked} value={newHint} onChange={(e) => setNewHint(e.target.value)} />} />
          <SettingsRow
            label=""
            control={<SettingsButton busy={busy === 'password'} disabled={!unlocked || !oldPw || newPw.length < 10 || newPw !== newPw2 || !!hintError(newHint, newPw)}
              onClick={() => void run('password', async () => {
                const r = await vaultApi.changePassword(oldPw, newPw, status.kdf, newHint.trim())
                setOldPw(''); setNewPw(''); setNewPw2(''); setNewHint('')
                if (r.recoveryKit) gotKit(r.recoveryKit)
                return `Master password changed, and your other windows were locked.${r.recoveryKit ? ' Your recovery code changed too: save the new kit below, the old one no longer works.' : ''}`
              })}>Change master password</SettingsButton>}
          />
        </SettingsGroup>
      )}

      {status?.setUp && <HintSettings status={status} onChanged={refresh} />}

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
            label="Secret Key"
            help="Set up Passwords on your iPhone: paste this Secret Key there once."
            control={shownKey
              ? <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                  <code className="pw-secret-key" data-testid="pw-settings-secret-key">{shownKey}</code>
                  <CopyButton text={shownKey} label="Copy" />
                </span>
              : <SettingsButton busy={busy === 'secret-key'} disabled={!unlocked || !confirmPw} data-testid="pw-show-secret-key"
                  onClick={() => void run('secret-key', async () => {
                    const key = await vaultApi.revealSecretKey(confirmPw, status.kdf)
                    setConfirmPw('')
                    setShownKey(key)
                  })}>Show Secret Key</SettingsButton>}
          />
          <SettingsRow
            label="Agents can ask while Passwords is locked"
            htmlFor="pw-agents-away"
            help="Off: only while Passwords is open in a window. On: a key stays on this Mac so they can ask any time (you still approve each use), and any program running as you could read the vault."
            control={<ToggleSwitch id="pw-agents-away" checked={!!status.agentsWhileAway} disabled={!unlocked || !confirmPw || busy === 'agents'}
              onChange={(v) => void run('agents', async () => {
                const { recoveryKit, ...next } = await vaultApi.setAgentsWhileAway(v, confirmPw, status.kdf)
                setStatus({ ...status, ...next, unlocked: true, waitMs: 0 })
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
