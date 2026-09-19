/**
 * Engine settings service: reads and writes an engine's OWN settings files on
 * the host where its sessions run, from the schema its registry descriptor
 * declares (`caps.settings`). Engine-agnostic: nothing here knows a vendor,
 * only a schema, a file format and a transport.
 *
 * Read: every declared file is fetched once, parsed per format, and each item
 * reports the value the engine will see plus WHERE it came from (the file, an
 * older location the engine still falls back to, or the built-in default) and
 * whether an environment variable overrides it. A file that cannot be parsed
 * degrades to "unreadable" for its items instead of failing the whole view,
 * and is refused as a write target until it is fixed: Walnut never rewrites
 * bytes it could not read.
 *
 * Write: read-modify-write per file with the daemon's atomic replace guarded
 * by the sha256 of the text that was read. A lost race (the engine rewrote the
 * file in between, which running CLIs do) is retried once from a fresh read
 * and then reported as a conflict, never silently overwritten. The response is
 * a fresh read, so the client shows what landed, not what it asked for.
 */

import { createHash } from 'node:crypto'
import type { SessionEngine } from '../types.js'
import { engineCaps, isKnownEngine } from './engine-registry.js'
import {
  type EngineSettingItem,
  type EngineSettingsFile,
  type EngineSettingsSchema,
  type EngineSettingValue,
  findSchemaItem,
  validateSettingValue,
} from './engine-settings-schema.js'
import {
  type JsonObject,
  type TomlScalar,
  TomlUnsupportedValueError,
  editTomlTopLevel,
  getJsonPath,
  parseJsonObject,
  readTomlTopLevel,
  serializeJsonObject,
  setJsonPath,
  unsetJsonPath,
} from './config-file-edit.js'

/** Sentinel the daemon understands for "the file must not exist yet". */
export const SHA_ABSENT = 'absent'

export interface SettingsFileTransport {
  /**
   * The file's exact bytes, or null when it does not exist. The bytes (not a
   * decoded string) are what the write guard hashes, so a file with a stray
   * non-UTF-8 byte still round-trips. Must throw an error whose message contains
   * 'EFBIG' when the file is larger than `maxBytes`, without reading it whole.
   */
  read(path: string, maxBytes: number): Promise<Buffer | null>
  /**
   * Atomic replace guarded by `expectSha256` (sha256 hex of the bytes previously
   * read, or SHA_ABSENT). Must throw an error whose message contains
   * 'EMODIFIED' when the guard fails.
   */
  writeAtomic(path: string, text: string, expectSha256: string): Promise<void>
  /** Runtime environment of the engine's processes on this host, when known (local host). */
  env?: Readonly<Record<string, string | undefined>>
}

/**
 * Larger than any settings file an engine writes on purpose (~/.claude.json
 * accumulates per-project history and has been seen at 176 KB), and small enough
 * that parse + serialize + hash on the server's one event loop stays in the low
 * milliseconds. Above it the file is reported, never edited.
 */
export const MAX_SETTINGS_FILE_BYTES = 4 * 1024 * 1024

export type EngineSettingSource = 'file' | 'legacy' | 'default'

export interface EngineSettingView {
  key: string
  label: string
  help: string
  type: EngineSettingItem['type']
  options?: EngineSettingItem['options']
  allowCustom?: boolean
  default: EngineSettingValue | null
  defaultLabel?: string
  scope: EngineSettingItem['scope']
  suggestions?: readonly string[]
  placeholder?: string
  min?: number
  max?: number
  /** EngineSettingsFile.id the value is written to. */
  file: string
  /** The value the engine will use; null when unset and the default cannot be named. */
  value: EngineSettingValue | null
  source: EngineSettingSource
  /** Set when `source` is 'legacy': the older file the value was actually read from (path as resolved on the host). */
  legacy?: { file: string; path: string }
  /** Set when an environment variable overrides the stored value. */
  envOverride?: { name: string; value: string }
  /** Set when the file holds something the schema cannot represent (wrong type, unreadable file). */
  invalid?: string
}

export interface EngineSettingsFileView {
  id: string
  /** Path as the engine resolves it on that host (after any homeEnv relocation). */
  path: string
  label: string
  format: EngineSettingsFile['format']
  exists: boolean
  /** Parse error; the file's items are shown as unset and writes to it are refused. */
  error?: string
}

export interface EngineSettingsGroupView {
  id: string
  title: string
  help: string
  items: EngineSettingView[]
}

export interface EngineSettingsView {
  engine: SessionEngine
  displayName: string
  host: string
  note?: string
  /** True when environment overrides were evaluated (the host's runtime env was known). */
  envChecked: boolean
  files: EngineSettingsFileView[]
  groups: EngineSettingsGroupView[]
}

