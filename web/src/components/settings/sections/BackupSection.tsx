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
  DESTINATIONS, DESTINATION_NOTE, MAX_INTERVAL_HOURS, RETENTION_NOTE, blockedReason, buildBackupConfig, cleanDestination,
  engineOf, fmtBytes, legacyToEncrypted, missingFields, othersAfterSwitch, sameDestination, stableJson, testHelp,
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
  restore?: RestoreStatus
}

type Drafts = Record<BackupDestinationType, BackupDestinationConfig>

const emptyDrafts = (saved?: BackupDestinationConfig, others: BackupDestinationConfig[] = []): Drafts => ({
  r2: { type: 'r2' },
  gdrive: { type: 'gdrive' },
  s3: { type: 's3', auth: { method: 'aws_chain' } },
  ...Object.fromEntries(others.map((o) => [o.type, o])),
  ...(saved ? { [saved.type]: saved } : {}),
})

const legacyOf = (b: BackupConfig): LegacyFields => ({ bucket: b.bucket, region: b.region, prefix: b.prefix, auth: b.auth })
const labelOf = (t: BackupDestinationType): string => DESTINATIONS.find((d) => d.value === t)?.label ?? t

export function BackupSection({ config, onSave }: Props) {
  const saved: BackupConfig = config.backup ?? {}
  const savedEngine = engineOf(saved)
  const savedDest = saved.destination
  const [enabled, setEnabled] = useState(saved.enabled ?? false)
  // Empty while the user retypes it; a save falls back to 24.
  const [intervalHours, setIntervalHours] = useState<number | undefined>(saved.interval_hours ?? 24)
  const [legacyMode, setLegacyMode] = useState(savedEngine === 'mirror')
  const [legacy, setLegacy] = useState<LegacyFields>(legacyOf(saved))
  const [type, setType] = useState<BackupDestinationType>(savedDest?.type ?? 'r2')
  const [drafts, setDrafts] = useState<Drafts>(() => emptyDrafts(savedDest, saved.other_destinations))
  const [profiles, setProfiles] = useState<string[]>([])
  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<DestinationTest | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [adopting, setAdopting] = useState(false)
  const [enablingVersioning, setEnablingVersioning] = useState(false)
  const [keyRefresh, setKeyRefresh] = useState(0)
  const [driveConnected, setDriveConnected] = useState(false)
  const [keyState, setKeyState] = useState<KeyState>({ hasKey: false, needsKey: false })

  // A config refresh re-seeds only what its SAVED value moved, so the refresh
  // after one field's save never wipes text typed meanwhile in another.
  const prevSaved = useRef(saved)
  // What the next write builds on: the saved section, or the last one this pane
  // wrote while its refresh is still on the way. Two writes in a row (I saved
  // it, then the switch) must not undo each other.
  const baseRef = useRef(saved)
  useEffect(() => {
    const p = prevSaved.current
    prevSaved.current = saved
    if (p === saved) return
    baseRef.current = saved
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
  useEffect(() => {
    loadStatus()
    fetchAwsProfiles().then(setProfiles).catch(() => {})
  }, [loadStatus])

  // An event carries the whole health: a field the server cleared is absent, so
  // replace, keeping only what the status route alone adds.
  useEvent('backup:status', useCallback((data: unknown) => {
    setStatus((prev) => ({ primary: prev?.primary, dataDir: prev?.dataDir, machineName: prev?.machineName, ...(data as BackupStatus) }))
  }, []))

  const draft = drafts[type]
  const draftIsSaved = !!savedDest && sameDestination(draft, savedDest)
  const missing = missingFields(draft)

  /**
   * The backup section to write, built on `base`. Until an encrypted destination
   * is saved, the older S3 copy keeps its fields (also after "Switch to
   * encrypted", which saves nothing by itself).
   */
  const compose = (base: BackupConfig, over: { enabled?: boolean; destination?: BackupDestinationConfig } = {}): BackupConfig => {
    const destination = over.destination ?? base.destination ?? null
    return buildBackupConfig(base, {
      enabled: over.enabled ?? enabled,
      intervalHours,
      destination,
      legacy: destination ? undefined : legacyMode ? legacy : engineOf(base) === 'mirror' ? legacyOf(base) : undefined,
    })
  }
  const writeBackup = async (next: BackupConfig) => {
    baseRef.current = next
    await onSave({ backup: next } as Partial<Config>)
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
    void writeBackup(compose(baseRef.current, { enabled: on }))
  }

  /** Where backups go from now on: saved on purpose, never by looking at a tab. */
  const saveDestination = async (d: BackupDestinationConfig) => {
    const base = baseRef.current
    await writeBackup({ ...compose(base, { destination: d }), other_destinations: othersAfterSwitch(base, d) })
    setLegacyMode(false)
    setKeyRefresh((n) => n + 1)
    loadStatus()
  }

  const setDest = (next: BackupDestinationConfig) => {
    setDrafts((cur) => ({ ...cur, [next.type]: next }))
    setTestResult(null)
  }
  const pickType = (t: BackupDestinationType) => {
    setType(t)
    setTestResult(null)
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      if (legacyMode) {
        setTestResult(await apiPost<DestinationTest>('/api/backup/test', form(), { timeoutMs: 45000 }))
        return
      }
      const r = await apiPost<DestinationTest>('/api/backup/destination/test', { destination: draft }, { timeoutMs: 45000 })
      if (r.ok && !draftIsSaved) {
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

  const handleRunNow = async () => {
    setRunError(null)
    try {
      // The server answers 202; progress and the result arrive as backup:status events.
      await apiPost('/api/backup/run', {})
      setStatus((prev) => (prev ? { ...prev, running: true } : prev))
    } catch (err) {
      setRunError(saveErrorMessage(err))
    }
  }

  const handleAdopt = async () => {
    setAdopting(true)
    try {
      await apiPost('/api/backup/adopt', {}, { timeoutMs: 45000 })
      setRunError(null)
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
    setType('s3')
    setLegacyMode(false)
    setTestResult(null)
  }

  /** "I saved it": on a first setup it also turns backups on (the key was seen before the first upload). */
  const markKeySaved = (turnOn = false) => {
    if (turnOn) setEnabled(true)
    void writeBackup({ ...compose(baseRef.current, turnOn ? { enabled: true } : {}), recovery_key_saved_at: new Date().toISOString() })
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
    if (!current || (current.type === 'gdrive' && !sameDestination(d, current))) void saveRef.current(cleanDestination(d))
    else setKeyRefresh((n) => n + 1)
  }, [])

  const otherWriter = !legacyMode && status?.errorCode === 'other_writer'
  const keyMismatch = !legacyMode && status?.errorCode === 'key_mismatch'
  const destReady = !legacyMode && !!savedDest && missingFields(savedDest).length === 0 && (savedDest.type !== 'gdrive' || driveConnected)
  const blocked = blockedReason({
    legacyMode,
    legacyBucket: legacy.bucket,
    saved: savedDest,
    driveConnected,
    needsKey: keyState.needsKey || keyMismatch,
    hasKey: keyState.hasKey,
  })
  const runBlocked = blocked ?? (otherWriter ? 'Another computer writes these backups. Move them here above first.' : null)

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
          ...(!legacyMode && status.snapshotCount ? [`${status.snapshotCount} kept`] : []),
        ].join(', ')
      : otherWriter ? 'Another computer writes these backups. Move them here above first.'
        : !blocked && enabled ? 'No backup yet. The first one starts within a minute.' : 'No backup yet.'
  const versioningOff = legacyMode && ((testResult?.ok && testResult.versioningEnabled === false) || (status?.configured && status.versioningEnabled === false))
  const lastError = otherWriter || keyMismatch ? null : (status?.error ? `Last backup failed: ${status.error}` : runError)
  const inUse = savedDest ? labelOf(savedDest.type) : null
  const lastHelp = status?.notice ?? (inUse && !legacyMode && !status?.running ? `${inUse}: ${lastBackupHelp}` : lastBackupHelp)
  const serviceHelp = !inUse
    ? 'Pick one, then connect it.'
    : savedDest!.type === type
      ? `In use: backups go to ${inUse}.`
      : `In use: ${inUse}.`

  const connectionHelp = (): string => {
    if (legacyMode) return testHelp(testResult, true)
    if (missing.length > 0) return `Fill in: ${missing.join(', ')}.`
    if (testResult) return testHelp(testResult, false)
    if (draftIsSaved) return 'Backups go here. Test again any time.'
    return savedDest
      ? `Not used yet. "Test and save" checks it, then backups go here instead of ${labelOf(savedDest.type)}.`
      : '"Test and save" writes, reads back and deletes a small test file, then backups go here.'
  }

  return (
    <SectionCard id="backup" title="Backup" onSave={handleSave} showSave={false}>
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
                  options={DESTINATIONS.map((d) => ({ value: d.value, label: d.label, testId: `backup-service-${d.value}` }))}
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
            {type === 'r2' && <R2Fields dest={draft} onChange={setDest} profiles={profiles} />}
            {type === 's3' && <S3Fields dest={draft} onChange={setDest} profiles={profiles} />}
            {type === 'gdrive' && (
              <DriveConnect
                dest={draft}
                onChange={setDest}
                inUse={savedDest?.type === 'gdrive'}
                otherInUse={savedDest && savedDest.type !== 'gdrive' ? labelOf(savedDest.type) : null}
                onConnected={onDriveConnected}
                onUse={() => void saveDestination(cleanDestination(draft))}
                onConnectedChange={setDriveConnected}
              />
            )}
          </>
        )}
        {(legacyMode || type !== 'gdrive') && (
          <SettingsRow
            label="Connection"
            help={testResult && !testResult.ok ? undefined : connectionHelp()}
            error={testResult && !testResult.ok ? connectionHelp() : undefined}
            data-testid="backup-connection-row"
            control={
              <SettingsButton onClick={handleTest} busy={testing} busyLabel="Testing..." data-testid="backup-test-connection"
                variant={!legacyMode && !draftIsSaved && missing.length === 0 ? 'primary' : undefined}
                disabled={legacyMode ? !legacy.bucket?.trim() : missing.length > 0}>
                {legacyMode || draftIsSaved ? 'Test connection' : 'Test and save'}
              </SettingsButton>
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
          onState={setKeyState}
          refreshToken={keyRefresh}
        />
      )}

      <SettingsGroup
        heading="Backups"
        data-testid="backup-backups-group"
        footer={
          <>
            Everything in your data folder is backed up (notes, tasks, passwords, sign-ins); caches and search indexes are skipped.
            {' '}Also from a terminal: <code>open-walnut backup restore</code>, or the{' '}
            <a href="https://github.com/EvanZhang008/open-walnut/blob/main/skills/restore-backup/SKILL.md" target="_blank" rel="noreferrer">
              restore-backup skill
            </a>{' '}
            in a Claude Code session on a new computer.
          </>
        }
      >
        {/* The one place that says why nothing can run yet; the rows below are greyed with it. */}
        <SettingsRow
          label="Back up automatically"
          htmlFor="backup-enabled"
          help={blocked
            ? (enabled ? `Paused: ${blocked}` : blocked)
            : legacyMode ? 'Only changed files upload after the first run.' : 'Encrypted on this computer first. After the first backup only changes upload.'}
          data-testid="backup-enabled-row"
          control={<ToggleSwitch id="backup-enabled" checked={enabled} onChange={setAutomatic} disabled={!!blocked && !enabled} />}
        />
        <SettingsRow
          label="Every"
          htmlFor="backup-interval"
          help={legacyMode ? `1 to ${MAX_INTERVAL_HOURS} hours.` : `1 to ${MAX_INTERVAL_HOURS} hours. ${RETENTION_NOTE}`}
          control={
            <NumberInput id="backup-interval" min={1} max={MAX_INTERVAL_HOURS} unit="hours" value={intervalHours} onChange={setIntervalHours}
              onBlur={() => {
                const n = Number(intervalHours)
                setIntervalHours(Number.isFinite(n) && n >= 1 ? Math.min(MAX_INTERVAL_HOURS, Math.round(n)) : (saved.interval_hours ?? 24))
              }} />
          }
        />
        {otherWriter && (
          <SettingsRow
            state="warning"
            label="Another computer writes these backups"
            help={`${status?.error ?? ''} Moving them here makes that computer stop backing up to this place.`}
            data-testid="backup-other-writer"
            control={<SettingsButton onClick={handleAdopt} busy={adopting} busyLabel="Moving..." data-testid="backup-adopt">Back up from this computer</SettingsButton>}
          />
        )}
        <SettingsRow
          label="Last backup"
          help={lastHelp}
          error={lastError ?? undefined}
          data-testid="backup-last-row"
          control={
            <SettingsButton onClick={handleRunNow} disabled={!!runBlocked} busy={status?.running === true} busyLabel="Backing up..."
              data-testid="backup-run-now">
              Back up now
            </SettingsButton>
          }
        />
        <RestorePanel
          dest={legacyMode ? null : savedDest ?? null}
          restore={status?.restore}
          dataDir={status?.dataDir}
          blocked={!!blocked}
        />
      </SettingsGroup>
    </SectionCard>
  )
}
