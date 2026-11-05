/**
 * Who answers an ACP engine's permission request, and which preset an ACP
 * session starts in. One posture for every ACP engine, the same as a Claude
 * Code session of the same task.
 *
 * 2026-11-05: a Codex reviewer task another task started kept putting an
 * "execute" card in front of the user for `walnut tools call task_send ...`.
 * Two causes, both fixed here: the start's permission mode never reached the
 * adapter (a Claude Code start with no mode runs in bypass, an ACP start ran
 * on the adapter's asking default, and on another host Codex's own
 * config.toml was not even read), and Walnut's own CLI asked like any other
 * command (Codex's default sandbox has no network, and the CLI talks to the
 * Walnut API).
 *
 * Rules:
 * - A request for Walnut's own CLI or Walnut's own MCP tools is allowed by
 *   Walnut in every mode. The command is read conservatively: only a simple
 *   command whose program is the bare `walnut` CLI, never a chain, a pipe, a
 *   redirect or a substitution (`walnut x; rm -rf ~` asks). Only the ops that
 *   cannot reach past the session's own permission mode are answered: Walnut's
 *   core read-only ops and the writes a task reports and coordinates with
 *   (WALNUT_WRITE_OPS_ANSWERED). An op that runs a command or code, starts or
 *   moves a session, calls another service, touches credentials, the user's
 *   memory or deletes still asks outside a bypass posture.
 * - Codex's command is read from the request's `_meta.codex.params.command`,
 *   never from `rawInput.command`: codex-acp strips the shell wrapper and its
 *   outer quotes there (stripShellPrefix), which turns the quoting inside out.
 * - An MCP tool is recognised only on a request the adapter marks as an MCP
 *   tool approval (`_meta.is_mcp_tool_approval`), never from a title alone.
 * - A session whose posture is bypass gets every request allowed, as the
 *   daemon answers a bypass Claude Code session's requests
 *   (`session.auto_approve_bypass`, daemon-policies.ts).
 * - A plan's go-ahead (`kind: switch_mode`) is a decision, never a
 *   permission: it is never answered for anyone.
 */
import type { SessionMode } from '../core/types.js'
import { getOp, getOpOwner } from '../ops/registry.js'

/** Adapter mode values that mean "never ask" (codex-acp, claude-agent-acp, gemini). */
export const ACP_FULL_ACCESS_MODE_VALUES: ReadonlySet<string> = new Set([
  'agent-full-access', 'bypassPermissions', 'yolo',
])

/** Adapter mode values that ask before acting; listed in the order an asking default is picked. */
export const ACP_ASKING_MODE_VALUES: readonly string[] = [
  'agent', 'default', 'acceptEdits', 'autoEdit', 'read-only', 'plan', 'dontAsk',
]

/** The codex-acp preset a Walnut permission mode starts in. */
export function codexPresetForSessionMode(mode: SessionMode): string {
  return mode === 'bypass' ? 'agent-full-access' : 'agent'
}

/**
 * The preset a Codex session starts in, and the Walnut mode that reads it.
 *
 * Order: the session's own persisted preset (a respawn keeps what it ran on) →
 * the mode the start named (it wins over any config file) → the user's own
 * codex configuration (`configured`: ~/.codex/config.toml, else
 * `session.codex_default_mode`), which applies only when the start named no
 * mode → Walnut's own default for the mode (bypass for a start with none,
 * the same as a Claude Code session).
 */
export function resolveCodexStartPreset(o: {
  persisted?: string
  modeNamed: boolean
  walnutMode: SessionMode
  configured?: string
}): { preset: string; walnutMode: SessionMode } {
  if (o.persisted) return { preset: o.persisted, walnutMode: o.walnutMode }
  if (o.modeNamed || !o.configured) return { preset: codexPresetForSessionMode(o.walnutMode), walnutMode: o.walnutMode }
  return { preset: o.configured, walnutMode: ACP_FULL_ACCESS_MODE_VALUES.has(o.configured) ? 'bypass' : 'default' }
}

/**
 * True when the session is supposed to run with full access: the adapter
 * preset it chose (persisted on its record, or picked through the adapter's own
 * control) when it chose one, else its Walnut mode. Never the adapter's live
 * value alone: an adapter that started in full access from its own config, or
 * kept it through a refused downgrade, is not what the session is supposed to be.
 */
export function acpSupposedFullAccess(o: { walnutMode: SessionMode; chosenMode?: string }): boolean {
  const chosen = knownPreset(o.chosenMode)
  return chosen ? ACP_FULL_ACCESS_MODE_VALUES.has(chosen) : o.walnutMode === 'bypass'
}

/** A chosen value counts only when it is a permission preset Walnut knows (an
 *  adapter's `mode` control may pick an agent instead, as OpenCode's build). */
