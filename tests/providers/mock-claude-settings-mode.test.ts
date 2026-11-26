/**
 * The mock CLI runs in the mode Claude Code would: the `--permission-mode` flag, else the
 * settings' `permissions.defaultMode`, else `default`. 2026-11-26: the browser fixture's settings
 * name `bypassPermissions` and Walnut starts an unnamed session without a flag (the engine
 * owns its default), but the mock's init said `default`, and the session record took it
 * (draft-mode-pill.spec test 5). Every init the mock prints names that one mode.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MOCK = path.resolve(import.meta.dirname, 'mock-claude.mjs')
const SRC = fs.readFileSync(MOCK, 'utf8')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-settings-mode-'))
const project = path.join(home, 'project')
fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
fs.mkdirSync(path.join(project, '.claude'), { recursive: true })
fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }))
afterAll(() => { fs.rmSync(home, { recursive: true, force: true }) })

function initMode(args: string[], env: Record<string, string>, cwd = home): string | undefined {
  const run = spawnSync(process.execPath, [MOCK, '-p', '--output-format', 'stream-json', ...args, 'hello'], {
    cwd, encoding: 'utf8', timeout: 20_000,
    env: { PATH: process.env.PATH ?? '', HOME: home, MOCK_CLAUDE_PLAIN_ECHO: '1', ...env },
  })
  const init = run.stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } })
    .find((e) => e?.type === 'system' && e.subtype === 'init')
  return init?.permissionMode
}

describe('the mock CLI reports the mode Claude Code would run in', () => {
  it('takes the settings default when no flag names one, and only where asked to read settings', () => {
    expect(initMode([], { MOCK_CLAUDE_HONOR_SETTINGS: '1' })).toBe('bypassPermissions')
    expect(initMode([], {})).toBe('default')
  })

  it('a flag outranks the settings, and the project local file outranks the user file', () => {
    expect(initMode(['--permission-mode', 'plan'], { MOCK_CLAUDE_HONOR_SETTINGS: '1' })).toBe('plan')
    fs.writeFileSync(path.join(project, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { defaultMode: 'acceptEdits' } }))
    expect(initMode([], { MOCK_CLAUDE_HONOR_SETTINGS: '1' }, project)).toBe('acceptEdits')
  })

  it('every init event the mock prints names that one mode', () => {
    const inits = [...SRC.matchAll(/subtype: 'init'[^\n]*/g)].map((m) => m[0])
    const block = /const initEvent = \{([\s\S]*?)\n {2}\};/.exec(SRC)?.[1] ?? ''
    expect(block).toMatch(/permissionMode: runMode,/)
    for (const line of inits.filter((l) => /permissionMode/.test(l))) expect(line).toMatch(/permissionMode: runMode\b/)
    expect(SRC).not.toMatch(/permissionMode: permissionMode \|\|/)
  })

  it('the browser fixture asks the mock to read its own settings', () => {
    const server = fs.readFileSync(path.resolve(import.meta.dirname, '../e2e/browser/test-server.ts'), 'utf8')
    expect(server).toMatch(/process\.env\.MOCK_CLAUDE_HONOR_SETTINGS = '1'/)
  })
})
