/**
 * Engine settings schema: the engine-agnostic vocabulary for "the settings a
 * coding-agent engine keeps in its OWN config files" (what `claude`'s /config
 * screen edits, what codex reads from ~/.codex/config.toml).
 *
 * An engine declares a schema on its registry descriptor (`caps.settings`);
 * the service in engine-settings-service.ts reads and writes the declared files
 * on the host where that engine's sessions run, and the web UI renders every
 * engine from the same descriptor shape. Adding a setting means adding one
 * entry to the engine's data file, never a new branch anywhere else.
 *
 * Contract rules the shape encodes:
 *   - Values live in files the ENGINE owns. Walnut only ever edits the declared
 *     `path` inside them and must leave every other byte of meaning intact
 *     (deep merge for JSON, line-level edits for TOML); these files also hold
 *     hooks, permission allowlists and model overrides that were never ours.
 *   - `default` is what the engine does when the key is absent. `null` means
 *     "engine-decided, Walnut cannot name it" (a plan-gated feature, say); the
 *     UI then shows the value as unset instead of inventing one.
 *   - `env` lists variables that override the stored value at runtime. The
 *     service reports them so the UI can say "set by env: X" instead of
 *     letting a toggle look effective when it is not.
 */

export type EngineSettingsFileFormat = 'json' | 'toml-top-level'

/** Placeholder in a project-scoped file's path, replaced by the session's working directory. */
export const CWD_PLACEHOLDER = '<cwd>'

export interface EngineSettingsFile {
  /** Stable id items reference (e.g. 'user', 'global', 'config'). */
  readonly id: string
  /**
   * Posix path: a leading `~` (the daemon expands it on the target host) or, for
   * a project-scoped file, a leading `<cwd>` (replaced by the working directory
   * of the session being configured; without one the file is not consulted).
   */
  readonly path: string
  readonly format: EngineSettingsFileFormat
  /** Short human label ("user settings"). */
  readonly label: string
  /**
   * Environment variable that relocates the file's directory (CLAUDE_CONFIG_DIR,
   * CODEX_HOME). When set in the engine's runtime environment, `replaces` (a
   * prefix of `path`) is swapped for its value before any read or write.
   */
  readonly homeEnv?: { readonly name: string; readonly replaces: string }
  /**
   * 'project' = lives under the working directory and applies to that project
   * only. Absent = 'user': one file per host, every directory.
   */
  readonly scope?: 'user' | 'project'
  /**
   * Read for attribution, never written. A project's SHARED settings file is
   * committed with the repo; Walnut overrides it through the local file instead
   * of editing a teammate's checked-in choices.
   */
  readonly readOnly?: boolean
  /**
   * Project-scoped files that layer over THIS file for the same keys, highest
   * precedence first (Claude: local before shared). Declared on the file, not
   * the schema, because a layer is a property of one file family: a key kept in
   * `~/.claude.json` has no project file the engine would read it from, so a
   * "this project only" write for it must be refused rather than land somewhere
   * the engine never looks. The first writable overlay is where such a write goes.
   */
  readonly overlays?: readonly string[]
}

/**
 * Who reads the setting. 'sessions' = the engine's non-interactive runtime that
 * Walnut drives honors it; 'terminal' = only the engine's own interactive UI
 * does (still worth editing here: it is the same file the user's terminal
 * reads); 'updates' = the engine's self-updater.
 */
export type EngineSettingScope = 'sessions' | 'terminal' | 'updates'

export type EngineSettingType = 'boolean' | 'select' | 'text' | 'number'

export type EngineSettingValue = boolean | string | number

export interface EngineSettingOption {
  readonly value: string
  readonly label: string
  readonly help?: string
}

