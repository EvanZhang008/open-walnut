/**
 * Restore: pick one of the backups, bring it back into a NEW folder.
 *
 * The data Walnut runs on is never touched; the last row says how to switch
 * to the restored folder. Progress and the result come from `backup:status`
 * (`restore`), so they survive closing and reopening Settings.
 */
import { useState } from 'react'
import { SettingsRow } from '../../SettingsSection'
import { SettingsButton } from '../../inputs/SettingsButton'
import { CopyButton } from '../../inputs/CopyButton'
import { saveErrorMessage } from '../../settings-pane-context'
import { formatAbsoluteTime } from '../addons-format'
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
  disabled: boolean
}

export function RestorePanel({ dest, restore, disabled }: Props) {
  const [items, setItems] = useState<BackupItem[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const [target, setTarget] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  const open = async () => {
    setLoading(true)
    setError(null)
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

  return (
    <>
      {restore?.finishedAt && !items && (
        restore.error ? (
          <SettingsRow label="Restore failed" state="error" help={restore.error} data-testid="backup-restore-failed" />
        ) : (
          <SettingsRow
            label="Restored"
            wide
            data-testid="backup-restore-done"
            help={<>{restore.doneFiles} files ({fmtBytes(restore.doneBytes)}) are in <code>{restore.targetDir}</code>. To use them: quit Walnut, rename <code>~/.open-walnut</code> to keep it aside, move this folder to <code>~/.open-walnut</code>, start Walnut.</>}
            control={restore.targetDir ? <CopyButton text={restore.targetDir} data-testid="backup-restore-copy-path" /> : undefined}
          />
        )
      )}
      <SettingsRow
        label="Restore"
        help="Bring a backup back into a new folder. The data Walnut runs on now is not touched."
        error={error ?? undefined}
        data-testid="backup-restore-row"
        control={
          <SettingsButton onClick={items ? () => setItems(null) : open} busy={loading} busyLabel="Loading..." disabled={disabled}
            reserve={['Choose a backup', 'Cancel']} data-testid="backup-restore-open">
            {items ? 'Cancel' : 'Choose a backup'}
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
                <span className="backup-restore-when">{formatAbsoluteTime(it.createdAt)}</span>
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
            help="Leave empty for a new folder next to your data (.open-walnut-restored-<date>)."
            control={
              <span className="settings-inline-pair">
                <input id="backup-restore-target" type="text" data-no-draft="autosave" className="settings-input settings-input--mono"
                  value={target} onChange={(e) => setTarget(e.target.value)} placeholder="New folder next to your data" />
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
