/**
 * Audio Capture Service — record system/app audio, auto-chunk, store as WAV.
 *
 * Uses ScreenCaptureKit (via screencapturekit-audio-capture npm) on macOS 13+.
 * Gracefully degrades to unavailable on non-macOS platforms.
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { RECORDINGS_DIR, TMP_DIR } from '../constants.js'
import { bus, EventNames } from './event-bus.js'
import { getConfig } from './config-manager.js'
import { log } from '../logging/index.js'

// Persistent state file — if this file exists, recording should be active.
// Written on start(), deleted on stop(). Server reads it on startup to auto-resume.
// Under tmp/ (not the WALNUT_HOME root): this is per-machine runtime state
// describing what THIS box is recording. Syncing it would make the other box try
// to resume a recording it never started.
const RECORDING_STATE_FILE = path.join(TMP_DIR, 'recording-state.json')

// Native addons (.node files) can only be loaded via require(), not ESM import().
// Since tsup bundles as ESM, we create a require function for loading the native addon.
const require = createRequire(import.meta.url)

// ── Types ──

export type AudioSource = 'system' | 'mic' | 'both'
export type RecordingMode = 'continuous' | 'on-demand'

export interface RecordingOptions {
  source: AudioSource
  mode: RecordingMode
  /** Bundle IDs or app names to capture (system audio only) */
  apps?: string[]
  /** Chunk duration in minutes (default: 10) */
  chunkMinutes?: number
  /** Audio sample rate (default: 48000) */
  sampleRate?: number
  /** Audio channels (default: 1 for mono — saves space, good for voice) */
  channels?: 1 | 2
}

export interface RecordingStatus {
  recording: boolean
  recordingId: string | null
  source: AudioSource | null
  mode: RecordingMode | null
  apps: string[]
  startedAt: string | null
  currentChunkIndex: number
  currentChunkDuration: number
  totalDuration: number
}

export interface RecordingChunkMeta {
  recordingId: string
  chunkIndex: number
  date: string
  time: string
  filePath: string | null
  duration: number
  size: number
  source: AudioSource
  apps: string[]
  sampleRate: number
  channels: number
  /** Transcription text (populated after STT processes the chunk) */
  transcription?: string
  /** Transcription duration in ms */
  transcriptionDurationMs?: number
  /** True when WAV was deleted after transcription */
  audioDeleted?: boolean
}

export interface RecordingListEntry {
  date: string
  files: Array<{
    name: string
    size: number
    meta?: RecordingChunkMeta
  }>
}

// ── Constants ──

const DEFAULT_CHUNK_MINUTES = 10
const DEFAULT_SAMPLE_RATE = 48000
const DEFAULT_CHANNELS = 1
const DEFAULT_REFRESH_INTERVAL_SEC = 60
const WAV_FORMAT_PCM = 1

// ── Service ──

class AudioCaptureService {
  private capture: any = null // AudioCapture instance (lazy-loaded)
  private recording = false
  private recordingId: string | null = null
  private source: AudioSource | null = null
  private mode: RecordingMode | null = null
  private apps: string[] = []
  private startedAt: number = 0
  private chunkStartedAt: number = 0
  private chunkIndex = 0
  private chunkTimer: ReturnType<typeof setTimeout> | null = null
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null
  private receivedAnyAudio = false
  private audioBuffers: Buffer[] = []
  private totalSamples = 0
  private nonSilentSamples = 0 // samples with amplitude > silence threshold
  private levelLogTimer: ReturnType<typeof setInterval> | null = null
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private excludeApps: string[] = []
  private refreshIntervalSec = DEFAULT_REFRESH_INTERVAL_SEC
  private sampleRate = DEFAULT_SAMPLE_RATE
  private channels: 1 | 2 = DEFAULT_CHANNELS
  private chunkMinutes = DEFAULT_CHUNK_MINUTES
  private available: boolean | null = null // null = not checked yet
  // Cache verifyPermissions() — the native ScreenCaptureKit call is a
  // SYNCHRONOUS bridge into macOS TCC that has been observed to block the event
  // loop for up to 150s (server log: GET /api/audio/available → 200 (151821ms)).
  // /api/audio/available is polled by the frontend, so an uncached native call
  // per request stalls EVERY HTTP request behind it. Permissions change rarely;
  // cache the result with a short TTL and never call the native bridge twice in
  // that window.
  private permissionsCache: { granted: boolean; message: string } | null = null
  private permissionsCheckedAt = 0
  private permissionsRefreshing = false
  private static readonly PERMISSIONS_TTL_MS = 5 * 60 * 1000
  // getAudioApps() is the same class of synchronous ScreenCaptureKit bridge as
  // verifyPermissions() — it spins a CFRunLoop waiting for a macOS callback.
  // 2026-08-11 incident: one GET /api/audio/apps pinned the event loop for
  // MINUTES (main-thread sample: 100% of ticks inside GetAvailableApps →
  // CFRunLoopRun, wedged behind replayd/os_log), freezing every HTTP request
  // including static index.html — the whole app "stuck on refresh". Same
  // cache + background-refresh treatment as permissions.
  private appsCache: Array<{ processId: number; bundleIdentifier: string; applicationName: string }> | null = null
  private appsCheckedAt = 0
  private appsRefreshing = false
  private static readonly APPS_TTL_MS = 60 * 1000