export interface EngineSettingsPatch {
  set?: Record<string, unknown>
  unset?: string[]
}

export type EngineSettingsErrorStatus = 400 | 404 | 409 | 502

/**
 * What a failed write did to the file: 'not-written' (refused or failed before
 * any byte moved), 'written' (the change landed, a later step failed), 'unknown'
 * (the transport died mid-write). A client may revert its control only for the
 * first; for the others the truth is on disk and has to be read back.
 */
export type EngineSettingsWriteOutcome = 'not-written' | 'written' | 'unknown'

export class EngineSettingsError extends Error {
  constructor(
    public readonly status: EngineSettingsErrorStatus,
    message: string,
    public readonly outcome: EngineSettingsWriteOutcome = 'not-written',
  ) {
    super(message)
    this.name = 'EngineSettingsError'
  }
}

export function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(typeof bytes === 'string' ? Buffer.from(bytes, 'utf-8') : bytes).digest('hex')
}

const isModifiedError = (err: unknown) => err instanceof Error && /EMODIFIED/.test(err.message)
const isTooLargeError = (err: unknown) => err instanceof Error && /EFBIG/.test(err.message)

/**
 * The transport's own "this host's daemon is too old" signal. Matched by name so
 * this module stays transport-agnostic; the route maps it to 501 with the
 * self-heal advice, which a generic 502 wrapper would bury.
 */
const isUpgradeError = (err: unknown) => err instanceof Error && err.name === 'DaemonNeedsUpgradeError'

/** The path the engine resolves on this host: `homeEnv` relocation applied when that variable is set. */
export function resolveSettingsFilePath(file: EngineSettingsFile, env?: Readonly<Record<string, string | undefined>>): string {
  const relocation = file.homeEnv
  const dir = relocation ? env?.[relocation.name] : undefined
  if (!relocation || !dir || dir.trim() === '') return file.path
  const prefix = relocation.replaces + '/'
  if (!file.path.startsWith(prefix)) return file.path
  return dir.replace(/\/+$/, '') + '/' + file.path.slice(prefix.length)
}

function schemaFor(engine: string): { engine: SessionEngine; displayName: string; schema: EngineSettingsSchema } {
  if (!isKnownEngine(engine)) throw new EngineSettingsError(404, `unknown engine '${engine}'`)
  const caps = engineCaps(engine)
  if (!caps.settings) throw new EngineSettingsError(404, `engine '${engine}' has no settings surface`)
  return { engine: caps.id, displayName: caps.displayName, schema: caps.settings }
}

// ── Parsed file state ──

interface LoadedFile {
  decl: EngineSettingsFile
  path: string
  exists: boolean
  /** Decoded text; null when the file is absent or was not read (too large). */
  text: string | null
  /** sha256 of the exact bytes read (the write guard), or SHA_ABSENT. */
  sha: string
  /** JSON object or TOML top-level map; undefined when absent or unparsable. */
  json?: JsonObject
  toml?: Map<string, TomlScalar | undefined>
  error?: string
}