export interface EngineSettingItem {
  /** Stable key, unique within the engine. PATCH bodies address settings by it. */
  readonly key: string
  readonly label: string
  /** One or two plain sentences: what it does, and any Walnut-specific caveat. */
  readonly help: string
  readonly type: EngineSettingType
  /** `select` only. */
  readonly options?: readonly EngineSettingOption[]
  /** `select` only: accept a value outside `options` (custom themes, model ids). */
  readonly allowCustom?: boolean
  /** Engine behavior when the key is absent; null when Walnut cannot name it. */
  readonly default: EngineSettingValue | null
  /** Overrides how the default reads in the UI ("on, unless MAX_THINKING_TOKENS=0"). */
  readonly defaultLabel?: string
  /** EngineSettingsFile.id the value is written to. */
  readonly file: string
  /** Dotted path inside that file ('permissions.defaultMode'). */
  readonly path: string
  /** Where older engine versions kept the value; read fallback only, never written. */
  readonly legacy?: { readonly file: string; readonly path: string }
  /** Environment variables that override the stored value when set. */
  readonly env?: readonly string[]
  readonly scope: EngineSettingScope
  /**
   * The engine's OWN config screen writes this key to a project-scoped file (one
   * of `file`'s `overlays`) rather than to `file`. With a working directory
   * known, Walnut's default scope follows it; without one the key goes to `file`
   * as the user-wide default.
   */
  readonly cliWritesTo?: string
  /** Overrides the schema's `appliesOn` for a key the engine reads only at startup. */
  readonly appliesOn?: EngineSettingAppliesOn
  /**
   * What Walnut itself passes at launch that outranks the stored value for the
   * sessions it drives (a CLI flag such as `--permission-mode`, an environment
   * variable it sets). Such a row still edits the engine's file, but the change
   * is felt by terminal sessions only; the UI says so instead of offering a
   * switch that changes nothing for the session it sits in.
   */
  readonly launchOverride?: string
  /** `text` only: completions offered by the input (not an allowlist). */
  readonly suggestions?: readonly string[]
  readonly placeholder?: string
  /** `number` only. */
  readonly min?: number
  readonly max?: number
}

export interface EngineSettingsGroup {
  readonly id: string
  readonly title: string
  readonly help: string
  readonly items: readonly EngineSettingItem[]
}

/**
 * When a saved value is felt: 'next-turn' = a running session of this engine
 * reloads its files and honours the change on its next turn; 'new-session' =
 * only sessions started after the save see it.
 */
export type EngineSettingAppliesOn = 'next-turn' | 'new-session'

export interface EngineSettingsSchema {
  readonly files: readonly EngineSettingsFile[]
  readonly groups: readonly EngineSettingsGroup[]
  /** One plain sentence shown under the engine's tab (where the file lives, how it is picked up). */
  readonly note?: string
  /** Engine-wide answer to "when does a change apply"; an item may override it. */
  readonly appliesOn?: EngineSettingAppliesOn
}

/** The overlays declared on a file, as file declarations, highest precedence first. */
export function fileOverlays(schema: EngineSettingsSchema, fileId: string): EngineSettingsFile[] {
  const file = schema.files.find((f) => f.id === fileId)
  return (file?.overlays ?? [])
    .map((id) => schema.files.find((f) => f.id === id))
    .filter((f): f is EngineSettingsFile => f !== undefined)
}

/** Whether any file of the schema has a writable project overlay (the "this project only" scope exists at all). */
export function schemaHasProjectScope(schema: EngineSettingsSchema): boolean {
  return schema.files.some((f) => fileOverlays(schema, f.id).some((o) => o.scope === 'project' && !o.readOnly))
}

/** Whether a file's path needs a working directory to resolve. */
export function fileNeedsCwd(file: EngineSettingsFile): boolean {
  return file.path.startsWith(CWD_PLACEHOLDER + '/')
}

/** Every item of a schema, in declaration order. */
export function schemaItems(schema: EngineSettingsSchema): EngineSettingItem[] {
  return schema.groups.flatMap((g) => [...g.items])
}

export function findSchemaItem(schema: EngineSettingsSchema, key: string): EngineSettingItem | undefined {
  for (const group of schema.groups) {
    const hit = group.items.find((i) => i.key === key)
    if (hit) return hit
  }
  return undefined
}

/**
 * Validate a value the client wants to store. Returns an error message, or null
 * when the value is acceptable for the item's declared type.
 */
