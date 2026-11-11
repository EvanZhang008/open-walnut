/**
 * Hook scripts ride files of their own (hook-files-v1): the server half (hook-files.ts)
 * and the daemon half (cli-argv-files-core.ts), with the real session hooks.
 *
 * 2026-11-11: the session settings had grown to 100 KB of hook scripts, 28 bytes under
 * the room of a host spawn template string, so the next hook change would fail. Pinned:
 * a template's compact settings are small and each script fits one argv string; a start
 * records the inline args whatever it was sent; every long hook lands in its own 0600
 * file under argv/hooks/ and the CLI never sees the pseudo flag; each hook run from its
 * file answers exactly what its inline command answers; a file that is gone refuses a
 * PreToolUse call and only reports for another event; a write that fails sends the
 * inline settings back byte for byte; the sweep keeps what a live settings file names
 * (whatever the dir's name) and writes back what a cleaner took; an older daemon after
 * a rollback never removes a live CLI's hook file and re-spawns what it knows.
 *
 * MACHINE SAFETY: every hook runs in a temp HOME and cwd with a PATH of /usr/bin:/bin
 * (no walnut, no claude), on made-up inputs; nothing is played, killed or cloned.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createCliArgvFiles } from '../../src/providers/cli-argv-files-core.js'
import { sessionSettingsHooks } from '../../src/providers/session-settings-hooks.js'
import { compactHookArgs, hookArgsFor, HOOK_FILE_FLAG, HOOK_FILE_TOKEN, HOOK_FILE_MIN_CHARS, HOOK_FILES_CAPABILITY } from '../../src/providers/hook-files.js'
import { createCliArgvFiles as createBeforeHookFiles } from '../fixtures/argv-files/cli-argv-files-core-before-hooks.js'
import { ADVERTISED_DAEMON_CAPABILITIES } from '../../src/providers/daemon-capabilities.js'

type Hook = { type: string; command: string; timeout?: number }
type Groups = Array<{ matcher?: string; hooks: Hook[] }>

const SETTINGS = JSON.stringify({ env: { OPEN_WALNUT_API_URL: 'http://127.0.0.1:1' }, hooks: sessionSettingsHooks({}, { orgRole: 'lead', prompt: '' }) })
const ARGS = ['claude', '-p', '--settings', SETTINGS, '--input-format', 'stream-json']
const dirs: string[] = []
const tmp = (p: string) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

const valueOf = (argv: readonly string[], flag: string) => argv[argv.indexOf(flag) + 1]
const commands = (settings: string) => Object.entries(JSON.parse(settings).hooks as Record<string, Groups>)
  .flatMap(([event, groups]) => groups.flatMap((g) => g.hooks.map((h) => ({ event, matcher: g.matcher ?? '', command: h.command }))))

/** One hook run in a HOME of its own (some hooks keep state there between calls). */
function runHook(command: string, input: string, cwd: string) {
  const home = tmp('hook-home-')
  fs.mkdirSync(path.join(home, 'task'))
  const r = spawnSync('/bin/sh', ['-c', command], {
    input, cwd, encoding: 'utf8', timeout: 20_000,
    env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: home, WALNUT_TASK_DIR: path.join(home, 'task'), WALNUT_SESSION_ID: 'test-session' },
  })
  const plain = (t: string) => t.split(home).join('<home>')
  return { status: r.status, stdout: plain(r.stdout), stderr: plain(r.stderr) }
}