function knownPreset(value: string | undefined): string | undefined {
  return value && (ACP_FULL_ACCESS_MODE_VALUES.has(value) || ACP_ASKING_MODE_VALUES.includes(value)) ? value : undefined
}

/**
 * True when the session answers every permission request itself: it is
 * supposed to run with full access (acpSupposedFullAccess). A bypass that comes
 * from the Walnut mode alone also needs `session.auto_approve_bypass` on, as a
 * Claude Code session's does; a full-access preset the session chose in the
 * adapter is the adapter's own "never ask".
 */
export function acpPostureAllowsAll(o: {
  walnutMode: SessionMode
  chosenMode?: string
  autoApproveBypass?: boolean
}): boolean {
  const chosen = knownPreset(o.chosenMode)
  if (chosen) return ACP_FULL_ACCESS_MODE_VALUES.has(chosen)
  return o.walnutMode === 'bypass' && o.autoApproveBypass !== false
}

/** The adapter kept a full-access preset the session's permission mode does not allow. */
export class AcpModeRefusedError extends Error {
  constructor(engine: string, mode: SessionMode, live: string) {
    super(`${engine} kept its full-access preset "${live}" and refused the "${mode}" permission mode; Walnut answers none of its requests for it`)
    this.name = 'AcpModeRefusedError'
  }
}

export interface AcpPermissionAsk {
  kind?: string
  title?: string
  input?: Record<string, unknown>
  /** The request's own `_meta` (session/request_permission params._meta). */
  meta?: Record<string, unknown>
}

export type AcpAutoAnswer = 'walnut-own' | 'posture'

/** Why Walnut answers this request itself (allow), or undefined when it goes to a person. */
export function acpAutoAnswer(ask: AcpPermissionAsk, allowAll: boolean): AcpAutoAnswer | undefined {
  if (ask.kind === 'switch_mode') return undefined
  if (isWalnutOwnRequest(ask)) return 'walnut-own'
  return allowAll ? 'posture' : undefined
}

// Walnut's MCP mount is named `walnut` (acp-worker/protocol.ts WALNUT_MCP_SERVER).
// Whole-title identifier forms only: a title is adapter text, so a looser match
// could read a shell command as a tool name.
const WALNUT_MCP_TITLES: readonly RegExp[] = [
  /^mcp[._]walnut[._]([A-Za-z0-9_-]+)$/,
  /^mcp__walnut__([A-Za-z0-9_-]+)$/,
  /^walnut__([A-Za-z0-9_-]+)$/,
  /^([A-Za-z0-9_-]+) \(walnut MCP Server\)$/,
]

/**
 * The Walnut writes answered unasked: a task reporting where it stands and
 * talking to its team and its user inside Walnut. None runs a command, starts or
 * moves a session, changes a permission, reaches outside Walnut or deletes.
 */
export const WALNUT_WRITE_OPS_ANSWERED: ReadonlySet<string> = new Set([
  'task_send', 'task_report_set', 'task_complete', 'task_not_done_settle', 'task_note_write', 'task_update', 'task_watch',
  'board_post', 'board_edit', 'board_set', 'board_project_set', 'board_card_set', 'board_remind',
  'brief_write', 'thread_update', 'thread_create', 'human_inbox_send', 'human_inbox_reply',
])

/** Read-only by the registry's tag, yet they reach another service or name credentials: they ask. */
export const WALNUT_READ_OPS_THAT_ASK: ReadonlySet<string> = new Set([
  'mcp_read', 'trigger_template_check', 'password_list', 'secret_list',
])

const OP_NAME = /^[a-z][a-z0-9_]*$/

/** True when Walnut answers a request to run this op of its own. */
export function walnutOpAnswered(op: unknown): boolean {
  if (typeof op !== 'string' || !OP_NAME.test(op)) return false
  if (WALNUT_WRITE_OPS_ANSWERED.has(op)) return true
  // Core ops only: a plugin's read-only tag is the plugin's word, not Walnut's.
  return getOpOwner(op) === 'core' && getOp(op)?.tags.readonly === true && !WALNUT_READ_OPS_THAT_ASK.has(op)
}

/** The command a request runs, from the field its adapter reports it in faithfully. */
function requestCommand(ask: AcpPermissionAsk): unknown {
  const codex = ask.meta?.codex as { params?: { command?: unknown } } | undefined
  if (codex && typeof codex === 'object') return codex.params?.command ?? null
  return ask.input?.command ?? ask.input?.cmd
}

