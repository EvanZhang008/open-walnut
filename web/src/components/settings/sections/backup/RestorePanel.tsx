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
import { apiGet, apiPost } from '@/api/client'
import { fmtBytes, type BackupDestinationConfig } from './backup-model'

export interface RestoreStatus {
  running: boolean
  snapshotId?: string
  targetDir?: string
  source?: string
  snapshotAt?: string
  doneBytes?: number
  totalBytes?: number
  doneFiles?: number
  totalFiles?: number
  finishedAt?: string
  error?: string
  /** The user stopped it; the folder it was writing was removed. */
  cancelled?: boolean
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
  /** A switch done at the last start, not read yet: said once, with where the previous data is. */
  switchDone?: { restored: string; aside: string; at: string } | null
  /** The switch was asked for or dropped: read the status again. */
  onSwitchChanged?: () => void
  /** Walnut can restart by itself into the restored data (else the user quits and opens it). */
  canRestart?: boolean
  /** Told when "Switch and restart" starts (and if it fails): the pane is out of reach meanwhile. */
  onRestarting?: (on: boolean) => void
}

/** When a backup was made; to the second when another one shares its minute. */
const whenOf = (iso: string, seconds = false): string =>
  new Date(iso).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}),
  })

export function RestorePanel({ dest, restore, dataDir, blocked, blockedWhy, destLabel, others = [], pendingSwitch, switchError, switchDone, onSwitchChanged, canRestart, onRestarting }: Props) {
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
  // A result is news for a day: after that the Restore row stands alone again.
  const shownResult = restore?.finishedAt && restore.finishedAt !== dismissedAt && Date.now() - Date.parse(restore.finishedAt) < 86_400_000 ? restore : undefined
  const [cancelling, setCancelling] = useState(false)
  const cancelRestore = () => {
    setCancelling(true)
    void apiPost('/api/backup/restore/cancel', {}).catch(() => {}).finally(() => { setCancelling(false); onSwitchChanged?.() })
  }
  // The picker opened: bring its last row (the folder and Restore) into view.
  const entryRef = useRef<HTMLDivElement>(null)
  // A refused start says why where the eye is: the message is brought into view.
  const startErrorRef = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    if (startError) startErrorRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [startError])
  useEffect(() => {
    if (items && items.length > 0) entryRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [items])
  // "Use this restored data": confirm, then ask; Walnut restarts into it when it can.
  const [confirmUse, setConfirmUse] = useState(false)
  const [using, setUsing] = useState(false)
  const [useError, setUseError] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)
  const [slowRestart, setSlowRestart] = useState(false)
  // While Walnut restarts into the restored data, ask it every 2 s; once it answers with the
  // switch done, load the page again (everything on it was the old data). Slow: offer Reload.
  useEffect(() => {
    if (!restarting) return
    let stop = false
    const started = Date.now()
    const poll = async () => {
      while (!stop) {
        await new Promise((r) => setTimeout(r, 2000))
        if (stop) return
        if (Date.now() - started > 20_000) setSlowRestart(true)
        try {
          const st = await apiGet<{ pendingSwitch?: unknown }>('/api/backup/status', undefined, { timeoutMs: 3000, quietStatuses: [502, 503, 504] })
          if (!st.pendingSwitch) { window.location.reload(); return }
        } catch { /* still restarting */ }
      }
    }
    void poll()
    return () => { stop = true }
  }, [restarting])
  const useRestored = async () => {
    if (!restore?.targetDir) return
    setUsing(true)
    setUseError(null)
    if (canRestart) onRestarting?.(true)
    try {
      const r = await apiPost<{ restarting: boolean }>('/api/backup/restore/use', { targetDir: restore.targetDir })
      setConfirmUse(false)
      setRestarting(r.restarting)
      if (!r.restarting) onRestarting?.(false)
      onSwitchChanged?.()
    } catch (err) {
      onRestarting?.(false)
      setUseError(saveErrorMessage(err))
    } finally {
      setUsing(false)
    }
  }
  // The data set aside by the last switch: kept by default, deleted only after a confirm.
  const [confirmDeletePrevious, setConfirmDeletePrevious] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  // Said for a few seconds after Delete, so the row going away reads as done, not lost.
  const [deletedNote, setDeletedNote] = useState(false)
  useEffect(() => {
    if (!deletedNote) return
    const t = setTimeout(() => setDeletedNote(false), 6000)
    return () => clearTimeout(t)
  }, [deletedNote])
  const deletePrevious = async () => {
    setDeleting(true)
    setDeleteError(null)
    try {
      await apiPost('/api/backup/restore/use/delete-previous', {})
      setConfirmDeletePrevious(false)
      setDeletedNote(true)
      onSwitchChanged?.()
    } catch (err) {
      setDeleteError(saveErrorMessage(err))
    } finally {
      setDeleting(false)
    }
  }
  const cancelUse = () => { void apiPost('/api/backup/restore/use/cancel', {}).catch(() => {}).finally(() => onSwitchChanged?.()) }

  const open = async (at: BackupDestinationConfig | null = source) => {
    setLoading(true)
    setError(null)
    // Each restore goes into a new, empty folder: a folder typed for the last one is not offered again.
    setTarget('')
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
          <span className="settings-inline-pair">
            <span className="settings-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
              <span className="settings-progress-track"><span className="settings-progress-fill" style={{ width: `${pct ?? 0}%` }} /></span>
              <span className="settings-progress-pct">{pct ?? 0}%</span>
            </span>
            <SettingsButton onClick={cancelRestore} busy={cancelling} busyLabel="Cancelling..." data-testid="backup-restore-cancel">Cancel</SettingsButton>
          </span>
        }
      />
    )
  }

  // One time format for the whole list: to the second when any two share a minute.
  const listSeconds = !!items && items.some((a) => items.some((b) => b.id !== a.id && whenOf(b.createdAt) === whenOf(a.createdAt)))
  const home = dataDir ?? '~/.open-walnut'
  const swap = restore?.targetDir ? swapCommands(home, restore.targetDir, restore.finishedAt) : null
  // A result shown stands in for the Restore row (Done brings it back): one row, not two.
  const resultRow = !!shownResult && !items && !pendingSwitch
  return (
    <>
      {!resultRow && <SettingsRow
        label="Restore"
        help={blocked && !items && blockedWhy ? `Bring a backup back into a new folder. ${blockedWhy}` : 'Bring a backup back into a new folder; the data in use is not touched. On a new computer, set up the same service first.'}
        error={error ?? undefined}
        data-testid="backup-restore-row"
        control={
          <SettingsButton onClick={items ? () => setItems(null) : () => void open()} busy={loading} busyLabel="Loading..." disabled={blocked && !items}
            title={blocked && !items ? (blockedWhy ?? 'Set up where backups go first.') : undefined}
            data-testid="backup-restore-open">
            {items ? 'Close' : 'Choose a backup'}
          </SettingsButton>
        }
      />}
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
            {items.map((it, i) => (
              <label key={it.id} className="backup-restore-item" data-picked={picked === it.id ? 'true' : undefined}>
                <input type="radio" name="backup-restore-pick" value={it.id} checked={picked === it.id} onChange={() => setPicked(it.id)} />
                <span className="backup-restore-when">
                  {whenOf(it.createdAt, listSeconds)}
                  {/* The list is newest first; the newest one says so, not only by its place. */}
                  {(it.isLatest || i === 0) && <span className="settings-tag settings-tag-neutral backup-restore-latest" data-testid="backup-restore-latest">Latest</span>}
                </span>
                <span className="backup-restore-meta">
                  {[it.fileCount !== undefined ? `${it.fileCount.toLocaleString()} files` : null,
                    it.totalBytes !== undefined ? fmtBytes(it.totalBytes) : null,
                    it.hostname ? `from ${it.hostname}` : null].filter(Boolean).join(' · ')}
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
            <SettingsButton variant="primary" onClick={start} busy={starting} busyLabel="Starting..." disabled={!picked}
              title={picked ? undefined : 'Pick a backup first.'} data-testid="backup-restore-start">
              Restore
            </SettingsButton>
          </div>
          {/* Under the field it is about, not above it. */}
          {startError && <p ref={startErrorRef} className="settings-row-error settings-row-error-indent" role="alert" data-testid="backup-restore-target-error">{startError}</p>}
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
            ? <>{slowRestart ? 'Taking longer than usual. Reload the page once Walnut is back.' : 'This page loads again by itself in a few seconds.'} Your current data is kept at <code>{pendingSwitch.aside}</code>.</>
            : <>Quit Walnut and open it again: it then uses <code>{pendingSwitch.restored}</code>, and keeps your current data at <code>{pendingSwitch.aside}</code>. Nothing is deleted.</>}
          control={restarting
            ? (slowRestart ? <SettingsButton onClick={() => window.location.reload()} data-testid="backup-restore-reload">Reload</SettingsButton> : undefined)
            : <SettingsButton onClick={cancelUse} data-testid="backup-restore-switch-cancel">Keep current data</SettingsButton>}
        />
      ) : shownResult && restore && !items && (
        restore.cancelled ? (
          <SettingsRow
            label="Restore cancelled"
            help={`The folder it was writing (${restore.targetDir}) was removed. Nothing else changed.`}
            data-testid="backup-restore-cancelled"
            control={<SettingsButton onClick={dismiss} data-testid="backup-restore-dismiss">Done</SettingsButton>}
          />
        ) : restore.error ? (
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
              ? <>Walnut restarts with the restored copy in <code>{restore.targetDir}</code> as its data folder: tasks, notes and settings as they were in that backup. Your current data is moved beside it and renamed; nothing is deleted.</>
              : <>From its next start (quit Walnut and open it again) the restored copy in <code>{restore.targetDir}</code> becomes Walnut's data folder: tasks, notes and settings as they were in that backup. Your current data is moved beside it and renamed; nothing is deleted.</>}
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
            label={restore.source ? `Restored from ${restore.source}` : 'Restored'}
            wide
            data-testid="backup-restore-done"
            help={<>{(restore.doneFiles ?? 0).toLocaleString()} files ({fmtBytes(restore.doneBytes)}){restore.snapshotAt ? ` from the backup of ${whenOf(restore.snapshotAt)}` : ''}, all checked, in <code>{restore.targetDir}</code>. Nothing changes until you use them.</>}
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
      {switchDone && !pendingSwitch && !switchError && (confirmDeletePrevious ? (
        <SettingsRow label="Delete your data from before the restore?" state="warning" wide data-testid="backup-restore-delete-previous-confirm"
          help="Anything you changed after the restored backup was made is only in this folder. It is deleted from this computer for good; your backups stay as they are."
          error={deleteError ?? undefined}
          control={
            <span className="settings-inline-pair">
              <SettingsButton onClick={() => { setConfirmDeletePrevious(false); setDeleteError(null) }} data-testid="backup-restore-delete-previous-cancel">Cancel</SettingsButton>
              <SettingsButton variant="danger" className="backup-danger-button" onClick={() => void deletePrevious()} busy={deleting} busyLabel="Deleting..."
                data-testid="backup-restore-delete-previous-yes">Delete</SettingsButton>
            </span>
          } />
      ) : (
        <>
          <SettingsRow label="Now running on the restored data" wide data-testid="backup-restore-switch-done"
            help="Walnut uses the data restored from the backup. Your data from before is kept, untouched, until you delete it."
            control={
              <span className="settings-inline-pair">
                <SettingsButton onClick={cancelUse} data-testid="backup-restore-switch-done-dismiss">Keep it</SettingsButton>
                <SettingsButton onClick={() => setConfirmDeletePrevious(true)} data-testid="backup-restore-delete-previous">Delete it</SettingsButton>
              </span>
            } />
          <SettingsDisclosure id="backup-restore-previous-where" label="Where it is" data-testid="backup-restore-previous-where">
            <p className="settings-steps-note"><code>{switchDone.aside}</code></p>
          </SettingsDisclosure>
        </>
      ))}
      {deletedNote && !switchDone && (
        <SettingsRow label="Deleted" help="The data from before the restore is gone from this computer." data-testid="backup-restore-previous-deleted" />
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