describe('hook files: the server half', () => {
  it('the settings shrink to a few KB and every script fits one argv string', () => {
    const out = compactHookArgs(ARGS) as string[]
    const settings = valueOf(out, '--settings')
    expect(SETTINGS.length).toBeGreaterThan(100 * 1024)
    expect(settings.length).toBeLessThan(8 * 1024)
    const texts = out.filter((_a, i) => out[i - 1] === HOOK_FILE_FLAG)
    expect(texts.length).toBeGreaterThan(5)
    for (const t of texts) expect(t.length).toBeLessThan(100 * 1024)
    // One text per distinct script (clone-identity serves PreToolUse and PostToolUse).
    expect(new Set(texts).size).toBe(texts.length)
    const long = commands(SETTINGS).filter((c) => c.command.length >= HOOK_FILE_MIN_CHARS)
    expect(new Set(long.map((c) => c.command)).size).toBe(texts.length)
    for (const c of commands(settings)) {
      if (c.command.startsWith(HOOK_FILE_TOKEN)) expect(c.command).toMatch(/^@walnut-hook-file:[0-9a-f]{32}$/)
      else expect(c.command.length).toBeLessThan(HOOK_FILE_MIN_CHARS)
    }
    // Everything else in the argv and the settings is as it was.
    expect(out.slice(0, 2)).toEqual(['claude', '-p'])
    expect(out.slice(-2)).toEqual(['--input-format', 'stream-json'])
    expect(JSON.parse(settings).env).toEqual({ OPEN_WALNUT_API_URL: 'http://127.0.0.1:1' })
  })

  it('an older daemon gets the inline form; a template keeps its slots', () => {
    expect(hookArgsFor({ hasCapability: () => false }, ARGS)).toEqual(ARGS)
    expect(hookArgsFor(null, ARGS)).toEqual(ARGS)
    expect(hookArgsFor({ hasCapability: (c) => c === HOOK_FILES_CAPABILITY }, ARGS)).toEqual(compactHookArgs(ARGS))
    expect(ADVERTISED_DAEMON_CAPABILITIES).toContain(HOOK_FILES_CAPABILITY)
    const slot = { slot: 'sid' }
    const template = compactHookArgs<typeof slot>(['claude', slot, '--settings', SETTINGS, slot])
    expect(template[1]).toBe(slot)
    expect(template[template.length - 1]).toBe(slot)
    // Nothing to move: no settings, a path, settings with no long hook.
    for (const argv of [['claude', '-p'], ['claude', '--settings', '/x.json'], ['claude', '--settings', '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"true"}]}]}}']]) {
      expect(compactHookArgs(argv)).toEqual(argv)
    }
  })

  it('the daemon factory reads the same flag and token (it can import nothing)', () => {
    const src = createCliArgvFiles.toString()
    // The transpiler may write either quote.
    for (const literal of [HOOK_FILE_FLAG, HOOK_FILE_TOKEN]) expect([`'${literal}'`, `"${literal}"`].some((q) => src.includes(q)), literal).toBe(true)
    expect(src).not.toContain('`')
  })

})