/** A request for Walnut's own CLI or its own MCP tools (walnutOpAnswered ops only). */
export function isWalnutOwnRequest(ask: AcpPermissionAsk): boolean {
  const command = requestCommand(ask)
  if (command !== undefined) {
    if (typeof command === 'string') return isWalnutCliCommand(command)
    if (Array.isArray(command) && command.length > 0 && command.every((w) => typeof w === 'string')) {
      return isWalnutCliCommand(command as string[])
    }
    return false
  }
  if (ask.meta?.is_mcp_tool_approval !== true) return false
  const input = ask.input
  if (input && input.server === 'walnut') return walnutOpAnswered(input.tool)
  if (typeof ask.title !== 'string') return false
  for (const re of WALNUT_MCP_TITLES) {
    const m = re.exec(ask.title)
    if (m) return walnutOpAnswered(m[1])
  }
  return false
}

const SHELLS = /^(?:\/(?:usr\/)?bin\/)?(?:sh|bash|zsh|dash)$/
const WAIT_ID = /^[A-Za-z0-9_-]+$/

/**
 * The in-session CLI's commands Walnut answers (daemon gateway: guide, wait,
 * tools list|help|call), as an exact list of shapes; anything else asks.
 * `args` are the words after `walnut`.
 */
function walnutCliShapeAnswered(args: readonly string[]): boolean {
  const [verb, sub, op, ...rest] = args
  if (args.length === 1) return verb === 'guide' || verb === 'help' || verb === '--help' || verb === '-h' || verb === '--version'
  if (verb === 'tools') {
    if (sub === 'list') return args.length === 2
    if (sub === 'help') return args.length === 3 && OP_NAME.test(op ?? '')
    // `walnut tools call <op> [json | @file | -]`
    if (sub === 'call') return (args.length === 3 || args.length === 4) && walnutOpAnswered(op)
    return false
  }
  if (verb === 'wait') {
    // `walnut wait <id> [--timeout <secs>]`
    if (!WAIT_ID.test(sub ?? '')) return false
    if (args.length === 2) return true
    return args.length === 4 && op === '--timeout' && /^\d{1,6}$/.test(rest[0] ?? '')
  }
  return false
}

/**
 * True for a simple command running the bare `walnut` CLI in one of the shapes
 * walnutCliShapeAnswered lists (for `tools call`, an op walnutOpAnswered takes).
 * A string is parsed as POSIX shell words and refused on any operator,
 * redirect, expansion, glob, brace, tilde or comment outside quotes, so every
 * word is exactly what the program receives; an `sh -c` / `bash -lc` wrapper
 * (as Codex runs every command) is unwrapped and its script read the same way.
 */
export function isWalnutCliCommand(command: string | readonly string[], depth = 0): boolean {
  if (depth > 2) return false
  const words = typeof command === 'string' ? shellWords(command) : [...command]
  if (!words || words.length === 0) return false
  if (SHELLS.test(words[0])) {
    const flags = words.slice(1, -1)
    const script = words[words.length - 1]
    const flagsOk = flags.length > 0 && flags.length <= 2
      && flags.every((f) => /^-[lc]+$/.test(f)) && flags.some((f) => f.includes('c'))
    return flagsOk && isWalnutCliCommand(script, depth + 1)
  }
  if (words[0] !== 'walnut') return false
  return walnutCliShapeAnswered(words.slice(1))
}

/**
 * POSIX shell words of a simple command, or null when the text is anything
 * else: an operator (`; & | && ||`), a redirect, a subshell, a substitution or
 * expansion (`$`, backquote), a glob or brace or tilde (`* ? [ ] { } ~`, zsh's
 * `^` and a word-leading `=`), a comment, history expansion or a newline outside
 * quotes, or an unterminated quote. Every word it returns is then exactly what
 * the shell hands the program (`c?ll` would expand to `call` beside a file of
 * that name).
 */
export function shellWords(text: string): string[] | null {
  const words: string[] = []
  let cur = ''
  let inWord = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === `'`) {
      const end = text.indexOf(`'`, i + 1)
      if (end < 0) return null
      cur += text.slice(i + 1, end)
      inWord = true
      i = end
    } else if (ch === '"') {
      let j = i + 1
      for (; j < text.length && text[j] !== '"'; j++) {
        const c = text[j]
        if (c === '$' || c === '`') return null
        if (c === '\\' && j + 1 < text.length && `"\\$\`\n`.includes(text[j + 1])) {
          if (text[j + 1] === '\n') return null
          cur += text[++j]
        } else {
          cur += c
        }
      }
      if (j >= text.length) return null
      inWord = true
      i = j
    } else if (ch === '\\') {
      if (i + 1 >= text.length || text[i + 1] === '\n') return null
      cur += text[++i]
      inWord = true
    } else if (ch === ' ' || ch === '\t') {
      if (inWord) words.push(cur)
      cur = ''
      inWord = false
    } else if (';&|<>()`$\n\r!*?[]{}~^'.includes(ch) || ((ch === '#' || ch === '=') && !inWord)) {
      return null
    } else {
      cur += ch
      inWord = true
    }
  }
  if (inWord) words.push(cur)
  return words
}