export function validateSettingValue(item: EngineSettingItem, value: unknown): string | null {
  switch (item.type) {
    case 'boolean':
      return typeof value === 'boolean' ? null : `${item.key} must be true or false`
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${item.key} must be a number`
      if (item.min !== undefined && value < item.min) return `${item.key} must be at least ${item.min}`
      if (item.max !== undefined && value > item.max) return `${item.key} must be at most ${item.max}`
      return null
    }
    case 'text': {
      if (typeof value !== 'string') return `${item.key} must be a string`
      if (value.length > 4096) return `${item.key} is too long`
      return null
    }
    case 'select': {
      if (typeof value !== 'string') return `${item.key} must be a string`
      if (value.length > 256) return `${item.key} is too long`
      const known = (item.options ?? []).some((o) => o.value === value)
      if (known || item.allowCustom) return null
      const allowed = (item.options ?? []).map((o) => o.value).join(', ')
      return `${item.key} must be one of: ${allowed}`
    }
  }
}

/**
 * Structural problems in a declared schema. A test pins this to an empty list
 * for every registered engine, so a typo in a data file fails the build
 * instead of rendering a broken row.
 */
export function schemaProblems(schema: EngineSettingsSchema): string[] {
  const problems: string[] = []
  const fileIds = new Set<string>()
  const byId = new Map<string, EngineSettingsFile>()
  for (const file of schema.files) {
    if (fileIds.has(file.id)) problems.push(`duplicate file id '${file.id}'`)
    fileIds.add(file.id)
    byId.set(file.id, file)
    const project = file.scope === 'project'
    if (project && !fileNeedsCwd(file)) problems.push(`project file '${file.id}' path must start with ${CWD_PLACEHOLDER}/ (got '${file.path}')`)
    if (!project && !file.path.startsWith('~/')) problems.push(`file '${file.id}' path must start with ~/ (got '${file.path}')`)
    if (project && file.homeEnv) problems.push(`project file '${file.id}' cannot declare homeEnv`)
  }
  for (const file of schema.files) {
    const overlays = file.overlays ?? []
    if (overlays.length === 0) continue
    if (file.scope === 'project') problems.push(`project file '${file.id}' cannot declare overlays of its own`)
    for (const id of overlays) {
      const f = byId.get(id)
      if (!f) problems.push(`file '${file.id}' overlays reference unknown file '${id}'`)
      else if (f.scope !== 'project') problems.push(`file '${file.id}' overlay '${id}' is not project-scoped`)
    }
    if (!overlays.some((id) => byId.get(id)?.scope === 'project' && !byId.get(id)!.readOnly)) {
      problems.push(`file '${file.id}' has no writable overlay, so "this project only" could never save its keys`)
    }
  }
  const keys = new Set<string>()
  const groupIds = new Set<string>()
  for (const group of schema.groups) {
    if (groupIds.has(group.id)) problems.push(`duplicate group id '${group.id}'`)
    groupIds.add(group.id)
    for (const item of group.items) {
      if (keys.has(item.key)) problems.push(`duplicate item key '${item.key}'`)
      keys.add(item.key)
      if (!fileIds.has(item.file)) problems.push(`item '${item.key}' references unknown file '${item.file}'`)
      else if (byId.get(item.file)!.scope === 'project') problems.push(`item '${item.key}' must be written to a user-scoped file, not '${item.file}'`)
      if (item.legacy && !fileIds.has(item.legacy.file)) problems.push(`item '${item.key}' legacy references unknown file '${item.legacy.file}'`)
      if (item.cliWritesTo !== undefined) {
        const own = byId.get(item.file)?.overlays ?? []
        if (!own.includes(item.cliWritesTo)) problems.push(`item '${item.key}' cliWritesTo '${item.cliWritesTo}' is not an overlay of '${item.file}'`)
        else if (byId.get(item.cliWritesTo)?.readOnly) problems.push(`item '${item.key}' cliWritesTo '${item.cliWritesTo}' is read-only`)
      }
      if (!item.path || item.path.split('.').some((seg) => seg.length === 0)) problems.push(`item '${item.key}' has an empty path segment`)
      if (item.type === 'select') {
        if (!item.options || item.options.length === 0) problems.push(`select '${item.key}' has no options`)
        const values = new Set((item.options ?? []).map((o) => o.value))
        if (values.size !== (item.options ?? []).length) problems.push(`select '${item.key}' has duplicate option values`)
        if (item.default !== null && !item.allowCustom && !values.has(String(item.default))) {
          problems.push(`select '${item.key}' default '${String(item.default)}' is not one of its options`)
        }
      } else if (item.options) {
        problems.push(`${item.type} '${item.key}' must not declare options`)
      }
      if (item.default !== null) {
        const err = validateSettingValue(item, item.default)
        if (err) problems.push(`default of '${item.key}' is invalid: ${err}`)
      }
      if (!item.help.trim()) problems.push(`item '${item.key}' has no help text`)
    }
  }
  return problems
}
