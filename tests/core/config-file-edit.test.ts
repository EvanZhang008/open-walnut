/**
 * Surgical config-file edits: JSON dotted paths keep every sibling, TOML
 * top-level edits keep comments, layout and tables byte-for-byte.
 */
import { describe, it, expect } from 'vitest'
import {
  TomlUnsupportedValueError,
  editTomlTopLevel,
  getJsonPath,
  parseJsonObject,
  readTomlTopLevel,
  serializeJsonObject,
  setJsonPath,
  unsetJsonPath,
} from '../../src/core/agents/config-file-edit.js'

describe('config-file-edit: JSON', () => {
  const settings = {
    cleanupPeriodDays: 99999,
    env: { AWS_REGION: 'us-west-2' },
    permissions: { defaultMode: 'bypassPermissions', allow: ['Bash(git *)'], deny: [] },
    hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'guard.sh' }] }] },
    modelOverrides: { 'claude-opus-5': 'global.anthropic.claude-opus-5[1m]' },
  }

  it('parses an object and refuses anything else', () => {
    expect(parseJsonObject('', 'x')).toEqual({})
    expect(parseJsonObject('  {"a":1} ', 'x')).toEqual({ a: 1 })
    expect(() => parseJsonObject('{"a":', '~/.claude/settings.json')).toThrow(/settings\.json is not valid JSON/)
    expect(() => parseJsonObject('[1]', 'x')).toThrow(/not a JSON object/)
  })

  it('reads nested paths and misses cleanly', () => {
    expect(getJsonPath(settings, 'permissions.defaultMode')).toBe('bypassPermissions')
    expect(getJsonPath(settings, 'permissions.nope')).toBeUndefined()
    expect(getJsonPath(settings, 'cleanupPeriodDays.x')).toBeUndefined()
    expect(getJsonPath(settings, 'missing.deep.path')).toBeUndefined()
  })

  it('setting a nested key keeps every sibling at every level and does not mutate the input', () => {
    const next = setJsonPath(settings, 'permissions.defaultMode', 'plan')
    expect(next.permissions).toEqual({ defaultMode: 'plan', allow: ['Bash(git *)'], deny: [] })
    expect(next.hooks).toBe(settings.hooks)
    expect(next.env).toBe(settings.env)
    expect(settings.permissions.defaultMode).toBe('bypassPermissions')
  })

  it('creates intermediate objects and replaces a scalar standing where an object belongs', () => {
    expect(setJsonPath({}, 'worktree.baseRef', 'head')).toEqual({ worktree: { baseRef: 'head' } })
    expect(setJsonPath({ worktree: 'oops' }, 'worktree.baseRef', 'head')).toEqual({ worktree: { baseRef: 'head' } })
  })

  it('unsetting removes only the leaf and is a no-op for absent paths', () => {
    const next = unsetJsonPath(settings, 'permissions.defaultMode')
    expect(next.permissions).toEqual({ allow: ['Bash(git *)'], deny: [] })
    expect(unsetJsonPath(settings, 'nope.deeper')).toBe(settings)
    expect(unsetJsonPath(settings, 'cleanupPeriodDays.x')).toBe(settings)
    expect(unsetJsonPath({ a: 1, b: 2 }, 'a')).toEqual({ b: 2 })
  })

  it('serializes the way the claude CLI writes its file: 2-space indent, key order kept, no trailing newline', () => {
    const text = serializeJsonObject({ b: 1, a: { z: true, y: [1, 2] } })
    expect(text).toBe('{\n  "b": 1,\n  "a": {\n    "z": true,\n    "y": [\n      1,\n      2\n    ]\n  }\n}')
  })

  it('follows the indentation and trailing newline of the text it replaces', () => {
    expect(serializeJsonObject({ a: 1 }, '{\n    "a": 0\n}\n')).toBe('{\n    "a": 1\n}\n')
    expect(serializeJsonObject({ a: 1 }, '{\n\t"a": 0\n}')).toBe('{\n\t"a": 1\n}')
    expect(serializeJsonObject({ a: 1 }, '{\n  "a": 0\n}')).toBe('{\n  "a": 1\n}')
    // A one-line file has no indentation to learn from: the CLI's own style.
    expect(serializeJsonObject({ a: 1 }, '{"a":0}')).toBe('{\n  "a": 1\n}')
  })

  it('rejects malformed paths instead of guessing', () => {
    expect(() => getJsonPath(settings, 'a..b')).toThrow(/invalid setting path/)
    expect(() => setJsonPath(settings, '', 1)).toThrow(/invalid setting path/)
    expect(() => setJsonPath(settings, 'a.b.c.d.e.f.g.h.i', 1)).toThrow(/invalid setting path/)
  })
})

const CODEX_TOML = [
  '# codex config',
  'model = "openai.gpt-5.6-sol"',
  'model_reasoning_effort = "max" # bumped 2026-09',
  "personality = 'pragmatic'",
  'check_for_update_on_startup = false',
  'commit_attribution = ""',
  'notify = [',
  '    "/Applications/Some App.app/Contents/MacOS/client",',
  '    "turn-ended",',
  ']',
  'approval_policy = "never"',
  'sandbox_mode = "danger-full-access"',
  '',
  '[projects."/Users/someone"]',
  'trust_level = "trusted"',
  '',
  '[model_providers.acme-bedrock]',
  'name = "bedrock"',
  'model = "should-not-be-read-as-top-level"',
  '',
].join('\n')

