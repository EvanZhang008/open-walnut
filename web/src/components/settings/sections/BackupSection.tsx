/**
 * Settings → Backup.
 *
 * Four groups, top to bottom: the switch and how often; where backups go
 * (Cloudflare R2, Google Drive or Amazon S3, with that service's fields);
 * the recovery key; and the backups themselves (last backup, Back up now,
 * Restore). People who set up the older unencrypted S3 copy keep that form
 * until they choose to switch.
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
  DESTINATIONS, DESTINATION_NOTE, buildBackupConfig, engineOf, fmtBytes, legacyToEncrypted, missingFields, stableJson,
  type BackupConfig, type BackupDestinationConfig, type BackupDestinationType,
} from './backup/backup-model'
import { R2Fields, S3Fields } from './backup/BucketFields'
import { DriveConnect } from './backup/DriveConnect'
import { LegacyS3Fields, type LegacyFields } from './backup/LegacyS3Fields'
import { RecoveryKeyGroup } from './backup/RecoveryKeyGroup'
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

interface TestResult {
  ok: boolean
  arn?: string
  versioningEnabled?: boolean
  hasBackups?: boolean
  keyMatches?: boolean
  hasKey?: boolean
  writer?: string
  error?: string
}

type Drafts = Record<BackupDestinationType, BackupDestinationConfig>

const emptyDrafts = (saved?: BackupDestinationConfig): Drafts => ({
  r2: { type: 'r2' },
  gdrive: { type: 'gdrive' },
  s3: { type: 's3', auth: { method: 'aws_chain' } },
  ...(saved ? { [saved.type]: saved } : {}),
})

const legacyOf = (b: BackupConfig): LegacyFields => ({ bucket: b.bucket, region: b.region, prefix: b.prefix, auth: b.auth })

function testHelp(r: TestResult | null, legacy: boolean): string {
  if (!r) return legacy ? 'Checks the bucket with these credentials.' : 'Writes, reads back and deletes a small test file.'
  if (!r.ok) return `Couldn't connect: ${r.error}`
  if (legacy) return `Connected as ${r.arn ?? 'unknown identity'}`
  if (!r.hasBackups) return 'Connected. Walnut can write here; no backups yet.'
  if (r.keyMatches === false) return 'Connected. It holds Walnut backups made with another recovery key.'
  return `Connected. It holds your Walnut backups${r.writer ? ` from ${r.writer}` : ''}.`
}

export function BackupSection({ config, onSave }: Props) {
  const saved: BackupConfig = config.backup ?? {}
  const savedEngine = engineOf(saved)
  const [enabled, setEnabled] = useState(saved.enabled ?? false)
  // Empty while the user retypes it; a save falls back to 24.
  const [intervalHours, setIntervalHours] = useState<number | undefined>(saved.interval_hours ?? 24)
  const [legacyMode, setLegacyMode] = useState(savedEngine === 'mirror')
  const [legacy, setLegacy] = useState<LegacyFields>(legacyOf(saved))
  const [type, setType] = useState<BackupDestinationType>(saved.destination?.type ?? 'r2')
  const [drafts, setDrafts] = useState<Drafts>(() => emptyDrafts(saved.destination))
  const [profiles, setProfiles] = useState<string[]>([])
  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [adopting, setAdopting] = useState(false)
  const [enablingVersioning, setEnablingVersioning] = useState(false)
  const [keyRefresh, setKeyRefresh] = useState(0)
  const [driveConnected, setDriveConnected] = useState(false)

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

  useEffect(() => {
    apiGet<BackupStatus>('/api/backup/status').then(setStatus).catch(() => {})
    fetchAwsProfiles().then(setProfiles).catch(() => {})
  }, [])

  useEvent('backup:status', useCallback((data: unknown) => {
    setStatus((prev) => ({ ...(prev ?? { configured: false, running: false, consecutiveFailures: 0 }), ...(data as BackupStatus) }))
  }, []))

  const dest = drafts[type]
  const form = (): BackupConfig => buildBackupConfig(saved, {
    enabled,
    intervalHours,
    destination: legacyMode ? null : dest,
    legacy: legacyMode ? legacy : undefined,
  })
  const baseline = (): BackupConfig => buildBackupConfig(saved, {
    enabled: saved.enabled ?? false,
    intervalHours: saved.interval_hours ?? 24,
    destination: saved.destination ?? null,
    legacy: savedEngine === 'mirror' ? legacyOf(saved) : undefined,
  })
  const handleSave = async () => {
    await onSave({ backup: form() } as Partial<Config>)
  }
  useSettingsAutoSave({ current: stableJson(form()), baseline: stableJson(baseline()), save: handleSave })

  const setDest = (next: BackupDestinationConfig) => setDrafts((cur) => ({ ...cur, [next.type]: next }))
  const pickType = (t: BackupDestinationType) => {
    setType(t)
    setTestResult(null)
  }

  const savedDest = saved.destination
  const destReady = !legacyMode && !!savedDest && savedDest.type === type && missingFields(savedDest).length === 0
  const destLabel = DESTINATIONS.find((d) => d.value === type)?.label ?? ''

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(legacyMode
        ? await apiPost<TestResult>('/api/backup/test', form(), { timeoutMs: 45000 })
        : await apiPost<TestResult>('/api/backup/destination/test', { destination: dest }, { timeoutMs: 45000 }))
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
  const onDriveConnected = useCallback(() => setKeyRefresh((n) => n + 1), [])

  const canRun = legacyMode ? Boolean(legacy.bucket?.trim()) : destReady && (type !== 'gdrive' || driveConnected)
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
      : canRun ? 'No backup yet. The first one starts within a minute once this is on.' : 'Finish "Where backups go" above first.'
  const versioningOff = legacyMode && ((testResult?.ok && testResult.versioningEnabled === false) || (status?.configured && status.versioningEnabled === false))
  const otherWriter = !legacyMode && status?.errorCode === 'other_writer'
  const lastError = otherWriter || status?.errorCode === 'key_mismatch' ? null : (status?.error ? `Last error: ${status.error}` : runError)

  return (
    <SectionCard id="backup" title="Backup" onSave={handleSave} showSave={false}>
      <SettingsGroup footer="Everything in your data folder is backed up (notes, tasks, passwords, sign-ins); caches and search indexes are skipped.">
        <SettingsRow
          label="Back up automatically"
          htmlFor="backup-enabled"
          help={legacyMode ? 'Only changed files upload after the first run.' : 'Encrypted on this computer first. After the first backup only changes upload.'}
          control={<ToggleSwitch id="backup-enabled" checked={enabled} onChange={setEnabled} />}
        />
        <SettingsRow
          label="Every"
          htmlFor="backup-interval"
          help={legacyMode ? undefined : 'Keeps one backup a day for a week and one a week for a month.'}
          control={<NumberInput id="backup-interval" min={1} unit="hours" value={intervalHours} onChange={setIntervalHours} />}
        />
      </SettingsGroup>

      <SettingsGroup heading="Where backups go" footer={legacyMode ? undefined : DESTINATION_NOTE[type]} data-testid="backup-destination-group">
        {legacyMode ? (
          <LegacyS3Fields value={legacy} onChange={setLegacy} profiles={profiles} onSwitch={switchToEncrypted} />
        ) : (
          <>
            <SettingsRow
              label="Service"
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
            {type === 'r2' && <R2Fields dest={dest} onChange={setDest} profiles={profiles} />}
            {type === 's3' && <S3Fields dest={dest} onChange={setDest} profiles={profiles} />}
            {type === 'gdrive' && <DriveConnect dest={dest} onChange={setDest} onConnected={onDriveConnected} onConnectedChange={setDriveConnected} />}
          </>
        )}
        {(legacyMode || type !== 'gdrive') && (
          <SettingsRow
            label="Connection"
            help={testHelp(testResult, legacyMode)}
            state={testResult && !testResult.ok ? 'error' : undefined}
            data-testid="backup-connection-row"
            control={
              <SettingsButton onClick={handleTest} busy={testing} busyLabel="Testing..." data-testid="backup-test-connection"
                disabled={legacyMode ? !legacy.bucket?.trim() : missingFields(dest).length > 0}
                title={legacyMode || missingFields(dest).length === 0 ? undefined : `Add the ${missingFields(dest).join(', ')} first.`}>
                Test connection
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
          destinationLabel={destLabel}
          ready={destReady && (type !== 'gdrive' || driveConnected)}
          savedAt={saved.recovery_key_saved_at}
          onMarkSaved={markKeySaved}
          refreshToken={keyRefresh}
        />
      )}

      <SettingsGroup
        heading="Backups"
        data-testid="backup-backups-group"
        footer={
          <>
            Also from a terminal: <code>open-walnut backup restore</code>, or paste the{' '}
            <a href="https://github.com/EvanZhang008/open-walnut/blob/main/skills/restore-backup/SKILL.md" target="_blank" rel="noreferrer">
              restore-backup skill
            </a>{' '}
            into a Claude Code session on the new computer.
          </>
        }
      >
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
            <SettingsButton onClick={handleRunNow} disabled={!canRun} busy={status?.running === true} busyLabel="Backing up..."
              title={canRun ? undefined : 'Finish "Where backups go" first.'} data-testid="backup-run-now">
              Back up now
            </SettingsButton>
          }
        />
        <RestorePanel dest={legacyMode ? null : savedDest ?? null} restore={status?.restore} disabled={!canRun && !status?.lastBackupAt} />
      </SettingsGroup>
    </SectionCard>
  )
}