  /**
   * Check if audio capture is available on this platform.
   */
  isAvailable(): boolean {
    if (this.available !== null) return this.available
    try {
      if (process.platform !== 'darwin') {
        this.available = false
        return false
      }
      // Try loading the native addon
      require('screencapturekit-audio-capture')
      this.available = true
    } catch {
      this.available = false
    }
    return this.available
  }

  /**
   * Check screen recording permissions (macOS).
   */
  checkPermissions(): { granted: boolean; message: string } {
    if (!this.isAvailable()) {
      return { granted: false, message: 'Audio capture not available on this platform' }
    }
    // NEVER call the native bridge synchronously on the request path. The
    // ScreenCaptureKit verifyPermissions() call is a synchronous hop into macOS
    // TCC that has been observed (via the event-loop monitor) to block the loop
    // for ~20s on a cold call and up to 150s under contention — freezing EVERY
    // HTTP request behind it. Instead: serve the cached value immediately and
    // refresh in the background when stale. Worst case a caller sees a
    // one-TTL-stale (or initial "checking") value; correctness of a poll never
    // justifies a 20s event-loop stall.
    const now = Date.now()
    const isStale = !this.permissionsCache || (now - this.permissionsCheckedAt) >= AudioCaptureService.PERMISSIONS_TTL_MS
    if (isStale) this.refreshPermissionsInBackground()
    return this.permissionsCache ?? { granted: false, message: 'Checking screen-recording permission…' }
  }

