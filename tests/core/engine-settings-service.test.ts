/**
 * Engine settings service over a fake transport: read attribution (file /
 * legacy / default / env), write-through that keeps every unrelated key,
 * conflict retry, refusal to write over an unreadable file, and validation.
 */
import { describe, it, expect } from 'vitest'
import {
  EngineSettingsError,
  MAX_SETTINGS_FILE_BYTES,
  SHA_ABSENT,
  readEngineSettings,
  resolveSettingsFilePath,
  sha256Hex,
  writeEngineSettings,
  type SettingsFileTransport,
} from '../../src/core/agents/engine-settings-service.js'

/**
 * In-memory host: files keyed by the path the service asks for (as BYTES, like
 * the daemon holds them); every write is recorded. The guard hashes bytes, and
 * `read` refuses with EFBIG above `maxBytes` like the real transport's
 * stat-before-read does.
 */
class FakeHost implements SettingsFileTransport {
  files = new Map<string, Buffer>()
  writes: Array<{ path: string; text: string; expectSha256: string }> = []
  /** Rewrite a file right before the Nth write lands, to simulate a concurrent editor. */
  raceOnWrite: Array<(path: string) => void> = []
  /** Make the read-back after a write fail, to simulate a tunnel that died after the rename. */
  failReadsAfterWrite = false
  env?: Record<string, string | undefined>

  constructor(files: Record<string, string | Buffer> = {}, env?: Record<string, string | undefined>) {
    for (const [p, t] of Object.entries(files)) this.set(p, t)
    this.env = env
  }

  set(path: string, text: string | Buffer): void {
    this.files.set(path, typeof text === 'string' ? Buffer.from(text, 'utf-8') : text)
  }

  text(path: string): string | undefined {
    return this.files.get(path)?.toString('utf-8')
  }

  async read(path: string, maxBytes: number): Promise<Buffer | null> {
    if (this.failReadsAfterWrite && this.writes.length > 0) throw new Error('fs.read transport failure: socket closed')
    const bytes = this.files.get(path)
    if (bytes === undefined) return null
    if (bytes.length > maxBytes) throw new Error(`file is ${bytes.length} bytes, larger than the ${maxBytes}-byte limit for this read (EFBIG)`)
    return bytes
  }

  async writeAtomic(path: string, text: string, expectSha256: string): Promise<void> {
    const race = this.raceOnWrite.shift()
    if (race) race(path)
    const current = this.files.has(path) ? sha256Hex(this.files.get(path)!) : SHA_ABSENT
    if (current !== expectSha256) throw new Error('fs.write refused: file changed since it was read (EMODIFIED)')
    this.writes.push({ path, text, expectSha256 })
    this.set(path, text)
  }
}

const USER = '~/.claude/settings.json'
const GLOBAL = '~/.claude.json'

const REAL_SHAPE = {
  cleanupPeriodDays: 99999,
  env: { AWS_REGION: 'us-west-2', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000' },
  includeCoAuthoredBy: false,
  permissions: { defaultMode: 'bypassPermissions', allow: ['Bash(git *)', 'Read'], deny: ['WebFetch'] },
  model: 'global.anthropic.claude-opus-5[1m]',
  availableModels: ['claude-opus-5[1m]', 'haiku'],
  modelOverrides: { 'claude-opus-5': 'global.anthropic.claude-opus-5[1m]' },
  hooks: { PreToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: '~/guard.sh' }] }] },
  statusLine: { type: 'command', command: 'walnut statusline' },
  enabledPlugins: { 'foo@bar': true },
  outputStyle: 'Explanatory',
  language: 'Chinese',
  alwaysThinkingEnabled: true,
  verbose: false,
}

const itemOf = (view: Awaited<ReturnType<typeof readEngineSettings>>, key: string) => {
  for (const g of view.groups) {
    const hit = g.items.find((i) => i.key === key)
    if (hit) return hit
  }
  throw new Error(`no item ${key}`)
}

