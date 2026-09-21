/**
 * Engine settings schema: every registered engine's declared settings are
 * structurally sound (a typo in a data file fails here, not in a rendered row),
 * and the value validator enforces what the schema declares.
 */
import { describe, it, expect } from 'vitest'
import { ENGINE_REGISTRY } from '../../src/core/agents/engine-registry.js'
import { CLAUDE_SETTINGS } from '../../src/core/agents/engine-settings/claude.js'
import { CODEX_SETTINGS } from '../../src/core/agents/engine-settings/codex.js'
import {
  findSchemaItem,
  schemaItems,
  schemaProblems,
  validateSettingValue,
  type EngineSettingItem,
} from '../../src/core/agents/engine-settings-schema.js'

describe('engine settings schema: registry data', () => {
  it('every engine that declares settings declares a problem-free schema', () => {
    for (const caps of ENGINE_REGISTRY.values()) {
      if (!caps.settings) continue
      expect(schemaProblems(caps.settings), `${caps.id} schema`).toEqual([])
    }
  })

  it('claude and codex have a settings surface; the other ACP engines do not inherit codex\'s', () => {
    expect(ENGINE_REGISTRY.get('claude')?.settings).toBe(CLAUDE_SETTINGS)
    expect(ENGINE_REGISTRY.get('codex')?.settings).toBe(CODEX_SETTINGS)
    for (const id of ['gemini', 'opencode', 'goose', 'pi', 'dsh', 'custom'] as const) {
      expect(ENGINE_REGISTRY.get(id)?.settings, id).toBeUndefined()
    }
  })

  it('claude covers the /config rows that shape a -p session', () => {
    const keys = new Set(schemaItems(CLAUDE_SETTINGS).map((i) => i.key))
    for (const key of [
      'alwaysThinkingEnabled', 'autoCompactEnabled', 'verbose', 'permissions.defaultMode',
      'outputStyle', 'language', 'model', 'enableWorkflows', 'workflowKeywordTriggerEnabled',
      'workflowSizeGuideline', 'useAutoModeDuringPlan', 'worktree.baseRef', 'autoUpdatesChannel',
      'theme', 'editorMode', 'preferredNotifChannel', 'askUserQuestionTimeout',
    ]) {
      expect(keys.has(key), key).toBe(true)
    }
  })

  it('claude writes to the user file except the terminal preferences the CLI keeps in ~/.claude.json', () => {
    const globalKeys = schemaItems(CLAUDE_SETTINGS).filter((i) => i.file === 'global').map((i) => i.key)
    expect(globalKeys).toEqual(expect.arrayContaining(['respectGitignore', 'copyOnSelect', 'leftArrowOpensAgents', 'autoUpdates', 'workflowSizeGuideline']))
    // The sixteen keys the CLI migrated out of ~/.claude.json still read from
    // there as a fallback: each declares it as legacy, none writes there.
    for (const key of ['theme', 'editorMode', 'verbose', 'autoCompactEnabled', 'showTurnDuration', 'teammateMode']) {
      const item = findSchemaItem(CLAUDE_SETTINGS, key)!
      expect(item.file).toBe('user')
      expect(item.legacy).toEqual({ file: 'global', path: key })
    }
  })

  it("claude declares the project layers the way the CLI reads them: local over shared, shared never written", () => {
    const byId = new Map(CLAUDE_SETTINGS.files.map((f) => [f.id, f]))
    expect(byId.get('project')).toMatchObject({ path: '<cwd>/.claude/settings.json', scope: 'project', readOnly: true })
    expect(byId.get('project-local')).toMatchObject({ path: '<cwd>/.claude/settings.local.json', scope: 'project' })
    expect(byId.get('project-local')!.readOnly).toBeUndefined()
    // The layers belong to the settings.json family only; ~/.claude.json has none.
    expect(byId.get('user')!.overlays).toEqual(['project-local', 'project'])
    expect(byId.get('global')!.overlays).toBeUndefined()
    // The four rows the CLI's own screen writes to the project's local file.
    const local = schemaItems(CLAUDE_SETTINGS).filter((i) => i.cliWritesTo !== undefined).map((i) => [i.key, i.cliWritesTo])
    expect(local).toEqual([['outputStyle', 'project-local'], ['spinnerTipsEnabled', 'project-local'], ['prefersReducedMotion', 'project-local'], ['defaultView', 'project-local']])
    // Codex has no project layer at all, so "this project only" is not offered for it.
    expect(CODEX_SETTINGS.files.every((f) => f.overlays === undefined)).toBe(true)
  })

  it('claude\'s permission mode row says Walnut sessions are unaffected (they pass --permission-mode)', () => {
    const item = findSchemaItem(CLAUDE_SETTINGS, 'permissions.defaultMode')!
    expect(item.help).toMatch(/--permission-mode/)
    expect(item.options!.map((o) => o.value)).toEqual(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'])
  })

  it('codex declares top-level TOML keys only', () => {
    for (const item of schemaItems(CODEX_SETTINGS)) {
      expect(item.path, item.key).not.toContain('.')
      expect(item.file).toBe('config')
    }
    expect(CODEX_SETTINGS.files[0].format).toBe('toml-top-level')
  })

  it('help text follows the docs rules: no em or en dashes', () => {
    for (const schema of [CLAUDE_SETTINGS, CODEX_SETTINGS]) {
      for (const item of schemaItems(schema)) {
        expect(item.help, item.key).not.toMatch(/[–—]/)
        expect(item.label, item.key).not.toMatch(/[–—]/)
      }
      for (const g of schema.groups) expect(g.help).not.toMatch(/[–—]/)
      expect(schema.note ?? '').not.toMatch(/[–—]/)
    }
  })
})

describe('engine settings schema: validateSettingValue', () => {
  const bool: EngineSettingItem = { key: 'b', label: 'B', help: 'h', type: 'boolean', default: true, file: 'f', path: 'b', scope: 'sessions' }
  const sel: EngineSettingItem = { key: 's', label: 'S', help: 'h', type: 'select', default: 'a', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], file: 'f', path: 's', scope: 'sessions' }
  const selCustom: EngineSettingItem = { ...sel, key: 'sc', allowCustom: true }
  const text: EngineSettingItem = { key: 't', label: 'T', help: 'h', type: 'text', default: '', file: 'f', path: 't', scope: 'sessions' }
  const num: EngineSettingItem = { key: 'n', label: 'N', help: 'h', type: 'number', default: 1, min: 0, max: 10, file: 'f', path: 'n', scope: 'sessions' }

  it('accepts declared shapes and rejects the rest with a key-specific message', () => {
    expect(validateSettingValue(bool, false)).toBeNull()
    expect(validateSettingValue(bool, 'false')).toMatch(/b must be true or false/)
    expect(validateSettingValue(sel, 'b')).toBeNull()
    expect(validateSettingValue(sel, 'zzz')).toMatch(/must be one of: a, b/)
    expect(validateSettingValue(selCustom, 'zzz')).toBeNull()
    expect(validateSettingValue(sel, 7)).toMatch(/must be a string/)
    expect(validateSettingValue(text, 'anything')).toBeNull()
    expect(validateSettingValue(text, 'x'.repeat(5000))).toMatch(/too long/)
    expect(validateSettingValue(num, 5)).toBeNull()
    expect(validateSettingValue(num, 11)).toMatch(/at most 10/)
    expect(validateSettingValue(num, -1)).toMatch(/at least 0/)
    expect(validateSettingValue(num, Number.NaN)).toMatch(/must be a number/)
  })

  it('schemaProblems catches the mistakes a data file can make', () => {
    const problems = schemaProblems({
      files: [{ id: 'f', path: 'no-tilde.json', format: 'json', label: 'x' }, { id: 'f', path: '~/dup.json', format: 'json', label: 'y' }],
      groups: [
        { id: 'g', title: 'G', help: 'h', items: [
          { ...bool, key: 'dup' }, { ...bool, key: 'dup' },
          { ...bool, key: 'orphan', file: 'nope' },
          { ...sel, key: 'nooptions', options: [] },
          { ...sel, key: 'baddefault', default: 'zzz' },
          { ...bool, key: 'boolopts', options: [{ value: 'a', label: 'A' }] },
          { ...bool, key: 'nohelp', help: '   ' },
          { ...bool, key: 'badpath', path: 'a..b' },
        ] },
        { id: 'g', title: 'G2', help: 'h', items: [] },
      ],
    })
    expect(problems).toEqual(expect.arrayContaining([
      expect.stringContaining('path must start with ~/'),
      expect.stringContaining("duplicate file id 'f'"),
      expect.stringContaining("duplicate item key 'dup'"),
      expect.stringContaining("unknown file 'nope'"),
      expect.stringContaining("select 'nooptions' has no options"),
      expect.stringContaining("default 'zzz' is not one of its options"),
      expect.stringContaining("boolean 'boolopts' must not declare options"),
      expect.stringContaining("item 'nohelp' has no help text"),
      expect.stringContaining("item 'badpath' has an empty path segment"),
      expect.stringContaining("duplicate group id 'g'"),
    ]))
  })

  it('schemaProblems pins the project-layer rules', () => {
    const problems = schemaProblems({
      files: [
        { id: 'user', path: '~/x.json', format: 'json', label: 'u', overlays: ['ro', 'ghost', 'other'] },
        { id: 'other', path: '~/y.json', format: 'json', label: 'o' },
        { id: 'proj', path: '~/not-cwd.json', format: 'json', label: 'p', scope: 'project', homeEnv: { name: 'X', replaces: '~' }, overlays: ['ro'] },
        { id: 'ro', path: '<cwd>/.x/ro.json', format: 'json', label: 'r', scope: 'project', readOnly: true },
      ],
      groups: [{ id: 'g', title: 'G', help: 'h', items: [
        { ...bool, key: 'intoproject', file: 'proj' },
        { ...bool, key: 'badcli', file: 'user', cliWritesTo: 'nowhere' },
        { ...bool, key: 'rocli', file: 'user', cliWritesTo: 'ro' },
        { ...bool, key: 'othercli', file: 'other', cliWritesTo: 'ro' },
      ] }],
    })
    expect(problems).toEqual(expect.arrayContaining([
      expect.stringContaining("project file 'proj' path must start with <cwd>/"),
      expect.stringContaining("project file 'proj' cannot declare homeEnv"),
      expect.stringContaining("project file 'proj' cannot declare overlays of its own"),
      expect.stringContaining("file 'user' overlays reference unknown file 'ghost'"),
      expect.stringContaining("file 'user' overlay 'other' is not project-scoped"),
      expect.stringContaining("file 'user' has no writable overlay"),
      expect.stringContaining("item 'intoproject' must be written to a user-scoped file"),
      expect.stringContaining("item 'badcli' cliWritesTo 'nowhere' is not an overlay of 'user'"),
      expect.stringContaining("item 'rocli' cliWritesTo 'ro' is read-only"),
      // A CLI target must layer over the item's OWN file, not just any file's.
      expect.stringContaining("item 'othercli' cliWritesTo 'ro' is not an overlay of 'other'"),
    ]))
  })
})
