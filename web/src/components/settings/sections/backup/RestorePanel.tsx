/**
 * Restore: pick one of the backups, bring it back into a NEW folder.
 *
 * The data Walnut runs on is never touched; the result row says how to switch
 * to the restored folder, naming the real folders. Progress and the result
 * come from `backup:status` (`restore`), so they survive closing and reopening
 * Settings, until the user dismisses the result or starts another restore.
 */
import { useEffect, useRef, useState } from 'react'
import { SettingsDisclosure, SettingsRow } from '../../SettingsSection'
import { SettingsButton } from '../../inputs/SettingsButton'
import { CopyButton } from '../../inputs/CopyButton'
import { SegmentedControl } from '../../inputs/SegmentedControl'
import { saveErrorMessage } from '../../settings-pane-context'
import { apiPost } from '@/api/client'
import { fmtBytes, type BackupDestinationConfig } from './backup-model'

export interface RestoreStatus {
  running: boolean
  snapshotId?: string
  targetDir?: string
  source?: string
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
  /** Why, in words, for this row too. */
  blockedWhy?: string
  /** The service in use, named when there is a choice of where to restore from. */
  destLabel?: string
  /** Other services set up before: their backups can be restored too, without switching to them. */
  others?: Array<{ label: string; dest: BackupDestinationConfig }>
  /** "Use this restored data" asked: done when Walnut next starts. */
  pendingSwitch?: { restored: string; aside: string } | null
  /** How the last start's switch failed, if it did. */
  switchError?: string | null
  /** The switch was asked for or dropped: read the status again. */
  onSwitchChanged?: () => void
  /** Walnut can restart by itself into the restored data (else the user quits and opens it). */
  canRestart?: boolean
}

/** When a backup was made; to the second when another one shares its minute. */
const whenOf = (iso: string, seconds = false): string =>
  new Date(iso).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}),
  })

