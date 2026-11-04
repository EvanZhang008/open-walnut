/**
 * A Mac without Xcode's Command Line Tools (CLT): /usr/bin/git, cc, make, python3, xcrun,
 * xcodebuild and the rest are stubs there, and running one puts "Install Command Line
 * Developer Tools" on the user's screen. 2026-11-04: host_exec ran `xcodebuild -version` on
 * such a Mac and the dialog came up in front of its owner; the TCC guard
 * (host-exec-guards.ts) only knew protected folders. Bundled into host-exec-core.
 *
 * Whether the tools are there is read from the filesystem, never by running a stub: the
 * developer directory xcode-select points at (or the CLT and Xcode default ones) holds
 * usr/bin. A bare name counts as the stub only when no other copy (Homebrew, a toolchain)
 * comes before /usr/bin on the PATH the run gets, which the login shell is asked for. A line is
 * read the way the keychain guard reads it (host-exec-prompts.ts): `sh -c`, heredocs and pipes
 * into a shell, eval, `env -S`, find -exec, and a path after `cd`.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { ANY_SHELL, EXEC_FLAGS, programAt, shellInput, tokenize, type CommandInput } from './host-exec-guards.js'

/** The /usr/bin programs macOS turns into an install prompt while the tools are missing. */
export const CLT_STUBS: ReadonlySet<string> = new Set([
  'git', 'cc', 'c++', 'gcc', 'g++', 'clang', 'clang++', 'cpp', 'ld', 'as', 'ar', 'nm', 'ranlib', 'strip', 'lipo', 'otool',
  'make', 'gnumake', 'xcrun', 'xcodebuild', 'python3', 'pip3', 'swift', 'swiftc', 'lldb',
  'svn', 'cvs', 'bison', 'flex', 'm4', 'gperf', 'indent', 'ctags', 'unifdef', 'mig', 'install_name_tool', 'codesign_allocate',
  'dsymutil', 'size', 'strings', 'segedit', 'cmpdylib', 'libtool', 'lorder', 'rpcgen', 'yacc', 'lex', 'gm4', 'git-receive-pack',
  'git-upload-pack', 'git-upload-archive', 'git-shell', 'scalar', 'pydoc3', 'python3-config', 'xed', 'xcscontrol', 'xctrace',
])

const DEV_DIRS = ['/Library/Developer/CommandLineTools', '/Applications/Xcode.app/Contents/Developer']
const SELECT_LINK = '/var/db/xcode_select_link'

export interface CltFs {
  exists(p: string): boolean
  readlink(p: string): string | null
}
const realFs: CltFs = {
  exists: (p) => { try { fs.accessSync(p); return true } catch { return false } },
  readlink: (p) => { try { return fs.readlinkSync(p) } catch { return null } },
}

/** The tools are installed: the selected developer dir (else a default one) holds usr/bin. */
export function cltInstalled(f: CltFs = realFs): boolean {
  const selected = f.readlink(SELECT_LINK)
  const dirs = selected ? [selected, ...DEV_DIRS] : DEV_DIRS
  return dirs.some((d) => f.exists(path.posix.join(d, 'usr/bin/xcrun')) || f.exists(path.posix.join(d, 'usr/bin/git')))
}

/** Where a bare name runs from on `pathVar`: the first directory holding it, else null. */
function firstOnPath(name: string, pathVar: string, f: CltFs): string | null {
  for (const dir of pathVar.split(':').filter(Boolean)) {
    if (f.exists(path.posix.join(dir, name))) return dir
  }
  return null
}

const MAX_DEPTH = 8
const NO_INPUT: CommandInput = { text: '', heredocs: [], pipedFrom: [] }

interface Scan { pathVar: string; f: CltFs; where: string | null }

/** The stub `word` names, run from `where`: a bare name by the PATH, a path by its directory. */
function stubOf(word: string, s: Scan): string | null {
  const program = path.posix.basename(word)
  if (!CLT_STUBS.has(program)) return null
  if (!word.includes('/')) {
    const from = firstOnPath(program, s.pathVar, s.f)
    return from === null || path.posix.normalize(from) === '/usr/bin' ? program : null
  }
  // `/usr/bin//git`, `/usr/./bin/git`, and `./git` after `cd /usr/bin` are the stub too.
  const full = word.startsWith('/') ? path.posix.normalize(word) : s.where ? path.posix.resolve(s.where, word) : null
  return full !== null && path.posix.dirname(full) === '/usr/bin' ? program : null
}

/** `env -S 'git status'` / `--split-string=...`: the line env splits and runs, or null. */
function envSplit(words: string[]): string | null {
  for (let k = 0; k < words.length; k++) {
    if (path.posix.basename(words[k]) !== 'env') continue
    for (let j = k + 1; j < words.length && words[j].startsWith('-'); j++) {
      const a = words[j]
      if (a === '-S' || a === '--split-string') return words.slice(j + 1).join(' ')
      if (a.startsWith('--split-string=')) return [a.slice('--split-string='.length), ...words.slice(j + 1)].join(' ')
      if (/^-[^-]*S./.test(a)) return [a.slice(a.indexOf('S') + 1), ...words.slice(j + 1)].join(' ')
    }
  }
  return null
}

