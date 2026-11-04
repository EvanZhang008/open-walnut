/**
 * Guards for `host_exec` that both sides run: this host's daemon before a run
 * (host-exec-core.ts, so both daemon twins), and the server before it asks a
 * host (src/core/hosts/host-exec-prompts.ts), so an older daemon is covered too.
 *
 * 1. A shell line read the way a shell reads it, enough to find the commands in
 *    it: quotes, `\`, `;`/`&&`/`|`, `$(...)`, backticks, `<(...)`, heredocs, and
 *    the wrappers that run another command (`sudo`, `env`, `timeout`, `xargs`).
 *
 * 2. On macOS, places the system asks the person at the Mac about before a
 *    program reads them (TCC). 2026-11-03: `du -sk ~/Library/Caches` through
 *    host_exec on someone else's Mac put a permission dialog on her screen
 *    (tccd AUTHREQ_PROMPTING kTCCServiceMediaLibrary, for this daemon) and du sat
 *    in it at 0.01 s of CPU for 6 minutes. `permissionRisk` names a command that
 *    reads such a place, or walks a tree holding one (`du ~`, `find ~/Library`).
 *    A small table, false negatives accepted: `ls ~`, `cat ~/x`, `du -sh ~/proj`
 *    must never be refused.
 *
 * What the table misses, a running job found waiting at such a dialog, is
 * host-exec-watch.ts.
 */
import path from 'node:path'

export const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*\+?=/
/** Words a command may follow in the same simple command (`if security ...`, `do security ...`). */
export const BEFORE_COMMAND = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'fi', 'done', 'esac', 'coproc'])

/** Where a wrapper's own command starts in its arguments, or null when it runs none. */
export type Wrapper = (args: string[]) => number | null

function skipOptions(args: string[], withArg: string[], opts: { assignments?: boolean; operands?: number } = {}): number {
  const takesArg = new Set(withArg)
  let k = 0
  while (k < args.length) {
    const a = args[k]
    if (a === '--') { k++; break }
    if (a.length > 1 && a.startsWith('-')) { k += takesArg.has(a) ? 2 : 1; continue }
    if (opts.assignments && ASSIGN.test(a)) { k++; continue }
    break
  }
  return k + (opts.operands ?? 0)
}

export const WRAPPERS: Record<string, Wrapper> = {
  sudo: (a) => skipOptions(a, ['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T', '--user', '--group', '--host', '--prompt', '--chdir', '--role', '--type', '--other-user', '--close-from', '--command-timeout'], { assignments: true }),
  doas: (a) => skipOptions(a, ['-u', '-C']),
  env: (a) => skipOptions(a, ['-u', '--unset', '-C', '--chdir', '-P', '-S', '--split-string'], { assignments: true }),
  exec: (a) => skipOptions(a, ['-a']),
  // `command -v security` only looks it up.
  command: (a) => (a.some((w) => w === '-v' || w === '-V') ? null : skipOptions(a, [])),
  builtin: () => 0,
  nohup: () => 0,
  unbuffer: () => 0,
  time: (a) => skipOptions(a, ['-o', '-f']),
  nice: (a) => skipOptions(a, ['-n', '--adjustment']),
  caffeinate: (a) => skipOptions(a, ['-w', '-t']),
  stdbuf: (a) => skipOptions(a, ['-i', '-o', '-e']),
  ionice: (a) => skipOptions(a, ['-c', '-n', '-p']),
  timeout: (a) => skipOptions(a, ['-s', '-k', '--signal', '--kill-after'], { operands: 1 }),
  gtimeout: (a) => skipOptions(a, ['-s', '-k', '--signal', '--kill-after'], { operands: 1 }),
  watch: (a) => skipOptions(a, ['-n', '--interval', '-q', '--equexit']),
  xargs: (a) => skipOptions(a, ['-n', '-I', '-L', '-P', '-s', '-E', '-d', '-a', '-J', '-R', '-S', '--max-args', '--replace', '--max-lines', '--max-procs', '--delimiter', '--arg-file', '--eof']),
  arch: (a) => skipOptions(a, ['-arch', '-e', '-d']),
  launchctl: (a) => (a[0] === 'asuser' || a[0] === 'bsexec' ? 2 : null),
}

