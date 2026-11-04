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
  engineOf, fmtBytes, legacyToEncrypted, missingFields, sameDestination, stableJson, testHelp,
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

const emptyDrafts = (saved?: BackupDestinationConfig): Drafts => ({
  r2: { type: 'r2' },
  gdrive: { type: 'gdrive' },
  s3: { type: 's3', auth: { method: 'aws_chain' } },
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
  const [drafts, setDrafts] = useState<Drafts>(() => emptyDrafts(savedDest))
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
  useEffect(() => {
    const p = prevSaved.current
    prevSaved.current = saved
    if (p === saved) return
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

  useEvent('backup:status', useCallback((data: unknown) => {
    setStatus((prev) => ({ ...(prev ?? { configured: false, running: false, consecutiveFailures: 0 }), ...(data as BackupStatus) }))
  }, []))

  const draft = drafts[type]
  const draftIsSaved = !!savedDest && sameDestination(draft, savedDest)
  const missing = missingFields(draft)

  // Autosave covers the switch and the interval (and the legacy form, as before).
  const form = (): BackupConfig => buildBackupConfig(saved, {
    enabled,
    intervalHours,
    destination: legacyMode ? null : savedDest ?? null,
    legacy: legacyMode ? legacy : undefined,
  })
  const baseline = (): BackupConfig => buildBackupConfig(saved, {
    enabled: saved.enabled ?? false,
    intervalHours: saved.interval_hours ?? 24,
    destination: legacyMode ? null : savedDest ?? null,
    legacy: savedEngine === 'mirror' ? legacyOf(saved) : undefined,
  })
  const handleSave = async () => {
    await onSave({ backup: form() } as Partial<Config>)
  }
  useSettingsAutoSave({ current: stableJson(form()), baseline: stableJson(baseline()), save: handleSave })

  /** Where backups go from now on: saved on purpose, never by looking at a tab. */
  const saveDestination = async (d: BackupDestinationConfig) => {
    await onSave({ backup: buildBackupConfig(saved, { enabled, intervalHours, destination: d }) } as Partial<Config>)
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

  const markKeySaved = () => {
    void onSave({ backup: { ...form(), recovery_key_saved_at: new Date().toISOString() } } as Partial<Config>)
  }

  // Drive is saved as the destination once its sign-in finishes (on this tab, so on purpose).
  const draftsRef = useRef(drafts)
  draftsRef.current = drafts
  const saveRef = useRef(saveDestination)
  saveRef.current = saveDestination
  const onDriveConnected = useCallback(() => {
    setDriveConnected(true)
    const d = draftsRef.current.gdrive
    const current = prevSaved.current.destination
    if (!current || !sameDestination(d, current)) void saveRef.current(cleanDestination(d))
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
              help={savedDest ? `Backups go to ${labelOf(savedDest.type)}.` : 'Pick one, then connect it.'}
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
          help={blocked && !enabled
            ? blocked
            : legacyMode ? 'Only changed files upload after the first run.' : 'Encrypted on this computer first. After the first backup only changes upload.'}
          data-testid="backup-enabled-row"
          control={<ToggleSwitch id="backup-enabled" checked={enabled} onChange={setEnabled} disabled={!!blocked && !enabled} />}
        />
        <SettingsRow
          label="Every"
          htmlFor="backup-interval"
          help={legacyMode ? undefined : RETENTION_NOTE}
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
          help={lastBackupHelp}
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