describe('engine settings service: read', () => {
  it('attributes each value to the file, the legacy location, or the default', async () => {
    const host = new FakeHost({
      [USER]: JSON.stringify(REAL_SHAPE, null, 2),
      [GLOBAL]: JSON.stringify({ numStartups: 5, theme: 'light', editorMode: 'vim', respectGitignore: false }),
    })
    const view = await readEngineSettings('claude', '__local__', host)
    expect(view.engine).toBe('claude')
    expect(view.files.map((f) => [f.id, f.exists])).toEqual([['user', true], ['global', true]])
    expect(view.envChecked).toBe(false)

    expect(itemOf(view, 'permissions.defaultMode')).toMatchObject({ value: 'bypassPermissions', source: 'file' })
    expect(itemOf(view, 'outputStyle')).toMatchObject({ value: 'Explanatory', source: 'file' })
    expect(itemOf(view, 'language')).toMatchObject({ value: 'Chinese', source: 'file' })
    expect(itemOf(view, 'verbose')).toMatchObject({ value: false, source: 'file' })
    // Absent from the user file, present in the legacy global file.
    expect(itemOf(view, 'theme')).toMatchObject({ value: 'light', source: 'legacy', legacy: { file: 'global', path: GLOBAL } })
    expect(itemOf(view, 'editorMode')).toMatchObject({ value: 'vim', source: 'legacy' })
    // A file-sourced value names no legacy location.
    expect(itemOf(view, 'verbose').legacy).toBeUndefined()
    // A global-file key read from its own file.
    expect(itemOf(view, 'respectGitignore')).toMatchObject({ value: false, source: 'file' })
    // Absent everywhere: the declared default.
    expect(itemOf(view, 'autoCompactEnabled')).toMatchObject({ value: true, source: 'default' })
    expect(itemOf(view, 'enableWorkflows')).toMatchObject({ value: null, source: 'default', defaultLabel: 'decided by your plan' })
  })

  it('reports environment overrides only when the host env is known, and relocates files by CLAUDE_CONFIG_DIR', async () => {
    const env = { DISABLE_AUTOUPDATER: '1', MAX_THINKING_TOKENS: '', CLAUDE_CONFIG_DIR: '/srv/claude-cfg' }
    const host = new FakeHost({
      '/srv/claude-cfg/settings.json': JSON.stringify({ alwaysThinkingEnabled: false }),
      '/srv/claude-cfg/.claude.json': JSON.stringify({ autoUpdates: false }),
    }, env)
    const view = await readEngineSettings('claude', '__local__', host)
    expect(view.envChecked).toBe(true)
    expect(view.files.map((f) => f.path)).toEqual(['/srv/claude-cfg/settings.json', '/srv/claude-cfg/.claude.json'])
    expect(itemOf(view, 'autoUpdates')).toMatchObject({ value: false, source: 'file', envOverride: { name: 'DISABLE_AUTOUPDATER', value: '1' } })
    expect(itemOf(view, 'autoUpdatesChannel').envOverride).toEqual({ name: 'DISABLE_AUTOUPDATER', value: '1' })
    // An EMPTY variable is not an override.
    expect(itemOf(view, 'alwaysThinkingEnabled')).toMatchObject({ value: false, source: 'file' })
    expect(itemOf(view, 'alwaysThinkingEnabled').envOverride).toBeUndefined()
  })

  it('treats missing files as defaults and an unparsable file as unreadable without failing the view', async () => {
    const host = new FakeHost({ [GLOBAL]: '{ not json' })
    const view = await readEngineSettings('claude', '__local__', host)
    expect(view.files[0]).toMatchObject({ id: 'user', exists: false })
    expect(view.files[1]).toMatchObject({ id: 'global', exists: true })
    expect(view.files[1].error).toMatch(/not valid JSON/)
    expect(itemOf(view, 'respectGitignore')).toMatchObject({ value: true, source: 'default' })
    expect(itemOf(view, 'respectGitignore').invalid).toMatch(/file unreadable/)
    expect(itemOf(view, 'alwaysThinkingEnabled')).toMatchObject({ value: true, source: 'default' })
  })

  it('flags a stored value of the wrong type instead of rendering it as something it is not', async () => {
    const host = new FakeHost({ [USER]: JSON.stringify({ verbose: 'yes', permissions: { defaultMode: ['plan'] } }) })
    const view = await readEngineSettings('claude', '__local__', host)
    expect(itemOf(view, 'verbose')).toMatchObject({ value: false, source: 'file' })
    expect(itemOf(view, 'verbose').invalid).toMatch(/stored value is string, expected boolean/)
    expect(itemOf(view, 'permissions.defaultMode').invalid).toMatch(/is an array/)
  })

  it('answers 404 for engines without a settings surface and for unknown engines', async () => {
    await expect(readEngineSettings('gemini', '__local__', new FakeHost())).rejects.toMatchObject({ status: 404 })
    await expect(readEngineSettings('nope', '__local__', new FakeHost())).rejects.toMatchObject({ status: 404 })
  })

  it('reads codex top-level TOML values', async () => {
    const toml = 'model = "openai.gpt-5.6-sol"\nmodel_reasoning_effort = "max"\napproval_policy = "never"\n\n[projects."/x"]\ntrust_level = "trusted"\n'
    const view = await readEngineSettings('codex', '__local__', new FakeHost({ '~/.codex/config.toml': toml }))
    expect(itemOf(view, 'model')).toMatchObject({ value: 'openai.gpt-5.6-sol', source: 'file' })
    expect(itemOf(view, 'model_reasoning_effort')).toMatchObject({ value: 'max', source: 'file' })
    expect(itemOf(view, 'sandbox_mode')).toMatchObject({ value: 'read-only', source: 'default' })
  })
})