/**
 * What a simple command may read as a script on stdin: its own heredoc bodies and herestrings,
 * and the commands piped into it (`a | b | this`), whose text and heredocs make what it reads.
 */
export interface CommandInput {
  /** The command's own text in the line, quotes and all. */
  text: string
  heredocs: string[]
  pipedFrom: CommandInput[]
}

/** `commands[k]` reads `inputs[k]`. */
export interface Tokens { commands: string[][]; inputs: CommandInput[]; subs: string[] }

/** The end of a `$(`/`<(` body that starts at `i` (just past its open paren): the index of its close paren. */
function closeParen(src: string, i: number): number {
  let depth = 1
  while (i < src.length) {
    const c = src[i]
    if (c === '\\') { i += 2; continue }
    if (c === "'") { const e = src.indexOf("'", i + 1); i = e < 0 ? src.length : e + 1; continue }
    if (c === '"') { i++; while (i < src.length && src[i] !== '"') i += src[i] === '\\' ? 2 : 1; i++; continue }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i
    i++
  }
  return src.length
}

/** Split a line into simple commands of unquoted words, with every command substitution's body set aside. */
export function tokenize(src: string): Tokens {
  const commands: string[][] = []
  const inputs: CommandInput[] = []
  const subs: string[] = []
  let cur: string[] = []
  let input: CommandInput = { text: '', heredocs: [], pipedFrom: [] }
  let cmdStart = 0
  let word = ''
  let inWord = false
  let dropNext: 'target' | 'heredoc' | 'herestring' | null = null
  const heredocs: Array<{ delim: string; strip: boolean; into: CommandInput }> = []
  let heredocStrip = false
  const endWord = () => {
    if (!inWord) return
    if (dropNext === 'heredoc') heredocs.push({ delim: word, strip: heredocStrip, into: input })
    else if (dropNext === 'herestring') input.heredocs.push(word)
    else if (dropNext !== 'target') cur.push(word)
    dropNext = null
    word = ''
    inWord = false
  }
  /** End the command at `at`; `pipe` when a `|` sends its output to the next one. */
  const endCommand = (at: number, pipe = false) => {
    endWord()
    const done = input
    const had = cur.length > 0
    if (had) { done.text = src.slice(cmdStart, at); commands.push(cur); inputs.push(done) }
    cur = []
    input = { text: '', heredocs: [], pipedFrom: pipe ? (had ? [...done.pipedFrom, done] : done.pipedFrom) : [] }
  }
  /** A `$(`/`<(`/`>(` body from `i`: kept for its own scan, and the word gets its text. */
  const substitution = (i: number, open: string): number => {
    const end = closeParen(src, i)
    subs.push(src.slice(i, end))
    word += open + src.slice(i, end) + ')'
    inWord = true
    return end + 1
  }
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '\n') {
      endCommand(i)
      i++
      // Heredoc bodies are data, kept for the command they feed (a shell or an interpreter reading one).
      for (const h of heredocs.splice(0)) {
        const body: string[] = []
        while (i < src.length) {
          const nl = src.indexOf('\n', i)
          const lineEnd = nl < 0 ? src.length : nl
          const text = src.slice(i, lineEnd)
          i = lineEnd + 1
          if ((h.strip ? text.replace(/^\t+/, '') : text) === h.delim) break
          body.push(text)
        }
        h.into.heredocs.push(body.join('\n'))
      }
      cmdStart = i
      continue
    }
    if (c === ' ' || c === '\t') { endWord(); i++; continue }
    if (c === '#' && !inWord) { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue }
    if (c === '\\') {
      if (src[i + 1] === '\n') { i += 2; continue }
      word += src[i + 1] ?? ''
      inWord = true
      i += 2
      continue
    }
    if (c === "'") {
      const e = src.indexOf("'", i + 1)
      word += src.slice(i + 1, e < 0 ? src.length : e)
      inWord = true
      i = e < 0 ? src.length : e + 1
      continue
    }
    if (c === '$' && src[i + 1] === "'") {
      let j = i + 2
      while (j < src.length && src[j] !== "'") {
        if (src[j] === '\\' && j + 1 < src.length) { const n = src[j + 1]; word += n === 'n' ? '\n' : n === 't' ? '\t' : n; j += 2 } else word += src[j++]
      }
      inWord = true
      i = j + 1
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < src.length && src[j] !== '"') {
        const d = src[j]
        if (d === '\\' && j + 1 < src.length) { word += '$`"\\\n'.includes(src[j + 1]) ? src[j + 1] : d + src[j + 1]; j += 2; continue }
        if (d === '$' && src[j + 1] === '(' && src[j + 2] !== '(') { const end = closeParen(src, j + 2); subs.push(src.slice(j + 2, end)); word += src.slice(j, end + 1); j = end + 1; continue }
        if (d === '`') { const e = src.indexOf('`', j + 1); const end = e < 0 ? src.length : e; subs.push(src.slice(j + 1, end)); word += src.slice(j, end + 1); j = end + 1; continue }
        word += d
        j++
      }
      inWord = true
      i = j + 1
      continue
    }
    if (c === '$' && src[i + 1] === '(') {
      // $(( ... )): arithmetic, not a command.
      if (src[i + 2] === '(') { const end = closeParen(src, i + 2); word += src.slice(i, end + 1); inWord = true; i = end + 1; continue }
      i = substitution(i + 2, '$(')
      continue
    }
    if (c === '`') {
      const e = src.indexOf('`', i + 1)
      const end = e < 0 ? src.length : e
      subs.push(src.slice(i + 1, end))
      word += src.slice(i, end + 1)
      inWord = true
      i = end + 1
      continue
    }
    if ((c === '<' || c === '>') && src[i + 1] === '(') { endWord(); i = substitution(i + 2, `${c}(`); continue }
    if (c === '<' || c === '>' || (c === '&' && src[i + 1] === '>')) {
      // A redirection: an fd number before it is not a word, the word after it is its target.
      if (inWord && /^\d+$/.test(word)) { word = ''; inWord = false } else endWord()
      const op = /^(?:<<<|<<-|<<|<>|>>|>\||>&|<&|&>>|&>|<|>)/.exec(src.slice(i))![0]
      i += op.length
      dropNext = op === '<<' || op === '<<-' ? 'heredoc' : op === '<<<' ? 'herestring' : 'target'
      heredocStrip = op === '<<-'
      continue
    }
    if (c === '|' && src[i + 1] !== '|') {
      // `|` and `|&` send this command's output to the next one; `||` does not.
      endCommand(i, true)
      i += src[i + 1] === '&' ? 2 : 1
      cmdStart = i
      continue
    }
    if (c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
      endCommand(i)
      i += (c === '|' || c === '&') && src[i + 1] === c ? 2 : 1
      cmdStart = i
      continue
    }
    word += c
    inWord = true
    i++
  }
  endCommand(src.length)
  return { commands, inputs, subs }
}