export function RestorePanel({ dest, restore, dataDir, blocked, blockedWhy, destLabel, others = [], pendingSwitch, switchError, onSwitchChanged, canRestart }: Props) {
  const sources = dest ? [{ label: destLabel ?? 'In use', dest }, ...others] : []
  const [from, setFrom] = useState(0)
  const source = sources[Math.min(from, Math.max(0, sources.length - 1))]?.dest ?? null
  const [items, setItems] = useState<BackupItem[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const [target, setTarget] = useState('')
  // The new folder an empty field means, named when the list opens: the restore goes exactly there.
  const [suggested, setSuggested] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // A refused start (a folder that is not empty) belongs to the folder row, and goes once it is edited.
  const [startError, setStartError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  // Done hides the result at once (the status that follows confirms it), never a click that seems to do nothing.
  const [dismissedAt, setDismissedAt] = useState<string | null>(null)
  const dismiss = () => {
    setDismissedAt(restore?.finishedAt ?? null)
    void apiPost('/api/backup/restore/dismiss', {}).catch(() => {}).finally(() => onSwitchChanged?.())
  }
  const shownResult = restore?.finishedAt && restore.finishedAt !== dismissedAt ? restore : undefined
  // The picker opened: bring its last row (the folder and Restore) into view.
  const entryRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (items && items.length > 0) entryRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [items])
  // "Use this restored data": confirm, then ask; Walnut restarts into it when it can.
  const [confirmUse, setConfirmUse] = useState(false)
  const [using, setUsing] = useState(false)
  const [useError, setUseError] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)
  const useRestored = async () => {
    if (!restore?.targetDir) return
    setUsing(true)
    setUseError(null)
    try {
      const r = await apiPost<{ restarting: boolean }>('/api/backup/restore/use', { targetDir: restore.targetDir })
      setConfirmUse(false)
      setRestarting(r.restarting)
      onSwitchChanged?.()
    } catch (err) {
      setUseError(saveErrorMessage(err))
    } finally {
      setUsing(false)
    }
  }
  const cancelUse = () => { void apiPost('/api/backup/restore/use/cancel', {}).catch(() => {}).finally(() => onSwitchChanged?.()) }

  const open = async (at: BackupDestinationConfig | null = source) => {
    setLoading(true)
    setError(null)
    if (restore?.finishedAt) dismiss()
    try {
      const r = await apiPost<{ snapshots: BackupItem[] }>('/api/backup/snapshots', at ? { destination: at } : {}, { timeoutMs: 60000 })
      setItems(r.snapshots)
      setPicked(r.snapshots[0]?.id ?? null)
      setSuggested(dataDir ? `${dataDir.replace(/\/[^/]*\/?$/, '')}/open-walnut-restored-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}` : null)
    } catch (err) {
      setError(saveErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  const start = async () => {
    if (!picked) return
    setStarting(true)
    setStartError(null)
    try {
      await apiPost('/api/backup/restore', {
        snapshotId: picked, targetDir: target.trim() || undefined,
        ...(!target.trim() && suggested ? { suggestedDir: suggested } : {}),
        ...(source ? { destination: source } : {}),
      })
      setItems(null)
    } catch (err) {
      setStartError(saveErrorMessage(err))
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
        help={`Into ${restore.targetDir}. ${restore.totalBytes && restore.doneBytes
          ? `${fmtBytes(restore.doneBytes)} of ${fmtBytes(restore.totalBytes)} (${(restore.doneFiles ?? 0).toLocaleString()} of ${(restore.totalFiles ?? 0).toLocaleString()} files)`
          : 'Starting: reading the backup list...'}, every file checked as it lands.`}
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
  const swap = restore?.targetDir ? swapCommands(home, restore.targetDir, restore.finishedAt) : null
  return (
    <>
      <SettingsRow
        label="Restore"
        help={blocked && !items && blockedWhy ? 'Bring a backup back into a new folder, once the first row of this group is done.' : 'Bring a backup back into a new folder. The data Walnut runs on now is not touched.'}
        error={error ?? undefined}
        data-testid="backup-restore-row"
        control={
          <SettingsButton onClick={items ? () => setItems(null) : () => void open()} busy={loading} busyLabel="Loading..." disabled={blocked && !items}
            data-testid="backup-restore-open">
            {items ? 'Close' : 'Choose a backup'}
          </SettingsButton>
        }
      />
      {items && sources.length > 1 && (
        <SettingsRow
          indent
          label="From"
          data-testid="backup-restore-from"
          control={
            <SegmentedControl
              id="backup-restore-from"
              aria-label="Restore from"
              value={String(from)}
              onChange={(v) => { setFrom(Number(v)); void open(sources[Number(v)].dest) }}
              options={sources.map((s, i) => ({ value: String(i), label: s.label, testId: `backup-restore-from-${s.dest.type}` }))}
            />
          }
        />
      )}
      {items && items.length === 0 && <SettingsRow indent label="No backups here yet." />}
      {items && items.length > 0 && (
        <>
          <div className="settings-row settings-row-indent backup-restore-list" role="radiogroup" aria-label="Backups" data-testid="backup-restore-list">
            {items.map((it) => (
              <label key={it.id} className="backup-restore-item" data-picked={picked === it.id ? 'true' : undefined}>
                <input type="radio" name="backup-restore-pick" value={it.id} checked={picked === it.id} onChange={() => setPicked(it.id)} />
                <span className="backup-restore-when">
                  {whenOf(it.createdAt, items.some((o) => o.id !== it.id && whenOf(o.createdAt) === whenOf(it.createdAt)))}
                </span>
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
            label="Into folder"
            htmlFor="backup-restore-target"
            help="A new, empty folder. Leave it empty to use the one shown, next to your data."
            data-testid="backup-restore-target-row"
          />
          <div ref={entryRef} className="settings-row settings-row-indent backup-wide-entry">
            <input id="backup-restore-target" type="text" data-no-draft="autosave" spellCheck={false}
              className="settings-input settings-input--mono" aria-label="Restore into folder"
              value={target} onChange={(e) => { setTarget(e.target.value); setStartError(null) }}
              placeholder={suggested ?? 'Optional'} />
            <SettingsButton variant="primary" onClick={start} busy={starting} busyLabel="Starting..." disabled={!picked} data-testid="backup-restore-start">
              Restore
            </SettingsButton>
          </div>
          {/* Under the field it is about, not above it. */}
          {startError && <p className="settings-row-error settings-row-error-indent" role="alert" data-testid="backup-restore-target-error">{startError}</p>}
          {target.trim().length > 40 && !startError && (
            // A long path's end (the folder's own name) never hides inside the field.
            <p className="settings-row settings-row-indent backup-restore-target-full" data-testid="backup-restore-target-full">
              Restores into <code>{target.trim()}</code>
            </p>
          )}
        </>
      )}
      {pendingSwitch ? (
        <SettingsRow
          label={restarting ? 'Restarting with the restored data...' : 'Switches when Walnut starts'}
          state="warning"
          wide
          data-testid="backup-restore-switch-pending"
          help={restarting
            ? <>This page comes back by itself. Your current data is kept at <code>{pendingSwitch.aside}</code>.</>
            : <>Quit Walnut and open it again: it then uses <code>{pendingSwitch.restored}</code>, and keeps your current data at <code>{pendingSwitch.aside}</code>. Nothing is deleted.</>}
          control={restarting ? undefined : <SettingsButton onClick={cancelUse} data-testid="backup-restore-switch-cancel">Keep current data</SettingsButton>}
        />
      ) : shownResult && restore && !items && (
        restore.error ? (
          <SettingsRow
            label="Restore failed"
            error={restore.error}
            data-testid="backup-restore-failed"
            control={<SettingsButton onClick={dismiss} data-testid="backup-restore-dismiss">Dismiss</SettingsButton>}
          />
        ) : confirmUse ? (
          <SettingsRow
            label="Use the restored data?"
            state="warning"
            wide
            data-testid="backup-restore-use-confirm"
            help={canRestart
              ? <>Walnut restarts and runs on <code>{restore.targetDir}</code>. Your current data is kept beside it, renamed, and nothing is deleted.</>
              : <>From its next start Walnut runs on <code>{restore.targetDir}</code> (quit Walnut and open it again). Your current data is kept beside it, renamed, and nothing is deleted.</>}
            error={useError ?? undefined}
            control={
              <span className="settings-inline-pair">
                <SettingsButton onClick={() => { setConfirmUse(false); setUseError(null) }} data-testid="backup-restore-use-cancel">Cancel</SettingsButton>
                <SettingsButton variant="primary" onClick={() => void useRestored()} busy={using} busyLabel="Switching..." data-testid="backup-restore-use-yes">
                  {canRestart ? 'Switch and restart' : 'Switch at next start'}
                </SettingsButton>
              </span>
            }
          />
        ) : (
          <SettingsRow
            label="Restored"
            wide
            data-testid="backup-restore-done"
            help={<>{restore.source ? `From ${restore.source}: ` : ''}{(restore.doneFiles ?? 0).toLocaleString()} files ({fmtBytes(restore.doneBytes)}), every one checked, are in <code>{restore.targetDir}</code>. Your Walnut data is unchanged until you choose to use them.</>}
            control={
              <span className="settings-inline-pair">
                <SettingsButton onClick={dismiss} data-testid="backup-restore-dismiss">Done</SettingsButton>
                <SettingsButton onClick={() => setConfirmUse(true)} data-testid="backup-restore-use">Use this data</SettingsButton>
              </span>
            }
          />
        )
      )}
      {!pendingSwitch && confirmUse && shownResult && !shownResult.error && !items && swap && (
        <SettingsDisclosure id="backup-restore-command" label="Advanced: switch it yourself in a terminal" data-testid="backup-restore-command">
          <div className="settings-row backup-restore-swap" data-testid="backup-restore-swap">
            <pre className="backup-restore-commands">{swap}</pre>
            <CopyButton text={swap} label="Copy command" bordered data-testid="backup-restore-copy-commands" />
          </div>
          <p className="settings-steps-note">Quit Walnut, run it in a terminal (it keeps your current data aside and deletes nothing), then start Walnut.</p>
        </SettingsDisclosure>
      )}
      {switchError && !pendingSwitch && (
        <SettingsRow label="The restored data was not switched in" error={switchError} data-testid="backup-restore-switch-error"
          control={<SettingsButton onClick={cancelUse} data-testid="backup-restore-switch-error-dismiss">Dismiss</SettingsButton>} />
      )}
    </>
  )
}

const shellQuote = (p: string): string => {
  if (p.startsWith('~/')) return `~/${shellQuote(p.slice(2))}`
  return /^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`
}

/**
 * The one command that makes the restored folder the live data, current data kept
 * aside. Chained with &&: when a step fails nothing after it runs, so the restored
 * folder never lands inside the live one.
 */
export function swapCommands(home: string, restored: string, at?: string): string {
  const stamp = (at ?? new Date().toISOString()).slice(0, 19).replace(/:/g, '-')
  const h = home.replace(/\/+$/, '')
  const aside = `${h}-before-restore-${stamp}`
  return `[ ! -e ${shellQuote(aside)} ] && mv ${shellQuote(h)} ${shellQuote(aside)} && mv ${shellQuote(restored)} ${shellQuote(h)}`
}
