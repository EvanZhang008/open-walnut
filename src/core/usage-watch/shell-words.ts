/**
 * The commands a shell line runs, read the way a shell splits them (quotes, `;`, `&&`, pipes,
 * heredoc bodies and comments), so a word a command only reads or prints (`grep "walnut-dev
 * land"`, a commit message) is never taken for a command it runs. Used to tell a ship (ships.ts)
 * and a Walnut CLI call (normalize.ts walnutOpOfToolCall).
 */

/**
 * The words of each simple command a shell line runs, quotes removed: split at `;`, `&`, `|`,
 * newlines, parentheses and backticks outside quotes; comments and heredoc bodies left out. A
 * quoted word stays one word, so `grep "walnut-dev land" x` is a grep and `git commit -m "...
 * land"` a commit. A heredoc starts only at `<<` outside quotes (never `<<<`) and its body runs
 * from the next line to its end word.
 */
export function simpleCommands(script: string): string[][] {
  return shellCommands(script).map((c) => c.words)
}

/**
 * The same commands, each with whether its output goes into the next one (`a | b`, never
 * `a || b`). A redirect stays one word with its `&` (`2>&1`, `&>file`, `>&2`), never a split.
 */
export interface ShellCommand { words: string[]; pipe: boolean }
export function shellCommands(script: string): ShellCommand[] {
  const text = String(script ?? '')
  const cmds: ShellCommand[] = []
  let words: string[] = []
  let w = ''
  let inWord = false
  let q: string | null = null
  const heredocs: string[] = []
  const endWord = () => { if (inWord) words.push(w); w = ''; inWord = false }
  const endCmd = (pipe = false) => { endWord(); if (words.length) cmds.push({ words, pipe }); words = [] }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (q) {
      if (c === q) q = null
      else if (c === '\\' && q === '"' && i + 1 < text.length) w += text[++i]
      else w += c
      continue
    }
    if (c === "'" || c === '"') { q = c; inWord = true; continue }
    if (c === '\\' && i + 1 < text.length) { if (text[i + 1] !== '\n') { w += text[i + 1]; inWord = true } i++; continue }
    if (c === '#' && !inWord) { while (i + 1 < text.length && text[i + 1] !== '\n') i++; continue }
    if (c === '<' && text[i + 1] === '<') {
      if (text[i + 2] === '<') { i += 2; continue }
      const m = /^<<-?[ \t]*(['"]?)([A-Za-z_][\w-]*)\1/.exec(text.slice(i, i + 80))
      if (m) { endWord(); heredocs.push(m[2]!); i += m[0].length - 1; continue }
    }
    if (c === '\n' && heredocs.length) {
      // Each heredoc's body, one after another: lines up to the one that is its end word.
      endCmd()
      for (const end of heredocs.splice(0)) {
        while (i < text.length) {
          const next = text.indexOf('\n', i + 1)
          const line = text.slice(i + 1, next < 0 ? text.length : next)
          i = next < 0 ? text.length : next
          if (line.trim() === end) break
        }
      }
      continue
    }
    if (c === '|') { if (text[i + 1] === '|') { i++; endCmd() } else endCmd(true); continue }
    if (c === '&' && (text[i + 1] === '>' || (inWord && (text[i - 1] === '>' || text[i - 1] === '<')))) { w += c; inWord = true; continue }
    if (c === ';' || c === '&' || c === '\n' || c === '(' || c === ')' || c === '`') { endCmd(); continue }
    if (c === ' ' || c === '\t') { endWord(); continue }
    w += c
    inWord = true
  }
  endCmd()
  return cmds
}

export const base = (word: string | undefined) => (word ?? '').split('/').pop() ?? ''

/** The command after its wrappers: `FOO=1 timeout 7200 nohup walnut-dev land` is `walnut-dev land`. */
export function unwrap(words: string[]): string[] {
  let i = 0
  for (;;) {
    const w = words[i]
    if (w === undefined) return []
    if (/^[A-Za-z_]\w*=/.test(w) || w === '{' || w === '!' || ['nohup', 'time', 'exec', 'command', 'sudo', 'env', 'nice', 'stdbuf'].includes(base(w))) { i++; continue }
    if (base(w) === 'timeout') {
      i++
      // Its options (`-k 5`, `-s KILL` take a value; `--kill-after=5` holds it), then the duration.
      while (words[i] !== undefined && words[i]!.startsWith('-')) i += words[i] === '-k' || words[i] === '-s' || words[i] === '--kill-after' || words[i] === '--signal' ? 2 : 1
      if (words[i] !== undefined && /^\d+(?:\.\d+)?[smhd]?$/.test(words[i]!)) i++
      continue
    }
    return words.slice(i)
  }
}
