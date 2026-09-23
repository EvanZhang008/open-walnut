/**
 * Host-local scan for coding-agent sessions that were started OUTSIDE Walnut.
 *
 * Runs IN THE DAEMON on each exec host (design principle: host-local work
 * belongs to the daemon). The host has thousands of transcript files; parsing
 * them server-side would mean shipping gigabytes over the tunnel. Instead the
 * daemon walks its own dirs, reads only the head/tail of each candidate, and
 * returns a small list of descriptors that the server turns into Walnut
 * sessions.
 *
 * Two engines:
 *   - claude: ~/.claude/projects/<encoded-cwd>/<sid>.jsonl. "External" means the
 *     first `user` line's `entrypoint` is a HUMAN entrypoint ('cli' = typed in a
 *     terminal, 'claude-desktop' = the desktop app). Walnut's own spawns are
 *     'sdk-cli' (it drives `claude -p --input-format stream-json`), so the
 *     entrypoint can also be inherited by child processes; it does not prove
 *     human intent. Title: the CLI's own rule, ported verbatim (a `/rename`
 *     `custom-title` line wins, then the AI-generated `ai-title` line, then the
 *     first user message that is neither a meta line nor a compaction summary).
 *   - codex: ~/.codex/sessions/<y>/<m>/<d>/rollout-<ts>-<id>.jsonl. The first
 *     line is a `session_meta` whose `originator` names the surface:
 *     'codex-tui' / 'Codex Desktop' are human, 'open-walnut' is ours. Codex
 *     writes no title at all, so we derive one from the first real user
 *     message (skipping the AGENTS.md instruction preamble it prepends).
 *
 * Codex resume writes a NEW rollout file for the SAME session id, so results
 * are deduped by id keeping the newest file.
 *
 * ⚠️ This module is compiled into the bun daemon binary AND textually inlined
 * into the source-deployed daemon twin (see daemon-source.ts). Keep it free of
 * imports beyond node builtins, and free of backticks — the source twin is an
 * embedded template literal.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export interface ExternalSessionCandidate {
  /** Provider session id (claude session UUID / codex session id). */
  sessionId: string
  engine: 'claude' | 'codex'
  /** Working directory the session ran in, when the transcript records one. */
  cwd?: string
  /** Best available human title. */
  title?: string
  /** Which surface started it ('cli', 'claude-desktop', 'codex-tui', …). */
  origin: string
  /** ISO timestamp of the transcript's first entry (session start). */
  startedAt?: string
  /** ISO timestamp of last write (transcript mtime). */
  lastActiveAt: string
  /** Rough user+assistant message count (from the scanned head only). */
  messageCount: number
  /** Absolute transcript path on this host. */
  transcriptPath: string
  /**
   * Set only by describe: why this known transcript should never have been
   * imported (the scan simply skips such files), or null when it is a real
   * outside session. The server removes an import that carries a reason; an
   * answer without the key comes from a scanner that predates the rule.
   */
  notExternal?: NotExternalReason | null
}

/**
 * 'fork': a programmatic fork (btw side thread, standby prewarm, chat-lane or
 * task fork): its history is a copy of another session. 'walnut-driven': a
 * Walnut envelope sits in a user turn, so some Walnut drove the session.
 * 'no-reply': the whole transcript holds no real model reply (a probe, or a
 * first turn that only ever errored), so there is nothing to adopt.
 */
export type NotExternalReason = 'fork' | 'walnut-driven' | 'no-reply'

export interface ScanExternalSessionsOptions {
  /** Only consider transcripts written within this window. */
  sinceMs: number
  /** Session ids the server already tracks — skipped without being parsed. */
  knownSessionIds?: string[]
  /** Cap on returned candidates (newest first). Guards a pathological host. */
  limit?: number
  excludedCwds?: string[]
  /** Test seam: override ~. */
  homeDir?: string
}

export interface ScanExternalSessionsResult {
  candidates: ExternalSessionCandidate[]
  /** Transcript files considered (post-window, pre-classification). */
  scanned: number
  /** True when `limit` clipped the result — the server logs what it dropped. */
  truncated: boolean
}

