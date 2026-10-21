/**
 * The `/bridge/build` door: how the Mac keeps its cloud companion on the Mac's
 * own build (docs/plan/walnut-companion-unified-replica.md, stage 1).
 *
 *   GET  /bridge/build                                      → BoxBuildStatus
 *   PUT  /bridge/build/package?id&offset&size&sha256 (raw)  → UploadReply
 *   POST /bridge/build/install  InstallRequest              → StepReply
 *   POST /bridge/build/activate {id}                        → StepReply
 *
 * Only the Mac's own machine credential passes (bridge-ingest.ts `authenticate`).
 * Every step is idempotent, so either side may restart and the Mac resumes from
 * the status. This file is the contract both sides import: pure, no I/O.
 */

import crypto from 'node:crypto'

export const BRIDGE_BUILD_PATH = '/bridge/build'
export const BUILD_SCHEMA = 1
/**
 * The Mac uploads in chunks of this size; the box takes at most MAX_CHUNK_BYTES.
 * 1 MB, as the daemon's chunked deploy: a long upload from the Mac now and then
 * loses its connection (2026-10-21: one 4 MB chunk in five), and a small chunk
 * costs little to send again.
 */
export const CHUNK_BYTES = 1024 * 1024
export const MAX_CHUNK_BYTES = 8 * 1024 * 1024
/** A box with less free disk than this refuses an upload or an install. */
export const MIN_FREE_BYTES = 3 * 1024 * 1024 * 1024
/** The largest package the box takes (the build plus one platform's daemon). */
export const MAX_PACKAGE_BYTES = 512 * 1024 * 1024

/** A build id is plain characters (it names directories and rides shell scripts). */
export const BUILD_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/
export function validBuildId(id: unknown): id is string {
  return typeof id === 'string' && BUILD_ID_RE.test(id) && !id.includes('..')
}
export const SHA256_RE = /^[a-f0-9]{64}$/

/**
 * The id of a build: version, commit, and a mark for a dirty tree. The Mac
 * labels its package with it and the box names the build it runs with it, so
 * both sides compare like for like (host-server/package.ts uses it too).
 */
export function buildIdOf(info: { version: string; commit: string | null; dirty: boolean; builtAt: string | null }, now = Date.now()): string {
  const dirtyMark = info.dirty
    ? `-d${crypto.createHash('sha256').update(info.builtAt ?? String(now)).digest('hex').slice(0, 6)}`
    : ''
  return `${info.version}-${info.commit ?? 'src'}${dirtyMark}`.replace(/[^A-Za-z0-9._-]/g, '_')
}

export type InstallStepState = 'running' | 'ready' | 'failed' | 'absent'
export type ActivateStepState = 'smoking' | 'restarting' | 'failed'

export interface BoxBuildStatus {
  ok: true
  schema: number
  /** The box takes builds from the Mac: its launcher runs the server and root allowed it. */
  accepts: boolean
  refusal?: 'launcher_absent' | 'turned_off_on_box'
  /** The build this server process runs. */
  running: { id: string; version: string; commit: string | null; base: boolean; trial: boolean }
  /** The build the launcher starts (null: the base tree). */
  current: string | null
  trial: { id: string; attempts: number } | null
  /** Builds the box gave up, newest first (at most 10). */
  failed: Array<{ id: string; at: number; why: string }>
  /** The package being uploaded, or the last one that completed and is not installed yet. */
  upload: { id: string; received: number; size: number; complete: boolean } | null
  install: { id: string; state: InstallStepState; message?: string; logTail?: string } | null
  activate: { id: string; state: ActivateStepState; message?: string; at: number } | null
  platform: string
  arch: string
  node: string
  /** Free bytes where builds live, or null when the box cannot tell. */
  freeBytes: number | null
}

export interface UploadReply {
  ok: boolean
  received: number
  size: number
  complete: boolean
  error?: 'bad_request' | 'offset_mismatch' | 'sha_mismatch' | 'too_large' | 'disk_full' | 'busy' | 'refused'
  message?: string
}

export interface InstallRequest {
  id: string
  depsHash: string
  dependencies: Record<string, string>
  optionalDependencies: Record<string, string>
  appPackageJson: string
}

export interface StepReply {
  ok: boolean
  state?: InstallStepState | ActivateStepState | 'running'
  error?: 'bad_request' | 'no_package' | 'not_installed' | 'busy' | 'disk_full' | 'refused'
  message?: string
}

/** Validate an install request body; returns the reason it is refused, or null. */
export function installRequestProblem(body: unknown): string | null {
  const b = body as Partial<InstallRequest> | null
  if (!b || typeof b !== 'object') return 'the body is not an object'
  if (!validBuildId(b.id)) return 'id is not a build id'
  if (typeof b.depsHash !== 'string' || !/^[a-f0-9]{8,64}$/.test(b.depsHash)) return 'depsHash is not a hash'
  if (typeof b.appPackageJson !== 'string' || b.appPackageJson.length > 64 * 1024) return 'appPackageJson is not a short string'
  for (const field of ['dependencies', 'optionalDependencies'] as const) {
    const deps = b[field]
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) return `${field} is not an object`
    for (const [name, range] of Object.entries(deps)) {
      if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) return `${field} has a bad package name`
      if (typeof range !== 'string' || !/^[A-Za-z0-9.^~<>=| *+-]{1,64}$/.test(range)) return `${field}.${name} has a bad version range`
    }
  }
  return null
}