describe('config-file-edit: TOML top level', () => {
  it('reads top-level scalars only, across a multi-line array, never from tables', () => {
    const m = readTomlTopLevel(CODEX_TOML)
    expect(m.get('model')).toBe('openai.gpt-5.6-sol')
    expect(m.get('model_reasoning_effort')).toBe('max')
    expect(m.get('personality')).toBe('pragmatic')
    expect(m.get('check_for_update_on_startup')).toBe(false)
    expect(m.get('commit_attribution')).toBe('')
    expect(m.get('approval_policy')).toBe('never')
    expect(m.get('sandbox_mode')).toBe('danger-full-access')
    // The array is a key we do not model: present, value unrepresentable.
    expect(m.has('notify')).toBe(true)
    expect(m.get('notify')).toBeUndefined()
    expect(m.has('trust_level')).toBe(false)
    expect(m.has('name')).toBe(false)
  })

  it('replaces a value in place, keeping its trailing comment and every other byte', () => {
    const next = editTomlTopLevel(CODEX_TOML, { model_reasoning_effort: 'high', check_for_update_on_startup: true }, [])
    const before = CODEX_TOML.split('\n')
    const after = next.split('\n')
    expect(after.length).toBe(before.length)
    for (let i = 0; i < before.length; i++) {
      if (before[i].startsWith('model_reasoning_effort')) expect(after[i]).toBe('model_reasoning_effort = "high" # bumped 2026-09')
      else if (before[i].startsWith('check_for_update_on_startup')) expect(after[i]).toBe('check_for_update_on_startup = true')
      else expect(after[i]).toBe(before[i])
    }
  })

  it('appends a new key at the end of the top-level block, before the blank line and the first table', () => {
    const next = editTomlTopLevel(CODEX_TOML, { model_provider: 'acme-bedrock' }, [])
    const lines = next.split('\n')
    const idx = lines.indexOf('model_provider = "acme-bedrock"')
    expect(idx).toBeGreaterThan(-1)
    expect(lines[idx - 1]).toBe('sandbox_mode = "danger-full-access"')
    expect(lines[idx + 1]).toBe('')
    expect(lines[idx + 2]).toBe('[projects."/Users/someone"]')
    expect(readTomlTopLevel(next).get('model_provider')).toBe('acme-bedrock')
  })

  it('removes a key line and leaves tables untouched', () => {
    const next = editTomlTopLevel(CODEX_TOML, {}, ['approval_policy', 'not_there'])
    expect(next).not.toContain('approval_policy')
    expect(next).toContain('[projects."/Users/someone"]\ntrust_level = "trusted"')
    expect(next).toContain('model = "should-not-be-read-as-top-level"')
  })

  it('handles an empty or table-less file and quotes strings safely', () => {
    expect(editTomlTopLevel('', { model: 'x' }, [])).toBe('model = "x"\n')
    expect(editTomlTopLevel('a = 1', { b: 'two' }, [])).toBe('a = 1\nb = "two"')
    expect(editTomlTopLevel('a = 1\n', { b: 'say "hi" \\ there' }, [])).toBe('a = 1\nb = "say \\"hi\\" \\\\ there"\n')
    expect(readTomlTopLevel('b = "say \\"hi\\" \\\\ there"').get('b')).toBe('say "hi" \\ there')
  })

  it('preserves CRLF line endings and rejects keys it cannot render', () => {
    const crlf = 'a = 1\r\nb = 2\r\n'
    expect(editTomlTopLevel(crlf, { a: 3 }, [])).toBe('a = 3\r\nb = 2\r\n')
    expect(() => editTomlTopLevel(crlf, { 'bad key': 1 }, [])).toThrow(/invalid TOML key/)
  })

  it('does not mistake an array element or a nested bracket for a key or table header', () => {
    const tricky = [
      'items = [',
      '  "x = 1",',
      '  "[not-a-table]",',
      ']',
      'inline = { a = "b # not a comment" } # real comment',
      'after = "still-top-level"',
      '',
      '[table]',
      'after = "shadowed"',
    ].join('\n')
    const m = readTomlTopLevel(tricky)
    expect(m.get('after')).toBe('still-top-level')
    expect(m.has('inline')).toBe(true)
    expect([...m.keys()]).toEqual(['items', 'inline', 'after'])
    const next = editTomlTopLevel(tricky, { after: 'edited' }, [])
    expect(next.split('\n')[5]).toBe('after = "edited"')
    expect(next.split('\n')[8]).toBe('after = "shadowed"')
  })

  it('skips multi-line strings as a whole and refuses to edit a key whose value it did not understand', () => {
    const text = [
      'instructions = """',
      'first line',
      '[looks like a table]',
      'key_in_string = "not a key"',
      '"""',
      "literal = '''",
      'x = 1',
      "'''",
      'one_line = """all on one line"""',
      'after = "top-level"',
      '',
      '[real_table]',
      'after = "shadowed"',
    ].join('\n')
    const m = readTomlTopLevel(text)
    expect([...m.keys()]).toEqual(['instructions', 'literal', 'one_line', 'after'])
    expect(m.get('instructions')).toBeUndefined()
    expect(m.get('literal')).toBeUndefined()
    expect(m.get('after')).toBe('top-level')
    // A new key lands before the REAL table, not inside the string.
    const added = editTomlTopLevel(text, { fresh: true }, []).split('\n')
    expect(added[10]).toBe('fresh = true')
    expect(added[12]).toBe('[real_table]')
    // Replacing or dropping the opener line would strand its continuation lines.
    expect(() => editTomlTopLevel(text, { instructions: 'x' }, [])).toThrow(TomlUnsupportedValueError)
    expect(() => editTomlTopLevel(text, {}, ['literal'])).toThrow(/cannot change 'literal' in place/)
    expect(() => editTomlTopLevel('items = [\n  1,\n]\n', { items: 'x' }, [])).toThrow(TomlUnsupportedValueError)
  })
})