/** Claude entrypoints that mean "a human started this", not Walnut's SDK spawn. */
const HUMAN_CLAUDE_ENTRYPOINTS = new Set(['cli', 'claude-desktop'])
/**
 * Programmatic entrypoints — OTHER SDK apps (e.g. an agent orchestrator running
 * investigations through the Agent SDK) record the same 'sdk-cli' Walnut's own
 * spawns do, so entrypoint alone cannot separate them. Walnut's own sessions
 * are excluded by knownSessionIds (they are all tracked); what remains is other
 * programs' sessions plus TEST DEBRIS from ephemeral/dev servers whose isolated
 * DBs are gone. The debris lives under temp dirs, so programmatic sessions are
 * accepted only with a real (non-temp) cwd — human sessions stay unconditional.
 */
const PROGRAMMATIC_CLAUDE_ENTRYPOINTS = new Set(['sdk-cli', 'sdk-ts'])
/** Codex originators that mean "a human started this". */
const HUMAN_CODEX_ORIGINATORS = new Set(['codex-tui', 'Codex Desktop', 'codex_desktop'])

/**
 * Envelopes only Walnut writes into a user turn. Mirrors CACHE_WARMUP_TAG
 * (core/sessions/side-thread-warmup.ts) and the two output-mode markers
 * (core/sessions/output-mode.ts); this file can import neither, so a test pins
 * the equality. knownSessionIds only covers THIS server's records, and a Walnut
 * session can reach the disk without one: a side-thread fork minted by another
 * Walnut instance sharing the host (a dev or test server), or a fork whose
 * record was lost. Its copied history carries these envelopes, which is how the
 * scan still recognises it. Line-anchored like stripOutputModeWrappers, so a
 * sentence that merely mentions the mode is not mistaken for one.
 */
export const WALNUT_ENVELOPE_MARKERS = {
  cacheWarmup: '<walnut-cache-warmup>',
  outputModeInstruction: '[Rich output mode: ',
  outputModeReminder: '[Rich output mode is still on',
}

export function isWalnutEnvelopeText(text: string): boolean {
  const m = WALNUT_ENVELOPE_MARKERS
  if (text.trimStart().startsWith(m.cacheWarmup)) return true
  if (!text.includes(m.outputModeInstruction) && !text.includes(m.outputModeReminder)) return false
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t.startsWith(m.outputModeInstruction)) return true
    if (t.startsWith(m.outputModeReminder) && t.endsWith(']')) return true
  }
  return false
}

/** Temp/test locations whose programmatic sessions are throwaway debris. */
function isTempCwd(cwd: string | undefined): boolean {
  if (!cwd) return true // no cwd recorded → can't place it → not worth a task
  if (cwd === '/tmp' || cwd === '/private/tmp') return true
  if (cwd.startsWith('/tmp/') || cwd.startsWith('/private/tmp/')) return true
  if (cwd.startsWith('/var/folders/') || cwd.startsWith('/private/var/folders/')) return true
  if (cwd.includes('walnut-test-') || cwd.includes('open-walnut-test')) return true
  return false
}

export function isExcludedExternalCwd(cwd: string | undefined, excludedCwds: string[]): boolean {
  if (!cwd) return false
  const normalized = path.posix.normalize(cwd)
  return excludedCwds.some(excluded => {
    const root = path.posix.normalize(excluded).replace(/\/+$/, '')
    return root !== '' && (normalized === root || normalized.startsWith(root + '/'))
  })
}

/** One read step when walking a transcript head. */
const CHUNK_BYTES = 131072
/**
 * Hard ceiling on head bytes read per transcript. Sized by measurement, not
 * guess: codex writes its whole system prompt into the `session_meta` line
 * (~22KB) and then replays the project's AGENTS.md plus a `world_state` and
 * `turn_context` block BEFORE the human's first words, which on real files put
 * the first user message anywhere from byte 86K to 155K. A 64KB window found
 * the metadata but never the message, so every codex session imported with no
 * title. The budget is per file and we stop as soon as the fields are found, so
 * the common case still reads one chunk.
 */
const MAX_HEAD_BYTES = 2 * 1024 * 1024
/** Bytes read from the tail when hunting for the newest title lines. */
const TAIL_BYTES = 131072
const MAX_TITLE_LEN = 120

function readChunk(filePath: string, size: number, bytes: number, fromEnd: boolean): string {
  const length = Math.min(bytes, size)
  if (length <= 0) return ''
  const position = fromEnd ? Math.max(0, size - length) : 0
  let fd: number | null = null
  try {
    fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(length)
    const read = fs.readSync(fd, buf, 0, length, position)
    return buf.subarray(0, read).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch { /* ignore */ } }
  }
}