/** Every simple command of a line, its command substitutions' included. */
export function simpleCommands(line: string, depth = 0): string[][] {
  if (depth > 8) return []
  const { commands, subs } = tokenize(line)
  return [...commands, ...subs.flatMap((body) => simpleCommands(body, depth + 1))]
}

/** Where the program of a simple command is: past assignments, `if`/`do`, and wrappers. -1 for none. */
export function programAt(words: string[], start = 0): number {
  let i = start
  for (let guard = 0; guard < 16; guard++) {
    while (i < words.length && (ASSIGN.test(words[i]) || BEFORE_COMMAND.has(words[i]))) i++
    if (i >= words.length) return -1
    const name = path.posix.basename(words[i])
    const wrapper = Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name] : undefined
    if (!wrapper) return i
    const at = wrapper(words.slice(i + 1))
    if (at === null) return -1
    i = i + 1 + at
  }
  return -1
}

// ── macOS places a program may not read without the person's OK (TCC) ──

/** Under the home directory: their content is behind a permission dialog. */
const PROTECTED_IN_HOME = [
  'Desktop', 'Documents', 'Downloads', 'Pictures', 'Movies', 'Music',
  'Library/Mail', 'Library/Messages', 'Library/Safari', 'Library/Containers', 'Library/Group Containers',
  'Library/Calendars', 'Library/Application Support/AddressBook', 'Library/Mobile Documents', 'Library/CloudStorage',
]
/** A tree walked from one of these reaches such content (the home, ~/Library, ~/Library/Caches, every user, every volume). */
const WALK_ROOTS_IN_HOME = ['', 'Library', 'Library/Caches']
const WALK_ROOTS = ['/', '/Users', '/Volumes']