/** Any stub named as a word in text a shell is fed (a pipe's output is not seen, its words are). */
function stubWordIn(text: string, s: Scan): string | null {
  for (const word of text.split(/[\s'"`;&|()<>]+/)) {
    const hit = word ? stubOf(word, s) : null
    if (hit) return hit
  }
  return null
}

function commandStub(words: string[], input: CommandInput, s: Scan, depth: number, scanExec = true): string | null {
  const split = envSplit(words)
  if (split !== null) return lineStub(split, s, depth + 1)
  const at = programAt(words)
  if (at < 0) return null
  const word = words[at]
  const program = path.posix.basename(word)
  const args = words.slice(at + 1)
  if (program === 'cd' || program === 'pushd' || program === 'popd') {
    const to = program === 'popd' ? undefined : args.find((a) => !(a.startsWith('-') && a.length > 1))
    s.where = to === undefined || to === '-' || to.startsWith('~') || to.startsWith('$') ? null
      : to.startsWith('/') ? path.posix.normalize(to) : s.where ? path.posix.resolve(s.where, to) : null
    return null
  }
  if (program === 'eval') return lineStub(args.join(' '), s, depth + 1)
  if (ANY_SHELL.has(program)) {
    const script = shellInput(args)
    if (script === null) return null
    if (script !== 'stdin') return lineStub(script, s, depth + 1)
    // Its own heredoc is shell text; what a pipe feeds it is some program's output, read for the word.
    for (const body of input.heredocs) {
      const hit = lineStub(body, s, depth + 1)
      if (hit) return hit
    }
    return stubWordIn(input.pipedFrom.flatMap((p) => [p.text, ...p.heredocs]).join('\n'), s)
  }
  if (program === 'xcode-select') return args.includes('--install') ? 'xcode-select --install' : null
  const hit = stubOf(word, s)
  if (hit) return hit
  // find -exec / -ok: the word after it starts a command.
  if (scanExec) {
    for (let k = at + 1; k < words.length; k++) {
      if (!EXEC_FLAGS.has(words[k])) continue
      const inner = commandStub(words.slice(k + 1), NO_INPUT, s, depth, false)
      if (inner) return inner
    }
  }
  return null
}

function lineStub(line: string, s: Scan, depth: number): string | null {
  if (depth > MAX_DEPTH) return null
  const { commands, inputs, subs } = tokenize(line)
  for (let k = 0; k < commands.length; k++) {
    const hit = commandStub(commands[k], inputs[k], s, depth)
    if (hit) return hit
  }
  for (const body of subs) {
    const hit = lineStub(body, s, depth + 1)
    if (hit) return hit
  }
  return null
}

/**
 * The stub a line would run, or null. `pathVar` is the PATH the run gets (loginPath), `cwd`
 * where it starts (a relative `./git` after `cd /usr/bin` is the stub).
 */
export function cltStubRun(line: string, pathVar: string, f: CltFs = realFs, cwd: string | null = null): string | null {
  return lineStub(line, { pathVar, f, where: cwd }, 0)
}

/**
 * The PATH macOS's login shell starts from: path_helper (/etc/zprofile, /etc/profile) puts
 * /etc/paths first, then the PATH it inherited. A user's own profile may prepend more
 * (Homebrew's shellenv); only asking the shell (loginPath) knows that.
 */
export function pathHelperOrder(env: NodeJS.ProcessEnv): string {
  return ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', env.PATH ?? ''].filter(Boolean).join(':')
}

const PATH_MARK = '__WALNUT_LOGIN_PATH__='
const PROBE_MS = 5_000
const PROBE_AGAIN_MS = 10 * 60_000

/**
 * The PATH a run gets: the login shell asked the way a run starts (`printf ... "$PATH"` through
 * shellPlan), at most 5 s, again after 10 minutes; the path_helper order until it has answered.
 */
export interface LoginPathDeps {
  spawn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess
  killGroup: (pid: number, signal: NodeJS.Signals) => void
  /** The login shell and its arguments for a line, as a run gets them (host-exec-line.ts shellPlan). */
  plan: (line: string) => { cmd: string; args: string[]; env?: Record<string, string> }
  env: NodeJS.ProcessEnv
  home: string
  now?: () => number
}

export function loginPath(deps: LoginPathDeps): () => string {
  const now = deps.now ?? Date.now
  let known: string | null = null
  let askedAt = -Infinity
  let asking = false
  const ask = () => {
    asking = true
    askedAt = now()
    let out = ''
    let child: ChildProcess
    try {
      const plan = deps.plan(`printf '\\n${PATH_MARK}%s\\n' "$PATH"`)
      child = deps.spawn(plan.cmd, plan.args, { cwd: deps.home, env: { ...deps.env, ...plan.env }, detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch { asking = false; return }
    const timer = setTimeout(() => { if (child.pid) deps.killGroup(child.pid, 'SIGKILL') }, PROBE_MS)
    child.stdout?.on('data', (d: Buffer) => { if (out.length < 64_000) out += d.toString() })
    const done = () => {
      clearTimeout(timer)
      asking = false
      const line = out.split('\n').reverse().find((l) => l.startsWith(PATH_MARK))
      if (line && line.length > PATH_MARK.length) known = line.slice(PATH_MARK.length).trim()
    }
    child.on('error', done)
    child.on('close', done)
  }
  return () => {
    if (!asking && now() - askedAt > PROBE_AGAIN_MS) ask()
    return known ?? pathHelperOrder(deps.env)
  }
}

export function cltMessage(program: string, where: string): string {
  return `\`${program}\` is one of the Command Line Tools, which ${where} does not have: running it shows an `
    + '"Install Command Line Developer Tools" dialog on its screen. Nothing ran. Use a program that is there '
    + '(`/usr/bin/xcode-select -p` fails without a dialog, so it tells whether the tools are there), or ask the user first and call again with allow_prompts: true.'
}