/**
 * Walk a transcript's head line by line, reading only as far as needed.
 * `onEntry` returns true to stop. Partial trailing lines are never parsed —
 * they are carried into the next chunk — so a value can't be lost at a chunk
 * boundary.
 */
function walkHeadLines(
  filePath: string,
  size: number,
  onEntry: (entry: Record<string, unknown>) => boolean,
): void {
  let fd: number | null = null
  try {
    fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(Math.min(CHUNK_BYTES, size))
    let position = 0
    let carry = ''
    const budget = Math.min(size, MAX_HEAD_BYTES)
    while (position < budget) {
      const want = Math.min(buf.length, budget - position)
      const read = fs.readSync(fd, buf, 0, want, position)
      if (read <= 0) break
      position += read
      const text = carry + buf.subarray(0, read).toString('utf8')
      const lines = text.split('\n')
      // Last element is either a partial line or '' — carry it either way.
      carry = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        let entry: Record<string, unknown>
        try { entry = JSON.parse(line) as Record<string, unknown> } catch { continue }
        if (onEntry(entry)) return
      }
    }
    // Final carry is a complete line only when the file has no trailing newline
    // AND we consumed it all; a budget-truncated carry would be a partial line.
    if (carry.trim() && position >= size) {
      try { onEntry(JSON.parse(carry) as Record<string, unknown>) } catch { /* partial */ }
    }
  } catch {
    /* unreadable file — caller treats it as unclassifiable */
  } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch { /* ignore */ } }
  }
}

/** Squash a raw message into a single-line title. */
function toTitle(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const cleaned = raw.replace(/\s+/g, ' ').trim()
  if (!cleaned) return undefined
  return cleaned.length > MAX_TITLE_LEN ? cleaned.slice(0, MAX_TITLE_LEN - 1) + '…' : cleaned
}

/** Every text block of a message payload, in order (string content = one). */
function messageTexts(message: unknown): string[] {
  if (typeof message === 'string') return [message]
  if (!message || typeof message !== 'object') return []
  const m = message as Record<string, unknown>
  if (typeof m.content === 'string') return [m.content]
  const out: string[] = []
  if (Array.isArray(m.content)) {
    for (const part of m.content) {
      if (part && typeof part === 'object') {
        const p = part as Record<string, unknown>
        if (p.type !== undefined && p.type !== 'text' && p.type !== 'input_text') continue
        if (typeof p.text === 'string' && p.text) out.push(p.text)
      }
    }
  }
  if (out.length === 0 && typeof m.text === 'string') out.push(m.text)
  return out
}

/**
 * The CLI's skip rule for a first prompt, verbatim (sessionStorage
 * SKIP_FIRST_PROMPT_PATTERN): any text that opens with a markup tag (hook
 * output, system reminders, IDE metadata, task notifications, and every
 * envelope Walnut injects) or an interrupt marker is never a title.
 */
const SKIP_FIRST_PROMPT_PATTERN = /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/

/** Beyond the CLI's rule: codex's AGENTS.md replay, the old CLI resume caveat,
 *  and a compaction summary in a transcript written before the CLI flagged it
 *  (isCompactSummary). None of these is ever a human's first words. */
function isLegacyPreamble(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith('# AGENTS.md') || t.startsWith('# CLAUDE.md') || t.startsWith('Caveat:')
    || t.startsWith(COMPACT_SUMMARY_PREFIX)
}

/**
 * The CLI's own commands and aliases (commands.ts builtInCommandNames, CLI
 * 2.1.280). A built-in like "/model sonnet" says nothing about the session, so
 * the CLI skips it; a custom command or skill with arguments is a fair title.
 * Refresh when the CLI adds commands; a miss only means one title reads as the
 * command instead of the next message.
 */
const BUILTIN_CLI_COMMANDS = new Set([
  'add-dir', 'advisor', 'agents', 'branch', 'bridge-kick', 'brief', 'btw', 'chrome', 'clear',
  'color', 'commit', 'commit-push-pr', 'compact', 'config', 'context', 'copy', 'cost',
  'desktop', 'diff', 'doctor', 'effort', 'exit', 'export', 'extra-usage', 'fast', 'feedback',
  'files', 'heapdump', 'help', 'hooks', 'ide', 'init', 'init-verifiers', 'insights', 'install',
  'install-github-app', 'install-slack-app', 'keybindings', 'login', 'logout', 'mcp', 'memory',
  'mobile', 'model', 'output-style', 'passes', 'permissions', 'plan', 'plugin', 'pr-comments',
  'privacy-settings', 'rate-limit-options', 'release-notes', 'reload-plugins',
  'remote-control', 'remote-env', 'rename', 'resume', 'review', 'rewind', 'sandbox',
  'security-review', 'session', 'skills', 'stats', 'status', 'statusline', 'stickers',
  'suggestions', 'tag', 'tasks', 'terminal-setup', 'theme', 'think-back', 'thinkback-play',
  'ultraplan', 'ultrareview', 'upgrade', 'usage', 'version', 'vim', 'voice', 'web-setup',
  'fork', 'workflows', 'allowed-tools', 'android', 'app', 'bashes', 'bug', 'checkpoint',
  'continue', 'ios', 'marketplace', 'new', 'plugins', 'quit', 'rc', 'remote', 'reset',
  'settings',
])

