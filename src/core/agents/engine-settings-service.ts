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
  CWD_PLACEHOLDER,
  type EngineSettingAppliesOn,
  type EngineSettingItem,
  type EngineSettingsFile,
  type EngineSettingsSchema,
  type EngineSettingValue,
  fileNeedsCwd,
  findSchemaItem,
  schemaHasProjectScope,
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
  /**
   * Keep a file Walnut just created inside a git checkout out of the repo
   * (`.git/info/exclude`, never a tracked file). Optional: a host without it
   * reports 'unavailable' and the caller says so instead of pretending.
   */
  ensureGitExcluded?(cwd: string, path: string): Promise<GitExcludeOutcome>
  /** Runtime environment of the engine's processes on this host, when known (local host). */
  env?: Readonly<Record<string, string | undefined>>
}

export type GitExcludeOutcome = 'added' | 'already' | 'not-a-repo' | 'unavailable'

/**
 * What happened to a project file the write created: the daemon's answer, or
 * 'failed' with the reason when the exclude step itself threw. Never fatal: the
 * settings write already landed, and the UI says which of the two it is.
 */
export interface GitExcludeReport {
  path: string
  outcome: GitExcludeOutcome | 'failed'
  error?: string
}

/** Where a write goes: 'default' follows the engine's own config screen; 'project' targets the project's local file only. */
export type EngineSettingsWriteScope = 'default' | 'project'

export interface EngineSettingsContext {
  /** Working directory of the session being configured; unlocks the project layers. */
  cwd?: string
  scope?: EngineSettingsWriteScope
}

/**
 * Larger than any settings file an engine writes on purpose (~/.claude.json
 * accumulates per-project history and has been seen at 176 KB), and small enough
 * that parse + serialize + hash on the server's one event loop stays in the low
 * milliseconds. Above it the file is reported, never edited.
 */
export const MAX_SETTINGS_FILE_BYTES = 4 * 1024 * 1024

/**
 * Where the value in force comes from: the item's own file, a project overlay
 * (`overlay` names it), an older location the engine still reads (`legacy`
 * names it), or the engine's built-in default.
 */
export type EngineSettingSource = 'file' | 'overlay' | 'legacy' | 'default'

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
  /** Set when `source` is 'overlay': the project file the value was read from (path as resolved on the host). */
  overlay?: { file: string; path: string }
  /** Set when `source` is 'legacy': the older file the value was actually read from (path as resolved on the host). */
  legacy?: { file: string; path: string }
  /**
   * Where a write for this row goes under the requested scope, and whether that
   * file holds the key today (a Reset removes it from there). The client shows
   * this so a save is never a surprise about which file changed.
   */
  writeTarget: { file: string; path: string; holds: boolean }
  /**
   * A layer ABOVE the write target holds the key (a read-only shared project
   * file with nothing writable over it), so saving here would not change what
   * the engine uses. The sentence says which file to edit by hand.
   */
  overriddenBy?: { file: string; path: string }
  /** Set when an environment variable overrides the stored value. */
  envOverride?: { name: string; value: string }
  /** Set when the file holds something the schema cannot represent (wrong type, unreadable file). */
  invalid?: string
  /** When a change to this row is felt, when the engine's data says. */
  appliesOn?: EngineSettingAppliesOn
  /**
   * False when Walnut's own launch (`launchOverride` names the flag or variable)
   * outranks the stored value for the sessions it drives: the row still edits
   * the file, but only terminal sessions feel it.
   */
  honoredHere?: false
  launchOverride?: string
  /**
   * False when the view offers the project scope (`projectScopeAvailable`) but
   * this key's file has no per-project layer the engine would read, so "this
   * project only" cannot apply to it and such a write is refused.
   */
  projectLayer?: false
}

