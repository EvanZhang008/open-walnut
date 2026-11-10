/**
 * Read the `walnut tools call <op> …` calls out of a shell command, with the
 * payload each one sent when the command itself holds it.
 *
 * A session's Bash row is the only trace of most of its Walnut calls, and a
 * model writes them many ways: inline JSON (`'{"to":…}'`), flags (`--to x`), a
 * file it wrote a moment before (`cat > /tmp/a.json <<'EOF' … EOF` then
 * `@/tmp/a.json`, or `echo '…' > f`), stdin (`… | walnut tools call op -`, a
 * heredoc on the call itself), several calls in one command, a loop. The web
 * cards them (SessionOutboundCard); the server ties a recorded call to its row
 * (core/sessions/op-call-log.ts).
 *
 * Rules, each one a way a naive reader is wrong:
 *  · Tokenize; never regex the raw string. `echo "walnut tools call task_send …"`
 *    is ONE quoted word, so it is prose, while `x | walnut tools call op -` is a
 *    real call at a command position.
 *  · A heredoc body is data. It is cut out before tokenizing, so words inside it
 *    never read as commands, and kept as the payload of whatever reads it.
 *  · `tools help <op>` and `tools call <op> --help` ask about an op: no call.
 *
 * Pure, dependency-free, never throws. The web imports it.
 */

export interface ShellToken {
  /** The word with one level of quoting removed. */
  value: string
  /** True when any part of the word was quoted: a quoted `walnut` is prose. */
  quoted: boolean
  /** True for a run of shell operators (`|`, `&&`, `;`, newline, …). */
  op: boolean
  /** True when the shell would expand part of it (`$x`, `$(…)`, a backtick outside
   *  single quotes): its value here is not what the command saw. */
  expands?: boolean
}

export type OpArgForm = 'inline' | 'file' | 'stdin' | 'flags' | 'none'

export interface CommandOpCall {
  op: string
  form: OpArgForm
  /** The arguments, when the command holds them (inline, flags, a file or
   *  stdin this same command wrote). */
  args?: Record<string, unknown>
  /** `@path` as typed. */
  path?: string
  /** The argument word as typed (inline JSON), for a reader's disclosure. */
  argText?: string
}

/** Shell metacharacters that end a word and start a new command position. */
const OPERATOR_CHARS = new Set([';', '|', '&', '(', ')', '{', '}', '\n'])

/** Tokens that may precede a command without moving it out of head position. */
const COMMAND_WRAPPERS = new Set(['env', 'exec', 'sudo', 'time', 'nice', 'command', 'builtin', 'do', 'then', 'else', '!'])

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Guard against tokenizer work inside a render for a pathological input. */
const MAX_COMMAND_CHARS = 400_000

const HEREDOC_WORD = '\u0000HEREDOC'
/** A heredoc body the shell expands: its text here is not what the command read. */
const EXPANDED_BODY = '\u0000EXPANDED'

/**
 * Split a shell command into words, undoing ONE level of quoting.
 *
 * Not a shell; the smallest thing that reads a `walnut tools call` line right.
 * Concatenation makes it work: `'it'\''s'` is three adjacent pieces of one word,
 * so appending each piece reproduces the literal the shell passes.
 */