/** Programs that read a whole tree: always, or with one of the flags matched. The first operand of a search tool is its pattern. */
const WALKERS: Record<string, { always?: boolean; flag?: RegExp; long?: string[]; pattern?: boolean }> = {
  du: { always: true }, find: { always: true }, tree: { always: true }, fd: { always: true, pattern: true },
  rg: { always: true, pattern: true }, ag: { always: true, pattern: true }, ack: { always: true, pattern: true },
  grep: { flag: /^-[A-Za-z]*[rR]/, long: ['--recursive', '--dereference-recursive'], pattern: true },
  egrep: { flag: /^-[A-Za-z]*[rR]/, long: ['--recursive'], pattern: true },
  ls: { flag: /^-[A-Za-z]*R/, long: ['--recursive'] },
  cp: { flag: /^-[A-Za-z]*[rRa]/, long: ['--recursive', '--archive'] },
  rsync: { flag: /^-[A-Za-z]*[ra]/, long: ['--recursive', '--archive'] },
  zip: { flag: /^-[A-Za-z]*r/, long: ['--recurse-paths'] },
  tar: { flag: /^-?[A-Za-z]*c[A-Za-z]*$/, long: ['--create'] },
}

function walks(name: string, args: string[]): boolean {
  const w = Object.hasOwn(WALKERS, name) ? WALKERS[name] : undefined
  if (!w) return false
  if (w.always) return true
  // tar's first word may be its bundled flags with no dash (`tar czf x.tgz dir`).
  const flags = name === 'tar' ? args.slice(0, 1).concat(args.filter((a) => a.startsWith('-'))) : args.filter((a) => a.startsWith('-'))
  return flags.some((a) => (w.flag?.test(a) ?? false) || (w.long ?? []).includes(a))
}

/** Programs that only print a path they are given, never read it. */
const NAMES_ONLY = new Set(['echo', 'printf', 'basename', 'dirname'])
const SHELL_NAMES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])

/** Every shell a line may hand a script to. */
export const ANY_SHELL: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'yash', 'fish', 'csh', 'tcsh'])
/** find's words that start a command of their own. */
export const EXEC_FLAGS: ReadonlySet<string> = new Set(['-exec', '-execdir', '-ok', '-okdir'])

/**
 * What a shell given `args` runs: the `-c` / `--command` script, `'stdin'` when it reads its
 * script from stdin (`-s`, no script file, `bash -o pipefail` and the like), or null for a file.
 */
export function shellInput(args: string[]): string | 'stdin' | null {
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    if (a.startsWith('--command=')) return a.slice('--command='.length)
    if (a === '--command' || /^-[A-Za-z]*c[A-Za-z]*$/.test(a)) return args.slice(k + 1).find((w) => !w.startsWith('-')) ?? null
    if (/^-[A-Za-z]*s[A-Za-z]*$/.test(a)) return 'stdin'
    if (a === '--') return args[k + 1] === undefined ? 'stdin' : null
    if (a === '-o' || a === '+o' || a === '-O' || a === '+O') { k++; continue }
    if (a.startsWith('-') || a.startsWith('+')) continue
    return null
  }
  return 'stdin'
}