describe('engine settings service: write', () => {
  it('changes only the addressed keys and keeps hooks, allowlists and unknown keys byte-for-byte', async () => {
    const original = JSON.stringify(REAL_SHAPE, null, 2)
    const host = new FakeHost({ [USER]: original })
    const result = await writeEngineSettings('claude', '__local__', {
      set: { 'permissions.defaultMode': 'plan', alwaysThinkingEnabled: false, 'worktree.baseRef': 'head' },
    }, host)
    expect(result.changed.sort()).toEqual(['alwaysThinkingEnabled', 'permissions.defaultMode', 'worktree.baseRef'])
    expect(host.writes).toHaveLength(1)
    expect(host.writes[0].expectSha256).toBe(sha256Hex(original))
    const after = JSON.parse(host.text(USER)!)
    const expected = { ...REAL_SHAPE, alwaysThinkingEnabled: false, worktree: { baseRef: 'head' } }
    expected.permissions = { ...REAL_SHAPE.permissions, defaultMode: 'plan' }
    expect(after).toEqual(expected)
    // Key order of the untouched prefix is preserved (a review diff shows one line).
    expect(Object.keys(after).slice(0, 5)).toEqual(Object.keys(REAL_SHAPE).slice(0, 5))
    // The response is a fresh read.
    expect(itemOf(result, 'permissions.defaultMode')).toMatchObject({ value: 'plan', source: 'file' })
    expect(itemOf(result, 'worktree.baseRef')).toMatchObject({ value: 'head', source: 'file' })
  })

  it('creates a missing file with only the written key and the absent-sentinel guard', async () => {
    const host = new FakeHost()
    await writeEngineSettings('claude', '__local__', { set: { theme: 'light' } }, host)
    expect(host.writes[0]).toMatchObject({ path: USER, expectSha256: SHA_ABSENT, text: '{\n  "theme": "light"\n}' })
  })

  it('routes each key to its own file and writes each file once', async () => {
    const host = new FakeHost({ [USER]: '{}', [GLOBAL]: JSON.stringify({ numStartups: 3 }) })
    await writeEngineSettings('claude', '__local__', { set: { respectGitignore: false, copyOnSelect: false, verbose: true } }, host)
    expect(host.writes.map((w) => w.path).sort()).toEqual([GLOBAL, USER])
    expect(JSON.parse(host.text(GLOBAL)!)).toEqual({ numStartups: 3, respectGitignore: false, copyOnSelect: false })
    expect(JSON.parse(host.text(USER)!)).toEqual({ verbose: true })
  })

  it('unset removes the key; an emptied text field is an unset; the legacy value then shows through', async () => {
    const host = new FakeHost({
      [USER]: JSON.stringify({ theme: 'light', language: 'Chinese', verbose: true }),
      [GLOBAL]: JSON.stringify({ theme: 'dark-ansi' }),
    })
    const result = await writeEngineSettings('claude', '__local__', { set: { language: '   ' }, unset: ['theme'] }, host)
    expect(JSON.parse(host.text(USER)!)).toEqual({ verbose: true })
    expect(itemOf(result, 'theme')).toMatchObject({ value: 'dark-ansi', source: 'legacy' })
    expect(itemOf(result, 'language')).toMatchObject({ value: '', source: 'default' })
  })

  it('skips the write when nothing would change', async () => {
    const host = new FakeHost({ [USER]: JSON.stringify({ verbose: true }, null, 2) })
    await writeEngineSettings('claude', '__local__', { set: { verbose: true } }, host)
    expect(host.writes).toHaveLength(0)
  })

  it('retries once when the file changed underneath, merging onto the NEW content', async () => {
    const host = new FakeHost({ [USER]: JSON.stringify({ verbose: false }) })
    host.raceOnWrite.push(() => host.set(USER, JSON.stringify({ verbose: false, outputStyle: 'Learning' })))
    await writeEngineSettings('claude', '__local__', { set: { verbose: true } }, host)
    expect(host.writes).toHaveLength(1)
    expect(JSON.parse(host.text(USER)!)).toEqual({ verbose: true, outputStyle: 'Learning' })
  })

  it('reports a conflict after the second lost race instead of overwriting', async () => {
    const host = new FakeHost({ [USER]: '{}' })
    host.raceOnWrite.push(() => host.set(USER, '{"a":1}'), () => host.set(USER, '{"a":2}'))
    await expect(writeEngineSettings('claude', '__local__', { set: { verbose: true } }, host))
      .rejects.toMatchObject({ status: 409, message: expect.stringMatching(/changed by another program/) })
    expect(host.writes).toHaveLength(0)
    expect(host.text(USER)).toBe('{"a":2}')
  })

  it('refuses to write over a file it could not parse', async () => {
    const host = new FakeHost({ [USER]: '{ broken' })
    await expect(writeEngineSettings('claude', '__local__', { set: { verbose: true } }, host))
      .rejects.toMatchObject({ status: 409, message: expect.stringMatching(/refusing to write .*not valid JSON/) })
    expect(host.text(USER)).toBe('{ broken')
  })

  it('validates the whole patch before touching any file', async () => {
    const host = new FakeHost({ [USER]: '{}' })
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ set: { verbose: 'true' } }, /verbose must be true or false/],
      [{ set: { 'permissions.defaultMode': 'yolo' } }, /must be one of/],
      [{ set: { nope: 1 } }, /unknown setting 'nope'/],
      [{ unset: ['nope'] }, /unknown setting 'nope'/],
      [{ set: { verbose: true, theme: 7 } }, /theme must be a string/],
      [{}, /nothing to change/],
      [{ set: [1] }, /`set` must be an object/],
      [{ unset: 'theme' }, /`unset` must be an array/],
    ]
    for (const [patch, message] of cases) {
      await expect(writeEngineSettings('claude', '__local__', patch, host), JSON.stringify(patch))
        .rejects.toMatchObject({ status: 400, message: expect.stringMatching(message) })
    }
    expect(host.writes).toHaveLength(0)
  })

  it('accepts a custom value where the schema allows one (theme custom:, output style by name)', async () => {
    const host = new FakeHost({ [USER]: '{}' })
    await writeEngineSettings('claude', '__local__', { set: { theme: 'custom:solarized', outputStyle: 'my-style' } }, host)
    expect(JSON.parse(host.text(USER)!)).toEqual({ theme: 'custom:solarized', outputStyle: 'my-style' })
  })

  it('edits codex config.toml in place and leaves tables and comments alone', async () => {
    const toml = '# mine\nmodel = "openai.gpt-5.6-sol"\nmodel_reasoning_effort = "max" # keep\nnotify = [\n  "turn-ended",\n]\n\n[projects."/x"]\ntrust_level = "trusted"\n'
    const host = new FakeHost({ '~/.codex/config.toml': toml })
    const result = await writeEngineSettings('codex', '__local__', { set: { model_reasoning_effort: 'high', sandbox_mode: 'workspace-write' }, unset: ['model'] }, host)
    expect(host.text('~/.codex/config.toml')).toBe(
      '# mine\nmodel_reasoning_effort = "high" # keep\nnotify = [\n  "turn-ended",\n]\nsandbox_mode = "workspace-write"\n\n[projects."/x"]\ntrust_level = "trusted"\n',
    )
    expect(itemOf(result, 'sandbox_mode')).toMatchObject({ value: 'workspace-write', source: 'file' })
    expect(itemOf(result, 'model')).toMatchObject({ value: '', source: 'default' })
  })

  it('lets the transport\'s daemon-upgrade error through untouched (the route maps it to 501)', async () => {
    const host = new FakeHost({ [USER]: '{}' })
    host.writeAtomic = async () => {
      const err = new Error('The Walnut daemon on box needs an upgrade')
      err.name = 'DaemonNeedsUpgradeError'
      throw err
    }
    await expect(writeEngineSettings('claude', 'box', { set: { verbose: true } }, host))
      .rejects.toMatchObject({ name: 'DaemonNeedsUpgradeError' })
  })

  it('wraps other transport failures as 502 with the path, and cannot promise the file is untouched', async () => {
    const host = new FakeHost({ [USER]: '{}' })
    host.writeAtomic = async () => { throw new Error('fs.write failed: EACCES') }
    await expect(writeEngineSettings('claude', '__local__', { set: { verbose: true } }, host))
      .rejects.toMatchObject({ status: 502, outcome: 'unknown', message: expect.stringMatching(/could not write ~\/.claude\/settings.json: fs.write failed: EACCES/) })
    expect(new EngineSettingsError(502, 'x').name).toBe('EngineSettingsError')
    expect(new EngineSettingsError(502, 'x').outcome).toBe('not-written')
  })

  it('names the outcome of every refusal as not-written (the client may put its control back)', async () => {
    const conflict = new FakeHost({ [USER]: '{}' })
    conflict.raceOnWrite.push(() => conflict.set(USER, '{"a":1}'), () => conflict.set(USER, '{"a":2}'))
    await expect(writeEngineSettings('claude', '__local__', { set: { verbose: true } }, conflict))
      .rejects.toMatchObject({ status: 409, outcome: 'not-written' })
    await expect(writeEngineSettings('claude', '__local__', { set: { verbose: 'x' } }, new FakeHost({ [USER]: '{}' })))
      .rejects.toMatchObject({ status: 400, outcome: 'not-written' })
    await expect(writeEngineSettings('claude', '__local__', { set: { verbose: true } }, new FakeHost({ [USER]: '{ broken' })))
      .rejects.toMatchObject({ status: 409, outcome: 'not-written' })
  })

  it("reports a read-back failure after a successful write as 'written', never as a refusal", async () => {
    const host = new FakeHost({ [USER]: '{}' })
    host.failReadsAfterWrite = true
    await expect(writeEngineSettings('claude', '__local__', { set: { verbose: true } }, host))
      .rejects.toMatchObject({ status: 502, outcome: 'written', message: expect.stringMatching(/^saved, but reading the file back failed/) })
    // The write DID land; a client that reverted its toggle would show the opposite of this.
    expect(JSON.parse(host.text(USER)!)).toEqual({ verbose: true })
  })

  it("marks a second file's refusal as 'written' when the first file already landed", async () => {
    const host = new FakeHost({ [USER]: '{}', [GLOBAL]: '{ broken' })
    await expect(writeEngineSettings('claude', '__local__', { set: { verbose: true, autoUpdates: false } }, host))
      .rejects.toMatchObject({ status: 409, outcome: 'written' })
    expect(JSON.parse(host.text(USER)!)).toEqual({ verbose: true })
    expect(host.text(GLOBAL)).toBe('{ broken')
  })

  it('hashes the exact bytes it read, so a stray non-UTF-8 byte does not make the file unwritable', async () => {
    // A hand-edited file with one invalid byte inside a string value: decoding
    // it yields U+FFFD, whose UTF-8 form is NOT the byte on disk. Hashing the
    // decoded text would never match the daemon's hash of the raw bytes.
    const bytes = Buffer.concat([Buffer.from('{"language": "Fran', 'utf-8'), Buffer.from([0xe7]), Buffer.from('ais"}', 'utf-8')])
    const host = new FakeHost({ [USER]: bytes })
    await writeEngineSettings('claude', '__local__', { set: { verbose: true } }, host)
    expect(host.writes).toHaveLength(1)
    expect(host.writes[0].expectSha256).toBe(sha256Hex(bytes))
    expect(JSON.parse(host.text(USER)!).verbose).toBe(true)
  })

  it('reports a file above the size ceiling as unreadable and refuses to rewrite it, without loading it', async () => {
    const host = new FakeHost({ [USER]: Buffer.alloc(MAX_SETTINGS_FILE_BYTES + 1, 0x20) })
    const view = await readEngineSettings('claude', '__local__', host)
    expect(view.files[0]).toMatchObject({ id: 'user', exists: true, error: expect.stringMatching(/larger than 4 MB/) })
    expect(itemOf(view, 'verbose').invalid).toMatch(/file unreadable/)
    await expect(writeEngineSettings('claude', '__local__', { set: { verbose: true } }, host))
      .rejects.toMatchObject({ status: 409, outcome: 'not-written' })
    expect(host.writes).toHaveLength(0)
  })

  it('refuses to replace a TOML line whose value it did not understand, and never mistakes a [ inside a string for a table', async () => {
    const toml = 'model = """\ngpt-5\n[not a table]\n"""\nmodel_reasoning_effort = "max"\n\n[projects."/x"]\ntrust_level = "trusted"\n'
    const host = new FakeHost({ '~/.codex/config.toml': toml })
    const view = await readEngineSettings('codex', '__local__', host)
    // The multi-line string is skipped as a whole; the key after it is still top-level.
    expect(itemOf(view, 'model_reasoning_effort')).toMatchObject({ value: 'max', source: 'file' })
    await expect(writeEngineSettings('codex', '__local__', { set: { model: 'gpt-6' } }, host))
      .rejects.toMatchObject({ status: 409, outcome: 'not-written', message: expect.stringMatching(/cannot change 'model' in place/) })
    expect(host.text('~/.codex/config.toml')).toBe(toml)
    // A key the scanner does understand is still editable, and lands before the table.
    await writeEngineSettings('codex', '__local__', { set: { sandbox_mode: 'read-only' } }, host)
    expect(host.text('~/.codex/config.toml')).toContain('model_reasoning_effort = "max"\nsandbox_mode = "read-only"\n\n[projects."/x"]')
  })

  it('keeps the file\'s own indentation and trailing newline (an edit is one line, not a reformat)', async () => {
    const fourSpaces = '{\n    "verbose": false,\n    "permissions": {\n        "allow": [\n            "Read"\n        ]\n    }\n}\n'
    const host = new FakeHost({ [USER]: fourSpaces })
    await writeEngineSettings('claude', '__local__', { set: { verbose: true } }, host)
    expect(host.text(USER)).toBe(fourSpaces.replace('"verbose": false', '"verbose": true'))
    const tabs = '{\n\t"verbose": false\n}'
    host.set(USER, tabs)
    await writeEngineSettings('claude', '__local__', { set: { verbose: true } }, host)
    expect(host.text(USER)).toBe('{\n\t"verbose": true\n}')
  })

  it('does not create an empty file to remove a key from a file that does not exist', async () => {
    const host = new FakeHost({})
    const result = await writeEngineSettings('claude', '__local__', { unset: ['verbose'] }, host)
    expect(host.writes).toHaveLength(0)
    expect(result.files[0]).toMatchObject({ id: 'user', exists: false })
    // But a set alongside the unset still creates the file with only that key.
    await writeEngineSettings('claude', '__local__', { set: { verbose: true }, unset: ['theme'] }, host)
    expect(JSON.parse(host.text(USER)!)).toEqual({ verbose: true })
  })
})

describe('resolveSettingsFilePath', () => {
  const file = { id: 'user', path: '~/.claude/settings.json', format: 'json' as const, label: 'x', homeEnv: { name: 'CLAUDE_CONFIG_DIR', replaces: '~/.claude' } }
  it('relocates only when the variable is set and the prefix matches', () => {
    expect(resolveSettingsFilePath(file)).toBe('~/.claude/settings.json')
    expect(resolveSettingsFilePath(file, {})).toBe('~/.claude/settings.json')
    expect(resolveSettingsFilePath(file, { CLAUDE_CONFIG_DIR: '' })).toBe('~/.claude/settings.json')
    expect(resolveSettingsFilePath(file, { CLAUDE_CONFIG_DIR: '/cfg/' })).toBe('/cfg/settings.json')
    expect(resolveSettingsFilePath({ ...file, homeEnv: { name: 'CLAUDE_CONFIG_DIR', replaces: '~/.other' } }, { CLAUDE_CONFIG_DIR: '/cfg' })).toBe('~/.claude/settings.json')
  })
})
