/**
 * Commands that can put a password dialog on another person's screen and wait there.
 *
 * 2026-11-03: a session ran `security show-keychain-info` and `security
 * find-generic-password` through host_exec on someone else's Mac. Its login
 * keychain was locked, so macOS showed a SecurityAgent password dialog on that
 * person's screen each time, and each run hung until it was stopped. host_exec
 * refuses such a command on a Mac (or a host whose system Walnut has not seen
 * yet) unless the caller passes `allow_prompts`, after asking the user
 * (src/core/hosts/host-exec.ts).
 *
 * What counts, found by reading the line the way a shell does (quotes, `\`,
 * `;`/`&&`/`|`, `$(...)`, backticks, `<(...)`, heredocs), never by a substring:
 *   - `security` run as a command (`/usr/bin/security`, after `sudo`, `env`,
 *     `exec`, `xargs`, `timeout`, ..., inside `sh -c '...'` or `eval`), with any
 *     subcommand but the few that never open a keychain (`cms -D` among them);
 *   - `osascript ... with administrator privileges` (the admin password dialog);
 *   - a script handed to an interpreter (`python3 -c`, `bash <<EOF`, `| sh`)
 *     that names `security` as a word: the script text only.
 * A word like `--security-group` or `describe-security-groups`, or `security`
 * as an argument (`grep security`, `command -v security`, `pytest tests/security`,
 * a commit message), is not a run.
 * Known limit: a program that calls `security` itself (a script file, `gh`,
 * `codesign` on a locked keychain) is not seen; the op's description says so, and
 * the host's daemon stops a run found idle at such a dialog (host-exec-watch.ts).
 *
 * The same refusal covers macOS's guarded places (permissionRisk, host-exec-guards.ts)
 * on a host Walnut knows is a Mac, so an older daemon that does not check them is covered.
 */
import path from 'node:path'
import os from 'node:os'
import { ANY_SHELL as SHELLS, ASSIGN, BEFORE_COMMAND, EXEC_FLAGS, WRAPPERS, permissionMessage, permissionRisk, shellInput as shellScript, stdinText, tokenize, type CommandInput } from '../../providers/host-exec-guards.js'

export interface PromptRisk {
  /** The command as the refusal names it, e.g. "security find-generic-password". */
  what: string
  kind: 'keychain' | 'admin-password'
}

/** `security` subcommands that read no keychain: help, error codes, the search list settings. */
const SAFE_SECURITY = new Set(['help', 'error', 'list-keychains', 'default-keychain', 'login-keychain'])

