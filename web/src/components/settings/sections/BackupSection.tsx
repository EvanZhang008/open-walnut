/**
 * Settings → Backup.
 *
 * Three groups, in the order a person sets it up: where backups go (Cloudflare
 * R2, Google Drive or Amazon S3, each service's fields kept apart); the
 * recovery key; and the backups themselves (the automatic switch, how often,
 * the last backup, Back up now, Restore).
 *
 * Looking at another service never changes where backups go: a bucket is
 * saved by "Test and save" once its connection works, Google Drive once its
 * sign-in finishes. Only the switch and the interval save as they change.
 * People who set up the older unencrypted S3 copy keep that form until they
 * choose to switch.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Config } from '@open-walnut/core'
import { SectionCard } from '../inputs/SectionCard'
import { ToggleSwitch } from '../inputs/ToggleSwitch'
import { SettingsGroup, SettingsRow } from '../SettingsSection'
import { SettingsButton } from '../inputs/SettingsButton'
import { NumberInput } from '../inputs/NumberInput'
import { SegmentedControl } from '../inputs/SegmentedControl'
import { useSettingsAutoSave } from '../inputs/useSettingsAutoSave'
import { saveErrorMessage } from '../settings-pane-context'
import { formatAbsoluteTime } from './addons-format'
import { apiGet, apiPost } from '@/api/client'
import { fetchAwsProfiles } from '@/api/config'
import { useEvent } from '@/hooks/useWebSocket'
import {
  DESTINATIONS, DESTINATION_NOTE, MAX_INTERVAL_HOURS, destinationSummary, RETENTION_NOTE, blockedReason, buildBackupConfig, cleanDestination,
  engineOf, fieldProblem, fmtBytes, legacyToEncrypted, missingFields, othersAfterSwitch, sameDestination, secretNeedsRetyping, stableJson, testHelp,
  type BackupConfig, type BackupDestinationConfig, type BackupDestinationType, type DestinationTest,
} from './backup/backup-model'
import { R2Fields, S3Fields } from './backup/BucketFields'
import { DriveConnect } from './backup/DriveConnect'
import { LegacyS3Fields, type LegacyFields } from './backup/LegacyS3Fields'
import { RecoveryKeyGroup, type KeyState } from './backup/RecoveryKeyGroup'
import { RestorePanel, type RestoreStatus } from './backup/RestorePanel'
import '@/styles/settings-sections-addons.css'
import '@/styles/settings-backup.css'

interface Props {
  config: Config
  onSave: (partial: Partial<Config>) => Promise<void>
}

interface BackupStatus {
  configured: boolean
  running: boolean
  primary?: boolean
  engine?: 'mirror' | 'encrypted'
  destination?: string
  dataDir?: string
  machineName?: string
  pendingSwitch?: { restored: string; aside: string } | null
  canRestart?: boolean
  switchError?: string | null
  switchDone?: { restored: string; aside: string; at: string } | null
  notice?: string
  lastBackupAt?: string
  lastFileCount?: number
  lastTotalBytes?: number
  lastUploadedBytes?: number
  progress?: { uploadedBytes: number; totalBytes: number }
  consecutiveFailures: number
  error?: string
  errorCode?: string
  versioningEnabled?: boolean
  snapshotCount?: number
  /** The next backup runs at the next check (within a minute). */
  dueNow?: boolean
  restore?: RestoreStatus
}

type Drafts = Record<BackupDestinationType, BackupDestinationConfig>

// What was typed and not saved yet (a new service, or edits to a saved one), kept
// on this browser across a reload. Never a secret: a new one is typed again, a
// saved one stays masked.
const TYPED_KEY = 'walnut.backup.typed'
const withoutSecrets = (d: BackupDestinationConfig): BackupDestinationConfig => {
  const { secret_access_key: _s, client_secret: _c, ...rest } = d
  if (rest.auth) {
    const { aws_secret_access_key: _a, ...auth } = rest.auth
    return { ...rest, auth }
  }
  return rest
}
const readTyped = (): Partial<Drafts> => {
  try { return JSON.parse(localStorage.getItem(TYPED_KEY) ?? '{}') as Partial<Drafts> } catch { return {} }
}
const writeTyped = (t: Partial<Drafts>): void => {
  try { localStorage.setItem(TYPED_KEY, JSON.stringify(t)) } catch { /* private mode: nothing kept */ }
}

/** A saved destination with the edits typed over it; its masked keys stay. */
const withTyped = (d: BackupDestinationConfig, typed?: BackupDestinationConfig): BackupDestinationConfig =>
  typed ? { ...d, ...typed, ...(d.auth || typed.auth ? { auth: { ...d.auth, ...typed.auth } as BackupDestinationConfig['auth'] } : {}) } : d

