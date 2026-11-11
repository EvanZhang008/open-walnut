/**
 * Ratchet: no Claude Code spawn puts hook scripts or a prompt in the process's
 * command line (src/providers/cli-argv-files-core.ts).
 *
 * 2026-10-31: `pkill -f "clone.*playwright"` matched the `--settings` hook text
 * in every CLI's argv and SIGTERMed every session on the Mac. The server still
 * builds the inline form; what makes it safe is that every way a claude process
 * starts runs its argv through `toFiles` first. This file enumerates, from the
 * source, every file that puts a content flag into an argv and the spawn points
 * that run a claude, and fails on one it does not know.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { createCliArgvFiles } from '../../src/providers/cli-argv-files-core.js'
import { sessionSettingsHooks } from '../../src/providers/session-settings-hooks.js'
import { compactHookArgs, HOOK_FILE_FLAG } from '../../src/providers/hook-files.js'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...sourceFiles(rel))
    else if (/\.(ts|tsx|mjs|cjs|js)$/.test(e.name)) out.push(rel)
  }
  return out
}

const CONTENT_FLAG = /['"]--(settings|mcp-config|append-system-prompt|system-prompt|agents)['"]/

/**
 * Every file that puts a content flag into a claude argv, and how that argv
 * reaches a process. 'session' = the daemon's session start (startSessionProcess
 * in both twins); 'oneshot' = a one-shot run (oneshot-core.ts, through the
 * daemon or the in-process fallback in oneshot-client.ts).
 */
const PRODUCERS: Record<string, 'session' | 'oneshot'> = {
  'src/providers/claude-code-session.ts': 'session',
  'src/providers/spawn-template.ts': 'session',
  'src/providers/host-start-core.ts': 'session',
  'src/providers/inline-subagent.ts': 'oneshot',
  'src/providers/micro-claude-warm.ts': 'oneshot',
  'src/model/providers/adapter-claude-cli.ts': 'oneshot',
}
/** Files that name a content flag without building an argv a process runs. */
const READERS: Record<string, string> = {
  'src/providers/cli-argv-files-core.ts': 'the rewrite itself',
  'src/providers/daemon-cron-supervision.ts': 'lists flags to keep in a cron resume; the start rewrites them',
  'src/core/sessions/spawn-prefix.ts': 'reads the inline prompt back from the registry args',
  'src/providers/daemon-source.ts': 'the smoke check of the rewrite it inlines',
  'src/providers/daemon-standalone.ts': 'reads the inline --settings env to pick the session PATH (walnutThroughGateway)',
  'src/providers/hook-files.ts': 'moves long hook commands out of the --settings value a start sends (hook-files-v1); the daemon writes them to files',
  'src/core/sessions/request-tag.ts': "adds the tag to a one-shot's inline --settings env inside startOneShot; that argv's spawn (oneshot-core) rewrites it to a file",
}