function extractTag(text: string, tag: string): string | undefined {
  const match = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>').exec(text)
  return match ? match[1] : undefined
}

/**
 * One text block through the CLI's first-prompt rule: a slash command becomes
 * "/name args" (none when it has no args), bash-mode input becomes "! cmd", and
 * anything the skip rule matches yields null (keep looking).
 */
function titleFromText(text: string): string | null {
  const commandName = extractTag(text, 'command-name')
  if (commandName !== undefined) {
    if (BUILTIN_CLI_COMMANDS.has(commandName.trim().replace(/^\//, ''))) return null
    const args = (extractTag(text, 'command-args') ?? '').trim()
    return args ? commandName.trim() + ' ' + args : null
  }
  const bashInput = extractTag(text, 'bash-input')
  if (bashInput) return '! ' + bashInput
  if (SKIP_FIRST_PROMPT_PATTERN.test(text) || isLegacyPreamble(text)) return null
  return text
}

/** The first title-bearing text of a message, if any. */
function titleFromMessage(message: unknown): string | undefined {
  for (const text of messageTexts(message)) {
    const title = titleFromText(text)
    if (title) return title
  }
  return undefined
}

/**
 * True for text the title rule skips (see titleFromText). Exported so the
 * server can recognise a title an older scanner took from such a line and
 * replace it (one rule, both sides).
 */
export function isSyntheticUserText(text: string): boolean {
  if (titleFromText(text) === null) return true
  // A title an older scanner formatted from a built-in command ("/model x").
  const command = /^\/([a-z][\w-]*)(?:\s|$)/.exec(text.trimStart())
  return command !== null && BUILTIN_CLI_COMMANDS.has(command[1])
}

/** First words of every compaction summary the CLI has ever written. */
const COMPACT_SUMMARY_PREFIX = 'This session is being continued from a previous conversation'

/**
 * The CLI's own first-prompt rule (sessionStorage getFirstMeaningfulUserMessage
 * TextContent): a user line is skipped when it is meta (an injected instruction)
 * or a compaction summary. Titling a session with either produced hundreds of
 * identical "This session is being continued..." rows.
 */
function isTitleBearingUserLine(entry: Record<string, unknown>): boolean {
  return entry.isMeta !== true && entry.isCompactSummary !== true
}

/** The two title lines the CLI appends: user rename beats AI title. */
interface TitleLines {
  customTitle?: string
  aiTitle?: string
}

/**
 * Newest `custom-title` / `ai-title` in a chunk of transcript text. The CLI
 * prefers customTitle over aiTitle regardless of append order, and an empty
 * customTitle is an explicit "cleared" (so the newest value wins, even '').
 */
function findTitleLines(text: string): TitleLines {
  const out: TitleLines = {}
  for (const line of text.split('\n')) {
    if (!line.includes('"custom-title"') && !line.includes('"ai-title"')) continue
    try {
      const entry = JSON.parse(line) as Record<string, unknown>
      if (entry.type === 'custom-title' && typeof entry.customTitle === 'string') {
        out.customTitle = entry.customTitle
      } else if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string' && entry.aiTitle.trim()) {
        out.aiTitle = entry.aiTitle
      }
    } catch { /* partial first line of the chunk — skip */ }
  }
  return out
}

/** CLI display priority: custom-title, then ai-title, then the first prompt.
 *  Tail lines are newer than head lines (custom-title is re-appended on resume). */
function pickClaudeTitle(head: ClaudeHead, tail: TitleLines): string | undefined {
  const custom = tail.customTitle !== undefined ? tail.customTitle : head.customTitle
  return toTitle(custom) ?? toTitle(tail.aiTitle ?? head.aiTitle) ?? toTitle(head.firstUserText)
}

interface ClaudeHead extends TitleLines {
  entrypoint?: string
  cwd?: string
  startedAt?: string
  firstUserText?: string
  messageCount: number
  isSidechain: boolean
  /** A Walnut envelope was seen in a user turn or a queued input. */
  walnutDriven: boolean
  /** The history was copied from another session (see FORK_COPY_GAP_MS). */
  forked: boolean
  /** A real model reply was seen (not an API error, not a synthetic stub). */
  replied: boolean
  /** The whole file fit the head budget, so a missing reply is a fact. */
  readWhole: boolean
}

/** Why a programmatic claude transcript is not an outside session, if it isn't.
 *  The envelope rule is programmatic-only: a person who forks a Walnut session
 *  in a terminal started real outside work, even though the history they
 *  copied carries Walnut's envelopes. */
function claudeNotExternal(head: ClaudeHead): NotExternalReason | undefined {
  const human = head.entrypoint !== undefined && HUMAN_CLAUDE_ENTRYPOINTS.has(head.entrypoint)
  if (head.forked && !human) return 'fork'
  if (head.walnutDriven && !human) return 'walnut-driven'
  if (head.readWhole && !head.replied) return 'no-reply'
  return undefined
}

/**
 * How a fork looks on disk: the CLI logs the queued first input (stamped at
 * fork time) and only then writes the copied chain, whose lines keep the
 * parent's older timestamps. So a first message line that predates a line
 * before it by more than this is copied history, not a session's own start.
 * Measured on one host's 30 days: every recorded Walnut fork (37) matched, and
 * the only other match was a chat-lane fork with no fork link; no plain, cli or
 * desktop session did. Fails open: a CLI that stops writing that order only
 * lets a fork through to the envelope rule.
 */
const FORK_COPY_GAP_MS = 60000

function isRealReply(entry: Record<string, unknown>): boolean {
  if (entry.isApiErrorMessage === true) return false
  const message = entry.message as Record<string, unknown> | undefined
  return !(message && message.model === '<synthetic>')
}

function parseClaudeHead(filePath: string, size: number): ClaudeHead {
  const out: ClaudeHead = {
    messageCount: 0, isSidechain: false, walnutDriven: false, forked: false, replied: false,
    readWhole: size <= MAX_HEAD_BYTES,
  }
  let latestBeforeFirstMessage = 0
  let sawMessage = false
  walkHeadLines(filePath, size, (entry) => {
    const type = entry.type
    const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
    if (!sawMessage && Number.isFinite(at)) {
      if (type === 'user' || type === 'assistant' || type === 'system') {
        sawMessage = true
        if (latestBeforeFirstMessage - at > FORK_COPY_GAP_MS) out.forked = true
      } else if (at > latestBeforeFirstMessage) {
        latestBeforeFirstMessage = at
      }
    }
    if (!out.startedAt && typeof entry.timestamp === 'string') out.startedAt = entry.timestamp
    if (!out.cwd && typeof entry.cwd === 'string') out.cwd = entry.cwd
    if (type === 'user' || type === 'assistant') out.messageCount++
    if (type === 'assistant' && !out.replied && isRealReply(entry)) out.replied = true
    // A queued input (a warm-up is enqueued before the fork's first turn) or a
    // user turn carrying a Walnut envelope.
    if (!out.walnutDriven) {
      const texts = type === 'queue-operation' && typeof entry.content === 'string' ? [entry.content]
        : type === 'user' ? messageTexts(entry.message) : []
      if (texts.some(isWalnutEnvelopeText)) out.walnutDriven = true
    }
    if (type === 'user' && !out.entrypoint) {
      out.entrypoint = typeof entry.entrypoint === 'string' ? entry.entrypoint : 'unknown'
      if (entry.isSidechain === true) out.isSidechain = true
      // Stop early only when the file can never be imported: an entrypoint in
      // neither set, or a programmatic session in a temp dir (cwd rides this
      // same line). Accepted programmatic sessions MUST keep walking — their
      // title is the first user message further down, and exiting here is what
      // once left every SDK import named "Claude session <id>".
      const human = HUMAN_CLAUDE_ENTRYPOINTS.has(out.entrypoint)
      const program = PROGRAMMATIC_CLAUDE_ENTRYPOINTS.has(out.entrypoint)
      if (!human && !program) return true
      if (program && !human && isTempCwd(out.cwd)) return true
    }
    // Settled: a programmatic fork or Walnut-driven session is never imported.
    if ((out.walnutDriven || out.forked) && out.entrypoint && !HUMAN_CLAUDE_ENTRYPOINTS.has(out.entrypoint)) return true
    if (type === 'user' && !out.firstUserText && isTitleBearingUserLine(entry)) {
      out.firstUserText = titleFromMessage(entry.message)
    }
    // Title lines can sit in the head too: an ai-title written early scrolls
    // out of the tail window on a long session, and the CLI's own readers fall
    // back to the head buffer for exactly that case.
    if (type === 'custom-title' && typeof entry.customTitle === 'string') out.customTitle = entry.customTitle
    if (type === 'ai-title' && typeof entry.aiTitle === 'string' && entry.aiTitle.trim()) out.aiTitle = entry.aiTitle
    // No "all fields found" early exit: a claude user line carries entrypoint +
    // cwd + message all at once, so exiting there would report messageCount=1
    // for a 200-message session. Accepted files read to the head budget, which
    // makes the count exact for normal transcripts and a lower bound for huge
    // ones (it is display-only either way).
    return false
  })
  return out
}

function scanClaude(
  homeDir: string,
  cutoff: number,
  known: Set<string>,
  excludedCwds: string[],
  out: ExternalSessionCandidate[],
): number {
  const root = path.join(homeDir, '.claude', 'projects')
  let dirs: string[]
  try { dirs = fs.readdirSync(root) } catch { return 0 }
  let scanned = 0

  for (const dirName of dirs) {
    const dir = path.join(root, dirName)
    let files: string[]
    try {
      if (!fs.statSync(dir).isDirectory()) continue
      files = fs.readdirSync(dir)
    } catch { continue }

    for (const fileName of files) {
      if (!fileName.endsWith('.jsonl')) continue
      const sessionId = fileName.slice(0, -'.jsonl'.length)
      if (known.has(sessionId)) continue
      const filePath = path.join(dir, fileName)
      let stat: fs.Stats
      try { stat = fs.statSync(filePath) } catch { continue }
      if (!stat.isFile() || stat.mtimeMs < cutoff || stat.size === 0) continue
      scanned++

      const head = parseClaudeHead(filePath, stat.size)
      if (!head.entrypoint) continue
      // A sidechain file is a subagent transcript, not a session someone opened.
      if (head.isSidechain || isExcludedExternalCwd(head.cwd, excludedCwds)) continue
      const isHuman = HUMAN_CLAUDE_ENTRYPOINTS.has(head.entrypoint)
      // Programmatic (other SDK apps, e.g. an investigation orchestrator):
      // only with a real working directory — temp-dir ones are test debris.
      const isProgram = PROGRAMMATIC_CLAUDE_ENTRYPOINTS.has(head.entrypoint) && !isTempCwd(head.cwd)
      if (!isHuman && !isProgram) continue
      if (claudeNotExternal(head)) continue

      out.push(claudeCandidate(sessionId, filePath, stat, head))
    }
  }
  return scanned
}

/** The descriptor for one claude transcript whose head is already parsed. */
function claudeCandidate(sessionId: string, filePath: string, stat: fs.Stats, head: ClaudeHead): ExternalSessionCandidate {
  const tail = findTitleLines(readChunk(filePath, stat.size, TAIL_BYTES, true))
  return {
    sessionId,
    engine: 'claude',
    cwd: head.cwd,
    title: pickClaudeTitle(head, tail),
    origin: head.entrypoint ?? 'unknown',
    startedAt: head.startedAt,
    lastActiveAt: new Date(stat.mtimeMs).toISOString(),
    messageCount: head.messageCount,
    transcriptPath: filePath,
  }
}

interface CodexHead {
  sessionId?: string
  originator?: string
  cwd?: string
  startedAt?: string
  firstUserText?: string
  messageCount: number
}

function parseCodexHead(filePath: string, size: number): CodexHead {
  const out: CodexHead = { messageCount: 0 }
  walkHeadLines(filePath, size, (entry) => {
    const payload = (entry.payload ?? {}) as Record<string, unknown>
    if (entry.type === 'session_meta') {
      const id = payload.session_id ?? payload.id
      if (typeof id === 'string') out.sessionId = id
      if (typeof payload.originator === 'string') out.originator = payload.originator
      if (typeof payload.cwd === 'string') out.cwd = payload.cwd
      const ts = payload.timestamp ?? entry.timestamp
      if (typeof ts === 'string') out.startedAt = ts
      // session_meta is line 1 and holds everything needed to reject a
      // Walnut-owned rollout — stop before reading its ~22KB of prompt plus the
      // AGENTS.md replay that follows.
      if (out.originator && !HUMAN_CODEX_ORIGINATORS.has(out.originator)) return true
      return false
    }
    if (entry.type === 'event_msg') {
      if (payload.type === 'user_message' || payload.type === 'agent_message') out.messageCount++
      if (payload.type === 'user_message' && !out.firstUserText) {
        const text = typeof payload.message === 'string' ? payload.message : undefined
        if (text) out.firstUserText = titleFromText(text) ?? undefined
      }
      return false
    }
    if (entry.type === 'response_item' && payload.role === 'user' && !out.firstUserText) {
      out.firstUserText = titleFromMessage(payload)
    }
    return false
  })
  return out
}

function codexCandidate(
  sessionId: string,
  file: { filePath: string; mtimeMs: number },
  head: CodexHead,
): ExternalSessionCandidate {
  return {
    sessionId,
    engine: 'codex',
    cwd: head.cwd,
    title: toTitle(head.firstUserText),
    origin: head.originator ?? 'unknown',
    startedAt: head.startedAt,
    lastActiveAt: new Date(file.mtimeMs).toISOString(),
    messageCount: head.messageCount,
    transcriptPath: file.filePath,
  }
}

/** Every codex rollout file under ~/.codex/sessions (a bounded 3-level walk). */
function listCodexRollouts(homeDir: string): Array<{ filePath: string; size: number; mtimeMs: number }> {
  const root = path.join(homeDir, '.codex', 'sessions')
  const files: Array<{ filePath: string; size: number; mtimeMs: number }> = []
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < 4) walk(full, depth + 1)
        continue
      }
      if (!entry.name.endsWith('.jsonl')) continue
      let stat: fs.Stats
      try { stat = fs.statSync(full) } catch { continue }
      if (!stat.isFile() || stat.size === 0) continue
      files.push({ filePath: full, size: stat.size, mtimeMs: stat.mtimeMs })
    }
  }
  walk(root, 0)
  return files
}

