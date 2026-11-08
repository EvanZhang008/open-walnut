// The outer command is only parsed (no shell runs it); only its sh -c script runs, against a stand-in claude.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { guardedPath } from '../setup/exec-guard.js'
import { demoPaths, type DemoPaths } from '../../src/commands/demo-home.js'
import {
  closeDemoSignIns, demoSignInCommand, demoSignInDirectories, demoSignInScriptFile, prepareDemoSignIns, shellQuote, writeDemoSignInScript,
  DEMO_CLI_NOT_FOUND, DEMO_NOT_TAKING_SIGN_INS,
} from '../../src/commands/demo-sign-ins.js'
import { demoProcessStart } from '../../src/commands/demo-process.js'

function mockShellWords(line: string): string[] {
  const words: string[] = []
  let word: string | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (c === ' ') { if (word !== null) words.push(word); word = null; continue }
    word ??= ''
    if (c === "'") {
      const end = line.indexOf("'", i + 1)
      if (end < 0) throw new Error('unclosed quote')
      const quoted = line.slice(i + 1, end)
      // fish reads a backslash inside single quotes as an escape.
      if (quoted.includes('\\')) throw new Error(`backslash inside quotes: ${quoted}`)
      word += quoted
      i = end
    } else if (c === '\\' && line[i + 1] === "'") { word += "'"; i++ }
    else if (/[A-Za-z0-9/=_.:-]/.test(c)) word += c
    else throw new Error(`unquoted ${JSON.stringify(c)} at ${i}`)
  }
  if (word !== null) words.push(word)
  return words
}

interface Parsed { env: Record<string, string>; script: string }

function parse(command: string): Parsed {
  const words = mockShellWords(command)
  expect(words.slice(0, 2)).toEqual(['/usr/bin/env', '-i'])
  const env: Record<string, string> = {}
  let i = 2
  for (; i < words.length && /^[A-Z_]+=/.test(words[i]!); i++) {
    const at = words[i]!.indexOf('=')
    env[words[i]!.slice(0, at)] = words[i]!.slice(at + 1)
  }
  expect(words.slice(i, i + 2)).toEqual(['/bin/sh', '-c'])
  expect(words.length).toBe(i + 3)
  return { env, script: words[i + 2]! }
}

interface Owned { child: ChildProcessWithoutNullStreams; out: string; closed: boolean; code: Promise<number | null> }
const owned: Owned[] = []
let base: string
let paths: DemoPaths
let bin: string

function runScript(parsed: Parsed, pathDirs = `${bin}:${guardedPath()}`): Owned {
  const child = spawn('/bin/sh', ['-c', parsed.script], {
    cwd: base, stdio: 'pipe',
    env: { ...parsed.env, PATH: pathDirs },
  })
  const row: Owned = { child, out: '', closed: false, code: Promise.resolve(null) }
  row.code = new Promise(resolve => child.once('close', code => { row.closed = true; resolve(code) }))
  child.stdout.setEncoding('utf8').on('data', (text: string) => { row.out += text })
  child.stderr.setEncoding('utf8').on('data', (text: string) => { row.out += text })
  child.stdin.on('error', () => {})
  owned.push(row)
  return row
}