export function tokenizeCommand(command: string): ShellToken[] {
  const tokens: ShellToken[] = []
  const n = command.length
  let i = 0
  while (i < n) {
    const c = command[i]
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue }
    if (c === '#' && (i === 0 || /[\s;|&()]/.test(command[i - 1]))) {
      while (i < n && command[i] !== '\n') i++
      continue
    }
    if (OPERATOR_CHARS.has(c)) {
      let j = i
      while (j < n && OPERATOR_CHARS.has(command[j])) j++
      tokens.push({ value: command.slice(i, j), quoted: false, op: true })
      i = j
      continue
    }
    let value = ''
    let quoted = false
    let expands = false
    while (i < n) {
      const ch = command[i]
      if (ch === ' ' || ch === '\t' || ch === '\r' || OPERATOR_CHARS.has(ch)) break
      if (ch === "'") {
        quoted = true
        const close = command.indexOf("'", i + 1)
        if (close < 0) { value += command.slice(i + 1); i = n; break }
        value += command.slice(i + 1, close)
        i = close + 1
        continue
      }
      if (ch === '"') {
        quoted = true
        i++
        while (i < n && command[i] !== '"') {
          if (command[i] === '\\' && i + 1 < n) { value += command[i + 1]; i += 2; continue }
          if (command[i] === '$' || command[i] === '`') expands = true
          value += command[i++]
        }
        i++
        continue
      }
      if (ch === '$' && command[i + 1] === "'") {
        // ANSI-C quoting: $'…' with \n, \t, \', \\ escapes.
        quoted = true
        i += 2
        while (i < n && command[i] !== "'") {
          if (command[i] === '\\' && i + 1 < n) {
            const e = command[i + 1]
            value += e === 'n' ? '\n' : e === 't' ? '\t' : e
            i += 2
            continue
          }
          value += command[i++]
        }
        i++
        continue
      }
      if (ch === '\\' && i + 1 < n) {
        // A backslash-newline joins lines.
        if (command[i + 1] !== '\n') value += command[i + 1]
        i += 2
        continue
      }
      if (ch === '$' || ch === '`') expands = true
      value += ch
      i++
    }
    tokens.push({ value, quoted, op: false, ...(expands ? { expands } : {}) })
  }
  return tokens
}

/**
 * Cut every heredoc body out of `command`. Each `<<DELIM` becomes one word the
 * tokenizer keeps (`\0HEREDOC<n>`), and its body is returned by index. One pass
 * with the tokenizer's own lexical state: a `<<` inside quotes (single, double,
 * across lines too) or after a `#` comment opens nothing, and `<<<` is a
 * here-string.
 */
