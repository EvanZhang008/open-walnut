/**
 * Restore: pick one of the backups, bring it back into a NEW folder.
 *
 * The data Walnut runs on is never touched; the result row says how to switch
 * to the restored folder, naming the real folders. Progress and the result
 * come from `backup:status` (`restore`), so they survive closing and reopening
 * Settings, until the user dismisses the result or starts another restore.
 */
import { useState } from 'react'
import { SettingsRow } from '../../SettingsSection'
import { SettingsButton } from '../../inputs/SettingsButton'
import { CopyButton } from '../../inputs/CopyButton'
import { saveErrorMessage } from '../../settings-pane-context'
import { apiPost } from '@/api/client'
import { fmtBytes, type BackupDestinationConfig } from './backup-model'

export interface RestoreStatus {
  running: boolean
  snapshotId?: string
  targetDir?: string
  doneBytes?: number
  totalBytes?: number
  doneFiles?: number
  totalFiles?: number
  finishedAt?: string
  error?: string
}

interface BackupItem {
  id: string
  createdAt: string
  hostname?: string
  fileCount?: number
  totalBytes?: number
  isLatest?: boolean
}

interface Props {
  dest: BackupDestinationConfig | null
  restore: RestoreStatus | undefined
  /** The data folder Walnut runs on (to name it in the switch steps). */
  dataDir?: string
  /** A restore cannot start yet (the Backups group's first row says why). */
  blocked: boolean
}

const whenOf = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export function RestorePanel({ dest, restore, dataDir, blocked }: Props) {
  const [items, setItems] = useState<BackupItem[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const [target, setTarget] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  const dismiss = () => { void apiPost('/api/backup/restore/dismiss', {}).catch(() => {}) }

  const open = async () => {
    setLoading(true)
    setError(null)
    if (restore?.finishedAt) dismiss()
    try {
      const r = await apiPost<{ snapshots: BackupItem[] }>('/api/backup/snapshots', dest ? { destination: dest } : {}, { timeoutMs: 60000 })
      setItems(r.snapshots)
      setPicked(r.snapshots[0]?.id ?? null)
    } catch (err) {
      setError(saveErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  const start = async () => {
    if (!picked) return
    setStarting(true)
    setError(null)
    try {
      await apiPost('/api/backup/restore', { snapshotId: picked, targetDir: target.trim() || undefined, ...(dest ? { destination: dest } : {}) })
      setItems(null)
    } catch (err) {
      setError(saveErrorMessage(err))
    } finally {
      setStarting(false)
    }
  }

  const pct = restore?.running && restore.totalBytes
    ? Math.floor(((restore.doneBytes ?? 0) / restore.totalBytes) * 100)
    : restore?.running && restore.totalFiles
      ? Math.floor(((restore.doneFiles ?? 0) / restore.totalFiles) * 100)
      : null

  if (restore?.running) {
    return (
      <SettingsRow
        label="Restoring"
        help={`Into ${restore.targetDir}. ${restore.doneFiles ?? 0} of ${restore.totalFiles ?? '...'} files, every file checked as it lands.`}
        data-testid="backup-restore-progress"
        control={
          <span className="settings-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
            <span className="settings-progress-track"><span className="settings-progress-fill" style={{ width: `${pct ?? 0}%` }} /></span>
            <span className="settings-progress-pct">{pct ?? 0}%</span>
          </span>
        }
      />
    )
  }

  const home = dataDir ?? '~/.open-walnut'
  return (
    <>
      {restore?.finishedAt && !items && (
        restore.error ? (
          <SettingsRow
            label="Restore failed"
            error={restore.error}
            data-testid="backup-restore-failed"
            control={<SettingsButton onClick={dismiss} data-testid="backup-restore-dismiss">Dismiss</SettingsButton>}
          />
        ) : (
          <SettingsRow
            label="Restored"
            wide
            data-testid="backup-restore-done"
            help={
              <>
                {restore.doneFiles} files ({fmtBytes(restore.doneBytes)}), every one checked, are in <code>{restore.targetDir}</code>.
                {' '}To make them your Walnut data: quit Walnut, rename <code>{home}</code> to keep it aside,
                rename the restored folder to <code>{home}</code>, then start Walnut.
              </>
            }
            control={
              <span className="settings-inline-pair">
                {restore.targetDir && <CopyButton text={restore.targetDir} label="Copy path" bordered data-testid="backup-restore-copy-path" />}
                <SettingsButton onClick={dismiss} data-testid="backup-restore-dismiss">Done</SettingsButton>
              </span>
            }
          />
        )
      )}
      <SettingsRow
        label="Restore"
        help="Bring a backup back into a new folder. The data Walnut runs on now is not touched."
        error={error ?? undefined}
        data-testid="backup-restore-row"
        control={
          <SettingsButton onClick={items ? () => setItems(null) : open} busy={loading} busyLabel="Loading..." disabled={blocked && !items}
            data-testid="backup-restore-open">
            {items ? 'Close' : 'Choose a backup'}
          </SettingsButton>
        }
      />
      {items && items.length === 0 && <SettingsRow indent label="No backups here yet." />}
      {items && items.length > 0 && (
        <>
          <div className="settings-row settings-row-indent backup-restore-list" role="radiogroup" aria-label="Backups" data-testid="backup-restore-list">
            {items.map((it) => (
              <label key={it.id} className="backup-restore-item" data-picked={picked === it.id ? 'true' : undefined}>
                <input type="radio" name="backup-restore-pick" value={it.id} checked={picked === it.id} onChange={() => setPicked(it.id)} />
                <span className="backup-restore-when">{whenOf(it.createdAt)}</span>
                <span className="backup-restore-meta">
                  {[it.fileCount !== undefined ? `${it.fileCount.toLocaleString()} files` : null,
                    it.totalBytes !== undefined ? fmtBytes(it.totalBytes) : null,
                    it.hostname ? `from ${it.hostname}` : null,
                    it.isLatest ? 'latest' : null].filter(Boolean).join(' · ')}
                </span>
              </label>
            ))}
          </div>
          <SettingsRow
            indent
            wide
            label="Into folder"
            htmlFor="backup-restore-target"
            help="A new, empty folder. Leave it empty for one next to your data (.open-walnut-restored-<date>)."
            control={
              <span className="settings-inline-pair">
                <input id="backup-restore-target" type="text" data-no-draft="autosave" className="settings-input"
                  value={target} onChange={(e) => setTarget(e.target.value)} placeholder="Optional" />
                <SettingsButton variant="primary" onClick={start} busy={starting} busyLabel="Starting..." disabled={!picked} data-testid="backup-restore-start">
                  Restore
                </SettingsButton>
              </span>
            }
          />
        </>
      )}
    </>
  )
}