  /**
   * Refresh the permissions cache off the request path — in a CHILD PROCESS.
   * The old setImmediate version only deferred the native call; it still ran
   * on (and blocked) the server's event loop for its full duration (~20s cold,
   * 150s under contention). Same child-process treatment as the apps refresh.
   */
  private refreshPermissionsInBackground(): void {
    if (this.permissionsRefreshing) return
    this.permissionsRefreshing = true
    let addonPath: string
    try {
      addonPath = require.resolve('screencapturekit-audio-capture')
    } catch (err) {
      this.permissionsCache = { granted: false, message: (err as Error).message }
      this.permissionsCheckedAt = Date.now()
      this.permissionsRefreshing = false
      return
    }
    const script = 'const m=require(process.argv[1]);' +
      'process.stdout.write(JSON.stringify(m.AudioCapture.verifyPermissions()))'
    const child = spawn(process.execPath, ['-e', script, addonPath], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30_000,
    })
    let out = ''
    child.stdout.on('data', (d: Buffer) => { out += d.toString() })
    child.on('error', (err) => {
      this.permissionsCache = { granted: false, message: err.message }
      this.permissionsCheckedAt = Date.now()
      this.permissionsRefreshing = false
    })
    child.on('exit', (code) => {
      try {
        if (code === 0 && out) {
          const status = JSON.parse(out) as { granted: boolean; message: string }
          this.permissionsCache = { granted: status.granted, message: status.message }
        } else {
          this.permissionsCache = this.permissionsCache
            ?? { granted: false, message: 'permission probe did not complete' }
        }
      } catch (err) {
        this.permissionsCache = { granted: false, message: (err as Error).message }
      } finally {
        this.permissionsCheckedAt = Date.now()
        this.permissionsRefreshing = false
      }
    })
  }

  /**
   * List running applications that can be captured.
   *
   * NEVER calls the native bridge on the request path (see appsCache note):
   * serves the cached list immediately and refreshes in the background when
   * stale. First-ever call returns [] while the initial refresh runs — the
   * frontend picker just shows an empty list for one poll.
   */
  listApps(): Array<{ processId: number; bundleIdentifier: string; applicationName: string }> {
    if (!this.isAvailable()) return []
    const now = Date.now()
    const isStale = !this.appsCache || (now - this.appsCheckedAt) >= AudioCaptureService.APPS_TTL_MS
    if (isStale) this.refreshAppsInBackground()
    return this.appsCache ?? []
  }

  /** Refresh the capturable-app list off the request path.
   *
   *  Runs getAudioApps() in a CHILD PROCESS, not via setImmediate: the native
   *  call blocks whichever event loop it runs on, and a deferred tick still
   *  froze /api/config for 10s right after deploy (measured 2026-08-11). A
   *  child process wedging for minutes costs nothing; it's killed on timeout. */
  private refreshAppsInBackground(): void {
    if (this.appsRefreshing) return
    this.appsRefreshing = true
    const startedAt = Date.now()
    let addonPath: string
    try {
      addonPath = require.resolve('screencapturekit-audio-capture')
    } catch (err) {
      log.audio.error('listApps refresh failed: addon not resolvable', { error: (err as Error).message })
      this.appsCache = this.appsCache ?? []
      this.appsCheckedAt = Date.now()
      this.appsRefreshing = false
      return
    }
    const script = 'const m=require(process.argv[1]);const ac=new m.AudioCapture();' +
      'try{process.stdout.write(JSON.stringify(ac.getAudioApps()))}finally{try{ac.dispose()}catch{}}'
    const child = spawn(process.execPath, ['-e', script, addonPath], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30_000, // wedged CFRunLoop → SIGTERM; cache just stays stale
    })
    let out = ''
    child.stdout.on('data', (d: Buffer) => { out += d.toString() })
    child.on('error', (err) => {
      log.audio.error('listApps refresh spawn failed', { error: err.message })
      this.appsCache = this.appsCache ?? []
      this.appsCheckedAt = Date.now()
      this.appsRefreshing = false
    })
    child.on('exit', (code) => {
      try {
        if (code === 0 && out) {
          this.appsCache = JSON.parse(out)
        } else {
          log.audio.warn('listApps refresh child failed', { code, tookMs: Date.now() - startedAt })
          this.appsCache = this.appsCache ?? []
        }
      } catch (err) {
        log.audio.error('listApps refresh parse failed', { error: (err as Error).message })
        this.appsCache = this.appsCache ?? []
      } finally {
        this.appsCheckedAt = Date.now()
        this.appsRefreshing = false
      }
    })
  }

  /**
   * Start recording audio.
   */
  async start(options: RecordingOptions): Promise<{ recordingId: string }> {
    if (this.recording) {
      throw new Error('Already recording. Stop current recording first.')
    }
    if (!this.isAvailable()) {
      throw new Error('Audio capture not available. macOS 13+ with Screen Recording permission required.')
    }

    const { AudioCapture } = require('screencapturekit-audio-capture')

    this.recordingId = randomBytes(6).toString('hex')
    this.source = options.source
    this.mode = options.mode
    this.apps = options.apps ?? []
    this.sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE
    this.channels = options.channels ?? DEFAULT_CHANNELS
    this.chunkMinutes = options.chunkMinutes ?? DEFAULT_CHUNK_MINUTES
    this.chunkIndex = 0
    this.audioBuffers = []
    this.totalSamples = 0
    this.startedAt = Date.now()
    this.chunkStartedAt = Date.now()

    // Ensure recordings directory exists
    const dateDir = this.getDateDir()
    fs.mkdirSync(dateDir, { recursive: true })

    // Create capture instance
    this.capture = new AudioCapture()

    // Set up audio event handler
    this.capture.on('audio', (sample: { data: Buffer; sampleRate: number; channels: number }) => {
      if (!this.recording) return
      this.receivedAnyAudio = true
      const buf = Buffer.from(sample.data)
      this.audioBuffers.push(buf)
      const sampleCount = buf.length / (4 * this.channels) // float32 = 4 bytes per sample per channel
      this.totalSamples += sampleCount
      // Count non-silent samples (amplitude > -60 dB ≈ 0.001)
      for (let i = 0; i < buf.length; i += 4) {
        if (Math.abs(buf.readFloatLE(i)) > 0.001) this.nonSilentSamples++
      }
    })

    this.capture.on('error', (err: Error) => {
      log.audio.error('capture error', { recordingId: this.recordingId, error: err.message })
      bus.emit(EventNames.AUDIO_ERROR, {
        recordingId: this.recordingId ?? undefined,
        error: err.message,
      }, ['*'], { source: 'audio-capture' })
      // Auto-stop on stream error (e.g. ScreenCaptureKit connection interrupted)
      if (this.recording) {
        log.audio.warn('auto-stopping due to capture error')
        this.stop().catch(() => { /* already cleaning up */ })
      }
    })

    // Load exclude list from config
    try {
      const cfg = await getConfig()
      this.excludeApps = cfg.audio?.exclude_apps ?? []
      this.refreshIntervalSec = cfg.audio?.refresh_interval_sec ?? DEFAULT_REFRESH_INTERVAL_SEC
    } catch {
      this.excludeApps = []
      this.refreshIntervalSec = DEFAULT_REFRESH_INTERVAL_SEC
    }

    // Start capture
    const captureOpts = {
      sampleRate: this.sampleRate,
      channels: this.channels,
      format: 'float32' as const,
    }
    try {
      if (options.source === 'system' && this.apps.length > 0) {
        // Explicit app list from caller — use startCapture with smart app lookup
        this.capture.startCapture(this.apps[0], captureOpts)
      } else if (options.source === 'system' && this.excludeApps.length > 0) {
        // Per-app filtering: capture all apps minus exclude list
        this.startFilteredCapture(captureOpts)
      } else {
        // No exclude list — capture all system audio via display
        const displays = this.capture.getDisplays()
        if (displays.length === 0) throw new Error('No displays found')
        this.capture.captureDisplay(displays[0].displayId, captureOpts)
      }
    } catch (err) {
      this.cleanup()
      throw err
    }

    this.recording = true
    this.receivedAnyAudio = false

    // Watchdog: if no audio data received within 5 seconds, stop with error
    this.watchdogTimer = setTimeout(() => {
      if (this.recording && !this.receivedAnyAudio) {
        const msg = 'No audio data received. Screen Recording permission may not be fully granted. Go to System Settings → Privacy & Security → Screen & System Audio Recording, enable access for your terminal app, then restart it.'
        log.audio.error('watchdog: no audio data received', { recordingId: this.recordingId })
        bus.emit(EventNames.AUDIO_ERROR, {
          recordingId: this.recordingId ?? undefined,
          error: msg,
        }, ['*'], { source: 'audio-capture' })
        this.stop().catch(() => { /* cleanup */ })
      }
    }, 5000)

    // Periodic audio level logging (every 30s) — helps diagnose silence issues
    this.levelLogTimer = setInterval(() => {
      if (!this.recording) return
      const pct = this.totalSamples > 0 ? (this.nonSilentSamples / this.totalSamples * 100).toFixed(1) : '0.0'
      const elapsed = ((Date.now() - this.startedAt) / 1000).toFixed(0)
      log.audio.info('audio level check', {
        recordingId: this.recordingId,
        elapsed: `${elapsed}s`,
        nonSilentPercent: `${pct}%`,
        totalSamples: this.totalSamples,
        bufferedBytes: this.audioBuffers.reduce((s, b) => s + b.length, 0),
      })
    }, 30_000)

    // Set up auto-chunk timer for continuous mode
    if (this.mode === 'continuous') {
      this.scheduleChunkTimer()
    }

    // Set up app refresh timer — periodically re-scan running apps and restart capture
    // to pick up newly launched apps and drop closed ones
    if (options.source === 'system' && this.excludeApps.length > 0 && this.refreshIntervalSec > 0) {
      this.scheduleRefreshTimer()
    }

    // Persist recording state so server restart can auto-resume
    this.saveState(options)

    log.audio.info('recording started', {
      recordingId: this.recordingId,
      source: this.source,
      mode: this.mode,
      apps: this.apps,
    })

    bus.emit(EventNames.AUDIO_STARTED, {
      recordingId: this.recordingId,
      source: this.source,
      apps: this.apps.length > 0 ? this.apps : undefined,
      startedAt: new Date(this.startedAt).toISOString(),
    }, ['*'], { source: 'audio-capture' })

    return { recordingId: this.recordingId }
  }

  /**
   * Stop recording and save the final chunk.
   */
  async stop(): Promise<{ recordingId: string; chunks: number; totalDuration: number }> {
    if (!this.recording || !this.recordingId) {
      throw new Error('Not currently recording.')
    }

    const recordingId = this.recordingId
    const totalDuration = (Date.now() - this.startedAt) / 1000

    // Save current chunk
    await this.saveCurrentChunk()

    // Stop capture
    if (this.capture) {
      try { this.capture.stopCapture() } catch { /* already stopped */ }
    }

    const chunks = this.chunkIndex

    this.cleanup()
    this.clearState()

    log.audio.info('recording stopped', { recordingId, chunks, totalDuration })

    bus.emit(EventNames.AUDIO_STOPPED, {
      recordingId,
      duration: totalDuration,
      chunks,
    }, ['*'], { source: 'audio-capture' })

    return { recordingId, chunks, totalDuration }
  }

  /**
   * Get current recording status.
   */
  getStatus(): RecordingStatus {
    const now = Date.now()
    return {
      recording: this.recording,
      recordingId: this.recordingId,
      source: this.source,
      mode: this.mode,
      apps: this.apps,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      currentChunkIndex: this.chunkIndex,
      currentChunkDuration: this.recording ? (now - this.chunkStartedAt) / 1000 : 0,
      totalDuration: this.recording ? (now - this.startedAt) / 1000 : 0,
    }
  }

  /**
   * List all recordings grouped by date.
   */
  async listRecordings(): Promise<RecordingListEntry[]> {
    try {
      if (!fs.existsSync(RECORDINGS_DIR)) return []
      const dates = fs.readdirSync(RECORDINGS_DIR)
        .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort()
        .reverse()

      const entries: RecordingListEntry[] = []
      for (const date of dates) {
        const dateDir = path.join(RECORDINGS_DIR, date)
        // Use .json metadata files as primary key (WAV may have been deleted after transcription)
        const files = fs.readdirSync(dateDir)
          .filter(f => f.endsWith('.json'))
          .sort()
          .reverse()
          .map(f => {
            let meta: RecordingChunkMeta | undefined
            try {
              meta = JSON.parse(fs.readFileSync(path.join(dateDir, f), 'utf-8'))
            } catch { /* ignore */ }
            const wavName = f.replace('.json', '.wav')
            const wavPath = path.join(dateDir, wavName)
            const wavExists = fs.existsSync(wavPath)
            return {
              name: wavName,
              size: wavExists ? fs.statSync(wavPath).size : 0,
              meta,
            }
          })
        if (files.length > 0) {
          entries.push({ date, files })
        }
      }
      return entries
    } catch (err) {
      log.audio.error('listRecordings failed', { error: (err as Error).message })
      return []
    }
  }

  // ── Private ──

  /**
   * Get running apps filtered by exclude list.
   * Returns app info objects for all apps NOT in the exclude list.
   */
  private getFilteredApps(): Array<{ processId: number; bundleIdentifier: string; applicationName: string }> {
    const allApps = this.capture.getAudioApps()
    if (this.excludeApps.length === 0) return allApps
    const excludeSet = new Set(this.excludeApps.map(id => id.toLowerCase()))
    return allApps.filter((app: { bundleIdentifier: string; applicationName: string }) =>
      !excludeSet.has(app.bundleIdentifier.toLowerCase()) &&
      !excludeSet.has(app.applicationName.toLowerCase())
    )
  }

  /**
   * Start capture using captureMultipleApps with filtered app list.
   * Falls back to captureDisplay if no apps remain after filtering.
   */
  private startFilteredCapture(captureOpts: { sampleRate: number; channels: number; format: 'float32' }): void {
    const filtered = this.getFilteredApps()

    if (filtered.length === 0) {
      // All apps excluded — fallback to captureDisplay (safety net)
      log.audio.warn('all apps excluded by filter, falling back to captureDisplay')
      const displays = this.capture.getDisplays()
      if (displays.length === 0) throw new Error('No displays found')
      this.capture.captureDisplay(displays[0].displayId, captureOpts)
      return
    }

    log.audio.info('starting filtered capture', {
      totalApps: filtered.length + this.excludeApps.length,
      excluded: this.excludeApps,
      capturing: filtered.length,
    })

    this.capture.captureMultipleApps(filtered, {
      ...captureOpts,
      allowPartial: true,
    })
  }

  /**
   * Periodically refresh running app list and restart capture to pick up new apps.
   * Saves current chunk before restart to avoid data loss.
   */
  private scheduleRefreshTimer(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    this.refreshTimer = setInterval(async () => {
      if (!this.recording || !this.capture) return
      try {
        const { AudioCapture } = require('screencapturekit-audio-capture')

        // Save current chunk before restarting
        await this.saveCurrentChunk()
        this.chunkStartedAt = Date.now()
        this.audioBuffers = []
        this.totalSamples = 0
        this.nonSilentSamples = 0

        // Stop current capture
        try { this.capture.stopCapture() } catch { /* already stopped */ }
        try { this.capture.dispose() } catch { /* ignore */ }

        // Create new capture instance and re-attach handlers
        this.capture = new AudioCapture()
        this.capture.on('audio', (sample: { data: Buffer; sampleRate: number; channels: number }) => {
          if (!this.recording) return
          this.receivedAnyAudio = true
          const buf = Buffer.from(sample.data)
          this.audioBuffers.push(buf)
          const sampleCount = buf.length / (4 * this.channels)
          this.totalSamples += sampleCount
          for (let i = 0; i < buf.length; i += 4) {
            if (Math.abs(buf.readFloatLE(i)) > 0.001) this.nonSilentSamples++
          }
        })
        this.capture.on('error', (err: Error) => {
          log.audio.error('capture error after refresh', { error: err.message })
        })

        // Reload exclude list in case config changed
        try {
          const cfg = await getConfig()
          this.excludeApps = cfg.audio?.exclude_apps ?? []
        } catch { /* keep existing list */ }

        // Restart with filtered apps
        const captureOpts = {
          sampleRate: this.sampleRate,
          channels: this.channels,
          format: 'float32' as const,
        }
        this.startFilteredCapture(captureOpts)

        log.audio.info('app list refreshed', { recordingId: this.recordingId })
      } catch (err) {
        log.audio.error('app refresh failed', { error: (err as Error).message })
      }
    }, this.refreshIntervalSec * 1000)
  }

  private scheduleChunkTimer(): void {
    if (this.chunkTimer) clearTimeout(this.chunkTimer)
    this.chunkTimer = setTimeout(async () => {
      if (!this.recording) return
      try {
        await this.saveCurrentChunk()
        this.chunkStartedAt = Date.now()
        this.audioBuffers = []
        this.totalSamples = 0
        this.nonSilentSamples = 0
        this.scheduleChunkTimer()
      } catch (err) {
        log.audio.error('auto-chunk failed', { error: (err as Error).message })
      }
    }, this.chunkMinutes * 60 * 1000)
  }

  private async saveCurrentChunk(): Promise<void> {
    if (this.audioBuffers.length === 0) return

    const pcmData = Buffer.concat(this.audioBuffers)
    if (pcmData.length === 0) return

    const dateStr = this.formatDate(new Date(this.chunkStartedAt))
    const timeStr = this.formatTime(new Date(this.chunkStartedAt))
    const dateDir = path.join(RECORDINGS_DIR, dateStr)
    fs.mkdirSync(dateDir, { recursive: true })

    const wavPath = path.join(dateDir, `${timeStr}.wav`)
    const metaPath = path.join(dateDir, `${timeStr}.json`)

    // Convert float32 PCM to WAV
    const wavBuffer = this.createWav(pcmData)
    fs.writeFileSync(wavPath, wavBuffer)

    const duration = (Date.now() - this.chunkStartedAt) / 1000

    // Save metadata
    const meta: RecordingChunkMeta = {
      recordingId: this.recordingId!,
      chunkIndex: this.chunkIndex,
      date: dateStr,
      time: timeStr,
      filePath: wavPath,
      duration,
      size: wavBuffer.length,
      source: this.source!,
      apps: this.apps,
      sampleRate: this.sampleRate,
      channels: this.channels,
    }
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2))

    this.chunkIndex++

    log.audio.info('chunk saved', {
      recordingId: this.recordingId,
      chunkIndex: meta.chunkIndex,
      duration: Math.round(duration),
      size: wavBuffer.length,
      path: wavPath,
    })

    bus.emit(EventNames.AUDIO_CHUNK_SAVED, {
      recordingId: this.recordingId!,
      chunkIndex: meta.chunkIndex,
      filePath: wavPath,
      duration,
      size: wavBuffer.length,
    }, ['*'], { source: 'audio-capture' })
  }

  private createWav(pcmFloat32: Buffer): Buffer {
    // Convert float32 to int16 for smaller file size
    const numSamples = pcmFloat32.length / 4
    const int16Data = Buffer.alloc(numSamples * 2)
    for (let i = 0; i < numSamples; i++) {
      const float = pcmFloat32.readFloatLE(i * 4)
      const clamped = Math.max(-1, Math.min(1, float))
      int16Data.writeInt16LE(Math.round(clamped * 32767), i * 2)
    }

    const dataSize = int16Data.length
    const headerSize = 44
    const wav = Buffer.alloc(headerSize + dataSize)

    // RIFF header
    wav.write('RIFF', 0)
    wav.writeUInt32LE(36 + dataSize, 4)
    wav.write('WAVE', 8)

    // fmt chunk
    wav.write('fmt ', 12)
    wav.writeUInt32LE(16, 16) // chunk size
    wav.writeUInt16LE(WAV_FORMAT_PCM, 20) // PCM format
    wav.writeUInt16LE(this.channels, 22)
    wav.writeUInt32LE(this.sampleRate, 24)
    wav.writeUInt32LE(this.sampleRate * this.channels * 2, 28) // byte rate (int16 = 2 bytes)
    wav.writeUInt16LE(this.channels * 2, 32) // block align
    wav.writeUInt16LE(16, 34) // bits per sample (int16)

    // data chunk
    wav.write('data', 36)
    wav.writeUInt32LE(dataSize, 40)
    int16Data.copy(wav, 44)

    return wav
  }

  private cleanup(): void {
    if (this.chunkTimer) {
      clearTimeout(this.chunkTimer)
      this.chunkTimer = null
    }
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer)
      this.watchdogTimer = null
    }
    if (this.levelLogTimer) {
      clearInterval(this.levelLogTimer)
      this.levelLogTimer = null
    }
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
    if (this.capture) {
      try { this.capture.dispose() } catch { /* ignore */ }
      this.capture = null
    }
    this.recording = false
    this.recordingId = null
    this.source = null
    this.mode = null
    this.apps = []
    this.excludeApps = []
    this.audioBuffers = []
    this.totalSamples = 0
    this.nonSilentSamples = 0
    this.startedAt = 0
    this.chunkStartedAt = 0
    this.chunkIndex = 0
  }

  private getDateDir(): string {
    return path.join(RECORDINGS_DIR, this.formatDate(new Date()))
  }

  private formatDate(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  private formatTime(d: Date): string {
    return `${String(d.getHours()).padStart(2, '0')}-${String(d.getMinutes()).padStart(2, '0')}-${String(d.getSeconds()).padStart(2, '0')}`
  }

  // ── State persistence (survive server restart) ──

  private saveState(options: RecordingOptions): void {
    try {
      // tmp/ is created by initDirectories(), but this class is also used from
      // CLI paths that never boot the server — mkdir keeps it self-sufficient.
      fs.mkdirSync(path.dirname(RECORDING_STATE_FILE), { recursive: true })
      fs.writeFileSync(RECORDING_STATE_FILE, JSON.stringify(options))
    } catch (err) {
      log.audio.warn('failed to save recording state', { error: (err as Error).message })
    }
  }

  private clearState(): void {
    try {
      fs.unlinkSync(RECORDING_STATE_FILE)
    } catch { /* file may not exist */ }
  }

  /**
   * Resume recording if it was active before server restart.
   * Called once during server startup.
   */
  async resume(): Promise<void> {
    try {
      if (!fs.existsSync(RECORDING_STATE_FILE)) return
      const raw = fs.readFileSync(RECORDING_STATE_FILE, 'utf-8')
      const options: RecordingOptions = JSON.parse(raw)
      log.audio.info('resuming recording after server restart', { options })
      await this.start(options)
    } catch (err) {
      log.audio.warn('failed to resume recording', { error: (err as Error).message })
      this.clearState() // don't retry on next restart
    }
  }
}

export const audioCaptureService = new AudioCaptureService()