export interface EngineSettingsFileView {
  id: string
  /** Path as the engine resolves it on that host (after any homeEnv relocation). */
  path: string
  label: string
  format: EngineSettingsFile['format']
  scope: 'user' | 'project'
  readOnly: boolean
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
  /** The working directory whose project layers were consulted, when one was given. */
  cwd?: string
  /** The write scope the `writeTarget` of every row was computed for. */
  scope: EngineSettingsWriteScope
  /** The engine declares a writable project file AND a working directory is known. */
  projectScopeAvailable: boolean
  /** Engine-wide answer to "when does a change apply"; rows may carry their own. */
  appliesOn?: EngineSettingAppliesOn
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

/**
 * The path the engine resolves on this host: `homeEnv` relocation applied when
 * that variable is set; `<cwd>` replaced by the session's working directory.
 * A project file with no working directory has no path (undefined).
 */
export function resolveSettingsFilePath(
  file: EngineSettingsFile,
  env?: Readonly<Record<string, string | undefined>>,
  cwd?: string,
): string | undefined {
  if (fileNeedsCwd(file)) {
    if (!cwd) return undefined
    return cwd.replace(/\/+$/, '') + file.path.slice(CWD_PLACEHOLDER.length)
  }
  const relocation = file.homeEnv
  const dir = relocation ? env?.[relocation.name] : undefined
  if (!relocation || !dir || dir.trim() === '') return file.path
  const prefix = relocation.replaces + '/'
  if (!file.path.startsWith(prefix)) return file.path
  return dir.replace(/\/+$/, '') + '/' + file.path.slice(prefix.length)
}

/** A working directory the daemon can use as a path: absolute (or `~`-relative), no traversal. */
export function validateCwd(cwd: unknown): string | null {
  if (typeof cwd !== 'string') return null
  const trimmed = cwd.trim()
  if (!trimmed || trimmed.length > 4096) return null
  if (!(trimmed.startsWith('/') || trimmed === '~' || trimmed.startsWith('~/'))) return null
  if (trimmed.split('/').some((seg) => seg === '..')) return null
  if (trimmed.includes('\0')) return null
  return trimmed
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

async function loadFile(decl: EngineSettingsFile, transport: SettingsFileTransport, path: string): Promise<LoadedFile> {
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

/** The loaded project overlays of ONE file, highest precedence first (only those a path resolved for). */
function loadedOverlays(fileId: string, files: Map<string, LoadedFile>): LoadedFile[] {
  return (files.get(fileId)?.decl.overlays ?? []).map((id) => files.get(id)).filter((f): f is LoadedFile => f !== undefined)
}

/** The first writable project overlay of a file, when it declares one and a working directory resolved it. */
function writableOverlay(fileId: string, files: Map<string, LoadedFile>): LoadedFile | undefined {
  return loadedOverlays(fileId, files).find((f) => !f.decl.readOnly)
}

function projectScopeAvailable(schema: EngineSettingsSchema, cwd: string | undefined): boolean {
  return cwd !== undefined && schemaHasProjectScope(schema)
}

/** A working directory resolved at least one writable project overlay in this load. */
function loadedOverlaysExist(files: Map<string, LoadedFile>): boolean {
  for (const f of files.values()) if (f.decl.scope === 'project' && !f.decl.readOnly) return true
  return false
}

/**
 * The file a write for `item` goes to. 'project' scope: the writable project
 * overlay, always. 'default' scope follows the engine's own screen, with one
 * rule on top: a key that a project layer already holds is edited (or
 * overridden) THERE, so flipping the control changes what the engine uses
 * rather than a user-wide value the project keeps hiding.
 */
function writeTargetFor(
  item: EngineSettingItem, schema: EngineSettingsSchema, files: Map<string, LoadedFile>, scope: EngineSettingsWriteScope,
): LoadedFile {
  const primary = files.get(item.file)!
  const writable = writableOverlay(item.file, files)
  if (scope === 'project') {
    if (!writable) throw new EngineSettingsError(400, `'${item.key}' is kept in ${primary.decl.label}, which has no per-project layer`)
    return writable
  }
  if (!writable) return primary
  for (const overlay of loadedOverlays(item.file, files)) {
    if (storedValue(overlay, item.path) !== undefined) return overlay.decl.readOnly ? writable : overlay
  }
  if (item.cliWritesTo !== undefined) {
    const declared = files.get(item.cliWritesTo)
    if (declared && !declared.decl.readOnly) return declared
  }
  return primary
}

function viewItem(
  item: EngineSettingItem, schema: EngineSettingsSchema, files: Map<string, LoadedFile>,
  scope: EngineSettingsWriteScope, env?: SettingsFileTransport['env'],
): EngineSettingView {
  // A key whose file has no project layer keeps its own file as the target even
  // under the project scope (a write there is refused; the view still renders).
  const projectLayer = writableOverlay(item.file, files) !== undefined
  const target = writeTargetFor(item, schema, files, projectLayer ? scope : 'default')
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
    writeTarget: { file: target.decl.id, path: target.path, holds: storedValue(target, item.path) !== undefined },
    ...(item.appliesOn ?? schema.appliesOn ? { appliesOn: item.appliesOn ?? schema.appliesOn } : {}),
    ...(item.launchOverride ? { honoredHere: false as const, launchOverride: item.launchOverride } : {}),
    // Only meaningful where the project scope exists at all (a cwd resolved some overlay).
    ...(!projectLayer && loadedOverlaysExist(files) ? { projectLayer: false as const } : {}),
  }
  const primary = files.get(item.file)
  if (primary?.error) view.invalid = `file unreadable: ${primary.error}`
  if (target.error && target !== primary) view.invalid = `file unreadable: ${target.error}`

  // Precedence: project overlays (highest first), then the item's own file, then
  // the legacy fallback, then the default. The first layer holding the key wins.
  const layers: Array<{ file: LoadedFile; path: string; source: EngineSettingSource }> = [
    ...loadedOverlays(item.file, files).map((file) => ({ file, path: item.path, source: 'overlay' as const })),
    ...(primary ? [{ file: primary, path: item.path, source: 'file' as const }] : []),
  ]
  if (item.legacy) {
    const legacyFile = files.get(item.legacy.file)
    if (legacyFile) layers.push({ file: legacyFile, path: item.legacy.path, source: 'legacy' })
  }
  for (const layer of layers) {
    const raw = storedValue(layer.file, layer.path)
    if (raw === undefined) continue
    if (layer.source === 'legacy' && !typeMatches(item, raw)) continue
    view.source = layer.source
    if (layer.source === 'overlay') view.overlay = { file: layer.file.decl.id, path: layer.file.path }
    if (layer.source === 'legacy') view.legacy = { file: layer.file.decl.id, path: layer.file.path }
    if (typeMatches(item, raw)) view.value = raw
    else { view.value = item.default; view.invalid = `stored value is ${Array.isArray(raw) ? 'an array' : typeof raw}, expected ${item.type}` }
    // A layer above the write target that holds the key makes a write here inert.
    if (layer.file !== target && layers.indexOf(layer) < layers.findIndex((l) => l.file === target)) {
      view.overriddenBy = { file: layer.file.decl.id, path: layer.file.path }
    }
    break
  }
  const override = envOverrideFor(item, env)
  if (override) view.envOverride = override
  return view
}

function buildView(
  engine: SessionEngine, displayName: string, host: string, schema: EngineSettingsSchema,
  files: Map<string, LoadedFile>, env: SettingsFileTransport['env'],
  ctx: { cwd: string | undefined; scope: EngineSettingsWriteScope },
): EngineSettingsView {
  return {
    engine, displayName, host,
    ...(schema.note ? { note: schema.note } : {}),
    envChecked: env !== undefined,
    ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
    scope: ctx.scope,
    projectScopeAvailable: projectScopeAvailable(schema, ctx.cwd),
    ...(schema.appliesOn ? { appliesOn: schema.appliesOn } : {}),
    // Only the files that resolved to a path: project files drop out without a cwd.
    files: schema.files.flatMap((decl) => {
      const f = files.get(decl.id)
      if (!f) return []
      return [{
        id: decl.id, path: f.path, label: decl.label, format: decl.format,
        scope: decl.scope ?? 'user', readOnly: decl.readOnly === true, exists: f.exists,
        ...(f.error ? { error: f.error } : {}),
      }]
    }),
    groups: schema.groups.map((g) => ({
      id: g.id, title: g.title, help: g.help,
      items: g.items.map((item) => viewItem(item, schema, files, ctx.scope, env)),
    })),
  }
}

/** Every declared file that resolves to a path here: project files only when a working directory is known. */
async function loadAll(schema: EngineSettingsSchema, transport: SettingsFileTransport, cwd: string | undefined): Promise<Map<string, LoadedFile>> {
  const targets = schema.files
    .map((decl) => ({ decl, path: resolveSettingsFilePath(decl, transport.env, cwd) }))
    .filter((t): t is { decl: EngineSettingsFile; path: string } => t.path !== undefined)
  const loaded = await Promise.all(targets.map((t) => loadFile(t.decl, transport, t.path)))
  return new Map(loaded.map((f) => [f.decl.id, f]))
}

function normalizeContext(ctx: EngineSettingsContext | undefined): { cwd: string | undefined; scope: EngineSettingsWriteScope } {
  const cwd = ctx?.cwd === undefined ? undefined : validateCwd(ctx.cwd) ?? undefined
  if (ctx?.cwd !== undefined && cwd === undefined) throw new EngineSettingsError(400, 'cwd must be an absolute path without ".." segments')
  const scope = ctx?.scope ?? 'default'
  if (scope !== 'default' && scope !== 'project') throw new EngineSettingsError(400, "scope must be 'default' or 'project'")
  if (scope === 'project' && !cwd) throw new EngineSettingsError(400, "scope 'project' needs a cwd")
  return { cwd, scope }
}

export async function readEngineSettings(
  engineId: string, host: string, transport: SettingsFileTransport, ctx?: EngineSettingsContext,
): Promise<EngineSettingsView> {
  const { engine, displayName, schema } = schemaFor(engineId)
  const { cwd, scope } = normalizeContext(ctx)
  if (scope === 'project' && !projectScopeAvailable(schema, cwd)) {
    throw new EngineSettingsError(400, `engine '${engineId}' has no project-scoped settings file`)
  }
  const files = await loadAll(schema, transport, cwd)
  return buildView(engine, displayName, host, schema, files, transport.env, { cwd, scope })
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

export interface EngineSettingsWriteResult extends EngineSettingsView {
  changed: string[]
  /**
   * Set when this write CREATED a project-scoped file inside a git checkout:
   * whether it was kept out of the repo. The engine's own screen relies on a
   * global ignore rule that a custom `core.excludesFile` silently disables, so
   * Walnut pins the exclusion per repo (.git/info/exclude) and reports it.
   */
  gitExclude?: GitExcludeReport
}

export async function writeEngineSettings(
  engineId: string, host: string, patch: EngineSettingsPatch, transport: SettingsFileTransport, ctx?: EngineSettingsContext,
): Promise<EngineSettingsWriteResult> {
  const { engine, displayName, schema } = schemaFor(engineId)
  const { cwd, scope } = normalizeContext(ctx)
  const changes = planChanges(schema, patch)
  if (scope === 'project' && !projectScopeAvailable(schema, cwd)) {
    throw new EngineSettingsError(400, `engine '${engineId}' has no project-scoped settings file`)
  }

  // Which file each key goes to depends on what the layers hold right now, so
  // everything is read once up front and the plan is grouped by TARGET file.
  const before = await loadAll(schema, transport, cwd)
  const byFile = new Map<string, { decl: EngineSettingsFile; path: string; changes: PlannedChange[] }>()
  for (const c of changes) {
    const target = writeTargetFor(c.item, schema, before, scope)
    const group = byFile.get(target.decl.id) ?? { decl: target.decl, path: target.path, changes: [] }
    group.changes.push(c)
    byFile.set(target.decl.id, group)
  }

  // True once any file in this patch has been replaced on disk: from then on a
  // failure is reported as 'written', never as a refusal the client may undo.
  let written = false
  let created: { decl: EngineSettingsFile; path: string } | null = null
  for (const { decl, path, changes: fileChanges } of byFile.values()) {
    // One retry: the engine rewrote the file between our read and our write
    // (running CLIs do this on their own schedule). A second loss is reported,
    // never overwritten.
    for (let attempt = 0; attempt < 2; attempt++) {
      let current: LoadedFile
      let next: string
      try {
        // The bytes read for the plan are the ones the write guard must quote;
        // only the retry after a concurrent change needs a fresh read.
        current = attempt === 0 && before.has(decl.id) ? before.get(decl.id)! : await loadFile(decl, transport, path)
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
        if (!current.exists && decl.scope === 'project') created = { decl, path: current.path }
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

  // A project file that did not exist a moment ago may now be an untracked file
  // in the user's repo. Best effort and never fatal: the settings write landed.
  let gitExclude: GitExcludeReport | undefined
  if (created && cwd) {
    gitExclude = { path: created.path, outcome: 'unavailable' }
    if (transport.ensureGitExcluded) {
      try {
        gitExclude.outcome = await transport.ensureGitExcluded(cwd, created.path)
      } catch (err) {
        // A daemon that has the command but could not run it is a different
        // story from one that lacks it; the UI tells the two apart.
        gitExclude = { path: created.path, outcome: 'failed', error: err instanceof Error ? err.message : String(err) }
      }
    }
  }

  let files: Map<string, LoadedFile>
  try {
    files = await loadAll(schema, transport, cwd)
  } catch (err) {
    if (!written || isUpgradeError(err)) throw err
    const message = err instanceof Error ? err.message : String(err)
    throw new EngineSettingsError(502, `saved, but reading the file back failed: ${message}`, 'written')
  }
  return {
    ...buildView(engine, displayName, host, schema, files, transport.env, { cwd, scope }),
    changed: changes.map((c) => c.item.key),
    ...(gitExclude ? { gitExclude } : {}),
  }
}