async function launched(row: Owned): Promise<RegExpMatchArray | null> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const match = row.out.match(/^ready (\d+) (.*)$/m)
    if (match) return match
    if (row.closed) return null
    if (Date.now() > deadline) throw new Error(`neither launched nor ended: ${row.out}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

beforeEach(async () => {
  // realpath: the Demo path guard refuses macOS's /var link.
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "demo it's sign-in ")))
  paths = demoPaths(path.join(base, "user's walnut", 'open-walnut-demo'), 'g1')
  await prepareDemoSignIns(paths)
  bin = path.join(base, 'stand in bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'claude'), [
    '#!/bin/sh',
    'printf \'ready %s %s|%s|%s|%s\\n\' "$$" "$*" "$HOME" "$CLAUDE_CONFIG_DIR" "${WALNUT_DEMO_SIGN_INS-unset}"',
    'IFS= read -r walnut_line',
    'exit 0', '',
  ].join('\n'), { mode: 0o755 })
})

afterEach(async () => {
  for (const row of owned.splice(0)) { row.child.stdin.end(); await row.code }
  fs.chmodSync(demoSignInDirectories(paths).root, 0o700)
  for (const dir of [demoSignInDirectories(paths).accepting, demoSignInDirectories(paths).closed]) {
    if (fs.existsSync(dir)) fs.chmodSync(dir, 0o700)
  }
  fs.rmSync(base, { recursive: true, force: true })
})

describe('demoSignInCommand: what it says', () => {
  it('signs in Demo HOME and config only, with this generation dir, quoted for every shell', () => {
    const command = demoSignInCommand(paths, `/usr/local/bin:relative/bin:/opt/it's/bin`)!
    expect(command).not.toMatch(/[\n\r!]/)
    const { env, script } = parse(command)
    expect(env.HOME).toBe(paths.home)
    expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(paths.home, '.claude'))
    expect(env.WALNUT_DEMO_SIGN_INS).toBe(demoSignInDirectories(paths).accepting)
    const dirs = env.PATH!.split(':')
    expect(dirs[0]).toBe(path.join(paths.home, '.local', 'bin'))
    expect(dirs).toContain("/opt/it's/bin")
    expect(dirs).not.toContain('relative/bin')
    expect(dirs).toEqual(expect.arrayContaining(['/usr/bin', '/bin']))
    expect(Object.keys(env).sort()).toEqual(['CLAUDE_CONFIG_DIR', 'HOME', 'PATH', 'TERM', 'WALNUT_DEMO_SIGN_INS'])
    expect(script).not.toContain(base)
    expect(script).not.toMatch(/[\\!]|\bmkdir\b/)
    expect(command).not.toContain(os.homedir() + '/.claude')
    expect(script.indexOf('set -C')).toBeLessThan(script.indexOf('> "$walnut_dir/$walnut_id.json"'))
    expect(script.indexOf('> "$walnut_dir/$walnut_id.json"')).toBeLessThan(script.indexOf('exec "$walnut_cli" auth login'))
    expect(script.match(/\bexec\b/g)).toHaveLength(1)
    expect(script).toContain('LC_ALL=C TZ=UTC /bin/ps -o lstart= -p $$')
  })

  it.each(['back\\slash', 'new\nline', 'tab\there'])('gives no command for a path a shell cannot read the same: %j', name => {
    expect(demoSignInCommand(demoPaths(path.join(base, name, 'open-walnut-demo'), 'g1'))).toBeNull()
  })

  it('names the generation it was made for, never another', () => {
    const other = demoPaths(paths.root, 'g2')
    expect(parse(demoSignInCommand(other, '')!).env.HOME).toBe(other.home)
    expect(parse(demoSignInCommand(other, '')!).env.WALNUT_DEMO_SIGN_INS).not.toBe(demoSignInDirectories(paths).accepting)
  })
})

describe('writeDemoSignInScript: the short line a person pastes', () => {
  it("is one short line that runs the same inline line from this generation's private script", async () => {
    const short = (await writeDemoSignInScript(paths, ''))!
    const file = demoSignInScriptFile(paths)
    expect(short).toBe(`/bin/sh ${shellQuote(file)}`)
    expect(short.length).toBeLessThan(file.length + 20)
    expect(fs.statSync(file).mode & 0o777).toBe(0o700)
    expect(fs.readFileSync(file, 'utf8')).toBe(`#!/bin/sh\nexec ${demoSignInCommand(paths, '')}\n`)
    expect(file.startsWith(paths.data + path.sep)).toBe(true)
  })

  it('runs the script the same way: the record names the pid the CLI keeps', async () => {
    await writeDemoSignInScript(paths, bin)
    const row = runScript({ env: {}, script: `exec /bin/sh ${shellQuote(demoSignInScriptFile(paths))}` } as ReturnType<typeof parse>)
    const ready = await launched(row)
    expect(ready, row.out).not.toBeNull()
    expect(Number(ready![1])).toBe(row.child.pid)
    const names = fs.readdirSync(demoSignInDirectories(paths).accepting)
    expect(names).toHaveLength(1)
    expect(JSON.parse(fs.readFileSync(path.join(demoSignInDirectories(paths).accepting, names[0]!), 'utf8')).pid).toBe(row.child.pid)
  })
})