/** `security` as a standalone word anywhere in a line: not part of `--security-group`, `aws-security`, `security.txt`. */
const SECURITY_WORD = /(?:^|[\s'"`;&|()<>/=])security(?=$|[\s'"`;&|()<>])/
const ADMIN_PRIVILEGES = /with\s+administrator\s+privileges/i
const MAX_DEPTH = 8

/**
 * How an interpreter takes its script: `code` flags carry it inline (`python3 -c`, `perl -ne`,
 * `node --eval=`), `elsewhere` flags name a module or a file instead (`python3 -m`), `arg` options
 * take a value. With none of these and no operand, the script is stdin.
 */
interface Interpreter { code: string[]; bundled?: RegExp; arg?: string[]; elsewhere?: string[]; evalSub?: string }
const PYTHON: Interpreter = { code: ['-c'], arg: ['-W', '-X', '-Q'], elsewhere: ['-m'] }
const JS: Interpreter = { code: ['-e', '--eval', '-p', '--print'], arg: ['-r', '--require', '--import', '--loader', '--experimental-loader', '--input-type', '--env-file', '--preload', '--cwd', '-C', '--conditions'] }
const INTERPRETERS: Record<string, Interpreter> = {
  python: PYTHON, python2: PYTHON, python3: PYTHON,
  perl: { code: ['-e', '-E'], bundled: /^-[A-Za-z]*[eE]$/, arg: ['-I', '-M', '-m'] },
  ruby: { code: ['-e'], bundled: /^-[A-Za-z]*e$/, arg: ['-r', '-I', '-C', '-E'] },
  node: JS, bun: JS, deno: { code: [], evalSub: 'eval' },
  php: { code: ['-r'], arg: ['-c', '-d', '-z'], elsewhere: ['-f'] },
  lua: { code: ['-e'], arg: ['-l'] },
  expect: { code: ['-c'], elsewhere: ['-f'] },
  tclsh: { code: [] }, swift: { code: [] },
  pwsh: { code: ['-c', '-Command', '-command', '--command'], elsewhere: ['-File', '-file', '-f'] },
}
const OSASCRIPT: Interpreter = { code: ['-e'], arg: ['-l', '-s'] }

/** The script an interpreter runs from its arguments: its inline code, 'stdin', or null (a file, a module, a subcommand: not seen here). */
function interpreterScript(spec: Interpreter, args: string[]): string[] | 'stdin' | null {
  const code: string[] = []
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    if (spec.code.includes(a) || spec.bundled?.test(a)) { if (k + 1 < args.length) code.push(args[++k]); continue }
    const eq = a.indexOf('=')
    if (a.startsWith('--') && eq > 0 && spec.code.includes(a.slice(0, eq))) { code.push(a.slice(eq + 1)); continue }
    const attached = spec.code.find((f) => f.length === 2 && a.length > 2 && a.startsWith(f))
    if (attached) { code.push(a.slice(2)); continue }
    if (code.length) return code
    if (spec.elsewhere?.includes(a)) return null
    if (a === '-') return 'stdin'
    if (a === '--') return args[k + 1] === undefined || args[k + 1] === '-' ? 'stdin' : null
    if (a.startsWith('-') && a.length > 1) { if (spec.arg?.includes(a)) k++; continue }
    // The first operand: a script file or a subcommand (`swift test`), or `deno eval <code>`.
    if (spec.evalSub === a) return k + 1 < args.length ? [args[k + 1]] : null
    return null
  }
  return code.length ? code : 'stdin'
}

function securityRisk(args: string[]): PromptRisk | null {
  let k = 0
  let interactive = false
  while (k < args.length && args[k].startsWith('-') && args[k].length > 1) {
    if (args[k] === '-i' || args[k] === '-p') interactive = true
    k += args[k] === '-p' ? 2 : 1
  }
  const sub = args[k]
  if (sub === undefined) return interactive ? { what: 'security -i', kind: 'keychain' } : null
  if (SAFE_SECURITY.has(sub)) return null
  // `security cms -D` decodes a signed message (a .mobileprovision) and opens no keychain; `-S` signs with a key from one.
  if (sub === 'cms' && args.slice(k + 1).includes('-D') && !args.slice(k + 1).includes('-S')) return null
  return { what: `security ${sub}`, kind: 'keychain' }
}

function fallback(text: string): PromptRisk | null {
  return SECURITY_WORD.test(text) ? { what: 'a script that runs security', kind: 'keychain' } : null
}

/** Wrappers followed per command (`sudo env nohup ...`), as programAt does: a line of thousands of them is not a command. */
const MAX_WRAPPER_HOPS = 16
const NO_INPUT: CommandInput = { text: '', heredocs: [], pipedFrom: [] }

/**
 * The risk of one simple command. Only what the command itself runs counts: a `security` program,
 * a shell's or an interpreter's own script text (its `-c`/`-e` code, its heredoc, what is piped into
 * it), never its other words: `python3 -m pytest tests/security`, `swift test --filter security`
 * and a commit message that names it run nothing (2026-11-03 review). `scanExec` reads find's `-exec`
 * commands: only in the outer call, so a chain of `-exec` words costs one pass, not one per subset of
 * them (2026-11-03 review: 32 of them took over a second on the event loop).
 */
function commandRisk(words: string[], start: number, input: CommandInput, depth: number, scanExec = true): PromptRisk | null {
  let i = start
  for (let hop = 0; ; hop++) {
    while (i < words.length && (ASSIGN.test(words[i]) || BEFORE_COMMAND.has(words[i]))) i++
    if (i >= words.length || hop > MAX_WRAPPER_HOPS) return null
    const name = path.posix.basename(words[i])
    const wrapper = Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name] : undefined
    if (!wrapper) break
    const at = wrapper(words.slice(i + 1))
    if (at === null) return null
    i = i + 1 + at
  }
  const first = words[i]
  if (first === 'for' || first === 'case' || first === 'select' || first === 'function' || first === '[[' || first === '[') return null
  const name = path.posix.basename(first)
  const rest = () => words.slice(i + 1)
  if (name === 'security') return securityRisk(rest())
  if (name === 'osascript') {
    const script = interpreterScript(OSASCRIPT, rest())
    if (script === null) return null
    const text = script === 'stdin' ? stdinText(input) : script.join('\n')
    return ADMIN_PRIVILEGES.test(text) ? { what: 'osascript with administrator privileges', kind: 'admin-password' } : fallback(text)
  }
  if (SHELLS.has(name)) {
    const script = shellScript(rest())
    if (script === null) return null
    if (script !== 'stdin') return lineRisk(script, depth + 1)
    // Its own heredoc is shell text; what a pipe feeds it is some program's output, read for the word.
    for (const body of input.heredocs) {
      const hit = lineRisk(body, depth + 1)
      if (hit) return hit
    }
    return fallback(input.pipedFrom.flatMap((f) => [f.text, ...f.heredocs]).join('\n'))
  }
  if (name === 'eval') return lineRisk(rest().join(' '), depth + 1)
  const interpreter = Object.hasOwn(INTERPRETERS, name) ? INTERPRETERS[name] : undefined
  if (interpreter) {
    const script = interpreterScript(interpreter, rest())
    return script === null ? null : fallback(script === 'stdin' ? stdinText(input) : script.join('\n'))
  }
  // find -exec / -ok: the word after it is a command.
  if (scanExec) {
    for (let k = i + 1; k < words.length; k++) {
      if (EXEC_FLAGS.has(words[k])) {
        const hit = commandRisk(words, k + 1, NO_INPUT, depth, false)
        if (hit) return hit
      }
    }
  }
  return null
}