function scanCodex(
  homeDir: string,
  cutoff: number,
  known: Set<string>,
  excludedCwds: string[],
  out: ExternalSessionCandidate[],
): number {
  // Layout is <year>/<month>/<day>/rollout-*.jsonl — a bounded 3-level walk.
  const files = listCodexRollouts(homeDir).filter((f) => f.mtimeMs >= cutoff)

  // Resume writes a fresh rollout file per session id — newest file wins.
  const byId = new Map<string, ExternalSessionCandidate>()
  for (const file of files) {
    const head = parseCodexHead(file.filePath, file.size)
    if (!head.sessionId || !head.originator) continue
    if (!HUMAN_CODEX_ORIGINATORS.has(head.originator)) continue
    if (known.has(head.sessionId) || isExcludedExternalCwd(head.cwd, excludedCwds)) continue
    const candidate = codexCandidate(head.sessionId, file, head)
    const prev = byId.get(head.sessionId)
    if (!prev || Date.parse(prev.lastActiveAt) < file.mtimeMs) {
      // Keep the earliest start + a title from whichever rollout has one.
      byId.set(head.sessionId, {
        ...candidate,
        startedAt: prev?.startedAt ?? candidate.startedAt,
        title: candidate.title ?? prev?.title,
      })
    } else if (!prev.title && candidate.title) {
      prev.title = candidate.title
    }
  }
  for (const candidate of byId.values()) out.push(candidate)
  return files.length
}