describe('every content flag in an argv reaches the CLI as a file', () => {
  it('knows every file that puts a content flag into an argv', () => {
    const found = sourceFiles('src').filter((f) => !f.endsWith('.orig') && CONTENT_FLAG.test(read(f)))
    const unknown = found.filter((f) => !(f in PRODUCERS) && !(f in READERS))
    expect(unknown, 'a new file builds a claude argv with a content flag: route its spawn through cliArgvFiles.toFiles (cli-argv-files-core.ts), then list it in PRODUCERS').toEqual([])
    for (const f of [...Object.keys(PRODUCERS), ...Object.keys(READERS)]) expect(found, `${f} no longer names a content flag: drop it from this list`).toContain(f)
  })

  it('one-shot producers start their claude through the one-shot client', () => {
    for (const [f, route] of Object.entries(PRODUCERS)) {
      if (route !== 'oneshot') continue
      const src = read(f)
      expect(src, `${f} must run its claude through oneshot-client (runOneShot)`).toMatch(/oneshot-client\.js/)
      expect(src, `${f} spawns a process of its own`).not.toMatch(/\bspawn\(\s*(cli|command|claude)/)
    }
  })

  it('every spawn point that runs a claude rewrites its argv first, in both twins and the in-process fallback', () => {
    const bun = read('src/providers/daemon-standalone.ts')
    const js = read('src/providers/daemon-source.ts')
    const client = read('src/providers/oneshot-client.ts')
    // The session start: what the shell execs, and what the JS twin spawns.
    expect(bun).toMatch(/const escapedArgs = cliArgvFiles\.toFiles\(launch\.args\)/)
    expect(js).toMatch(/const spawnArgs = cliArgvFiles\.toFiles\(launch\.args\);/)
    expect(js).toMatch(/spawnBehindRegistry\(launch\.command, spawnArgs, spawnOptions\)/)
    expect(js).toMatch(/spawn\(launch\.command, spawnArgs, spawnOptions\)/)
    expect(js).not.toMatch(/spawn\(launch\.command, launch\.args/)
    // The one-shot core gets a spawn that rewrites a claude's argv.
    expect(bun).toMatch(/const oneShot = createOneShotCore<[^\n]*\(\{\s*\n\s*\/\/[^\n]*\n\s*spawn: \(\(cmd[^\n]*cliArgvFiles\.toFiles\(args\)/)
    expect(js).toMatch(/__CREATE_ONESHOT__\)\(\{\s*\n\s*\/\/[^\n]*\n\s*spawn: function \(cmd, args, opts\) \{ return spawn\(cmd, cliArgvFiles\.isClaude\(cmd, args\) \? cliArgvFiles\.toFiles\(args\)/)
    expect(client).toMatch(/spawn: \(cmd, args, opts\) => spawn\(cmd, argvFiles\.isClaude\(cmd, args\) \? argvFiles\.toFiles\(args\)/)
    // The JS twin builds the factory from its text, and both hash lists ship it.
    expect(js).toContain("['__CREATE_CLI_ARGV_FILES__', createCliArgvFiles.toString()]")
    expect(read('scripts/build-daemon.sh')).toContain('  src/providers/cli-argv-files-core.ts\n')
    expect(read('src/providers/daemon-version-check.ts')).toContain("'src/providers/cli-argv-files-core.ts'")
    // No other place in the twins spawns the session CLI (the barrier and the plain spawn above).
    expect(bun.match(/spawn\(userShell, \['-c', shellCmd\]/g)?.length).toBe(1)
    expect(js.match(/spawn\(launch\.command,/g)?.length).toBe(1)
  })

  it('the session settings and every hook script fit a host spawn template string, with room to grow', () => {
    // host-start-core.ts MAX_TEMPLATE_STRING (120 KB) caps each argv string. A daemon with
    // hook-files-v1 gets each long hook script as its own string (hook-files.ts), so the
    // settings stay small and the budget is per script.
    for (const role of [undefined, 'lead', 'main'] as const) {
      const settings = JSON.stringify({ env: { OPEN_WALNUT_API_URL: 'http://127.0.0.1:3456' }, hooks: sessionSettingsHooks({}, { orgRole: role, prompt: '' }) })
      const argv = compactHookArgs(['claude', '--settings', settings]) as string[]
      expect(argv[2].length, 'the settings carry a long hook inline: hook-files.ts moves commands from HOOK_FILE_MIN_CHARS on').toBeLessThan(16 * 1024)
      for (let i = 3; i < argv.length; i += 2) {
        expect(argv[i]).toBe(HOOK_FILE_FLAG)
        expect(argv[i + 1].length, `one hook script outgrew an argv string: ${argv[i + 1].slice(0, 60)}`).toBeLessThan(100 * 1024)
      }
    }
    expect(read('src/providers/host-start-core.ts')).toContain('const MAX_TEMPLATE_STRING = 120 * 1024')
  })

  it('the real session settings and prompt leave the argv as paths', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argv-ratchet-'))
    try {
      const af = createCliArgvFiles({ fs, path, crypto, dir: path.join(dir, 'argv') })
      const settings = JSON.stringify({ hooks: sessionSettingsHooks({}) })
      expect(settings).toMatch(/clone/) // the text that matched the 2026-10-31 pattern
      const args = af.toFiles(['claude', '-p', '--append-system-prompt', 'git clone here', '--settings', settings, '--system-prompt=x clone', '--mcp-config', '{"mcpServers":{}}'])
      for (const a of args) expect(a).not.toMatch(/clone|PreToolUse/)
      expect(args).toEqual(['claude', '-p', '--append-system-prompt-file', expect.any(String), '--settings', expect.any(String), expect.stringMatching(/^--system-prompt-file=\//), '--mcp-config', expect.any(String)])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