/** What a command reads as a script on stdin: its heredocs and herestrings, and what is piped in. */
export function stdinText(input: CommandInput): string {
  return [...input.heredocs, ...input.pipedFrom.flatMap((f) => [f.text, ...f.heredocs])].join('\n')
}

/** The script a shell runs with `-c` (`bash -lc '...'`), or null. */
export function shellScript(program: string, args: string[]): string | null {
  if (!SHELL_NAMES.has(program)) return null
  for (let i = 0; i < args.length; i++) {
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(args[i])) return args[i + 1] ?? null
    if (!args[i].startsWith('-')) return null
  }
  return null
}

/** A word that names a path on its face (a bare word is a path only to a tree walker). */
const LOOKS_LIKE_PATH = /^(?:~(?:\/|$)|\/|\$|\.\.?(?:\/|$))|\//

/** A word's leading `$NAME` or `${NAME}`, then a `/` or its end. */
const LEAD_VAR = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})(?=\/|$)/

/**
 * A path word as the host sees it, or null when where it points is not known here. `~`, $HOME and
 * the variables in `vars` (WALNUT_TASK_DIR where it is known) are expanded; a word that starts with
 * any other variable, `${X:-...}`, `$(...)` or `~user` is unknown, and is never judged (2026-11-03
 * review: `"$WALNUT_TASK_DIR"` was cut to `.`, the home, so `du -sh $WALNUT_TASK_DIR` was refused).
 * A relative word is read from `cwd` (null: unknown). A pattern later in the word cuts it there
 * (`~/*` reads the home itself), and so does a variable after the first segment
 * (`~/Library/$d` is somewhere in ~/Library).
 */
export function resolvePathWord(word: string, cwd: string | null, home: string, vars: Record<string, string> = {}): string | null {
  let p = word
  if (p === '~' || p.startsWith('~/')) p = home + p.slice(1)
  else if (p.startsWith('~')) return null
  else if (p.startsWith('$') || p.startsWith('`')) {
    const m = LEAD_VAR.exec(p)
    const name = m ? (m[1] ?? m[2]) : null
    const value = name === 'HOME' ? home : name !== null && Object.hasOwn(vars, name) ? vars[name] : null
    if (!m || !value || !value.startsWith('/')) return null
    p = value + p.slice(m[0].length)
  }
  const segs = p.split('/')
  const cut = segs.findIndex((s) => /[*?[\]$`{]/.test(s))
  if (cut === 0 && /[$`]/.test(segs[0])) return null
  if (cut >= 0) p = segs.slice(0, cut).join('/') || (p.startsWith('/') ? '/' : '.')
  if (!p.startsWith('/')) {
    if (cwd === null) return null
    p = path.posix.join(cwd, p)
  }
  const n = path.posix.normalize(p)
  return n.length > 1 ? n.replace(/\/+$/, '') : n
}

const within = (p: string, root: string) => p === root || p.startsWith(root === '/' ? '/' : root + '/')

export interface PermissionRisk {
  /** The path as the host sees it, e.g. /Users/sam/Library/Caches. */
  path: string
  /** `reads`: the place is protected itself; `walks`: a tree walk from it reaches protected places. */
  how: 'reads' | 'walks'
  /** The program, e.g. du. */
  program: string
}

/**
 * The first command in `line` that reads a protected place, or walks a tree that holds one; null for
 * none. `vars` holds what the run's environment is known to set (WALNUT_TASK_DIR). A `cd` moves where
 * the commands after it stand.
 */
export function permissionRisk(line: string, cwd: string, home: string, vars: Record<string, string> = {}): PermissionRisk | null {
  return riskOf(line, cwd, home, vars, 0)
}