export interface DescribeExternalSessionsOptions {
  /** Provider session ids to look up (claude UUIDs and/or codex ids). */
  sessionIds: string[]
  /** Stat only: answer each id's last activity (transcript mtime) without
   *  parsing it. The idle sweep asks this before completing anything. */
  activityOnly?: boolean
  /** Test seam: override ~. */
  homeDir?: string
}

/** One located transcript's last activity (activityOnly answers). */
export interface ExternalSessionActivity {
  sessionId: string
  lastActiveAt: string
}

/** Ids looked up per call (the server's per-run caps are at or below this). */
const DESCRIBE_LIMIT = 300

type LocatedFile = { filePath: string; size: number; mtimeMs: number }

/** Find each wanted id's transcript: claude by one readdir per project dir,
 *  codex by rollout suffix (newest rollout wins, resume writes a new one). */
function locateTranscripts(homeDir: string, ids: string[]): Map<string, { engine: 'claude' | 'codex'; file: LocatedFile }> {
  const wanted = new Set(ids)
  const found = new Map<string, { engine: 'claude' | 'codex'; file: LocatedFile }>()
  const root = path.join(homeDir, '.claude', 'projects')
  let dirs: string[] = []
  try { dirs = fs.readdirSync(root) } catch { dirs = [] }
  for (const dirName of dirs) {
    if (wanted.size === 0) break
    let names: string[]
    try { names = fs.readdirSync(path.join(root, dirName)) } catch { continue }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const sessionId = name.slice(0, -'.jsonl'.length)
      if (!wanted.has(sessionId)) continue
      const filePath = path.join(root, dirName, name)
      let stat: fs.Stats
      try { stat = fs.statSync(filePath) } catch { continue }
      if (!stat.isFile() || stat.size === 0) continue
      found.set(sessionId, { engine: 'claude', file: { filePath, size: stat.size, mtimeMs: stat.mtimeMs } })
      wanted.delete(sessionId)
    }
  }
  if (wanted.size > 0) {
    for (const file of listCodexRollouts(homeDir)) {
      const base = path.basename(file.filePath, '.jsonl')
      for (const sessionId of wanted) {
        if (!base.endsWith('-' + sessionId)) continue
        const prev = found.get(sessionId)
        if (!prev || prev.file.mtimeMs < file.mtimeMs) found.set(sessionId, { engine: 'codex', file })
      }
    }
  }
  return found
}

