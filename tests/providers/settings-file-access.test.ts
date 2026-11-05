/**
 * A rule kept in a file the CLI cannot write is held before the answer goes out
 * (claude-code-session.ts resolvePermissionRequest): these are the files and the check.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { settingsFilesOf, PermissionSaveError } from '../../src/providers/claude-permission-options.js'
import { unwritableSettingsFile } from '../../src/providers/settings-file-access.js'

const dirs: string[] = []
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-access-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) { fs.chmodSync(d, 0o755); fs.rmSync(d, { recursive: true, force: true }) } })

const rule = (destination: string) => ({ type: 'addRules' as const, rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination })

describe('settingsFilesOf', () => {
  it('names each file a choice writes, once, and nothing for a session-only rule or a mode', () => {
    expect(settingsFilesOf([rule('localSettings'), rule('localSettings'), rule('session'), { type: 'setMode', mode: 'acceptEdits', destination: 'localSettings' }], '/w', '/cfg'))
      .toEqual([{ path: '/w/.claude/settings.local.json', shown: '.claude/settings.local.json' }])
    expect(settingsFilesOf([rule('projectSettings'), rule('userSettings')], '/w', '/cfg')).toEqual([
      { path: '/w/.claude/settings.json', shown: '.claude/settings.json' },
      { path: '/cfg/settings.json', shown: '~/.claude/settings.json' },
    ])
  })
})

describe('unwritableSettingsFile', () => {
  const asRoot = process.getuid?.() === 0
  it('passes a file that does not exist yet under a folder that can be written', async () => {
    const cwd = tmp()
    expect(await unwritableSettingsFile(settingsFilesOf([rule('localSettings')], cwd, cwd))).toBeNull()
  })
  it.skipIf(asRoot)('names an existing file that cannot be written', async () => {
    const cwd = tmp()
    fs.mkdirSync(path.join(cwd, '.claude'))
    const file = path.join(cwd, '.claude', 'settings.local.json')
    fs.writeFileSync(file, '{}')
    fs.chmodSync(file, 0o444)
    expect(await unwritableSettingsFile(settingsFilesOf([rule('localSettings')], cwd, cwd))).toEqual({ shown: '.claude/settings.local.json', why: 'not-writable' })
  })
  it.skipIf(asRoot)('names a file whose nearest existing folder cannot be written', async () => {
    const cwd = tmp()
    fs.chmodSync(cwd, 0o555)
    expect(await unwritableSettingsFile(settingsFilesOf([rule('localSettings')], cwd, cwd))).toEqual({ shown: '.claude/settings.local.json', why: 'not-writable' })
  })
  it('names a file that is not valid JSON (the CLI keeps nothing in it), and passes an empty one', async () => {
    const cwd = tmp()
    fs.mkdirSync(path.join(cwd, '.claude'))
    const file = path.join(cwd, '.claude', 'settings.local.json')
    fs.writeFileSync(file, '{ "permissions": { "allow": [ }')
    expect(await unwritableSettingsFile(settingsFilesOf([rule('localSettings')], cwd, cwd))).toEqual({ shown: '.claude/settings.local.json', why: 'not-json' })
    fs.writeFileSync(file, '')
    expect(await unwritableSettingsFile(settingsFilesOf([rule('localSettings')], cwd, cwd))).toBeNull()
    fs.writeFileSync(file, '{"permissions":{"allow":[]}}')
    expect(await unwritableSettingsFile(settingsFilesOf([rule('localSettings')], cwd, cwd))).toBeNull()
  })
  it('says what to do instead', () => {
    expect(new PermissionSaveError('.claude/settings.local.json', 'not-json').message)
      .toBe('Could not save the rule: .claude/settings.local.json is not valid JSON. Fix the file, or allow once or for this session instead.')
    expect(new PermissionSaveError('.claude/settings.local.json').message)
      .toBe('Could not save the rule: .claude/settings.local.json cannot be written. Allow once or for this session instead.')
  })
})
