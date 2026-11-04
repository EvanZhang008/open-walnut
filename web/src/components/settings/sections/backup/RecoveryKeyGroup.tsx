/**
 * The recovery key: the one thing that opens the encrypted backups.
 *
 * Shown hidden by default with Show, Copy and Download (a small text kit).
 * Until the user says they saved it, a warning row asks them to. On a new
 * computer, where the destination already holds backups made with another
 * key, the row asks for that key instead and checks it before keeping it; the
 * same when this computer has a key but the destination's backups were made
 * with another one (`mismatch`).
 */
import { useCallback, useEffect, useState } from 'react'
import { SettingsGroup, SettingsRow } from '../../SettingsSection'
import { SettingsButton } from '../../inputs/SettingsButton'
import { CopyButton } from '../../inputs/CopyButton'
import { saveErrorMessage } from '../../settings-pane-context'
import { apiGet, apiPost, apiPut } from '@/api/client'
import { recoveryKitText, type BackupDestinationConfig } from './backup-model'

export interface KeyState {
  hasKey: boolean
  needsKey: boolean
}

interface Props {
  /** The destination as saved (the key is checked against it). */
  dest: BackupDestinationConfig
  destinationLabel: string
  ready: boolean
  /** The last backup found the destination's backups made with another key. */
  mismatch: boolean
  savedAt: string | undefined
  onMarkSaved: () => void
  /** Told what the pane may do: back up only with a key, and never while one is asked for. */
  onState: (s: KeyState) => void
  /** Bumped by the pane when something changed that may make a key appear (Drive connected, a save). */
  refreshToken: number
}

export function RecoveryKeyGroup({ dest, destinationLabel, ready, mismatch, savedAt, onMarkSaved, onState, refreshToken }: Props) {
  const [key, setKey] = useState<string | null>(null)
  const [askedForKey, setNeedsKey] = useState(false)
  const needsKey = askedForKey || mismatch
  const [shown, setShown] = useState(false)
  const [typed, setTyped] = useState('')
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await apiGet<{ key: string | null }>('/api/backup/recovery-key')
      if (r.key) {
        setKey(r.key)
        setNeedsKey(false)
      } else if (ready) {
        // First time here: make the key, unless backups are already there (then ask for theirs).
        const e = await apiPost<{ key: string | null; needsKey?: boolean }>('/api/backup/recovery-key/ensure', { destination: dest }, { timeoutMs: 45000 })
        setKey(e.key)
        setNeedsKey(Boolean(e.needsKey))
      }
      setError(null)
    } catch (err) {
      setError(saveErrorMessage(err))
    } finally {
      setLoaded(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, JSON.stringify(dest)])

  useEffect(() => { void load() }, [load, refreshToken])
  useEffect(() => { onState({ hasKey: !!key && !mismatch, needsKey }) }, [key, needsKey, mismatch, onState])

  const useTypedKey = async () => {
    setChecking(true)
    setError(null)
    try {
      const r = await apiPut<{ key: string }>('/api/backup/recovery-key', { key: typed, destination: dest }, { timeoutMs: 45000 })
      setKey(r.key)
      setNeedsKey(false)
      setTyped('')
      onMarkSaved()
    } catch (err) {
      setError(saveErrorMessage(err))
    } finally {
      setChecking(false)
    }
  }

  const download = () => {
    if (!key) return
    const blob = new Blob([recoveryKitText(key, destinationLabel, window.location.hostname, new Date())], { type: 'text/plain' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'walnut-recovery-key.txt'
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  if (!loaded || (!key && !needsKey && !error)) return null

  return (
    <SettingsGroup
      heading="Recovery key"
      data-testid="backup-recovery-group"
      footer={needsKey ? undefined : 'Your backups are encrypted with this key before they leave this computer. Without it nobody can open them, Walnut included.'}
    >
      {needsKey ? (
        <SettingsRow
          label="Enter your recovery key"
          htmlFor="backup-key-input"
          wide
          state="warning"
          help={mismatch && key
            ? `The backups in ${destinationLabel} were made with another recovery key. Type that key (it starts with WB1-). It replaces this computer's key, so keep the old one if other backups use it.`
            : `${destinationLabel} already has Walnut backups. Type the key you saved when you set them up (it starts with WB1-).`}
          error={error ?? undefined}
          data-testid="backup-key-needed"
          control={
            <span className="settings-inline-pair">
              <input id="backup-key-input" type="text" data-no-draft="autosave" autoComplete="off" spellCheck={false}
                className="settings-input settings-input--mono" value={typed} onChange={(e) => setTyped(e.target.value)}
                placeholder="WB1-XXXXX-XXXXX-..." />
              <SettingsButton variant="primary" onClick={useTypedKey} busy={checking} busyLabel="Checking..." disabled={!typed.trim()}
                data-testid="backup-key-use">
                Use this key
              </SettingsButton>
            </span>
          }
        />
      ) : key ? (
        <>
          <SettingsRow
            label="Recovery key"
            help="Opens your backups. Keep a copy somewhere other than this computer."
            error={error ?? undefined}
            data-testid="backup-key-row"
            control={
              <span className="settings-inline-pair">
                <SettingsButton onClick={() => setShown(!shown)} reserve={['Show', 'Hide']} data-testid="backup-key-show">{shown ? 'Hide' : 'Show'}</SettingsButton>
                <CopyButton text={key} bordered data-testid="backup-key-copy" />
                <SettingsButton onClick={download} data-testid="backup-key-download">Download</SettingsButton>
              </span>
            }
          />
          {shown && (
            <div className="settings-row settings-row-indent backup-key-shown" data-testid="backup-key-shown">
              <code className="backup-key" data-testid="backup-key-value">{key}</code>
            </div>
          )}
          {!savedAt && (
            <SettingsRow
              state="warning"
              label="Save it somewhere safe"
              help="Put it in your password manager or print it. You need it to restore on a new computer."
              data-testid="backup-key-unsaved"
              control={<SettingsButton onClick={onMarkSaved} data-testid="backup-key-saved">I saved it</SettingsButton>}
            />
          )}
        </>
      ) : (
        <SettingsRow label="Key" error={error ?? undefined} />
      )}
    </SettingsGroup>
  )
}