function lineRisk(line: string, depth: number): PromptRisk | null {
  if (depth > MAX_DEPTH) return null
  const { commands, inputs, subs } = tokenize(line)
  for (let k = 0; k < commands.length; k++) {
    const hit = commandRisk(commands[k], 0, inputs[k], depth)
    if (hit) return hit
  }
  for (const body of subs) {
    const hit = lineRisk(body, depth + 1)
    if (hit) return hit
  }
  return null
}

/** The first thing in `line` (a shell line) that can show a password dialog on the host's screen, or null. */
export function promptRisk(line: string): PromptRisk | null {
  return lineRisk(line, 0)
}

/** A host's system and home, as its daemon last reported them (host-profile.ts); nulls when Walnut has not seen it. */
async function hostSystem(host: string): Promise<{ platform: string | null; home: string | null }> {
  if (host === '__local__') return { platform: process.platform, home: os.homedir() }
  const { readHostProfile } = await import('./host-profile.js')
  const probed = (await readHostProfile(host).catch(() => null))?.probed
  const platform = probed?.os?.platform
  return { platform: typeof platform === 'string' && platform ? platform : null, home: typeof probed?.home === 'string' && probed.home.startsWith('/') ? probed.home : null }
}

/**
 * Why host_exec refuses `line` on `host`, or null. A command that can show a password dialog,
 * on a Mac or a host whose system Walnut has not seen yet; a command that reads a place macOS
 * guards, on a host Walnut knows is a Mac (its daemon checks that itself too, host-exec-core.ts).
 * Either dialog waits for someone there, and the run with it. The caller passes allow_prompts
 * once the user agreed.
 */
export async function promptRefusal(host: string, line: string, cwd?: string, taskId?: string): Promise<{ message: string; what: string } | null> {
  const risk = promptRisk(line)
  const system = await hostSystem(host)
  const mac = system.platform === 'darwin'
  if (!risk && !(mac && system.home)) return null
  const { hostName } = await import('./host-exec.js')
  const name = await hostName(host)
  if (risk && (mac || system.platform === null)) {
    const why = risk.kind === 'keychain'
      ? `\`${risk.what}\` can show a password dialog on ${name}'s screen (a locked login keychain) and wait there for someone`
      : `\`${risk.what}\` shows a password dialog on ${name}'s screen and waits there for someone`
    return { what: risk.what, message: `${why}, so the run would hang until it is stopped. Nothing ran. Ask the user first; if they agree, call again with allow_prompts: true.` }
  }
  if (mac && system.home) {
    const at = !cwd || cwd === '~' ? system.home : cwd.startsWith('~/') ? path.posix.join(system.home, cwd.slice(2)) : cwd.startsWith('/') ? cwd : system.home
    // WALNUT_TASK_DIR as the host names it, when its daemon told its root (no dial for it); else unknown, never judged.
    const { taskDirForHost } = await import('../sessions/task-dir-place.js')
    const taskDir = taskId ? await taskDirForHost(taskId, host).catch(() => null) : null
    const place = permissionRisk(line, at, system.home, taskDir ? { WALNUT_TASK_DIR: taskDir } : {})
    if (place) return { what: `${place.program} ${place.path}`, message: permissionMessage(place, name) }
  }
  return null
}