/**
 * Re-read specific transcripts by session id, regardless of age. The scan is
 * windowed by mtime, so a session imported with a placeholder title whose file
 * has since aged out of the window would otherwise keep that title forever;
 * the server asks for exactly those ids and retitles from the answer. With
 * activityOnly it answers each id's current transcript mtime instead: an
 * imported session someone keeps using in a terminal is never re-scanned (it
 * is known), so this is the only way the server learns it is still alive. No
 * entrypoint/originator classification: the ids are ones Walnut already owns.
 * An id with no transcript is simply absent from the answer. A transcript
 * the scan would have skipped says why in notExternal.
 */
export function describeExternalSessions(
  options: DescribeExternalSessionsOptions,
): { candidates: ExternalSessionCandidate[]; activity: ExternalSessionActivity[] } {
  const homeDir = options.homeDir ?? os.homedir()
  const ids = [...new Set(options.sessionIds.filter((id) => typeof id === 'string' && id.length > 0))].slice(0, DESCRIBE_LIMIT)
  const candidates: ExternalSessionCandidate[] = []
  const activity: ExternalSessionActivity[] = []
  if (ids.length === 0) return { candidates, activity }
  for (const [sessionId, hit] of locateTranscripts(homeDir, ids)) {
    if (options.activityOnly) {
      activity.push({ sessionId, lastActiveAt: new Date(hit.file.mtimeMs).toISOString() })
      continue
    }
    if (hit.engine === 'claude') {
      const head = parseClaudeHead(hit.file.filePath, hit.file.size)
      if (head.isSidechain) continue
      let stat: fs.Stats
      try { stat = fs.statSync(hit.file.filePath) } catch { continue }
      const candidate = claudeCandidate(sessionId, hit.file.filePath, stat, head)
      candidate.notExternal = claudeNotExternal(head) ?? null
      candidates.push(candidate)
    } else {
      const candidate = codexCandidate(sessionId, hit.file, parseCodexHead(hit.file.filePath, hit.file.size))
      candidate.notExternal = null
      candidates.push(candidate)
    }
  }
  return { candidates, activity }
}

/**
 * Scan this host for sessions started outside Walnut. Pure host-local I/O —
 * safe to call from either daemon twin.
 */
export function scanExternalSessions(
  options: ScanExternalSessionsOptions,
): ScanExternalSessionsResult {
  const homeDir = options.homeDir ?? os.homedir()
  const cutoff = Date.now() - Math.max(0, options.sinceMs)
  const known = new Set(options.knownSessionIds ?? [])
  const candidates: ExternalSessionCandidate[] = []

  let scanned = 0
  scanned += scanClaude(homeDir, cutoff, known, options.excludedCwds ?? [], candidates)
  scanned += scanCodex(homeDir, cutoff, known, options.excludedCwds ?? [], candidates)

  candidates.sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt))
  const limit = options.limit ?? 200
  const truncated = candidates.length > limit
  return { candidates: truncated ? candidates.slice(0, limit) : candidates, scanned, truncated }
}