function riskOf(line: string, cwd: string | null, home: string, vars: Record<string, string>, depth: number): PermissionRisk | null {
  if (depth > 8) return null
  const protectedPlaces = PROTECTED_IN_HOME.map((p) => path.posix.join(home, p))
  const walkRoots = [...WALK_ROOTS_IN_HOME.map((p) => (p ? path.posix.join(home, p) : home)), ...WALK_ROOTS]
  const isProtected = (p: string) => protectedPlaces.some((root) => within(p, root)) || p.startsWith('/Volumes/')
  // Walking p reaches a protected place: p is one, holds one, or is a root above them.
  const walkReaches = (p: string) => isProtected(p) || walkRoots.includes(p) || protectedPlaces.some((root) => within(root, p))
  let where = cwd
  for (const words of simpleCommands(line)) {
    const at = programAt(words)
    if (at < 0) continue
    const program = path.posix.basename(words[at])
    if (NAMES_ONLY.has(program)) continue
    const args = words.slice(at + 1)
    if (program === 'cd' || program === 'pushd' || program === 'popd') {
      const to = program === 'popd' ? '-' : args.find((a) => !(a.startsWith('-') && a.length > 1))
      where = to === undefined ? home : to === '-' ? null : resolvePathWord(to, where, home, vars)
      if (where !== null && isProtected(where)) return { path: where, how: 'reads', program }
      continue
    }
    // A script run by another shell, or by eval, is read the same way.
    const script = program === 'eval' ? args.join(' ') : shellScript(program, args)
    if (script !== null) {
      const inner = riskOf(script, where, home, vars, depth + 1)
      if (inner) return inner
      continue
    }
    const walker = walks(program, args)
    // find's paths are the words after its own options and before its expression (`-name "*.swift"` is not a path).
    const lead = program === 'find' ? Math.max(0, args.findIndex((a) => !/^-[HLPEXdsx]+$/.test(a))) : 0
    const exprAt = program === 'find' ? args.findIndex((a, i) => i >= lead && (a.startsWith('-') || a === '(' || a === '!')) : -1
    let here = where
    const paths: Array<{ word: string; at: string | null }> = []
    const window = args.slice(lead, exprAt >= 0 ? exprAt : args.length)
    for (let k = 0; k < window.length; k++) {
      const a = window[k]
      // tar -C <dir>: the words after it are read from there; the directory itself is not walked.
      if (program === 'tar' && (a === '-C' || a === '--directory')) { if (k + 1 < window.length) here = resolvePathWord(window[++k], here, home, vars); continue }
      if (program === 'tar' && a.startsWith('--directory=')) { here = resolvePathWord(a.slice('--directory='.length), here, home, vars); continue }
      if (!(a.startsWith('-') && a.length > 1)) paths.push({ word: a, at: here })
    }
    const targets = walker && Object.hasOwn(WALKERS, program) && WALKERS[program].pattern ? paths.slice(1) : paths
    // A walker given no path walks where it stands; through xargs its paths come from its input, unseen.
    const viaXargs = words.slice(0, at).some((w) => path.posix.basename(w) === 'xargs')
    if (walker && targets.length === 0 && !viaXargs && where !== null && walkReaches(where)) return { path: where, how: 'walks', program }
    for (const { word, at: from } of targets) {
      if (!walker && !LOOKS_LIKE_PATH.test(word)) continue
      const p = resolvePathWord(word, from, home, vars)
      if (p === null) continue
      if (isProtected(p)) return { path: p, how: 'reads', program }
      if (walker && walkReaches(p)) return { path: p, how: 'walks', program }
    }
  }
  return null
}

/** The refusal for a permission risk, the same words from the daemon (`where` = "this Mac") and the server. */
export function permissionMessage(risk: PermissionRisk, where: string): string {
  return `\`${risk.program}\` would ${risk.how === 'reads' ? 'read' : 'walk through'} ${risk.path}, which macOS guards: it shows a permission dialog `
    + `on ${where}'s screen and the command waits there until someone answers. Nothing ran. Leave that path out (on a Mac never `
    + 'scan ~, ~/Library or ~/Library/Caches, and never read Desktop, Documents, Downloads, Pictures, Movies, Music, Mail, Messages '
    + 'or /Volumes), or ask the user first and call again with allow_prompts: true.'
}
