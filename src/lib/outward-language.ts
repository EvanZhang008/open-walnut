/**
 * Words other people read go out in the language the user set for them (config
 * `session.outward_language`), the other direction of the reply-language gate (reply-language.ts:
 * words for the user in his language). 2026-11-25, Main for the user, after three slips in one week
 * (his own rule: "English only for code, commits, ... what colleagues see"): a code review's guide
 * quoting a session's Chinese, a ticket's closing note written in Chinese because the session wrote
 * in the user's language, and an English text he was to approve rewritten into Chinese.
 *
 * Held at the send step: a PreToolUse hook (providers/reply-language-hook.ts) pipes the call to
 * reply_language_check, which asks `outwardCall` what in it other people read and refuses the call
 * when those words are in another language. Which steps those are is the user's own list (a Claude
 * Code tool name, a Bash command): Walnut cannot tell a colleague's channel from a friend's. Pure.
 */
import { expectedScript, measureScript, type Script, type ScriptMeasure } from './reply-language.js'

export interface OutwardSetting {
  /** The language as the user wrote it ("English"). */
  language: string
  script: Script
  /** Tool names whose input other people read, as regular expressions matched against the whole name. */
  tools: string[]
  /** Regular expressions matched anywhere in a Bash command. */
  commands: string[]
}

const MAX_PATTERNS = 50
const MAX_PATTERN_CHARS = 300
const MAX_LANGUAGE_CHARS = 80

function patterns(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const p of raw.slice(0, MAX_PATTERNS)) {
    if (typeof p !== 'string' || !p.trim() || p.length > MAX_PATTERN_CHARS) continue
    try { new RegExp(p) } catch { continue }
    out.push(p)
  }
  return out
}

/** The setting as Walnut reads it, or null while it names no language it knows. */
export function outwardSettingOf(raw: unknown): OutwardSetting | null {
  const r = raw as { language?: unknown; tools?: unknown; commands?: unknown } | null | undefined
  const language = typeof r?.language === 'string' ? r.language.replace(/\s+/g, ' ').trim().slice(0, MAX_LANGUAGE_CHARS) : ''
  const script = language ? expectedScript(language) : null
  if (!script) return null
  return { language, script, tools: patterns(r?.tools), commands: patterns(r?.commands) }
}

/**
 * Walnut's own ways a session runs a command or calls an MCP tool somewhere (as Claude Code names
 * them): what they run is held as if the session ran it itself. The class guard
 * (tests/lib/outward-language.test.ts) fails when an op that takes a command or an MCP tool is in
 * neither list nor OUTWARD_RUNNERS_EXEMPT.
 */
export const COMMAND_RUNNERS: readonly string[] = ['Bash', 'mcp__walnut__host_exec', 'mcp__walnut__host_exec_pinned']
export const MCP_RUNNERS: readonly string[] = ['mcp__walnut__host_mcp_call', 'mcp__walnut__mcp_call']
/** Ops that take a command or an MCP tool but run nothing other people read, with why. */
export const OUTWARD_RUNNERS_EXEMPT: Readonly<Record<string, string>> = {
  mcp_read: 'reads an MCP server, sends nothing',
  approval_request: 'its command is what the user is asked to approve, shown to him, not run',
  password_use: 'its command only names what a password is for, shown to the user',
}

/** The tools Walnut's hook must see for this setting, as one Claude Code matcher; null: none. */
export function outwardHookMatcher(s: OutwardSetting | null): string | null {
  if (!s || (!s.tools.length && !s.commands.length)) return null
  const names = [...s.tools.map((t) => `(?:${t})`)]
  if (s.commands.length) names.push(...COMMAND_RUNNERS)
  if (s.tools.length) names.push(...MCP_RUNNERS)
  return `^(?:${names.join('|')})$`
}

/**
 * One of the user's patterns as a POSIX ERE that matches at least what it matches, or null when it
 * cannot be said so (a lookaround, a backreference). `\\b` is dropped (wider, never narrower), the
 * common escapes become their bracket classes: grep on macOS and Linux reads them alike.
 */
