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
  /** Backups were never switched on: "I saved it" turns them on too. */
  firstSetup: boolean
  /** This computer's name, for the downloaded kit. */
  machineName?: string
  onMarkSaved: (turnOn?: boolean) => void
  /** Told what the pane may do: back up only with a key, and never while one is asked for. */
  onState: (s: KeyState) => void
  /** Bumped by the pane when something changed that may make a key appear (Drive connected, a save). */
  refreshToken: number
  /** Lost the key: start new backups in a new folder of the same bucket (the old ones stay). Absent for Google Drive. */
  onStartOver?: () => Promise<void>
  /** Where the new backups would go, for the confirm. */
  startOverWhere?: string
}

export function RecoveryKeyGroup({ dest, destinationLabel, ready, mismatch, savedAt, firstSetup, machineName, onMarkSaved, onState, refreshToken, onStartOver, startOverWhere }: Props) {
  const [confirmStartOver, setConfirmStartOver] = useState(false)
  const [startingOver, setStartingOver] = useState(false)
  const startOver = async () => {
    if (!onStartOver) return
    setStartingOver(true)
    try {
      await onStartOver()
      setConfirmStartOver(false)
    } catch (err) {
      setError(saveErrorMessage(err))
    } finally {
      setStartingOver(false)
    }
  }
  const [accepted, setAccepted] = useState<string | null>(null)
  const [key, setKey] = useState<string | null>(null)
  const [askedForKey, setNeedsKey] = useState(false)
  const needsKey = askedForKey || mismatch
  const [shown, setShown] = useState(false)
  // "Downloaded" for a moment after the kit is saved, so a second click is never needed to be sure.
  const [downloaded, setDownloaded] = useState(false)
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
      const r = await apiPut<{ key: string; snapshotCount?: number }>('/api/backup/recovery-key', { key: typed, destination: dest }, { timeoutMs: 45000 })
      setKey(r.key)
      setNeedsKey(false)
      setTyped('')
      setAccepted(r.snapshotCount ? `Key accepted. It opens the ${r.snapshotCount} backup${r.snapshotCount === 1 ? '' : 's'} in ${destinationLabel}.` : 'Key accepted.')
      onMarkSaved()
    } catch (err) {
      setError(saveErrorMessage(err))
    } finally {
      setChecking(false)
    }
  }

  const download = () => {
    if (!key) return
    const blob = new Blob([recoveryKitText(key, destinationLabel, machineName ?? 'this computer', new Date())], { type: 'text/plain' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'walnut-recovery-key.txt'
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
    setDownloaded(true)
    setTimeout(() => setDownloaded(false), 2500)
  }

  if (!loaded || (!key && !needsKey && !error)) return null

  return (
    <SettingsGroup
      heading="Recovery key"
      data-testid="backup-recovery-group"
      footer={needsKey ? undefined : 'Backups are encrypted with this key before they leave this computer. Without it nobody can open them, Walnut included.'}
    >
      {needsKey ? (
        <>
          <SettingsRow
            label="Enter your recovery key"
            htmlFor="backup-key-input"
            state="warning"
            help={mismatch && key
              ? `The backups in ${destinationLabel} were made with another recovery key. Type that key. This computer's current key is kept aside, and you can copy it here first.`
              : `${destinationLabel} already has Walnut backups. Type the key you saved when you set them up (it starts with WB1-).`}
            error={error ?? undefined}
            data-testid="backup-key-needed"
            control={mismatch && key ? (
              <span className="settings-inline-pair">
                <CopyButton text={key} label="Copy current key" bordered data-testid="backup-key-copy-old" />
                <SettingsButton onClick={download} data-testid="backup-key-download-old">Download</SettingsButton>
              </span>
            ) : undefined}
          />
          <div className="settings-row settings-row-indent backup-key-entry">
            <input id="backup-key-input" type="text" data-no-draft="autosave" autoComplete="off" spellCheck={false}
              aria-label="Recovery key"
              className="settings-input settings-input--mono backup-key-input" value={typed} onChange={(e) => setTyped(e.target.value)}
              placeholder="WB1-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXX" />
            <SettingsButton variant="primary" onClick={useTypedKey} busy={checking} busyLabel="Checking..." disabled={!typed.trim()}
              data-testid="backup-key-use">
              Use this key
            </SettingsButton>
          </div>
          {confirmStartOver ? (
            <SettingsRow
              indent
              state="warning"
              label="Start over with a new key?"
              help={`New backups go to ${startOverWhere ?? 'a new folder'}, with a new key. The old backups stay where they are, but nobody can open them without the old key.`}
              data-testid="backup-key-start-over-confirm"
              control={
                <span className="settings-inline-pair">
                  <SettingsButton onClick={() => setConfirmStartOver(false)} data-testid="backup-key-start-over-cancel">Cancel</SettingsButton>
                  <SettingsButton variant="danger" onClick={() => void startOver()} busy={startingOver} busyLabel="Starting over..." data-testid="backup-key-start-over-yes">Start over</SettingsButton>
                </span>
              }
            />
          ) : (
            <SettingsRow
              indent
              label="Lost the key?"
              help={onStartOver
                ? 'Without it these backups cannot be opened. You can start new ones with a new key.'
                : `Without it these backups cannot be opened. To start new ones: in ${destinationLabel} rename the "Walnut Backup" folder, then Disconnect and Connect again above. Walnut makes a new folder and a new key.`}
              data-testid="backup-key-lost"
              control={onStartOver ? <SettingsButton onClick={() => setConfirmStartOver(true)} data-testid="backup-key-start-over">Start over</SettingsButton> : undefined}
            />
          )}
        </>
      ) : key ? (
        <>
          <SettingsRow
            label="Your key"
            help={accepted ?? (savedAt ? 'Opens your backups. You saved a copy; keep it off this computer.' : 'Opens your backups.')}
            error={error ?? undefined}
            data-testid="backup-key-row"
            control={
              <span className="settings-inline-pair">
                <SettingsButton onClick={() => setShown(!shown)} reserve={['Show', 'Hide']} data-testid="backup-key-show">{shown ? 'Hide' : 'Show'}</SettingsButton>
                <CopyButton text={key} bordered data-testid="backup-key-copy" />
                <SettingsButton onClick={download} reserve={['Download', 'Downloaded']} data-testid="backup-key-download">{downloaded ? 'Downloaded' : 'Download'}</SettingsButton>
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
              help="In a password manager or on paper, not only on this computer: a new computer needs it to restore."
              data-testid="backup-key-unsaved"
              control={
                <SettingsButton variant={firstSetup ? 'primary' : undefined} onClick={() => { setShown(false); onMarkSaved(firstSetup) }} data-testid="backup-key-saved">
                  {firstSetup ? 'I saved it, turn on backups' : 'I saved it'}
                </SettingsButton>
              }
            />
          )}
        </>
      ) : (
        <SettingsRow label="Key" error={error ?? undefined} />
      )}
    </SettingsGroup>
  )
}