const emptyDrafts = (saved?: BackupDestinationConfig, others: BackupDestinationConfig[] = []): Drafts => {
  const typed = readTyped()
  return {
    r2: { type: 'r2' },
    gdrive: { type: 'gdrive' },
    // A new S3 setup starts with keys: most people have no AWS sign-in on the computer.
    s3: { type: 's3', auth: { method: 'access_keys' } },
    ...typed,
    ...Object.fromEntries(others.map((o) => [o.type, withTyped(o, typed[o.type])])),
    ...(saved ? { [saved.type]: withTyped(saved, typed[saved.type]) } : {}),
  }
}

const TAB_KEY = 'walnut.backup.tab'
const readTab = (): BackupDestinationType | null => {
  try {
    const t = sessionStorage.getItem(TAB_KEY)
    return DESTINATIONS.some((d) => d.value === t) ? t as BackupDestinationType : null
  } catch { return null }
}
const writeTab = (t: BackupDestinationType): void => {
  try { sessionStorage.setItem(TAB_KEY, t) } catch { /* private mode: not kept */ }
}

const legacyOf = (b: BackupConfig): LegacyFields => ({ bucket: b.bucket, region: b.region, prefix: b.prefix, auth: b.auth })
/** A new, empty folder in the same bucket for backups that start over with a new key. */
const startOverPrefix = (d: BackupDestinationConfig): string =>
  `${(d.prefix || 'walnut-backup').replace(/-new-\d{4}-\d{2}-\d{2}$/, '')}-new-${new Date().toISOString().slice(0, 10)}`
const labelOf = (t: BackupDestinationType): string => DESTINATIONS.find((d) => d.value === t)?.label ?? t