function asEre(re: string): string | null {
  // grep reads the hook's input as JSON text, where a quote or a backslash is escaped; and a class
  // escape inside brackets has no ERE spelling here.
  if (/\(\?(?!:)/.test(re) || /\\[1-9kpPuxc\\]/.test(re) || /"/.test(re) || /\[[^\]]*\\/.test(re)) return null
  // grep sees the whole hook input on one line, so a pattern's anchors are dropped (wider again).
  return withoutAnchors(re).replace(/\(\?:/g, '(').replace(/\\[bB]/g, '')
    .replace(/\\d/g, '[0-9]').replace(/\\D/g, '[^0-9]').replace(/\\s/g, '[[:space:]]').replace(/\\S/g, '[^[:space:]]')
    .replace(/\\w/g, '[[:alnum:]_]').replace(/\\W/g, '[^[:alnum:]_]')
}

/** A pattern with every unescaped `^` and `$` outside brackets taken out (`^git commit|^gh pr`). */
function withoutAnchors(re: string): string {
  let out = ''
  let inBracket = false
  for (let i = 0; i < re.length; i++) {
    const ch = re[i]
    if (ch === '\\') { out += ch + (re[i + 1] ?? ''); i++; continue }
    if (inBracket) { if (ch === ']' && !/\[\^?$/.test(out)) inBracket = false; out += ch; continue }
    if (ch === '[') { inBracket = true; out += ch; continue }
    if (ch === '^' || ch === '$') continue
    out += ch
  }
  return out
}

/**
 * A POSIX ERE the hook's shell tests the raw hook input with before it asks Walnut, or null when
 * every listed command must be asked about (no patterns, or one grep cannot be trusted with).
 */
export function outwardCommandPrefilter(s: OutwardSetting | null): string | null {
  if (!s?.commands.length) return null
  const eres = s.commands.map(asEre)
  if (eres.some((e) => e === null || !e.trim())) return null
  return eres.map((e) => `(${e})`).join('|')
}

const whole = (re: string, name: string): boolean => {
  try { return new RegExp(`^(?:${re})$`).test(name) } catch { return false }
}
const anywhere = (re: string, text: string): boolean => {
  // A command spans lines (a heredoc, a quoted body): `.` crosses them.
  try { return new RegExp(re, 's').test(text) } catch { return false }
}

/** Every string inside a value, in order. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) strings(x, out)
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out)
  return out
}

export interface OutwardCall {
  /** What the words are, for the refusal: "Your Bash command", "Your call of mcp__chat__post". */
  what: string
  text: string
  /** A shell command: its backticks run commands, they are not code to leave out. */
  shell: boolean
}

/**
 * The files a shell command reads its words from (`--body-file x`, `-F x`, `@x`, `$(cat x)`, `< x`):
 * the hook's shell reads them on the session's own machine and hands their text in with the call
 * (providers/reply-language-hook.ts), since the words others read are in them, not in the command.
 */
export const COMMAND_FILE_RE = /(?:--[\w-]*file|--input|-F)(?:=|\s+)(['"]?)([^\s'"|;&<>]+)\1|(?<![\w@])@(['"]?)([~./][^\s'"|;&<>]*)\3|\$\(\s*cat\s+(['"]?)([^\s'")]+)\5\s*\)|(?<![<\d])<\s*(['"]?)([^\s'"|;&<>(]+)\7/g

/** The paths a command reads its words from, in order, each once. */
export function commandFiles(cmd: string): string[] {
  const out: string[] = []
  for (const m of cmd.matchAll(COMMAND_FILE_RE)) {
    const p = m[2] ?? m[4] ?? m[6] ?? m[8]
    if (p && !out.includes(p)) out.push(p)
  }
  return out
}

/** What in a tool call other people read, or null when the call is none the user listed. */
export function outwardCall(toolName: unknown, toolInput: unknown, s: OutwardSetting, files?: Record<string, string>): OutwardCall | null {
  if (typeof toolName !== 'string') return null
  const input = (toolInput && typeof toolInput === 'object' ? toolInput : {}) as Record<string, unknown>
  if (COMMAND_RUNNERS.includes(toolName)) {
    const cmd = typeof input.command === 'string' ? input.command
      : Array.isArray(input.argv) ? input.argv.filter((a): a is string => typeof a === 'string').join(' ') : ''
    if (!cmd || !s.commands.some((c) => anywhere(c, cmd))) return null
    // Paths and file names keep their own words (a folder named in Chinese is not a message); the
    // files the command reads its words from are judged instead, with the command's own words.
    // Only a token that starts like a path goes (`/x`, `~/x`, `./x`, `../x`, `dir/x`), or a relative
    // file path in any script (`notes/today.md`, no colon): Chinese prose has no spaces, so a sentence
    // with one slash or link in it is still words, never a path.
    const own = cmd.replace(/(?:^|\s)(['"]?)(?:(?:~|\.\.?)?\/|[\w.-]+\/)[^\s'"]*\1(?=\s|$)/g, ' ')
      .replace(/(?:^|\s)(['"]?)[^\s'":]+\/[^\s'":]*\.[A-Za-z0-9]{1,8}\1(?=\s|$)/g, ' ')
    const read = Object.entries(files ?? {}).filter(([p]) => commandFiles(cmd).includes(p)).map(([, t]) => t)
    return { what: toolName === 'Bash' ? 'Your command' : `Your command (${toolName.replace(/^mcp__walnut__/, '')})`, text: [own, ...read].join('\n\n'), shell: true }
  }
  if (MCP_RUNNERS.includes(toolName)) {
    const name = `mcp__${String(input.server ?? '')}__${String(input.tool ?? '')}`
    if (!s.tools.some((t) => whole(t, name))) return null
    return { what: `Your call of ${name} (${toolName.replace(/^mcp__walnut__/, '')})`, text: strings(input.arguments).join('\n\n'), shell: false }
  }
  if (!s.tools.some((t) => whole(t, toolName))) return null
  return { what: `Your call of ${toolName}`, text: strings(input).join('\n\n'), shell: false }
}

/** Fewer words in another script than this pass: a person's name, one quoted term. */
export const OUTWARD_MIN_FOREIGN = 4

/**
 * The measure when words other people read are not in `script`, else null. For a Latin-script
 * language any run of Han, kana, Hangul or Cyrillic is foreign, quoted or not (a colleague cannot
 * read a quote either); only code blocks and inline code of a Markdown text are left out. For another
 * script, the share rule of words for the user (measureScript).
 */
export function outwardOffScript(text: string, script: Script, opts: { shell?: boolean } = {}): ScriptMeasure | null {
  if (!text) return null
  if (script !== 'latin') {
    const m = measureScript(text, script)
    return m.words >= 5 && m.share < 0.2 ? m : null
  }
  let t = text.replace(/```[\s\S]*?(?:```|$)/g, ' ').replace(/~~~[\s\S]*?(?:~~~|$)/g, ' ')
  if (!opts.shell) t = t.replace(/`[^`\n]*`/g, ' ')
  const foreign = (t.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) ?? []).length
    + (t.match(/\p{Script=Cyrillic}+/gu) ?? []).length
  const latin = (t.match(/\p{Script=Latin}+/gu) ?? []).length
  const words = foreign + latin
  return foreign >= OUTWARD_MIN_FOREIGN ? { words, inScript: latin, share: words ? latin / words : 0 } : null
}

/** The refusal a held call answers with. */
export function outwardRefusal(c: OutwardCall, s: OutwardSetting, m: ScriptMeasure): string {
  // The words it found, so a session sees what to rewrite (a folder name it cannot change is not one: paths are left out).
  const runs = [...new Set(c.text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}][\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{P}\s\d]*/gu) ?? [])]
    .map((r) => r.trim()).filter(Boolean).slice(0, 3).map((r) => `"${r.length > 24 ? `${r.slice(0, 24)}\u2026` : r}"`)
  return `${c.what} was not run: other people read its words, and the user's setting says words for them are in ${s.language}, `
    + `but ${m.words - m.inScript} characters or words of it are in another script${runs.length ? ` (${runs.join(', ')})` : ''}. `
    + `Write them in ${s.language} and run it again; never translate them into the user's own language. Words for the user himself stay in his language, in your chat.`
}
