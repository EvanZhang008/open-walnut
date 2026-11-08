/**
 * The scanner behind tests/scripts/no-pattern-kill-ratchet.test.ts: finds a kill by
 * name or pattern in shell, JS/TS and Python source. See the ratchet for the rules.
 */

export type Kind = 'shell' | 'js' | 'py'
export type KillRule = 'pkill' | 'killall' | 'search-kill'
export interface KillViolation { rule: KillRule; line: number; text: string }

/** How far after a captured search a kill still counts as killing its result. */
const CAPTURE_WINDOW = 40
const JS_WINDOW = 15

// ── shell ──────────────────────────────────────────────────────────────────

function stripTrailingComment(raw: string, marker: '#' | '//'): string {
  let quote: string | null = null
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!
    if (quote) {
      if (c === '\\') { i++; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (raw.startsWith(marker, i) && (i === 0 || /\s/.test(raw[i - 1]!))) return raw.slice(0, i)
  }
  return raw
}

/** The code of each line ('' for a comment line, the trailing comment cut), with a
 *  backslash-continued line joined onto its first line (the rest become ''). */
export function shellLines(content: string): string[] {
  const code = content.split('\n').map((raw) => (/^\s*#/.test(raw) ? '' : stripTrailingComment(raw, '#')))
  for (let i = 0; i < code.length; i++) {
    while (/\\\s*$/.test(code[i]!) && i + 1 < code.length) {
      const next = code.findIndex((l, k) => k > i && l !== '')
      if (next < 0) break
      code[i] = code[i]!.replace(/\\\s*$/, ' ') + code[next]!.trim()
      code[next] = ''
    }
  }
  return code
}

const CMD = String.raw`(?:^|[\s;&|(\x60{!])`
/** Wrappers that run the command after them: sudo, env, timeout, nice, time, nohup, VAR=value. */
const WRAPPERS = String.raw`(?:(?:sudo(?:\s+-[a-zA-Z]+(?:\s+(?!-)[\w.-]+)?)*|env(?:\s+-[a-zA-Z]+)*(?:\s+[A-Za-z_]\w*=\S*)*|timeout(?:\s+-\S+)*\s+\d\S*|nice(?:\s+-n\s*-?\d+|\s+-\d+)?|time(?:\s+-p)?|nohup|command|exec|builtin|[A-Za-z_]\w*=\S*)\s+)*`
/** Command position: a line start, after a separator, a substitution or a keyword (not
 *  inside a sentence), past any wrapper; the name may be a path, escaped or quoted. */
const AT_CMD = String.raw`(?:^|[;&|({!\x60]|\$\(|\b(?:then|do|else|xargs(?:\s+-\S+)*))\s*${WRAPPERS}(?:\/usr\/bin\/|\/bin\/)?(?:\\|['"])?`

const SHELLS = String.raw`(?:\/bin\/|\/usr\/bin\/)?(?:ba|z|da|k)?sh`
const QUOTED = String.raw`(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s;&|]+))`
/** ssh options that take an argument (the next word is not the host). */
const SSH_ARG_OPTS = new Set('bcDEeFIiJLlmOopQRSWw'.split(''))

/**
 * The line with quoted text blanked to spaces, length kept, so a word inside a quoted
 * message is never taken for a command. A plain quoted word ('pkill', "/bin/x") stays,
 * and so do the $(...) and backtick expansions inside double quotes, which run.
 */
function maskQuotes(c: string): string {
  const out = c.split('')
  for (let i = 0; i < c.length; i++) {
    const q = c[i]!
    if (q === '\\') { i++; continue }
    if (q !== "'" && q !== '"') continue
    let end = i + 1
    while (end < c.length && c[end] !== q) end += q === '"' && c[end] === '\\' ? 2 : 1
    const inner = c.slice(i + 1, end)
    if (!/^[\w/.-]+$/.test(inner)) {
      const keep = new Set<number>()
      if (q === '"') for (const m of inner.matchAll(/\$\([^)]*\)|\x60[^\x60]*\x60/g)) for (let k = 0; k < m[0].length; k++) keep.add(m.index! + k)
      for (let k = 0; k < inner.length; k++) if (!keep.has(k)) out[i + 1 + k] = ' '
    }
    i = end
  }
  return out.join('')
}

/** Commands nested in a line, run by another: sh -c '...', eval '...', ssh host ..., '...' | sh.
 *  The running command is found outside quotes; its argument is read from the line itself. */
function nestedCommands(c: string): string[] {
  const masked = maskQuotes(c)
  const out: string[] = []
  const argAt = (p: number) => {
    const m = new RegExp(String.raw`^${QUOTED}`).exec(c.slice(p))
    return m ? (m[1] ?? m[2] ?? m[3] ?? '') : ''
  }
  for (const m of masked.matchAll(new RegExp(String.raw`(?:^|[\s;&|(\x60{!])${SHELLS}\s+(?:-[a-zA-Z]+\s+)*?-[a-zA-Z]*c[a-zA-Z]*\s+`, 'g'))) out.push(argAt(m.index! + m[0].length))
  for (const m of masked.matchAll(/(?:^|[\s;&|(\x60{!])eval\s+/g)) out.push(argAt(m.index! + m[0].length))
  for (const m of c.matchAll(new RegExp(String.raw`(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*\|\s*${SHELLS}\b`, 'g'))) {
    if (masked[m.index! + m[0].lastIndexOf('|')] === '|') out.push(m[1] ?? m[2] ?? '')
  }
  for (const m of masked.matchAll(/(?:^|[\s;&|(\x60{!])ssh\s+/g)) {
    const words = c.slice(m.index! + m[0].length).match(/"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g) ?? []
    let k = 0
    while (k < words.length && words[k]!.startsWith('-')) {
      const w = words[k]!
      k += w.length === 2 && SSH_ARG_OPTS.has(w[1]!) ? 2 : 1
    }
    const rest = words.slice(k + 1).join(' ')
    if (!rest) continue
    const one = /^(?:"((?:[^"\\]|\\.)*)"|'([^']*)')$/.exec(rest)
    out.push(one ? (one[1] ?? one[2] ?? '') : rest)
  }
  return out.filter(Boolean)
}

/** Heredoc bodies that are data (fed to a command that is not a shell) blanked; an
 *  unquoted one keeps only its $(...) and backtick expansions, which do run. */
function blankDataHeredocs(code: string[]): string[] {
  const out = [...code]
  for (let i = 0; i < out.length; i++) {
    const m = /(?<!<)<<(?!<)(-?)\s*(['"]?)([A-Za-z_]\w*)\2/.exec(out[i]!)
    if (!m) continue
    const head = out[i]!
    const toShell = new RegExp(String.raw`(?:^|[\s;&|(])${SHELLS}(?:\s+-[a-zA-Z]+)*\s*$`).test(head.slice(0, m.index)) || new RegExp(String.raw`\|\s*${SHELLS}\b`).test(head.slice(m.index))
    const quoted = m[2] !== ''
    let k = i + 1
    for (; k < out.length; k++) {
      if ((m[1] ? code[k]!.replace(/^\t+/, '') : code[k]!) === m[3]) break
      if (toShell) continue
      out[k] = quoted ? '' : (code[k]!.match(/\$\([^)]*\)|\x60[^\x60]*\x60/g) ?? []).join('; ')
    }
    i = k
  }
  return out
}
const SEARCH_CMDS = [
  new RegExp(String.raw`${CMD}pgrep\b(?![^|;&)]*\s-P\b)`),        // pgrep, unless -P <pid>: the children of one pid
  new RegExp(String.raw`${CMD}pidof\b`),
  new RegExp(String.raw`${CMD}lsof\b[^|;&)]*\s-[a-zA-Z]*t`),      // lsof -t / -ti / -tiTCP:...
  // ps over the whole table, filtered by a pattern; ps -p <pid> or ps <pid> reads one pid.
  new RegExp(String.raw`${CMD}ps\b(?![^|;&)]*(?:\s-[a-zA-Z]*p\b|\$))[^|;&)]*\|\s*(?:grep|egrep|fgrep|awk|sed)\b`),
]

/** Where a search starts on the line, or -1. */
function searchAt(c: string, searchFns: string[]): number {
  let best = -1
  const res = [...SEARCH_CMDS]
  if (searchFns.length) res.push(new RegExp(String.raw`${CMD}(?:${searchFns.join('|')})(?![\w-])(?!\s*\(\))`))
  for (const re of res) {
    const m = re.exec(c)
    if (m) {
      const at = m.index + (m[0].length - m[0].trimStart().length) + (/^[;&|(\x60{!]/.test(m[0].trimStart()) ? 1 : 0)
      if (best < 0 || at < best) best = at
    }
  }
  return best
}

/** A search whose output is consumed on the spot (a test, a count), not a pid list. */
function consumedHere(c: string): boolean {
  return /(?:^|[^2&])>\s*\/dev\/null|&>\s*\/dev\/null|\|\s*(?:grep\s+-[a-zA-Z]*[qc]|wc)\b/.test(c)
}

/** The arguments of each signalling kill on the line (kill -0 and kill -l only ask). */
function killArgs(c: string): string[] {
  const out: string[] = []
  const re = new RegExp(String.raw`${AT_CMD}kill((?:\s+(?:-s\s+\w+|-n\s+\d+|--|-[A-Za-z0-9]+))*)\s+([^;&|)]*)`, 'g')
  for (let m = re.exec(c); m; m = re.exec(c)) {
    const opts = m[1] ?? ''
    if (/(?:^|\s)(?:-0|-s\s+0|-n\s+0|-l|-L)(?:\s|$)/.test(opts)) continue
    out.push(m[2] ?? '')
  }
  return out
}

const refs = (text: string, name: string) => new RegExp(String.raw`\$\{?${name}\b`).test(text)

/** An exact-pid comparison on `name`: [ "$p" = "$X" ], [[ $p == $X ]], -eq, grep -x "$p". */
function narrows(c: string, name: string): boolean {
  const v = String.raw`"?\$\{?${name}\}?"?`
  return new RegExp(String.raw`\[\[?\s*${v}\s*(?:==?|-eq)\s`).test(c)
    || new RegExp(String.raw`\s(?:==?|-eq)\s*${v}\s*\]`).test(c)
    || new RegExp(String.raw`\bgrep\s+(?:-[a-zA-Z]*x[a-zA-Z]*\s+)+(?:--\s+)?${v}`).test(c)
}

/** Shell functions whose output is a search's pid list. */
function searchFunctions(code: string[]): string[] {
  const names: string[] = []
  for (let i = 0; i < code.length; i++) {
    const h = /^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{?\s*$/.exec(code[i]!)
    if (!h) continue
    for (let k = i + 1; k < code.length && !/^\}\s*$/.test(code[k]!); k++) {
      const c = code[k]!
      const at = searchAt(c, [])
      if (at < 0 || consumedHere(c)) continue
      const before = c.slice(0, at)
      if (/(?:\$\(|\x60|<\()[^)]*$/.test(before) || /\b(?:if|while|until)\b/.test(before)) continue
      names.push(h[1]!)
      break
    }
  }
  return names
}

interface ShellScan { violations: KillViolation[]; outputs: number[] }

/** Shell rules over code lines. `outputs`: lines whose search result is the code's own output. */
function scanShell(lines: string[], rawCode: string[], depth = 0): ShellScan {
  const violations: KillViolation[] = []
  const outputs: number[] = []
  const code = blankDataHeredocs(rawCode)
  const fns = searchFunctions(code)
  const push = (rule: KillRule, i: number) => {
    if (!violations.some((v) => v.line === i + 1 && v.rule === rule)) violations.push({ rule, line: i + 1, text: lines[i]!.trim() })
  }
  code.forEach((c, i) => {
    if (!c) return
    const words = maskQuotes(c)
    if (new RegExp(String.raw`${AT_CMD}pkill\b`).test(words)) push('pkill', i)
    if (new RegExp(String.raw`${AT_CMD}killall\b`).test(words)) push('killall', i)
    if (depth < 3) {
      for (const inner of nestedCommands(c)) {
        for (const v of scanShell(inner.split('\n'), shellLines(inner), depth + 1).violations) push(v.rule, i)
      }
    }
    const at = searchAt(c, fns)
    if (at < 0) return
    const before = c.slice(0, at)
    const after = c.slice(at)
    if (/\|\s*xargs\b[^|;&]*\bkill\b/.test(after) || /\bkill\b[^;&|$\x60]*["']?(?:\$\(|\x60)\s*$/.test(before)) { push('search-kill', i); return }
    // Who holds the result: a variable, a loop variable, a while-read loop.
    const tainted = new Set<string>()
    let from = i
    const assign = /([A-Za-z_]\w*)\+?=["']?(?:\$\(|\x60)[^)]*$/.exec(before)
    const forIn = /\bfor\s+([A-Za-z_]\w*)\s+in\s+[^;]*(?:\$\(|\x60)[^)]*$/.exec(before)
    const mapfile = /\b(?:mapfile|readarray)\s+(?:-\S+\s+)*([A-Za-z_]\w*)\s*<\s*<\(\s*$/.exec(before)
    const pipeRead = /\|\s*while\s+(?:IFS=\S*\s+)?read\s+(?:-\S+\s+)*([A-Za-z_][\w ]*?)\s*(?:;|$|\bdo\b)/.exec(after)
    if (assign) tainted.add(assign[1]!)
    if (forIn) tainted.add(forIn[1]!)
    if (mapfile) tainted.add(mapfile[1]!)
    if (pipeRead) pipeRead[1]!.split(/\s+/).filter(Boolean).forEach((n) => tainted.add(n))
    if (/\bdone\s*<\s*<\(\s*$/.test(before)) {
      for (let k = i; k >= Math.max(0, i - CAPTURE_WINDOW); k--) {
        const w = /\bwhile\b[^;]*\bread\s+(?:-\S+\s+)*([A-Za-z_][\w ]*?)\s*(?:;|$|\bdo\b)/.exec(code[k]!)
        if (w) { w[1]!.split(/\s+/).filter(Boolean).forEach((n) => tainted.add(n)); from = k; break }
      }
    }
    if (tainted.size === 0) {
      // Printed: the line's own output, or a substitution echo/printf prints (`echo "PID:$(pgrep -f x)"`).
      const printed = /\b(?:echo|printf)\b[^;|&]*(?:\$\(|\x60)[^)]*$/.test(before)
      if (!consumedHere(c) && (printed || !/(?:\$\(|\x60|<\()[^)]*$/.test(before)) && !/\b(?:if|while|until)\b/.test(before)) outputs.push(i)
      return
    }
    const end = Math.min(code.length - 1, Math.max(i, from) + CAPTURE_WINDOW)
    for (let k = from; k <= end; k++) {
      const l = code[k]!
      if (k !== i) {
        const loop = /\bfor\s+([A-Za-z_]\w*)\s+in\s+(.*)$/.exec(l)
        if (loop && [...tainted].some((t) => refs(loop[2]!, t))) tainted.add(loop[1]!)
        const set = /(?:^|[\s;&(])([A-Za-z_]\w*)=(.*)$/.exec(l)
        if (set && [...tainted].some((t) => refs(set[2]!, t))) tainted.add(set[1]!)
        const fed = /\|\s*while\s+(?:IFS=\S*\s+)?read\s+(?:-\S+\s+)*([A-Za-z_][\w ]*?)\s*(?:;|$|\bdo\b)/.exec(l)
        if (fed && [...tainted].some((t) => refs(l.slice(0, fed.index), t))) fed[1]!.split(/\s+/).filter(Boolean).forEach((n) => tainted.add(n))
      }
      for (const args of killArgs(l)) {
        const hit = [...tainted].filter((t) => refs(args, t))
        if (hit.length === 0) continue
        const between = code.slice(Math.min(from, i), k + 1)
        if (hit.some((t) => between.some((b) => narrows(b, t)))) continue
        push('search-kill', i)
        return
      }
    }
  })
  return { violations, outputs }
}

// ── JS / TS ────────────────────────────────────────────────────────────────

interface JsString { text: string; line: number; position: number }

/** Read a string literal at src[i]; returns its text (a template's ${...} as $X), the
 *  index after it, and the newlines it spans. */
function readString(src: string, i: number): [string, number, number] {
  const q = src[i]!
  let j = i + 1
  let text = ''
  let nl = 0
  while (j < src.length) {
    const d = src[j]!
    if (d === '\\') {
      const e = src[j + 1] ?? ''
      text += e === 'n' ? '\n' : e
      if (e === '\n') nl++
      j += 2
      continue
    }
    if (d === q) return [text, j + 1, nl]
    if (d === '\n') {
      if (q !== '`') return [text, j, nl]
      nl++
    }
    if (q === '`' && d === '$' && src[j + 1] === '{') {
      let depth = 1
      j += 2
      while (j < src.length && depth > 0) {
        const e = src[j]!
        if (e === '"' || e === "'" || e === '`') {
          const [, k, n] = readString(src, j)
          nl += n; j = k; continue
        }
        if (e === '{') depth++
        else if (e === '}') depth--
        else if (e === '\n') nl++
        j++
      }
      text += '$X'
      continue
    }
    text += d
    j++
  }
  return [text, j, nl]
}

/** The code with comments removed and every string literal replaced by «n», lines kept. */
function jsScan(src: string): { code: string; strings: JsString[] } {
  let out = ''
  const strings: JsString[] = []
  let line = 1
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2)
      const stop = close < 0 ? src.length : close + 2
      for (let k = i; k < stop; k++) if (src[k] === '\n') { out += '\n'; line++ }
      i = stop
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const [text, j, nl] = readString(src, i)
      strings.push({ text, line, position: out.length })
      out += `«${strings.length - 1}»` + '\n'.repeat(nl)
      line += nl
      i = j
      continue
    }
    if (c === '/') {
      let end = out.length
      while (end > 0 && /\s/.test(out[end - 1]!)) end--
      const p = out[end - 1] ?? ''
      let start = end
      while (start > 0 && /[\w$]/.test(out[start - 1]!)) start--
      // Match the old identifier suffix exactly, including a leading digit run.
      while (start < end && !/[A-Za-z_$]/.test(out[start]!)) start++
      const word = out.slice(start, end)
      if (p === '' || '(,=:[!&|?{};+-*%<>~^'.includes(p) || /^(?:return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await)$/.test(word)) {
        let j = i + 1
        let cls = false
        while (j < src.length && src[j] !== '\n') {
          const d = src[j]!
          if (d === '\\') { j += 2; continue }
          if (cls) { if (d === ']') cls = false } else if (d === '[') cls = true
          else if (d === '/') break
          j++
        }
        j++
        while (j < src.length && /[a-z]/i.test(src[j]!)) j++
        out += '/re/'
        i = j
        continue
      }
    }
    if (c === '\n') line++
    out += c
    i++
  }
  return { code: out, strings }
}

const EXEC_CALL = /(?:\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|execa|execaSync|execAsync|execFileAsync|run|runSync|sh|shell|Bun\.spawn|Bun\.spawnSync)\s*\(\s*\[?\s*|\$)$/
const SHELL_C = /\b(?:spawn|spawnSync|execFile|execFileSync|execa|execaSync|Bun\.spawn|Bun\.spawnSync)\s*\(\s*\[?\s*«(\d+)»\s*,\s*\[?\s*(?:«\d+»\s*,\s*)*«(\d+)»\s*,\s*$/
const SSH_CALL = /\bssh\w*\s*\([^()«]*(?:«\d+»[^()«]*)*,\s*$/i
const JS_SIGNAL = /\b(?:process|os)\.kill\s*\((?![^)]*,\s*0\s*\))/
/** A command string that signals an interpolated pid: `kill -TERM ${pid}` (a template's ${...} reads as $X). */
const KILL_OF_VALUE = /(?:^|[\s;&|(])kill\s+(?:(?:-s\s+(?!0\b)\w+|-n\s+(?!0\b)\d+|--|-(?!0\b)[A-Za-z0-9]+)\s+)*["']?\$X/
/** An exact comparison on a pid: pid === x, x == pid, set.has(pid). */
const JS_NARROWED = /\b\w*[pP]id\w*\s*(?<![!=])===?\s*\w|\w\s*(?<![!=])===?\s*\w*[pP]id\b|(?<!!)\b\w+\.has\(\s*\w*[pP]id\b/

function scanJs(content: string, test: boolean): KillViolation[] {
  const lines = content.split('\n')
  const { code, strings } = jsScan(content)
  const codeLines = code.split('\n')
  const out: KillViolation[] = []
  const push = (rule: KillRule, line: number) => {
    if (!out.some((v) => v.line === line && v.rule === rule)) out.push({ rule, line, text: (lines[line - 1] ?? '').trim() })
  }
  const sources: number[] = []
  // Each string's place in the code is recorded by jsScan as it writes «n»: an indexOf per
  // string made a large file quadratic (the whole-repo ratchet ran past its timeout on a
  // loaded host), and the recorded place is exact even if «n» also appears earlier.
  strings.forEach((s, k) => {
    const pos = s.position
    const before = code.slice(Math.max(0, pos - 240), pos)
    const shellC = SHELL_C.exec(before)
    const isShellScript = shellC && /^(?:\/bin\/|\/usr\/bin\/)?(?:ba|z|da)?sh$/.test(strings[Number(shellC[1])]!.text) && /^-[a-z]*c$/.test(strings[Number(shellC[2])]!.text)
    const isCommand = EXEC_CALL.test(before) || SSH_CALL.test(before) || isShellScript
    if (!isCommand) {
      // In a tool, a string that is a shell command line counts too: a script is often
      // built into a variable and run later (`const script = \`pkill -f ${x}; rm ...\``).
      // A bare word is a name (a type, a deny-list entry), and a message names a command
      // without running it, so only a command in command position counts, as in a script.
      if (test || !/\s/.test(s.text)) return
      const scan = scanShell(s.text.split('\n'), shellLines(s.text))
      for (const v of scan.violations) push(v.rule, s.line)
      if (scan.outputs.length) sources.push(s.line)
      return
    }
    const text = s.text.trim()
    if (!/\s/.test(text) && !isShellScript) {
      // argv form: execFileSync('pgrep', ['-f', x]) and friends.
      const name = text.split('/').pop()!
      if (name === 'pkill') return push('pkill', s.line)
      if (name === 'killall') return push('killall', s.line)
      let depth = 1
      const args: string[] = []
      for (let j = pos; j < code.length && depth > 0; j++) {
        if (code[j] === '(') depth++
        else if (code[j] === ')') depth--
        const m = /^«(\d+)»/.exec(code.slice(j, j + 12))
        if (m && Number(m[1]) !== k) args.push(strings[Number(m[1])]!.text)
      }
      // A wrapper running pkill (env, timeout, nice, sudo...), or ssh running a command.
      if (/^(?:env|timeout|nice|nohup|sudo|time)$/.test(name)) {
        const run = args.map((a) => a.split('/').pop()!).find((a) => a === 'pkill' || a === 'killall')
        if (run) return push(run as KillRule, s.line)
      }
      if (name === 'ssh') {
        for (const a of args.filter((a) => /\s/.test(a))) for (const v of scanShell(a.split('\n'), shellLines(a)).violations) push(v.rule, s.line)
      }
      if ((name === 'pgrep' && !args.includes('-P')) || name === 'pidof' || (name === 'lsof' && args.some((a) => /^-[a-z]*t/.test(a))) || (name === 'ps' && !args.includes('-p'))) sources.push(s.line)
      return
    }
    // A shell command: the shell rules over it, and a search that is its output is a source.
    const sl = s.text.split('\n')
    const scan = scanShell(sl, shellLines(s.text))
    for (const v of scan.violations) push(v.rule, s.line)
    if (scan.outputs.length) sources.push(s.line)
  })
  // Lines holding a command string that signals an interpolated pid.
  const killLines = new Set<number>()
  for (const s of strings) if (KILL_OF_VALUE.test(s.text)) killLines.add(s.line)
  for (const line of sources) {
    for (let k = line - 1; k < Math.min(codeLines.length, line + JS_WINDOW); k++) {
      if (!JS_SIGNAL.test(codeLines[k]!) && !(k !== line - 1 && killLines.has(k + 1))) continue
      if (codeLines.slice(line - 1, k + 1).some((l) => JS_NARROWED.test(l))) break
      push('search-kill', line)
      break
    }
  }
  return out
}

// ── Python ─────────────────────────────────────────────────────────────────

function scanPy(content: string): KillViolation[] {
  const lines = content.split('\n')
  const code = lines.map((raw) => (/^\s*#/.test(raw) ? '' : stripTrailingComment(raw, '#')))
  const out: KillViolation[] = []
  code.forEach((c, i) => {
    const push = (rule: KillRule) => out.push({ rule, line: i + 1, text: lines[i]!.trim() })
    if (/(?:^|[^\w.-])pkill\b/.test(c)) push('pkill')
    if (/(?:^|[^\w.-])killall\b/.test(c)) push('killall')
    if (/["'](?:\/usr\/bin\/)?(?:pgrep|pidof)\b/.test(c) && code.slice(i, i + JS_WINDOW + 1).some((l) => /\bos\.kill\s*\((?![^)]*,\s*0\s*\))/.test(l))) push('search-kill')
  })
  return out
}

export function findKillViolations(content: string, kind: Kind = 'shell', test = false): KillViolation[] {
  // Every rule ends in a kill (pkill, killall, a kill of a search's result): a file that never
  // says it has nothing to find, and most of the repo is such files.
  if (!/kill/i.test(content)) return []
  if (kind === 'js') return scanJs(content, test)
  if (kind === 'py') return scanPy(content)
  return scanShell(content.split('\n'), shellLines(content)).violations
}