async function loadFile(decl: EngineSettingsFile, transport: SettingsFileTransport): Promise<LoadedFile> {
  const path = resolveSettingsFilePath(decl, transport.env)
  let bytes: Buffer | null
  try {
    bytes = await transport.read(path, MAX_SETTINGS_FILE_BYTES)
  } catch (err) {
    if (isUpgradeError(err)) throw err
    if (isTooLargeError(err)) {
      // Reported like a parse failure: items unset, writes refused. Rewriting a
      // file this size on the shared event loop is the outage to avoid.
      return {
        decl, path, exists: true, text: null, sha: SHA_ABSENT,
        error: `file is larger than ${MAX_SETTINGS_FILE_BYTES / (1024 * 1024)} MB; Walnut does not edit files that large`,
      }
    }
    throw new EngineSettingsError(502, `could not read ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (bytes === null) return { decl, path, exists: false, text: null, sha: SHA_ABSENT }
  const text = bytes.toString('utf-8')
  const loaded: LoadedFile = { decl, path, exists: true, text, sha: sha256Hex(bytes) }
  try {
    if (decl.format === 'json') loaded.json = parseJsonObject(text, path)
    else loaded.toml = readTomlTopLevel(text)
  } catch (err) {
    loaded.error = err instanceof Error ? err.message : String(err)
  }
  return loaded
}

/** Raw stored value at an item's path, or undefined when absent (or the file is absent/unreadable). */
function storedValue(file: LoadedFile | undefined, path: string): unknown {
  if (!file || file.error) return undefined
  if (file.json) return getJsonPath(file.json, path)
  if (file.toml) return file.toml.get(path)
  return undefined
}

function typeMatches(item: EngineSettingItem, value: unknown): value is EngineSettingValue {
  switch (item.type) {
    case 'boolean': return typeof value === 'boolean'
    case 'number': return typeof value === 'number'
    case 'text':
    case 'select': return typeof value === 'string'
  }
}

function envOverrideFor(item: EngineSettingItem, env?: Readonly<Record<string, string | undefined>>): { name: string; value: string } | undefined {
  if (!env || !item.env) return undefined
  for (const name of item.env) {
    const v = env[name]
    if (v !== undefined && v !== '') return { name, value: v }
  }
  return undefined
}

function viewItem(item: EngineSettingItem, files: Map<string, LoadedFile>, env?: SettingsFileTransport['env']): EngineSettingView {
  const view: EngineSettingView = {
    key: item.key, label: item.label, help: item.help, type: item.type,
    ...(item.options ? { options: item.options } : {}),
    ...(item.allowCustom ? { allowCustom: true } : {}),
    default: item.default,
    ...(item.defaultLabel ? { defaultLabel: item.defaultLabel } : {}),
    scope: item.scope,
    ...(item.suggestions ? { suggestions: item.suggestions } : {}),
    ...(item.placeholder ? { placeholder: item.placeholder } : {}),
    ...(item.min !== undefined ? { min: item.min } : {}),
    ...(item.max !== undefined ? { max: item.max } : {}),
    file: item.file,
    value: item.default,
    source: 'default',
  }
  const primary = files.get(item.file)
  if (primary?.error) view.invalid = `file unreadable: ${primary.error}`

  const raw = storedValue(primary, item.path)
  if (raw !== undefined) {
    view.source = 'file'
    if (typeMatches(item, raw)) view.value = raw
    else { view.value = item.default; view.invalid = `stored value is ${Array.isArray(raw) ? 'an array' : typeof raw}, expected ${item.type}` }
  } else if (item.legacy) {
    const legacyFile = files.get(item.legacy.file)
    const legacyRaw = storedValue(legacyFile, item.legacy.path)
    if (legacyRaw !== undefined && typeMatches(item, legacyRaw)) {
      view.source = 'legacy'
      view.value = legacyRaw
      view.legacy = { file: item.legacy.file, path: legacyFile!.path }
    }
  }
  const override = envOverrideFor(item, env)
  if (override) view.envOverride = override
  return view
}

function buildView(
  engine: SessionEngine, displayName: string, host: string, schema: EngineSettingsSchema,
  files: Map<string, LoadedFile>, env: SettingsFileTransport['env'],
): EngineSettingsView {
  return {
    engine, displayName, host,
    ...(schema.note ? { note: schema.note } : {}),
    envChecked: env !== undefined,
    files: schema.files.map((decl) => {
      const f = files.get(decl.id)!
      return {
        id: decl.id, path: f.path, label: decl.label, format: decl.format, exists: f.exists,
        ...(f.error ? { error: f.error } : {}),
      }
    }),
    groups: schema.groups.map((g) => ({
      id: g.id, title: g.title, help: g.help,
      items: g.items.map((item) => viewItem(item, files, env)),
    })),
  }
}

async function loadAll(schema: EngineSettingsSchema, transport: SettingsFileTransport): Promise<Map<string, LoadedFile>> {
  const loaded = await Promise.all(schema.files.map((decl) => loadFile(decl, transport)))
  return new Map(loaded.map((f) => [f.decl.id, f]))
}

export async function readEngineSettings(engineId: string, host: string, transport: SettingsFileTransport): Promise<EngineSettingsView> {
  const { engine, displayName, schema } = schemaFor(engineId)
  const files = await loadAll(schema, transport)
  return buildView(engine, displayName, host, schema, files, transport.env)
}

// ── Writes ──

interface PlannedChange {
  item: EngineSettingItem
  /** undefined = unset the key. */
  value: EngineSettingValue | undefined
}

/** Validate a patch against the schema. Every problem is a 400: nothing is written when any key is wrong. */
function planChanges(schema: EngineSettingsSchema, patch: EngineSettingsPatch): PlannedChange[] {
  const changes = new Map<string, PlannedChange>()
  const set = patch.set ?? {}
  const unset = patch.unset ?? []
  if (typeof set !== 'object' || set === null || Array.isArray(set)) throw new EngineSettingsError(400, '`set` must be an object')
  if (!Array.isArray(unset) || unset.some((k) => typeof k !== 'string')) throw new EngineSettingsError(400, '`unset` must be an array of keys')
  for (const key of unset) {
    const item = findSchemaItem(schema, key)
    if (!item) throw new EngineSettingsError(400, `unknown setting '${key}'`)
    changes.set(key, { item, value: undefined })
  }
  for (const [key, value] of Object.entries(set)) {
    const item = findSchemaItem(schema, key)
    if (!item) throw new EngineSettingsError(400, `unknown setting '${key}'`)
    // An emptied text field means "back to the engine's default", i.e. unset.
    if (item.type === 'text' && typeof value === 'string' && value.trim() === '') {
      changes.set(key, { item, value: undefined })
      continue
    }
    const problem = validateSettingValue(item, value)
    if (problem) throw new EngineSettingsError(400, problem)
    changes.set(key, { item, value: value as EngineSettingValue })
  }
  if (changes.size === 0) throw new EngineSettingsError(400, 'nothing to change')
  return [...changes.values()]
}

/** Apply the planned changes for ONE file to its current text. Returns the new text (may equal the old one). */
function applyToFile(file: LoadedFile, changes: PlannedChange[]): string {
  if (file.error) {
    throw new EngineSettingsError(409, `refusing to write ${file.path}: ${file.error}. Fix the file by hand first.`)
  }
  if (file.decl.format === 'json') {
    let obj: JsonObject = file.json ?? {}
    for (const c of changes) {
      obj = c.value === undefined ? unsetJsonPath(obj, c.item.path) : setJsonPath(obj, c.item.path, c.value)
    }
    return serializeJsonObject(obj, file.text ?? undefined)
  }
  const set: Record<string, TomlScalar> = {}
  const unset: string[] = []
  for (const c of changes) {
    if (c.value === undefined) unset.push(c.item.path)
    else set[c.item.path] = c.value
  }
  try {
    return editTomlTopLevel(file.text ?? '', set, unset)
  } catch (err) {
    if (err instanceof TomlUnsupportedValueError) {
      throw new EngineSettingsError(409, `refusing to write ${file.path}: ${err.message}. Edit that line by hand first.`)
    }
    throw err
  }
}

export async function writeEngineSettings(
  engineId: string, host: string, patch: EngineSettingsPatch, transport: SettingsFileTransport,
): Promise<EngineSettingsView & { changed: string[] }> {
  const { engine, displayName, schema } = schemaFor(engineId)
  const changes = planChanges(schema, patch)

  const byFile = new Map<string, PlannedChange[]>()
  for (const c of changes) {
    const list = byFile.get(c.item.file) ?? []
    list.push(c)
    byFile.set(c.item.file, list)
  }

  // True once any file in this patch has been replaced on disk: from then on a
  // failure is reported as 'written', never as a refusal the client may undo.
  let written = false
  for (const [fileId, fileChanges] of byFile) {
    const decl = schema.files.find((f) => f.id === fileId)!
    // One retry: the engine rewrote the file between our read and our write
    // (running CLIs do this on their own schedule). A second loss is reported,
    // never overwritten.
    for (let attempt = 0; attempt < 2; attempt++) {
      let current: LoadedFile
      let next: string
      try {
        current = await loadFile(decl, transport)
        // Removing keys from a file that does not exist is already done; creating
        // an empty `{}` to prove it would be a write the user never asked for.
        if (!current.exists && fileChanges.every((c) => c.value === undefined)) break
        next = applyToFile(current, fileChanges)
      } catch (err) {
        // A second file's refusal after the first file landed is a partial save.
        if (written && err instanceof EngineSettingsError) throw new EngineSettingsError(err.status, err.message, 'written')
        throw err
      }
      if (current.text !== null && next === current.text) break
      try {
        await transport.writeAtomic(current.path, next, current.sha)
        written = true
        break
      } catch (err) {
        if (isModifiedError(err) && attempt === 0) continue
        if (isModifiedError(err)) {
          throw new EngineSettingsError(409, `${current.path} was changed by another program while saving. Try again.`, written ? 'written' : 'not-written')
        }
        if (isUpgradeError(err)) throw err
        // The daemon may have renamed the file before the transport died, and an
        // earlier file in this same patch may already be on disk.
        throw new EngineSettingsError(502, `could not write ${current.path}: ${err instanceof Error ? err.message : String(err)}`, 'unknown')
      }
    }
  }

  let files: Map<string, LoadedFile>
  try {
    files = await loadAll(schema, transport)
  } catch (err) {
    if (!written || isUpgradeError(err)) throw err
    const message = err instanceof Error ? err.message : String(err)
    throw new EngineSettingsError(502, `saved, but reading the file back failed: ${message}`, 'written')
  }
  return { ...buildView(engine, displayName, host, schema, files, transport.env), changed: changes.map((c) => c.item.key) }
}