export function extractHeredocs(command: string): { text: string; bodies: string[] } {
  if (!command.includes('<<')) return { text: command, bodies: [] }
  const bodies: string[] = []
  let out = ''
  let quote: '"' | "'" | null = null
  let comment = false
  const pending: { strip: boolean; delim: string; expands: boolean }[] = []
  const n = command.length
  let i = 0
  while (i < n) {
    const c = command[i]
    if (c === '\n') {
      out += c
      i++
      comment = false
      if (quote || pending.length === 0) continue
      // The bodies of this line's heredocs follow it, one after another.
      for (const p of pending) {
        const body: string[] = []
        while (i < n) {
          const eol = command.indexOf('\n', i)
          const line = command.slice(i, eol < 0 ? n : eol)
          i = eol < 0 ? n : eol + 1
          const cmp = p.strip ? line.replace(/^\t+/, '') : line
          if (cmp === p.delim) break
          body.push(cmp)
        }
        const text = body.join('\n')
        // An unquoted delimiter expands `$x` and backticks in the body.
        bodies.push(p.expands && /[$`]/.test(text) ? EXPANDED_BODY : text)
      }
      pending.length = 0
      continue
    }
    if (comment) { out += c; i++; continue }
    if (quote) {
      out += c
      if (c === '\\' && quote === '"' && i + 1 < n) { out += command[i + 1]; i += 2; continue }
      if (c === quote) quote = null
      i++
      continue
    }
    if (c === '\\' && i + 1 < n) { out += c + command[i + 1]; i += 2; continue }
    if (c === "'" || c === '"') { quote = c; out += c; i++; continue }
    if (c === '#' && (i === 0 || /[\s;|&()]/.test(command[i - 1]))) { comment = true; out += c; i++; continue }
    if (c === '<' && command[i + 1] === '<' && command[i + 2] !== '<' && command[i - 1] !== '<') {
      const m = /^<<(-?)\s*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([A-Za-z_][A-Za-z0-9_]*))/.exec(command.slice(i, i + 200))
      if (m) {
        out += ` ${HEREDOC_WORD}${bodies.length + pending.length} `
        pending.push({ strip: m[1] === '-', delim: m[2] ?? m[3] ?? m[4], expands: m[4] !== undefined })
        i += m[0].length
        continue
      }
    }
    out += c
    i++
  }
  // A heredoc whose line never ended: no body.
  for (let k = 0; k < pending.length; k++) bodies.push('')
  return { text: out, bodies }
}

function isWalnutBinary(word: string): boolean {
  const base = word.slice(word.lastIndexOf('/') + 1)
  return base === 'walnut' || base === 'open-walnut'
}

function atCommandPosition(tokens: ShellToken[], i: number): boolean {
  if (i === 0) return true
  const prev = tokens[i - 1]
  if (prev.op) return true
  if (prev.quoted) return false
  return ENV_ASSIGN.test(prev.value) || COMMAND_WRAPPERS.has(prev.value)
}

function parseJsonObject(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined
  try {
    const v: unknown = JSON.parse(text.trim())
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** One simple command: its words, and the operator that ended it. */
interface Segment { words: ShellToken[]; end: string }

function segmentsOf(tokens: ShellToken[]): Segment[] {
  const out: Segment[] = []
  let words: ShellToken[] = []
  for (const t of tokens) {
    if (t.op) { out.push({ words, end: t.value }); words = []; continue }
    words.push(t)
  }
  out.push({ words, end: '' })
  return out
}

/** The text a segment writes to stdout or to a file, when it is a literal writer
 *  (`cat <<EOF`, `echo '…'`, `printf '%s' '…'`), with the file it redirects into. */
function literalOutput(seg: Segment, bodies: string[]): { text: string; file?: string; append?: boolean } | null {
  const w = seg.words
  if (w.length === 0) return null
  let i = 0
  while (i < w.length && !w[i].quoted && ENV_ASSIGN.test(w[i].value)) i++
  const head = w[i]?.value
  if (!head) return null
  let file: string | undefined
  let append = false
  const rest: ShellToken[] = []
  let heredoc: string | undefined
  for (let j = i + 1; j < w.length; j++) {
    const v = w[j].value
    if (!w[j].quoted && (v === '>' || v === '>>')) { file = w[j + 1]?.value; append = v === '>>'; j++; continue }
    if (!w[j].quoted && /^>>?[^>&]/.test(v)) { file = v.replace(/^>>?/, ''); append = v.startsWith('>>'); continue }
    if (!w[j].quoted && v.startsWith(HEREDOC_WORD)) { heredoc = bodies[Number(v.slice(HEREDOC_WORD.length))]; continue }
    if (!w[j].quoted && /^\d?>&?\d|^2>/.test(v)) continue
    rest.push(w[j])
  }
  // A writer whose words the shell expands wrote something this reader cannot know.
  if (heredoc === EXPANDED_BODY || rest.some((t) => t.expands)) return { text: '', ...(file ? { file } : {}), append: true }
  if (head === 'cat' || head === 'tee') {
    if (heredoc === undefined) return null
    if (head === 'tee' && rest[0] && !rest[0].value.startsWith('-')) file = rest[0].value
    return { text: heredoc, ...(file ? { file } : {}), ...(append ? { append } : {}) }
  }
  if (head === 'echo') {
    const words = rest.filter((t, k) => !(k === 0 && !t.quoted && /^-[neE]+$/.test(t.value)))
    return { text: words.map((t) => t.value).join(' '), ...(file ? { file } : {}), ...(append ? { append } : {}) }
  }
  if (head === 'printf') {
    if (rest.length === 0) return null
    const fmt = rest[0].value
    const text = rest.length > 1 && /^%s\\?n?$/.test(fmt) ? rest.slice(1).map((t) => t.value).join('') : fmt.replace(/\\n/g, '\n')
    return { text, ...(file ? { file } : {}), ...(append ? { append } : {}) }
  }
  return null
}

/**
 * Every real `walnut tools call <op>` in `command` whose op `wanted` accepts, in
 * order, with the payload when the command holds it. Empty for prose, help and
 * other ops.
 */
export function findOpCalls(command: string, wanted: (op: string) => boolean): CommandOpCall[] {
  if (!command.includes('tools') || !command.includes('call')) return []
  if (command.length > MAX_COMMAND_CHARS) return []
  const { text, bodies } = extractHeredocs(command)
  const tokens = tokenizeCommand(text)
  const segs = segmentsOf(tokens)
  const files = new Map<string, string>()
  const out: CommandOpCall[] = []
  let piped: string | undefined
  for (const seg of segs) {
    const call = opCallIn(seg, bodies, wanted, piped, files)
    if (call) out.push(call)
    const lit = literalOutput(seg, bodies)
    if (lit?.file && !lit.append) files.set(lit.file, lit.text)
    else {
      // Any other command that names a file this one wrote may have changed it
      // (`python3 fix.py a.json`, `sed -i … a.json`, `>> a.json`): what it holds
      // now is not known, so the reader claims nothing about it.
      for (const f of [...files.keys()]) if (!call && seg.words.some((w) => w.value.includes(f))) files.delete(f)
      if (lit?.file) files.delete(lit.file)
    }
    piped = seg.end === '|' && lit && !lit.file && !lit.append ? lit.text : undefined
  }
  return out
}

function opCallIn(
  seg: Segment,
  bodies: string[],
  wanted: (op: string) => boolean,
  piped: string | undefined,
  files: Map<string, string>,
): CommandOpCall | null {
  const w = seg.words
  for (let i = 0; i + 3 < w.length; i++) {
    const head = w[i]
    if (head.quoted || !isWalnutBinary(head.value)) continue
    if (!atCommandPosition(w, i)) continue
    const [tools, call, opTok] = [w[i + 1], w[i + 2], w[i + 3]]
    if ([tools, call, opTok].some((t) => t.quoted)) continue
    if (tools.value !== 'tools' || call.value !== 'call' || !wanted(opTok.value)) continue
    const rest = w.slice(i + 4)
    let heredoc: string | undefined
    const words: ShellToken[] = []
    for (let j = 0; j < rest.length; j++) {
      const v = rest[j].value
      if (!rest[j].quoted && v.startsWith(HEREDOC_WORD)) { heredoc = bodies[Number(v.slice(HEREDOC_WORD.length))]; continue }
      if (!rest[j].quoted && (v === '<' || v === '>' || v === '>>')) { j++; continue }
      if (!rest[j].quoted && /^(?:\d?>|<)/.test(v)) continue
      words.push(rest[j])
    }
    const arg = words[0]
    if (arg && (arg.value === '--help' || arg.value === '-h')) return null
    const op = opTok.value
    const stdin = heredoc === EXPANDED_BODY ? undefined : heredoc ?? piped
    if (!arg) return { op, form: stdin !== undefined ? 'stdin' : 'none', ...(stdin !== undefined ? withArgs(stdin) : {}) }
    if (arg.value === '-' && !arg.quoted) return { op, form: 'stdin', ...(stdin !== undefined ? withArgs(stdin) : {}) }
    if (arg.value.startsWith('@')) {
      const path = arg.value.slice(1)
      const written = files.get(path)
      return { op, form: 'file', path, ...(written !== undefined ? withArgs(written) : {}) }
    }
    if (arg.value.startsWith('--')) return { op, form: 'flags', args: flagArgs(words) }
    return { op, form: 'inline', argText: arg.value, ...(parseJsonObject(arg.value) ? { args: parseJsonObject(arg.value) } : {}) }
  }
  return null
}

function withArgs(text: string): { args?: Record<string, unknown>; argText: string } {
  const args = parseJsonObject(text)
  return { argText: text, ...(args ? { args } : {}) }
}

/** `--key value` pairs as the CLI reads them (booleans bare, `--a-b` = `a_b`). */
function flagArgs(words: ShellToken[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (let i = 0; i < words.length; i++) {
    const f = words[i].value
    if (!f.startsWith('--')) continue
    const key = f.slice(2).replace(/-/g, '_')
    const next = words[i + 1]
    if (!next || next.value.startsWith('--')) { out[key] = true; continue }
    out[key] = next.value === 'true' ? true : next.value === 'false' ? false : next.value
    i++
  }
  return out
}

/** True when `command` runs `op` (with `@path`, when given, matched by its full
 *  path or its file name). For tying a recorded call to the row that made it. */
export function commandRunsOp(command: string, op: string, path?: string): boolean {
  const calls = findOpCalls(command, (o) => o === op)
  if (calls.length === 0) return false
  if (!path) return true
  const base = path.slice(path.lastIndexOf('/') + 1)
  return calls.some((c) => c.path === path) || calls.some((c) => !!c.path && c.path.slice(c.path.lastIndexOf('/') + 1) === base)
}

/** What a call's output may be piped into and still be that call alone: readers that run nothing. */
const PIPE_READERS = new Set(['head', 'tail', 'jq', 'cat', 'grep', 'wc', 'less', 'sort', 'cut', 'column'])
/** A redirect that only sends output away. */
const NULL_REDIRECT = /^\d?>>?\/dev\/null$/

/**
 * The ONE Walnut op `command` runs when the command is that call and nothing else
 * (env prefixes before it, its own heredoc, a redirect to nowhere or a pipe into a
 * reader after it), or null. The web shows such a row as the MCP tool the CLI
 * stands in for (`mcp__walnut__<op>`): a chain, a loop, a script, a pipe into a
 * writer, a redirect into a file or anything the shell expands stays a command,
 * so the card never hides what ran.
 */
export function soleOpCall(command: string): CommandOpCall | null {
  if (!command.includes('tools') || command.length > MAX_COMMAND_CHARS) return null
  const { text, bodies } = extractHeredocs(command)
  if (bodies.some((b) => b === EXPANDED_BODY)) return null
  const tokens = tokenizeCommand(text)
  if (tokens.some((t) => t.expands)) return null
  // `2>&1` splits at its `&`: put it back together before reading commands.
  const words: ShellToken[] = []
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]
    if (t.op && t.value === '&' && /^\d?>$/.test(words[words.length - 1]?.value ?? '') && tokens[k + 1]?.value === '1' && !tokens[k + 1].op) {
      words[words.length - 1] = { ...words[words.length - 1], value: `${words[words.length - 1].value}&1` }
      k++
      continue
    }
    words.push(t)
  }
  const segs = segmentsOf(words)
  while (segs.length > 1 && segs[segs.length - 1].words.length === 0 && segs[segs.length - 2].end === '\n') segs.pop()
  const [first, ...after] = segs
  if (!first || !(first.end === '' || first.end === '|' || first.end === '\n')) return null
  const w = first.words
  let i = 0
  while (i < w.length && !w[i].quoted && (ENV_ASSIGN.test(w[i].value) || COMMAND_WRAPPERS.has(w[i].value))) i++
  if (!w[i] || w[i].quoted || !isWalnutBinary(w[i].value)) return null
  const call = opCallIn({ words: w.slice(i), end: first.end }, bodies, () => true, undefined, new Map())
  if (!call || !/^[a-z][a-z0-9_]*$/.test(call.op)) return null
  // The call's own words: its argument(s) and redirects to nowhere, never a second command.
  const rest = w.slice(i + 4).filter((t) => !(!t.quoted && t.value.startsWith(HEREDOC_WORD)))
  const isRedirect = (t: ShellToken) => !t.quoted && (NULL_REDIRECT.test(t.value) || /^\d?>&\d$/.test(t.value))
  const argWords = rest.filter((t) => !isRedirect(t))
  if (call.form !== 'flags' && argWords.length > 1) return null
  if (rest.some((t, k) => !t.quoted && /[<>]/.test(t.value) && !isRedirect(t) && !(t.value === '>' && rest[k + 1]?.value === '/dev/null'))) return null
  if (first.end === '\n' && after.some((s) => s.words.length > 0)) return null
  for (let k = 0; k < after.length; k++) {
    const s = after[k]
    if (s.words.length === 0) return null
    const head = s.words[0]
    if (head.quoted || !PIPE_READERS.has(head.value)) return null
    if (s.words.some((t) => !t.quoted && /[<>]/.test(t.value) && !isRedirect(t))) return null
    if (!(s.end === '|' || (s.end === '' && k === after.length - 1))) return null
  }
  return call
}
