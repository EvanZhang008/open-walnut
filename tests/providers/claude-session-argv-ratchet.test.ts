/**
 * One builder assembles a Walnut session's `claude -p` argv and `--settings` JSON
 * (docs/plan/one-service-every-host.md phase 4). send() (claude-code-session.ts) and the host spawn
 * template (spawn-template.ts) used to build them twice and a parity test kept them equal; now both
 * call src/providers/claude-session-argv.ts and claude-session-settings.ts. This ratchet fails when a
 * new file assembles the session argv or the hooks JSON on its own: call the builders instead.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { buildClaudeArgv } from '../../src/providers/claude-session-argv.js'
import { buildSessionSettings } from '../../src/providers/claude-session-settings.js'
import { daemonRuntimeText } from '../helpers/daemon-runtime-text.js'

const SRC = path.resolve(import.meta.dirname, '../../src')

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? sourceFiles(p) : /\.(ts|tsx|mjs|js)$/.test(e.name) ? [p] : []
  })
}
const rel = (p: string) => path.relative(SRC, p).split(path.sep).join('/')
/** The code of a file: comment lines (`//`, `*`, `/**`) left out, so a doc example is not an assembly. */
const codeOf = (f: string) => fs.readFileSync(f, 'utf-8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
const filesMatching = (re: RegExp) => sourceFiles(SRC).filter((f) => re.test(codeOf(f))).map(rel).sort()

describe('one builder for a session\'s claude argv and settings', () => {
  it('only the builder spells the output/input format flags of a session', () => {
    // The others are different runs, not a Walnut session: a one-shot model call, the inline
    // subagent child and the warm micro child. The daemon's resume whose spawn record is lost
    // takes the builder too (daemon-standalone.ts bridgeResume).
    const allowed = new Set([
      'providers/claude-session-argv.ts',
      'providers/inline-subagent.ts',
      'providers/micro-claude-warm.ts',
      'model/providers/adapter-claude-cli.ts',
    ])
    const found = filesMatching(/'--output-format',\s*'stream-json'|'--input-format',\s*'stream-json'/)
    expect(found.filter((f) => !allowed.has(f))).toEqual([])
  })

  it('only claude-session-settings.ts calls sessionSettingsHooks', () => {
    const found = filesMatching(/\bsessionSettingsHooks\s*\(/).filter((f) => f !== 'providers/session-settings-hooks.ts')
    expect(found).toEqual(['providers/claude-session-settings.ts'])
  })

  it('the daemon\'s resume of a lost spawn record goes through the builder, with the argv it always had', () => {
    const daemon = daemonRuntimeText()
    // cmdBridgeResume, to the end of its body (daemon-session-resume.ts, dedented as the runtime's text).
    const at = daemon.indexOf('function cmdBridgeResume(')
    expect(at).toBeGreaterThan(-1)
    const resume = daemon.slice(at, daemon.indexOf('\n}\n', at))
    expect(resume).toMatch(/\bbuildClaudeArgv\(\{\s*command: 'claude'/)
    // The literal list it used before the builder (2026-11-24), for a plan session with a model.
    const session = ['--permission-mode', 'plan', '--model', 'm', '--resume', 'sid-1']
    expect(buildClaudeArgv({ command: 'claude', env: {}, session, settings: {} })).toEqual([
      'claude', '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--debug',
      '--allow-dangerously-skip-permissions', '--permission-mode', 'plan', '--model', 'm', '--resume', 'sid-1',
      '--input-format', 'stream-json', '--permission-prompt-tool', 'stdio',
    ])
  })

  it('send() and the host template both go through the builders', () => {
    const send = fs.readFileSync(path.join(SRC, 'providers/claude-code-session.ts'), 'utf-8')
    const template = fs.readFileSync(path.join(SRC, 'providers/spawn-template.ts'), 'utf-8')
    for (const text of [send, template]) {
      expect(text).toMatch(/\bbuildClaudeArgv\b/)
      expect(text).toMatch(/\bbuildSessionSettings\b/)
    }
  })
})

describe('the builders', () => {
  it('assemble the frame in the order a session has always had', () => {
    const argv = buildClaudeArgv({ command: 'claude', env: {}, session: ['--permission-mode', 'plan', '--session-id', 'sid-1'], settings: { env: { A: '1' } } })
    expect(argv).toEqual([
      'claude', '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--debug',
      '--allow-dangerously-skip-permissions', '--permission-mode', 'plan', '--session-id', 'sid-1',
      '--settings', '{"env":{"A":"1"}}', '--input-format', 'stream-json', '--permission-prompt-tool', 'stdio',
    ])
  })

  it('leave out what is off: no command, no streaming, no debug, no settings, no prompt tool', () => {
    const argv = buildClaudeArgv({
      env: { WALNUT_CLAUDE_DEBUG: '0' }, streamPartialMessages: false, permissionPrompt: false, session: [], settings: {},
    })
    expect(argv).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--allow-dangerously-skip-permissions', '--input-format', 'stream-json'])
  })

  it('keep slots where the session parts are', () => {
    const slot = { slot: 'sid' as const }
    expect(buildClaudeArgv({ env: {}, session: [slot], settings: {} })).toContain(slot)
  })

  it('give settings keys in the order permissions, env, overrides, hooks', () => {
    const keys = (o: Parameters<typeof buildSessionSettings>[0]) => Object.keys(buildSessionSettings(o))
    const env = { WALNUT_COMPACT_OPEN_ITEMS: '1' } as NodeJS.ProcessEnv
    expect(keys({ env, sessionEnv: { A: '1' }, overrides: { model: 'x' } })).toEqual(['permissions', 'env', 'model', 'hooks'])
    expect(keys({ env: { WALNUT_AUTO_ALLOW_OPS: '0' }, sessionEnv: {} })).not.toContain('permissions')
    expect(keys({ env, slim: true, sessionEnv: { A: '1' }, overrides: { model: 'x' } })).toEqual(['env', 'model'])
  })
})