describe('hook files: the daemon half', () => {
  const files = (dir: string) => createCliArgvFiles({ fs, path, crypto, dir })
  const texts = (argv: readonly string[]) => argv.filter((_a, i) => argv[i - 1] === HOOK_FILE_FLAG)
  const hookFile = (dir: string, text: string) => path.join(dir, 'hooks', crypto.createHash('sha256').update(text).digest('hex').slice(0, 32) + '.sh')

  it('a template\'s hook texts go back into its settings byte for byte, and the pseudo flag goes', () => {
    const af = files('/nonexistent/argv')
    expect(af.inlineArgs(compactHookArgs(ARGS) as string[])).toEqual(ARGS)
    expect(af.inlineArgs(ARGS)).toEqual(ARGS)
    expect(af.inlineArgs(['claude', '--walnut-hook-file=exit 0', '-p'])).toEqual(['claude', '-p'])
  })

  it('a start writes each long hook to its own file, the same from inline or template args, and each hook answers as its inline command', () => {
    const root = tmp('hook-files-')
    const dir = path.join(root, 'argv')
    const out = files(dir).toFiles(ARGS)
    expect(out).toEqual(['claude', '-p', '--settings', expect.stringMatching(/\.json$/), '--input-format', 'stream-json'])
    expect(files(dir).toFiles(compactHookArgs(ARGS) as string[])).toEqual(out)
    const written = fs.readFileSync(valueOf(out, '--settings'), 'utf8')
    expect(written.length).toBeLessThan(8 * 1024)
    expect(written).not.toContain(HOOK_FILE_TOKEN)
    const long = texts(compactHookArgs(ARGS) as string[])
    expect(fs.readdirSync(path.join(dir, 'hooks')).sort()).toEqual(long.map((t) => path.basename(hookFile(dir, t))).sort())
    expect(fs.statSync(path.join(dir, 'hooks')).mode & 0o777).toBe(0o700)
    for (const t of long) {
      expect(fs.readFileSync(hookFile(dir, t), 'utf8')).toBe(t)
      expect(fs.statSync(hookFile(dir, t)).mode & 0o777).toBe(0o600)
    }

    const inline = commands(SETTINGS)
    const fromFiles = commands(written)
    expect(fromFiles.map((c) => [c.event, c.matcher])).toEqual(inline.map((c) => [c.event, c.matcher]))
    const bash = (command: string) => JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: root })
    const inputs: Record<string, string[]> = {
      PreToolUse: [bash('say hi'), bash('cliclick c:1,1'), bash('pkill -f node'), bash('git clone /a /tmp/b'), bash('ls -la'),
        bash('codex exec hi'), bash('walnut tools call x $(id)'),
        JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x' }, cwd: root })],
      PostToolUse: [JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: '/tmp/plan.md' }, cwd: root }), bash('git clone /a b')],
      Stop: [JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false, session_id: 's' })],
      SessionStart: [JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: 's' })],
    }
    let compared = 0
    let refused = 0
    for (let i = 0; i < inline.length; i++) {
      if (inline[i].command === fromFiles[i].command) { expect(inline[i].command.length).toBeLessThan(512); continue }
      for (const input of inputs[inline[i].event] ?? ['{}']) {
        const a = runHook(inline[i].command, input, root)
        const b = runHook(fromFiles[i].command, input, root)
        expect(b, `${inline[i].event} ${inline[i].command.slice(0, 50)} on ${input.slice(0, 80)}`).toEqual(a)
        compared++
        if (a.status === 2 || /"deny"|"block"/.test(a.stdout)) refused++
      }
    }
    expect(compared).toBeGreaterThan(20)
    expect(refused, 'the guards refuse the sound, input and pattern-kill inputs from their files too').toBeGreaterThanOrEqual(3)
  }, 120_000)

  it('a hook file that is gone refuses a PreToolUse call and only reports for another event', () => {
    const root = tmp('hook-files-gone-')
    const dir = path.join(root, 'argv')
    const out = files(dir).toFiles(ARGS)
    const written = commands(fs.readFileSync(valueOf(out, '--settings'), 'utf8'))
    fs.rmSync(path.join(dir, 'hooks'), { recursive: true })
    const pre = written.find((c) => c.event === 'PreToolUse' && c.command.includes(dir))!
    const stop = written.find((c) => c.event === 'Stop' && c.command.includes(dir))!
    const p = runHook(pre.command, '{}', root)
    expect(p.status).toBe(2)
    expect(p.stderr).toContain('a hook file of this session is gone')
    expect(runHook(stop.command, '{}', root).status).toBe(1)
  })

  it('a write that fails sends the inline settings back byte for byte', () => {
    const root = tmp('hook-files-fail-')
    const broken = { ...fs, writeFileSync: () => { throw new Error('read-only') } } as unknown as typeof fs
    const logs: string[] = []
    const af = createCliArgvFiles({ fs: broken, path, crypto, dir: path.join(root, 'argv'), log: (_l, m) => { logs.push(m) } })
    expect(af.toFiles(compactHookArgs(ARGS) as string[])).toEqual(ARGS)
    expect(af.toFiles(ARGS)).toEqual(ARGS)
    expect(logs[0]).toMatch(/could not write/)
  })

  // A dir with a quote, a backslash and a space: the settings hold it shell-quoted and JSON-escaped.
  for (const name of ['argv', "it's \\ odd"]) {
    it(`the sweep keeps what a live settings file names and writes back what a cleaner took (${JSON.stringify(name)})`, () => {
      const root = tmp('hook-files-sweep-')
      const dir = path.join(root, name)
      let clock = Date.now()
      const af = createCliArgvFiles({ fs, path, crypto, dir, now: () => clock })
      const out = af.toFiles(ARGS)
      const settingsFile = valueOf(out, '--settings')
      const hooks = () => fs.readdirSync(path.join(dir, 'hooks')).sort()
      const kept = hooks()
      const old = new Date(clock - 2 * 24 * 60 * 60 * 1000)
      const age = () => { for (const d of [dir, path.join(dir, 'hooks')]) for (const f of fs.readdirSync(d)) fs.utimesSync(path.join(d, f), old, old) }
      // Two days on, an unused script, and a live CLI no registry session names (another daemon's,
      // or one adopted from its pgid alone): its command line names only the settings.
      fs.writeFileSync(path.join(dir, 'hooks', 'ffffffffffffffffffffffffffffffff.sh'), 'exit 0', { mode: 0o600 })
      age()
      expect(af.sweep([[]], [`claude -p --settings ${settingsFile}`])).toBe(1)
      expect(hooks()).toEqual(kept)
      expect(fs.existsSync(settingsFile)).toBe(true)
      // A live session of this daemon whose files a cleaner took gets them back.
      fs.rmSync(dir, { recursive: true, force: true })
      clock += 1000
      expect(af.sweep([ARGS], [])).toBe(0)
      expect(hooks()).toEqual(kept)
      expect(fs.existsSync(settingsFile)).toBe(true)
      expect(af.namesIn(ARGS)).toEqual([path.basename(settingsFile)])
      // Nothing names them any more: they go after a day, the hooks dir stays.
      age()
      expect(af.sweep([], [])).toBe(kept.length + 1)
      expect(hooks()).toEqual([])
    })
  }

  it('after a rollback, the older daemon\'s sweep never removes a live CLI\'s hook files', () => {
    // The sweep of the release before hook files (a frozen copy): it knows only top-level names.
    const createOld = createBeforeHookFiles
    const root = tmp('hook-files-rollback-')
    const dir = path.join(root, 'argv')
    const out = files(dir).toFiles(ARGS)
    const kept = fs.readdirSync(path.join(dir, 'hooks')).sort()
    const day = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    for (const f of kept) fs.utimesSync(path.join(dir, 'hooks', f), day, day)
    fs.utimesSync(path.join(dir, 'hooks'), day, day)
    // The old daemon took the registry over: its args are inline (the start recorded them so).
    createOld({ fs, path, crypto, dir }).sweep([ARGS], [`claude -p --settings ${valueOf(out, '--settings')}`])
    expect(fs.readdirSync(path.join(dir, 'hooks')).sort()).toEqual(kept)
    // And it re-spawns those args as it always did.
    const again = createOld({ fs, path, crypto, dir }).toFiles(ARGS)
    expect(again).not.toContain(HOOK_FILE_FLAG)
    expect(fs.readFileSync(valueOf(again, '--settings'), 'utf8')).toBe(SETTINGS)
  })
})

describe('hook files: a session start sends the inline settings to every daemon', () => {
  it('the start payload carries the args as built, with or without hook-files-v1', async () => {
    const { RemoteSessionManager } = await import('../../src/providers/remote-session-manager.js')
    for (const caps of [[HOOK_FILES_CAPABILITY], []]) {
      const sent: Array<Record<string, unknown>> = []
      const conn = {
        connected: true,
        hasCapability: (c: string) => caps.includes(c),
        onEvent: () => () => {},
        send: async (cmd: string, payload: Record<string, unknown>) => { if (cmd === 'start') sent.push(payload); return { ok: true, pid: 4242, outputFile: '/nonexistent/x.jsonl', offset: 0 } },
      }
      const mgr = new RemoteSessionManager('sid-hook-files', '__local__', null)
      Object.assign(mgr as unknown as Record<string, unknown>, { conn, ensureConnected: async () => conn })
      await mgr.start({ args: ARGS.slice(1), cwd: '/tmp', message: '', resume: false, onOutput: () => {}, onExit: () => {} })
      expect((sent[0].args as string[]).slice(1)).toEqual(ARGS.slice(1))
    }
  })
})