export function BackupSection({ config, onSave }: Props) {
  const saved: BackupConfig = config.backup ?? {}
  const savedEngine = engineOf(saved)
  const savedDest = saved.destination
  const [enabled, setEnabled] = useState(saved.enabled ?? false)
  // Empty while the user retypes it; a save falls back to 24.
  const [intervalHours, setIntervalHours] = useState<number | undefined>(saved.interval_hours ?? 24)
  // Said after a value out of range was put back, until the next edit (never a silent change).
  const [intervalNote, setIntervalNote] = useState<string | null>(null)
  // A value out of range is shown as an error and never saved (no silent change to it).
  const intervalOk = Number.isInteger(Number(intervalHours)) && Number(intervalHours) >= 1 && Number(intervalHours) <= MAX_INTERVAL_HOURS
  const intervalToSave = intervalOk ? Number(intervalHours) : (saved.interval_hours ?? 24)
  const [legacyMode, setLegacyMode] = useState(savedEngine === 'mirror')
  const [legacy, setLegacy] = useState<LegacyFields>(legacyOf(saved))
  // The tab looked at stays across a reload of this window (a Google sign-in finishing, say).
  const [type, setType] = useState<BackupDestinationType>(() => readTab() ?? savedDest?.type ?? 'r2')
  const [drafts, setDrafts] = useState<Drafts>(() => emptyDrafts(savedDest, saved.other_destinations))
  const [profiles, setProfiles] = useState<string[]>([])
  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<DestinationTest | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [adopting, setAdopting] = useState(false)
  const [enablingVersioning, setEnablingVersioning] = useState(false)
  const [keyRefresh, setKeyRefresh] = useState(0)
  // null until read: not known is never said as "not connected" (no flash of Paused).
  const [driveConnected, setDriveConnected] = useState<boolean | null>(null)
  const driveOk = driveConnected !== false
  const [keyState, setKeyState] = useState<KeyState>({ hasKey: false, needsKey: false })
  // Read once the key group answered: before that nothing is said as missing or paused.
  const [keyKnown, setKeyKnown] = useState(false)
  // "Switch and restart" chosen: the pane waits for the page to load again.
  const [switchingNow, setSwitchingNow] = useState(false)

  // A config refresh re-seeds only what its SAVED value moved, so the refresh
  // after one field's save never wipes text typed meanwhile in another.
  const prevSaved = useRef(saved)
  // What the next write builds on: the saved section, or the last one this pane
  // wrote while its refresh is still on the way. Two writes in a row (I saved
  // it, then the switch) must not undo each other.
  const baseRef = useRef(saved)
  // Writes still on the way: the refresh after the first of two must not set the base back.
  const writesInFlight = useRef(0)
  useEffect(() => {
    const p = prevSaved.current
    prevSaved.current = saved
    if (p === saved) return
    if (writesInFlight.current === 0) baseRef.current = saved
    if ((p.enabled ?? false) !== (saved.enabled ?? false)) setEnabled(saved.enabled ?? false)
    if ((p.interval_hours ?? 24) !== (saved.interval_hours ?? 24)) setIntervalHours(saved.interval_hours ?? 24)
    if (stableJson(p.destination) !== stableJson(saved.destination) && saved.destination) {
      const d = saved.destination
      setDrafts((cur) => ({ ...cur, [d.type]: d }))
    }
    if (stableJson(legacyOf(p)) !== stableJson(legacyOf(saved))) setLegacy(legacyOf(saved))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config])

  const loadStatus = useCallback(() => {
    apiGet<BackupStatus>('/api/backup/status').then(setStatus).catch(() => {})
  }, [])
  // Drive's sign-in is read here too, whichever tab is open: whether backups can run must
  // never depend on the tab looked at (Drive in use, the R2 tab open after a reload).
  const loadDrive = useCallback(() => {
    apiGet<{ connected: boolean }>('/api/backup/gdrive/status').then((d) => setDriveConnected(d.connected)).catch(() => {})
  }, [])
  useEffect(() => { loadDrive() }, [loadDrive])
  useEvent('backup:gdrive', useCallback(() => loadDrive(), [loadDrive]))
  useEffect(() => {
    loadStatus()
    fetchAwsProfiles().then(setProfiles).catch(() => {})
  }, [loadStatus])

  // An event carries the whole health: a field the server cleared is absent, so
  // replace, keeping only what the status route alone adds.
  useEvent('backup:status', useCallback((data: unknown) => {
    setStatus((prev) => ({
      primary: prev?.primary, dataDir: prev?.dataDir, machineName: prev?.machineName,
      pendingSwitch: prev?.pendingSwitch, switchError: prev?.switchError, switchDone: prev?.switchDone, canRestart: prev?.canRestart, ...(data as BackupStatus),
    }))
  }, []))

  const draft = drafts[type]
  const draftIsSaved = !!savedDest && sameDestination(draft, savedDest)
  // This service as saved: in use, or kept for later.
  const keptOf = (t: BackupDestinationType): BackupDestinationConfig | undefined =>
    savedDest?.type === t ? savedDest : (saved.other_destinations ?? []).find((o) => o.type === t)
  const kept = keptOf(type)
  const draftIsKept = !!kept && sameDestination(draft, kept)
  const missing = missingFields(draft)
  const problem = fieldProblem(draft)
    ?? (secretNeedsRetyping(draft, [savedDest, ...(saved.other_destinations ?? [])].filter((d): d is BackupDestinationConfig => !!d))
      ? 'You changed where backups go, so type the secret key again.' : null)

  /**
   * The backup section to write, built on `base`. Until an encrypted destination
   * is saved, the older S3 copy keeps its fields (also after "Switch to
   * encrypted", which saves nothing by itself).
   */
  const compose = (base: BackupConfig, over: { enabled?: boolean; destination?: BackupDestinationConfig } = {}): BackupConfig => {
    const destination = over.destination ?? base.destination ?? null
    return buildBackupConfig(base, {
      enabled: over.enabled ?? enabled,
      intervalHours: intervalToSave,
      destination,
      legacy: destination ? undefined : legacyMode ? legacy : engineOf(base) === 'mirror' ? legacyOf(base) : undefined,
    })
  }
  const writeBackup = async (next: BackupConfig) => {
    const before = baseRef.current
    baseRef.current = next
    writesInFlight.current++
    try {
      await onSave({ backup: next } as Partial<Config>)
    } catch (err) {
      // Not saved: the next write must not carry it (a destination the user never got).
      if (baseRef.current === next) baseRef.current = before
      throw err
    } finally {
      writesInFlight.current--
    }
  }

  // Autosave covers the interval (and the legacy form, as before); the switch saves at once.
  const form = (): BackupConfig => compose(saved)
  const baseline = (): BackupConfig => buildBackupConfig(saved, {
    enabled: saved.enabled ?? false,
    intervalHours: saved.interval_hours ?? 24,
    destination: savedDest ?? null,
    legacy: savedEngine === 'mirror' && !savedDest ? legacyOf(saved) : undefined,
  })
  const handleSave = async () => {
    await writeBackup(compose(baseRef.current))
  }
  useSettingsAutoSave({ current: stableJson(form()), baseline: stableJson(baseline()), save: handleSave })

  const setAutomatic = (on: boolean) => {
    setEnabled(on)
    writeBackup(compose(baseRef.current, { enabled: on })).catch(() => setEnabled(!on))
  }

  /** Where backups go from now on: saved on purpose, never by looking at a tab. */
  const saveDestination = async (d: BackupDestinationConfig) => {
    // Never a destination that cannot run: the summary would say "in use" while nothing backs up.
    const lacks = missingFields(d)
    if (lacks.length > 0) throw new Error(`Fill in: ${lacks.join(', ')}.`)
    const base = baseRef.current
    await writeBackup({ ...compose(base, { destination: d }), other_destinations: othersAfterSwitch(base, d) })
    const typed = readTyped()
    delete typed[d.type]
    writeTyped(typed)
    setLegacyMode(false)
    setEditing(false)
    setKeyRefresh((n) => n + 1)
    loadStatus()
  }

  const setDest = (next: BackupDestinationConfig) => {
    setDrafts((cur) => ({ ...cur, [next.type]: next }))
    const base = baseRef.current
    const savedOne = base.destination?.type === next.type ? base.destination : (base.other_destinations ?? []).find((o) => o.type === next.type)
    const typed = readTyped()
    if (savedOne && sameDestination(next, savedOne)) delete typed[next.type]
    else typed[next.type] = withoutSecrets(next)
    writeTyped(typed)
    setTestResult(null)
  }
  const pickType = (t: BackupDestinationType) => {
    setType(t)
    writeTab(t)
    setEditing(!!keptOf(t) && !!readTyped()[t])
    setTestResult(null)
  }
  /** Back to the saved settings: what was typed since goes. */
  const cancelEdit = () => {
    if (!kept) return
    setDrafts((cur) => ({ ...cur, [type]: kept }))
    const typed = readTyped()
    delete typed[type]
    writeTyped(typed)
    setEditing(false)
    setTestResult(null)
  }

  /** `confirmed`: the person chose to use a folder whose backups were made with another key. */
  const handleTest = async (confirmed = false) => {
    setTesting(true)
    setTestResult(null)
    try {
      if (legacyMode) {
        setTestResult(await apiPost<DestinationTest>('/api/backup/test', form(), { timeoutMs: 45000 }))
        return
      }
      const r = await apiPost<DestinationTest>('/api/backup/destination/test', { destination: draft }, { timeoutMs: 45000 })
      if (r.ok && !draftIsSaved) {
        // Backups that would stop (they cannot open this folder's backups) are asked about, never switched silently.
        // A computer with no key of its own (a new one) has nothing to pause: it goes straight on, then asks for the key.
        if (r.hasBackups && r.keyMatches === false && r.hasKey && !confirmed) {
          setTestResult({ ...r, askOtherKey: true })
          return
        }
        await saveDestination(cleanDestination(draft))
        setTestResult({ ...r, savedNow: true })
      } else {
        setTestResult(r)
      }
    } catch (err) {
      setTestResult({ ok: false, error: saveErrorMessage(err) })
    } finally {
      setTesting(false)
    }
  }

  const [runStarting, setRunStarting] = useState(false)
  // The saved bucket's fields, folded to one line until "Edit" (open again after a reload with edits not saved).
  const [editing, setEditing] = useState(() => {
    const t = readTab() ?? savedDest?.type ?? 'r2'
    return !!readTyped()[t] && (savedDest?.type === t || (saved.other_destinations ?? []).some((o) => o.type === t))
  })
  const handleRunNow = async () => {
    if (runStarting || status?.running || justDone) return
    setRunError(null)
    setRunStarting(true)
    try {
      // The server answers 202 (a run already going is joined); progress and the result arrive as backup:status events.
      await apiPost('/api/backup/run', {})
      setStatus((prev) => (prev ? { ...prev, running: true } : prev))
    } catch (err) {
      setRunError(saveErrorMessage(err))
    } finally {
      setRunStarting(false)
    }
  }
  // A run that just finished says so for a moment, and a second click in that moment
  // (the second half of a double click on a fast backup) makes no second backup.
  const [justDone, setJustDone] = useState(false)
  const wasRunning = useRef(false)
  useEffect(() => {
    const running = status?.running === true
    if (wasRunning.current && !running && !status?.error) {
      setJustDone(true)
      const t = setTimeout(() => setJustDone(false), 3000)
      wasRunning.current = running
      return () => clearTimeout(t)
    }
    wasRunning.current = running
  }, [status?.running, status?.error])
  // A refusal belongs to the click that got it: the next run, or a finished one, clears it.
  useEffect(() => {
    if (status?.running || status?.lastBackupAt) setRunError(null)
  }, [status?.running, status?.lastBackupAt])

  const [confirmAdopt, setConfirmAdopt] = useState(false)
  const handleAdopt = async () => {
    setAdopting(true)
    try {
      await apiPost('/api/backup/adopt', {}, { timeoutMs: 45000 })
      setRunError(null)
      setConfirmAdopt(false)
    } catch (err) {
      setRunError(saveErrorMessage(err))
    } finally {
      setAdopting(false)
    }
  }

  const handleEnableVersioning = async () => {
    setEnablingVersioning(true)
    try {
      await apiPost('/api/backup/enable-versioning', form(), { timeoutMs: 45000 })
      setStatus((prev) => (prev ? { ...prev, versioningEnabled: true } : prev))
      setTestResult((prev) => (prev ? { ...prev, versioningEnabled: true } : prev))
    } catch (err) {
      setRunError(saveErrorMessage(err))
    } finally {
      setEnablingVersioning(false)
    }
  }

  const switchToEncrypted = () => {
    setDrafts((cur) => ({ ...cur, s3: legacyToEncrypted(saved) }))
    setType('s3'); writeTab('s3')
    setLegacyMode(false)
    setTestResult(null)
  }

  /** "I saved it": on a first setup it also turns backups on (the key was seen before the first upload). */
  const markKeySaved = (turnOn = false) => {
    if (turnOn) setEnabled(true)
    writeBackup({ ...compose(baseRef.current, turnOn ? { enabled: true } : {}), recovery_key_saved_at: new Date().toISOString() })
      .catch(() => { if (turnOn) setEnabled(false) })
  }

  // Drive is saved as the destination once its sign-in finishes (on this tab, so on purpose).
  const draftsRef = useRef(drafts)
  draftsRef.current = drafts
  const saveRef = useRef(saveDestination)
  saveRef.current = saveDestination
  // Drive's sign-in makes it the destination only when nothing else is in use;
  // otherwise "Use Google Drive" is the step that moves the backups.
  const onDriveConnected = useCallback(() => {
    setDriveConnected(true)
    const d = draftsRef.current.gdrive
    const current = baseRef.current.destination
    if (!current || (current.type === 'gdrive' && !sameDestination(d, current))) void saveRef.current(cleanDestination(d)).catch(() => {})
    else setKeyRefresh((n) => n + 1)
  }, [])

  const otherWriter = !legacyMode && status?.errorCode === 'other_writer'
  const keyMismatch = !legacyMode && status?.errorCode === 'key_mismatch'
  const destReady = !legacyMode && !!savedDest && missingFields(savedDest).length === 0 && (savedDest.type !== 'gdrive' || driveOk)
  const blocked = blockedReason({
    legacyMode,
    legacyBucket: legacy.bucket,
    saved: savedDest,
    driveConnected: driveOk,
    needsKey: keyState.needsKey || keyMismatch,
    hasKey: keyState.hasKey,
    keySaved: Boolean(saved.recovery_key_saved_at),
  })
  // Nothing leaves this computer before the user has the key that opens it (the server holds to it too).
  const keyUnsaved = !legacyMode && keyState.hasKey && !saved.recovery_key_saved_at
  const runBlocked = blocked ?? (otherWriter ? 'Another computer writes these backups. Move them to this computer first.' : null)

  const progressPct = status?.progress && status.progress.totalBytes > 0
    ? Math.floor((status.progress.uploadedBytes / status.progress.totalBytes) * 100)
    : null
  const lastBackupHelp = status?.running
    ? progressPct !== null ? `Backing up: ${progressPct}% of ${fmtBytes(status.progress?.totalBytes)}` : 'Backing up...'
    : status?.lastBackupAt
      ? [
          formatAbsoluteTime(status.lastBackupAt),
          `${(status.lastFileCount ?? 0).toLocaleString()} files`,
          fmtBytes(status.lastTotalBytes),
          ...(!legacyMode && status.snapshotCount ? [`${status.snapshotCount} backup${status.snapshotCount === 1 ? '' : 's'} kept`] : []),
        ].join(', ') + (enabled && !runBlocked
          // When the next one runs, so a switch of service never leaves the user guessing.
          ? (status.error ? '' : status.dueNow ? '. Next: within a minute.' : `. Next: ${formatAbsoluteTime(new Date(Math.max(Date.now() + 60_000, Date.parse(status.lastBackupAt) + Math.max(1, saved.interval_hours ?? 24) * 3_600_000)).toISOString())}.`)
          : '')
      : otherWriter ? 'Another computer writes these backups. Move them to this computer first.'
        : keyUnsaved ? 'No backup yet. It can start once the recovery key is saved.'
          : !blocked && enabled ? 'No backup yet. The first one starts within a minute.' : 'No backup yet.'
  const versioningOff = legacyMode && ((testResult?.ok && testResult.versioningEnabled === false) || (status?.configured && status.versioningEnabled === false))
  const lastError = otherWriter || keyMismatch ? null : (status?.error ? `Last backup failed: ${status.error}` : runError)
  const inUse = savedDest ? labelOf(savedDest.type) : null
  // Until the status and the key are read, the rows say so, never a failure that is not there.
  const onKeyState = useCallback((k: KeyState) => { setKeyState(k); setKeyKnown(true) }, [])
  const loading = !status || (!legacyMode && !!savedDest && !keyKnown)
  const lastHelp = loading ? 'Checking...' : status?.notice
    // The first row of the group says why nothing can run yet; this one does not repeat it.
    ?? (runBlocked && !status?.running && !status?.lastBackupAt ? (blocked ? 'No backup yet.' : `No backup yet. ${runBlocked}`)
      : inUse && !legacyMode && !status?.running ? `${inUse}: ${lastBackupHelp}` : lastBackupHelp)
  const serviceHelp = !inUse
    ? 'Pick one, then connect it.'
    : savedDest!.type === type
      ? `In use: backups go to ${inUse}.`
      : `In use: ${inUse}.`

  // Keys that are not AWS keys (AKIA.../ASIA...) sent to AWS: most likely MinIO or B2 without its endpoint.
  const endpointHint = type === 's3' && testResult && !testResult.ok && !(draft.endpoint ?? '').trim()
    && !/^(AKIA|ASIA)/.test((draft.auth?.aws_access_key_id ?? draft.access_key_id ?? '').trim())
    ? ' Using MinIO or Backblaze B2? Set its endpoint under Advanced.' : ''
  const connectionHelp = (): string => {
    if (legacyMode) return testHelp(testResult, true)
    if (missing.length > 0) return `Fill in: ${missing.join(', ')}.`
    if (problem) return problem
    if (testResult && !testResult.ok && savedDest?.type === type && !draftIsSaved) {
      return `${testHelp(testResult, false)}${endpointHint} Nothing was saved: backups still use the settings that worked.`
    }
    if (testResult) return `${testHelp(testResult, false)}${endpointHint}`
    if (draftIsSaved) return 'Backups go here. Test again any time.'
    // Edits to a saved service (kept across a reload) are said to be edits, not saved settings.
    if (kept && !draftIsKept) return `Edited, not saved yet. "${savedDest?.type === type ? 'Test and save' : `Use ${labelOf(type)}`}" checks and saves it; Cancel goes back to the saved settings.`
    return savedDest && savedDest.type !== type
      ? `Not in use now. "Use ${labelOf(type)}" checks it first, then backups go here instead of ${labelOf(savedDest.type)}.`
      : '"Test and save" writes, reads back and deletes a small test file, then backups go here.'
  }

  return (
    <SectionCard id="backup" title="Backup" onSave={handleSave} showSave={false}>
      {/* While Walnut restarts into restored data, the rest of the pane is out of reach. */}
      <div className={switchingNow ? 'backup-contents backup-restarting' : 'backup-contents'} data-testid="backup-pane">
      <SettingsGroup
        heading="Where backups go"
        footer={legacyMode ? undefined : DESTINATION_NOTE[type]}
        data-testid="backup-destination-group"
      >
        {legacyMode ? (
          <LegacyS3Fields value={legacy} onChange={setLegacy} profiles={profiles} onSwitch={switchToEncrypted} />
        ) : (
          <>
            <SettingsRow
              label="Service"
              help={serviceHelp}
              data-testid="backup-service-row"
              control={
                <SegmentedControl
                  id="backup-service"
                  aria-label="Backup service"
                  value={type}
                  onChange={pickType}
                  options={DESTINATIONS.map((d) => ({
                    value: d.value, label: d.label, testId: `backup-service-${d.value}`,
                    // The service backups go to now carries a mark, whichever tab is open.
                    ...(savedDest?.type === d.value && !legacyMode ? { className: 'backup-service-in-use', title: 'In use: backups go here' } : {}),
                  }))}
                />
              }
            />
            {savedEngine === 'mirror' && !savedDest && (
              <SettingsRow
                state="warning"
                label="The older S3 copy keeps running"
                help={'Until this one is tested and saved, files still go to the old bucket unencrypted.'}
                data-testid="backup-legacy-pending"
                control={<SettingsButton onClick={() => { setLegacyMode(true); setTestResult(null) }} data-testid="backup-legacy-back">Back to it</SettingsButton>}
              />
            )}
            {type !== 'gdrive' && kept && draftIsKept && missing.length === 0 && !editing ? (
              // Connected before: one line, so the key and the backups stay in view.
              <SettingsRow
                label="Saved settings"
                help={destinationSummary(kept, savedDest?.type === type)}
                data-testid="backup-dest-summary"
                control={<SettingsButton onClick={() => setEditing(true)} data-testid="backup-dest-edit">Edit</SettingsButton>}
              />
            ) : (
              <>
                {type === 'r2' && <R2Fields dest={draft} onChange={setDest} profiles={profiles} />}
                {type === 's3' && <S3Fields dest={draft} onChange={setDest} profiles={profiles} />}
              </>
            )}
            {type === 'gdrive' && (
              <DriveConnect
                dest={draft}
                onChange={setDest}
                inUse={savedDest?.type === 'gdrive'}
                otherInUse={savedDest && savedDest.type !== 'gdrive' ? labelOf(savedDest.type) : null}
                onConnected={onDriveConnected}
                onUse={() => void saveDestination(cleanDestination(draft)).catch(() => {})}
                onConnectedChange={setDriveConnected}
              />
            )}
          </>
        )}
        {(legacyMode || type !== 'gdrive') && (
          <SettingsRow
            label="Connection"
            state={testResult?.askOtherKey ? 'warning' : undefined}
            help={(testResult && !testResult.ok) || (!legacyMode && missing.length === 0 && problem) ? undefined : connectionHelp()}
            error={(testResult && !testResult.ok) || (!legacyMode && missing.length === 0 && problem) ? connectionHelp() : undefined}
            data-testid="backup-connection-row"
            control={
              <span className="settings-inline-pair">
                {!legacyMode && kept && (editing || !draftIsKept) && (
                  <SettingsButton onClick={cancelEdit} data-testid="backup-dest-cancel">Cancel</SettingsButton>
                )}
                <SettingsButton onClick={() => void handleTest(Boolean(testResult?.askOtherKey))} busy={testing} busyLabel="Testing..." data-testid="backup-test-connection"
                  variant={!legacyMode && !draftIsSaved && missing.length === 0 && !problem ? 'primary' : undefined}
                  disabled={legacyMode ? !legacy.bucket?.trim() : missing.length > 0 || !!problem}
                  // Disabled, it says why (the same words the row shows once something is typed).
                  title={legacyMode ? (legacy.bucket?.trim() ? undefined : 'Fill in the bucket first.')
                    : missing.length > 0 ? `Fill in ${missing.join(', ')} first.` : problem ?? undefined}>
                  {testResult?.askOtherKey ? 'Use this folder'
                    : legacyMode || draftIsSaved ? 'Test connection' : savedDest && savedDest.type !== type ? `Use ${labelOf(type)}` : 'Test and save'}
                </SettingsButton>
              </span>
            }
          />
        )}
        {versioningOff && (
          <SettingsRow
            state="warning"
            label="Bucket versioning is off"
            help="A deleted or overwritten backup can't be recovered."
            data-testid="backup-versioning-off"
            control={<SettingsButton onClick={handleEnableVersioning} busy={enablingVersioning} busyLabel="Enabling...">Enable versioning</SettingsButton>}
          />
        )}
      </SettingsGroup>

      {!legacyMode && savedDest && (
        <RecoveryKeyGroup
          dest={savedDest}
          destinationLabel={labelOf(savedDest.type)}
          ready={destReady}
          mismatch={keyMismatch}
          savedAt={saved.recovery_key_saved_at}
          firstSetup={!saved.enabled}
          machineName={status?.machineName}
          onMarkSaved={markKeySaved}
          onState={onKeyState}
          refreshToken={keyRefresh}
          onStartOver={savedDest.type === 'gdrive' ? undefined : () => saveDestination({ ...savedDest, prefix: startOverPrefix(savedDest) })}
          startOverWhere={savedDest.type === 'gdrive' ? undefined : `the folder "${startOverPrefix(savedDest)}" in ${savedDest.bucket}`}
        />
      )}

      <SettingsGroup
        heading="Backups"
        data-testid="backup-backups-group"
        footer={legacyMode
          // The older copy sends files as they are: credentials included, readable by whoever reads the bucket.
          ? <>What gets backed up: everything in your data folder, credentials (<code>auth.json</code>) included, so use a bucket only you can access.</>
          : <>Your whole data folder is backed up, except caches, search indexes, Git sync's history and health data.</>
        }
      >
        {/* The one place that says why nothing can run yet; the rows below are greyed with it. */}
        <SettingsRow
          label="Back up automatically"
          htmlFor="backup-enabled"
          help={loading ? 'Checking...' : blocked
            ? (enabled ? `Paused: ${blocked}` : blocked)
            : !enabled ? 'Off: backups run only when you choose Back up now.'
              : legacyMode ? 'Only changed files upload after the first run.' : 'Encrypted on this computer first. After the first backup only changes upload.'}
          state={blocked && enabled && !loading ? 'warning' : undefined}
          data-testid="backup-enabled-row"
          // On but paused (the reason is the help): the switch reads as paused too, not plainly on.
          control={<span className={enabled && blocked && !loading ? 'backup-toggle-paused' : undefined}><ToggleSwitch id="backup-enabled" checked={enabled} onChange={setAutomatic} disabled={!!blocked && !enabled} /></span>}
        />
        <SettingsRow
          label="Every"
          htmlFor="backup-interval"
          help={!enabled ? 'Turn on Back up automatically to choose how often.'
            : legacyMode ? `1 to ${MAX_INTERVAL_HOURS} hours.` : `1 to ${MAX_INTERVAL_HOURS} hours. ${RETENTION_NOTE}`}
          error={intervalOk ? (intervalNote ?? undefined) : `Enter whole hours from 1 to ${MAX_INTERVAL_HOURS}. Backups keep running every ${saved.interval_hours ?? 24} hours until then.`}
          data-testid="backup-interval-row"
          disabled={!enabled}
          control={
            <NumberInput id="backup-interval" min={1} max={MAX_INTERVAL_HOURS} unit="hours" value={intervalHours}
              onChange={(v) => { setIntervalHours(v); setIntervalNote(null) }} disabled={!enabled}
              // Back in the field (even to type the same number again), the old note has done its job.
              onFocus={() => setIntervalNote(null)}
              // A value never saved does not stay on screen: leaving the field shows the one in use again, and says so.
              onBlur={() => {
                if (intervalOk) { setIntervalNote(null); return }
                const kept = saved.interval_hours ?? 24
                setIntervalNote(`Enter 1 to ${MAX_INTERVAL_HOURS} hours: kept ${kept} hours.`)
                setIntervalHours(kept)
              }} />
          }
        />
        {otherWriter && (confirmAdopt ? (
          <SettingsRow
            state="warning"
            label="Back up this computer from now on?"
            help={`${inUse ?? 'This service'} then takes this computer's backups, the first within a minute. The other computer stops backing up there; the backups already there stay.`}
            error={runError ?? undefined}
            data-testid="backup-adopt-confirm"
            control={
              <span className="settings-inline-pair">
                <SettingsButton onClick={() => { setConfirmAdopt(false); setRunError(null) }} data-testid="backup-adopt-cancel">Cancel</SettingsButton>
                <SettingsButton variant="primary" onClick={() => void handleAdopt()} busy={adopting} busyLabel="Moving..." data-testid="backup-adopt-yes">Back up this computer</SettingsButton>
              </span>
            }
          />
        ) : (
          <SettingsRow
            state="warning"
            label="Another computer writes these backups"
            help={status?.error ?? undefined}
            data-testid="backup-other-writer"
            control={<SettingsButton onClick={() => setConfirmAdopt(true)} data-testid="backup-adopt">Back up this computer</SettingsButton>}
          />
        ))}
        <SettingsRow
          label="Last backup"
          help={justDone && !lastError ? `Backed up just now. ${lastHelp}` : lastHelp}
          error={lastError ?? undefined}
          data-testid="backup-last-row"
          control={status?.running && progressPct !== null ? (
            // A run under way shows its progress the way a restore does.
            <span className="settings-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPct} data-testid="backup-run-progress">
              <span className="settings-progress-track"><span className="settings-progress-fill" style={{ width: `${progressPct}%` }} /></span>
              <span className="settings-progress-pct">{progressPct}%</span>
            </span>
          ) : (
            <SettingsButton onClick={handleRunNow} disabled={!!runBlocked || justDone} busy={status?.running === true || runStarting} busyLabel="Backing up..."
              title={runBlocked ?? undefined}
              reserve={['Back up now', 'Backed up']} data-testid="backup-run-now">
              {justDone ? 'Backed up' : 'Back up now'}
            </SettingsButton>
          )}
        />
        <RestorePanel
          dest={legacyMode ? null : savedDest ?? null}
          destLabel={inUse ?? undefined}
          others={legacyMode ? [] : (saved.other_destinations ?? [])
            .filter((o) => missingFields(o).length === 0 && (o.type !== 'gdrive' || driveConnected === true))
            .map((o) => ({ label: labelOf(o.type), dest: o }))}
          restore={status?.restore}
          dataDir={status?.dataDir}
          blocked={!!blocked}
          blockedWhy={loading ? undefined : (blocked ?? undefined)}
          pendingSwitch={status?.pendingSwitch}
          switchError={status?.switchError}
          switchDone={status?.switchDone}
          onSwitchChanged={loadStatus}
          canRestart={status?.canRestart}
          onRestarting={setSwitchingNow}
        />
      </SettingsGroup>
      </div>
    </SectionCard>
  )
}