describe('demoSignInCommand: what its script does', () => {
  it('claims a private record of the pid the CLI keeps, then runs only `auth login` with Demo env', async () => {
    const row = runScript(parse(demoSignInCommand(paths, '')!))
    const ready = await launched(row)
    expect(ready, row.out).not.toBeNull()
    const pid = Number(ready![1])
    expect(ready![2]).toBe(`auth login|${paths.home}|${path.join(paths.home, '.claude')}|unset`)
    expect(pid).toBe(row.child.pid)
    const dir = demoSignInDirectories(paths).accepting
    const names = fs.readdirSync(dir)
    expect(names).toHaveLength(1)
    expect(names[0]).toMatch(/^[a-f0-9-]{36}\.json$/i)
    expect(fs.statSync(path.join(dir, names[0]!)).mode & 0o777).toBe(0o600)
    const record = JSON.parse(fs.readFileSync(path.join(dir, names[0]!), 'utf8'))
    expect(record.pid).toBe(pid)
    expect(record.startTime).toMatch(/^ps:[A-Za-z0-9 :]+$/)
    expect(await demoProcessStart(pid, 'ps')).toBe(record.startTime)
    await expect(closeDemoSignIns(paths)).rejects.toThrow(/still open in Terminal/)
    row.child.stdin.end()
    expect(await row.code).toBe(0)
    await expect(closeDemoSignIns(paths)).resolves.toBeUndefined()
  })

  it('a copy run after reset closed admission starts nothing and makes no dir', async () => {
    await closeDemoSignIns(paths)
    const row = runScript(parse(demoSignInCommand(paths, '')!))
    expect(await launched(row)).toBeNull()
    expect(await row.code).toBe(1)
    expect(row.out).toContain(DEMO_NOT_TAKING_SIGN_INS)
    expect(fs.existsSync(demoSignInDirectories(paths).accepting)).toBe(false)
    expect(fs.readdirSync(demoSignInDirectories(paths).closed)).toEqual([])
  })

  it('a symlinked admission dir is refused, its target untouched', async () => {
    const dirs = demoSignInDirectories(paths)
    const target = path.join(base, 'target')
    fs.mkdirSync(target, { mode: 0o700 })
    fs.rmdirSync(dirs.accepting)
    fs.symlinkSync(target, dirs.accepting)
    const row = runScript(parse(demoSignInCommand(paths, '')!))
    expect(await launched(row)).toBeNull()
    expect(await row.code).toBe(1)
    expect(fs.readdirSync(target)).toEqual([])
    fs.unlinkSync(dirs.accepting)
    fs.mkdirSync(dirs.accepting, { mode: 0o700 })
  })

  it.skipIf(process.getuid?.() === 0)('a record it cannot write starts nothing', async () => {
    fs.chmodSync(demoSignInDirectories(paths).accepting, 0o500)
    const row = runScript(parse(demoSignInCommand(paths, '')!))
    expect(await launched(row)).toBeNull()
    expect(await row.code).toBe(1)
    expect(row.out).toContain(DEMO_NOT_TAKING_SIGN_INS)
  })

  it('no CLI on its PATH: says so, claims no record', async () => {
    const empty = path.join(base, 'empty bin')
    fs.mkdirSync(empty)
    const row = runScript(parse(demoSignInCommand(paths, '')!), empty)
    expect(await row.code).toBe(1)
    expect(row.out).toContain(DEMO_CLI_NOT_FOUND)
    expect(fs.readdirSync(demoSignInDirectories(paths).accepting)).toEqual([])
  })
})

describe('the Demo generation route', () => {
  it('reports this generation and its own sign-in command, computed from its own paths', () => {
    const server = fs.readFileSync(path.resolve(import.meta.dirname, '../../src/commands/demo-server.ts'), 'utf8')
    expect(server).toMatch(/const signInCommand = await writeDemoSignInScript\(paths\)/)
    // The route itself lives in demo-routes.ts, handed the command the server computed.
    const routes = fs.readFileSync(path.resolve(import.meta.dirname, '../../src/commands/demo-routes.ts'), 'utf8')
    expect(routes).toMatch(/req\.path === '\/api\/demo\/generation'[\s\S]{0,300}res\.json\(\{ generation: o\.generation, signInCommand: o\.signInCommand,/)
  })
})
