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
  /** Set by describe with 'walnut-spawned': the spawn journal's line for it. */
  spawnedBy?: SpawnJournalEntry
}

/** What the reader keeps of one spawn-journal line (daemon appendSpawnJournal). */
export interface SpawnJournalEntry {
  /** new | fork | resume | backfill (an id folded in from an older record). */
  kind?: string
  at?: string
  /** A fork's source session. */
  parent?: string
  /** The asking Walnut's data dir: prod, a dev server, an ephemeral test server. */
  home?: string
  task?: string
}

/**
 * 'walnut-spawned': the id is in this host's spawn journal — a daemon on this
 * host started that CLI for some Walnut instance (prod, dev, or a test server
 * whose own DB is gone), so no transcript reading is needed at all.
 * 'fork': a programmatic fork (btw side thread, standby prewarm, chat-lane or
 * task fork): its history is a copy of another session. 'walnut-driven': a
 * Walnut envelope sits in a user turn, so some Walnut drove the session.
 * 'no-reply': the whole transcript holds no real model reply (a probe, or a
 * first turn that only ever errored), so there is nothing to adopt.
 * 'batch': one worker of a scripted fan-out (see BATCH_MIN_SESSIONS).
 */
export type NotExternalReason = 'walnut-spawned' | 'fork' | 'walnut-driven' | 'no-reply' | 'batch'

/**
 * A program that fans out `claude -p` (one worker per dashboard widget, per
 * ticket row) starts many sessions in one directory with the same opening
 * prompt within minutes. Each worker is part of that program's run, like a
 * subagent, not a session someone opened: imported one task each, one host's
 * runs added about 1,000 tasks a day to its folders (2026-10-06). A
 * programmatic session is a batch worker when at least BATCH_MIN_SESSIONS
 * sessions with its cwd and the first BATCH_PROMPT_CHARS of its opening prompt
 * started within BATCH_WINDOW_MS of it. Measured on that host's 60 days: the
 * fan-outs ran 26 to 340 workers in the window, the busiest non-batch pattern 7
 * (one ticket run again, a repeated "hi"), and nothing on the Mac reached 10.
 */
export const BATCH_MIN_SESSIONS = 10
export const BATCH_WINDOW_MS = 10 * 60 * 1000
const BATCH_PROMPT_CHARS = 80

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
  /** Test seam: override the spawn journal path. */
  spawnJournal?: string
}

export interface ScanExternalSessionsResult {
  candidates: ExternalSessionCandidate[]
  /** Transcript files considered (post-window, pre-classification). */
  scanned: number
  /** Of those, the files whose head was read this scan; the rest were
   *  unchanged since the last scan and kept its verdict. */
  parsed: number
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

/**
 * Where this host's daemons journal every session they start: under the HOME
 * whose ~/.claude the CLI writes into. WALNUT_SPAWN_JOURNAL relocates it (the
 * test harness does). Keep in sync with SPAWN_JOURNAL in both daemon twins.
 */
export function spawnJournalPath(homeDir: string): string {
  return process.env.WALNUT_SPAWN_JOURNAL || path.join(homeDir, '.open-walnut', 'local', 'spawn-journal.jsonl')
}

const JOURNAL_SID = /^[A-Za-z0-9_-]{1,128}$/

/** Read and parse a spawn journal; a missing file is an empty map. */
export function readSpawnJournal(file: string): Map<string, SpawnJournalEntry> {
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { /* no journal yet */ }
  return parseSpawnJournal(text)
}

/**
 * One JSON line per session. The first line for an id wins (the original
 * spawn); a torn or foreign line is skipped.
 */
export function parseSpawnJournal(text: string): Map<string, SpawnJournalEntry> {
  const out = new Map<string, SpawnJournalEntry>()
  const pick = (x: unknown) => (typeof x === 'string' && x ? x : undefined)
  for (const line of text.split('\n')) {
    if (!line) continue
    let rec: Record<string, unknown>
    try { rec = JSON.parse(line) } catch { continue }
    const sid = rec && rec.sid
    if (typeof sid !== 'string' || !JOURNAL_SID.test(sid) || out.has(sid)) continue
    const entry: SpawnJournalEntry = {}
    for (const key of ['kind', 'at', 'parent', 'home', 'task'] as const) {
      const value = pick(rec[key])
      if (value) entry[key] = value
    }
    out.set(sid, entry)
  }
  return out
}

/**
 * Session ids some Walnut instance on this host STARTED, keyed to what the
 * spawn journal says about each. This is the authoritative "is it ours"
 * answer: knownSessionIds only covers the ASKING server's DB, while the
 * journal covers every instance that shares the host. Two older records are
 * read as a fallback, for a daemon that has not folded them in yet: the
 * per-id marker files the journal replaced, and the streams dir, whose
 * <sid>.jsonl captures predate both. The text heuristics below stay as the
 * fallback for transcripts spawned before any of these existed.
 */
export function walnutSpawnedIds(homeDir: string, journalFile = spawnJournalPath(homeDir)): Map<string, SpawnJournalEntry> {
  const out = readSpawnJournal(journalFile)
  const dirs = [
    path.join(homeDir, '.open-walnut', 'tmp', 'spawned-sessions'),
    path.join(homeDir, '.open-walnut', 'tmp', 'streams'),
  ]
  for (const dir of dirs) {
    let names: string[] = []
    try { names = fs.readdirSync(dir) } catch { continue }
    for (const name of names) {
      // Markers are bare ids; streams hold <sid>.jsonl plus .pipe/.pgid/
      // .jsonl.err siblings, which the dot filter drops.
      const sid = name.endsWith('.jsonl') ? name.slice(0, -6) : name.includes('.') ? '' : name
      if (sid && !out.has(sid)) out.set(sid, { kind: 'backfill' })
    }
  }
  return out
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
 * boundary. False when the file could not be opened or read.
 */
function walkHeadLines(
  filePath: string,
  size: number,
  onEntry: (entry: Record<string, unknown>) => boolean,
): boolean {
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
        if (onEntry(entry)) return true
      }
    }
    // Final carry is a complete line only when the file has no trailing newline
    // AND we consumed it all; a budget-truncated carry would be a partial line.
    if (carry.trim() && position >= size) {
      try { onEntry(JSON.parse(carry) as Record<string, unknown>) } catch { /* partial */ }
    }
    return true
  } catch {
    // Unreadable file: the caller treats it as unclassifiable, this time.
    return false
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
  /** Opening or reading the file failed: no verdict to remember. */
  readFailed?: boolean
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

/** How a programmatic session opened: the key fan-out workers share (cwd +
 *  opening prompt) and when it started. None for a human entrypoint, a temp
 *  cwd, or a session with no prompt or start to compare. */
interface Opening { key: string; startMs: number }

function openingOf(head: ClaudeHead): Opening | undefined {
  if (!head.entrypoint || !PROGRAMMATIC_CLAUDE_ENTRYPOINTS.has(head.entrypoint) || isTempCwd(head.cwd)) return undefined
  const prompt = (head.firstUserText ?? '').replace(/\s+/g, ' ').trim().slice(0, BATCH_PROMPT_CHARS)
  const startMs = head.startedAt ? Date.parse(head.startedAt) : NaN
  if (!prompt || !Number.isFinite(startMs)) return undefined
  return { key: head.cwd + '\n' + prompt, startMs }
}

/** Openings grouped by key, each group's starts sorted. */
function startsByKey(openings: Iterable<Opening>): Map<string, number[]> {
  const out = new Map<string, number[]>()
  for (const o of openings) {
    const starts = out.get(o.key)
    if (starts) starts.push(o.startMs)
    else out.set(o.key, [o.startMs])
  }
  for (const starts of out.values()) starts.sort((a, b) => a - b)
  return out
}

function earliestStart(items: Array<{ opening: Opening }>): number {
  let min = Infinity
  for (const { opening } of items) if (opening.startMs < min) min = opening.startMs
  return min
}

/** Sessions with this opening's key that started within the window of it (itself included). */
function batchCount(opening: Opening, byKey: Map<string, number[]>): number {
  let n = 0
  for (const at of byKey.get(opening.key) ?? []) if (Math.abs(at - opening.startMs) <= BATCH_WINDOW_MS) n++
  return n
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

/** openingOnly: stop once the opening is known (entrypoint, cwd, start, first
 *  prompt), a few KB in. Enough for openingOf, and nothing else on the head is
 *  complete then. */
function parseClaudeHead(filePath: string, size: number, openingOnly = false): ClaudeHead {
  const out: ClaudeHead = {
    messageCount: 0, isSidechain: false, walnutDriven: false, forked: false, replied: false,
    readWhole: size <= MAX_HEAD_BYTES,
  }
  let latestBeforeFirstMessage = 0
  let sawMessage = false
  const readable = walkHeadLines(filePath, size, (entry) => {
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
    if (openingOnly && out.entrypoint && (out.firstUserText || !PROGRAMMATIC_CLAUDE_ENTRYPOINTS.has(out.entrypoint))) return true
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
  if (!readable) out.readFailed = true
  return out
}

/**
 * The scan shares the daemon's one event loop with every live session's I/O.
 * Done in one synchronous pass over ~16,000 transcripts (1.6 GB of heads on one
 * host) it held that loop for 17 to 75 s every ten minutes (2026-09-29): a send
 * timed out, the server fell back to a resume and the daemon stopped the live
 * CLI to make room for it. The walk now hands the loop back every SLICE_MS.
 */
const SLICE_MS = 8

/** A yield point: free inside a slice, otherwise lets timers and sockets run. */
function createPause(): () => Promise<void> {
  let sliceStart = Date.now()
  return async () => {
    if (Date.now() - sliceStart < SLICE_MS) return
    await new Promise<void>((resolve) => setImmediate(resolve))
    sliceStart = Date.now()
  }
}

/** What a stat says about a file's bytes: any write moves size, mtime or ctime
 *  (ctime also moves on utimes, which is how a copy can fake an mtime). */
interface FileStamp { size: number; mtimeMs: number; ctimeMs: number; ino: number }

function stampOf(stat: FileStamp): FileStamp {
  return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino }
}

function sameStamp(a: FileStamp, b: FileStamp): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino
}

/**
 * Last scan's verdict per transcript path. A verdict depends only on the
 * file's own bytes (the window, known ids and excluded cwds are applied around
 * it), so an unchanged file keeps it and a steady-state scan is one stat per
 * file: on the host above every one of the 16,000 files was rejected, head
 * read and all, every ten minutes. Each scan rebuilds the map from the files it
 * visits, so it never outgrows the directory.
 */
type ClaudeVerdict = { candidate: ExternalSessionCandidate | null; opening?: Opening }
const claudeVerdicts = new Map<string, FileStamp & ClaudeVerdict>()
const codexHeads = new Map<string, FileStamp & { head: CodexHead }>()

interface ScanTally { scanned: number; parsed: number }

/** One claude transcript's verdict from its bytes: its descriptor or null
 *  (with its opening, for the fan-out rule), and whether the bytes could be
 *  read at all (a failed read is not a verdict). */
function classifyClaude(
  sessionId: string,
  filePath: string,
  stat: fs.Stats,
): ClaudeVerdict & { readable: boolean } {
  const head = parseClaudeHead(filePath, stat.size)
  const reject = { candidate: null, readable: !head.readFailed }
  // A sidechain file is a subagent transcript, not a session someone opened.
  if (!head.entrypoint || head.isSidechain) return reject
  const isHuman = HUMAN_CLAUDE_ENTRYPOINTS.has(head.entrypoint)
  // Programmatic (other SDK apps, e.g. an investigation orchestrator):
  // only with a real working directory — temp-dir ones are test debris.
  const isProgram = PROGRAMMATIC_CLAUDE_ENTRYPOINTS.has(head.entrypoint) && !isTempCwd(head.cwd)
  if (!isHuman && !isProgram) return reject
  if (claudeNotExternal(head)) return reject
  return { candidate: claudeCandidate(sessionId, filePath, stat, head), opening: openingOf(head), readable: true }
}

async function scanClaude(
  homeDir: string,
  cutoff: number,
  known: Set<string>,
  excludedCwds: string[],
  out: ExternalSessionCandidate[],
  tally: ScanTally,
  pause: () => Promise<void>,
): Promise<void> {
  const root = path.join(homeDir, '.claude', 'projects')
  let dirs: string[]
  try { dirs = fs.readdirSync(root) } catch { return }
  const verdicts = new Map<string, FileStamp & ClaudeVerdict>()
  // Programmatic candidates by project dir: the fan-out rule needs their siblings.
  const programmatic = new Map<string, Array<{ candidate: ExternalSessionCandidate; opening: Opening }>>()

  for (const dirName of dirs) {
    await pause()
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
      await pause()
      const filePath = path.join(dir, fileName)
      let stat: fs.Stats
      try { stat = fs.statSync(filePath) } catch { continue }
      if (!stat.isFile() || stat.mtimeMs < cutoff || stat.size === 0) continue
      tally.scanned++

      const stamp = stampOf(stat)
      const prev = claudeVerdicts.get(filePath)
      let verdict: ClaudeVerdict
      if (prev && sameStamp(prev, stamp)) {
        verdict = prev
        verdicts.set(filePath, prev)
      } else {
        tally.parsed++
        const fresh = classifyClaude(sessionId, filePath, stat)
        verdict = { candidate: fresh.candidate, opening: fresh.opening }
        if (fresh.readable) verdicts.set(filePath, { ...stamp, ...verdict })
      }
      const candidate = verdict.candidate
      if (!candidate || isExcludedExternalCwd(candidate.cwd, excludedCwds)) continue
      if (!verdict.opening) { out.push({ ...candidate }); continue }
      const inDir = programmatic.get(dir) ?? []
      inDir.push({ candidate, opening: verdict.opening })
      programmatic.set(dir, inDir)
    }
  }
  // A programmatic session younger than the window waits a scan: workers still
  // starting would join its batch, and one imported early stays imported. The
  // rest are judged against every transcript in their dir, the ones the server
  // already tracks and the ones the window no longer reaches included, exactly
  // as describe judges them for the audit.
  const now = Date.now()
  for (const [dir, pending] of programmatic) {
    const settled = pending.filter((p) => p.opening.startMs <= now - BATCH_WINDOW_MS)
    if (settled.length === 0) continue
    const byKey = startsByKey(await dirOpenings(dir, earliestStart(settled) - BATCH_WINDOW_MS, pause))
    for (const { candidate, opening } of settled) {
      if (batchCount(opening, byKey) < BATCH_MIN_SESSIONS) out.push({ ...candidate })
    }
  }
  claudeVerdicts.clear()
  for (const [filePath, verdict] of verdicts) claudeVerdicts.set(filePath, verdict)
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
  /** Opening or reading the file failed: no verdict to remember. */
  readFailed?: boolean
}

function parseCodexHead(filePath: string, size: number): CodexHead {
  const out: CodexHead = { messageCount: 0 }
  const readable = walkHeadLines(filePath, size, (entry) => {
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
  if (!readable) out.readFailed = true
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

type RolloutFile = FileStamp & { filePath: string }

/** Every codex rollout file under ~/.codex/sessions (a bounded 3-level walk). */
async function listCodexRollouts(homeDir: string, pause: () => Promise<void>): Promise<RolloutFile[]> {
  const root = path.join(homeDir, '.codex', 'sessions')
  const files: RolloutFile[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      await pause()
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < 4) await walk(full, depth + 1)
        continue
      }
      if (!entry.name.endsWith('.jsonl')) continue
      let stat: fs.Stats
      try { stat = fs.statSync(full) } catch { continue }
      if (!stat.isFile() || stat.size === 0) continue
      files.push({ filePath: full, ...stampOf(stat) })
    }
  }
  await walk(root, 0)
  return files
}

async function scanCodex(
  homeDir: string,
  cutoff: number,
  known: Set<string>,
  excludedCwds: string[],
  out: ExternalSessionCandidate[],
  tally: ScanTally,
  pause: () => Promise<void>,
): Promise<void> {
  // Layout is <year>/<month>/<day>/rollout-*.jsonl — a bounded 3-level walk.
  const files = (await listCodexRollouts(homeDir, pause)).filter((f) => f.mtimeMs >= cutoff)
  tally.scanned += files.length

  // Resume writes a fresh rollout file per session id — newest file wins.
  const byId = new Map<string, ExternalSessionCandidate>()
  const heads = new Map<string, FileStamp & { head: CodexHead }>()
  for (const file of files) {
    await pause()
    const remembered = codexHeads.get(file.filePath)
    let head: CodexHead
    if (remembered && sameStamp(remembered, file)) {
      head = remembered.head
      heads.set(file.filePath, remembered)
    } else {
      tally.parsed++
      head = parseCodexHead(file.filePath, file.size)
      if (!head.readFailed) heads.set(file.filePath, { ...stampOf(file), head })
    }
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
  codexHeads.clear()
  for (const [filePath, entry] of heads) codexHeads.set(filePath, entry)
}

export interface DescribeExternalSessionsOptions {
  /** Provider session ids to look up (claude UUIDs and/or codex ids). */
  sessionIds: string[]
  /** Stat only: answer each id's last activity (transcript mtime) without
   *  parsing it. The idle sweep asks this before completing anything. */
  activityOnly?: boolean
  /** Test seam: override ~. */
  homeDir?: string
  /** Test seam: override the spawn journal path. */
  spawnJournal?: string
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
async function locateTranscripts(
  homeDir: string,
  ids: string[],
  pause: () => Promise<void>,
): Promise<Map<string, { engine: 'claude' | 'codex'; file: LocatedFile }>> {
  const wanted = new Set(ids)
  const found = new Map<string, { engine: 'claude' | 'codex'; file: LocatedFile }>()
  const root = path.join(homeDir, '.claude', 'projects')
  let dirs: string[] = []
  try { dirs = fs.readdirSync(root) } catch { dirs = [] }
  for (const dirName of dirs) {
    if (wanted.size === 0) break
    await pause()
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
    for (const file of await listCodexRollouts(homeDir, pause)) {
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
export async function describeExternalSessions(
  options: DescribeExternalSessionsOptions,
): Promise<{ candidates: ExternalSessionCandidate[]; activity: ExternalSessionActivity[] }> {
  const homeDir = options.homeDir ?? os.homedir()
  const ids = [...new Set(options.sessionIds.filter((id) => typeof id === 'string' && id.length > 0))].slice(0, DESCRIBE_LIMIT)
  const candidates: ExternalSessionCandidate[] = []
  const activity: ExternalSessionActivity[] = []
  if (ids.length === 0) return { candidates, activity }
  const spawned = walnutSpawnedIds(homeDir, options.spawnJournal)
  const pause = createPause()
  // Still-undecided programmatic sessions, by directory: a batch is judged
  // against the siblings in its project dir once all of them are read.
  const undecided = new Map<string, Array<{ candidate: ExternalSessionCandidate; opening: Opening }>>()
  for (const [sessionId, hit] of await locateTranscripts(homeDir, ids, pause)) {
    await pause()
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
      candidate.notExternal = spawned.has(sessionId) ? 'walnut-spawned' : (claudeNotExternal(head) ?? null)
      if (spawned.has(sessionId)) candidate.spawnedBy = spawned.get(sessionId)
      candidates.push(candidate)
      const opening = candidate.notExternal ? undefined : openingOf(head)
      if (opening) {
        const dir = path.dirname(hit.file.filePath)
        const inDir = undecided.get(dir) ?? []
        inDir.push({ candidate, opening })
        undecided.set(dir, inDir)
      }
    } else {
      const candidate = codexCandidate(sessionId, hit.file, parseCodexHead(hit.file.filePath, hit.file.size))
      candidate.notExternal = spawned.has(sessionId) ? 'walnut-spawned' : null
      if (spawned.has(sessionId)) candidate.spawnedBy = spawned.get(sessionId)
      candidates.push(candidate)
    }
  }
  for (const [dir, pending] of undecided) {
    const byKey = startsByKey(await dirOpenings(dir, earliestStart(pending) - BATCH_WINDOW_MS, pause))
    for (const { candidate, opening } of pending) {
      if (batchCount(opening, byKey) >= BATCH_MIN_SESSIONS) candidate.notExternal = 'batch'
    }
  }
  return { candidates, activity }
}

/** Openings of the transcripts in one project dir, remembered per file until
 *  it changes: an audit asks about one batch's workers over many runs. */
const dirOpeningCache = new Map<string, FileStamp & { opening?: Opening }>()
const DIR_OPENING_CACHE_MAX = 50000

/** The openings in `dir` of every transcript written since `sinceMs` (a file
 *  is last written after its session starts, so an older one cannot have
 *  started inside the window). Each read stops a few KB in. */
async function dirOpenings(dir: string, sinceMs: number, pause: () => Promise<void>): Promise<Opening[]> {
  let names: string[] = []
  try { names = fs.readdirSync(dir) } catch { return [] }
  if (dirOpeningCache.size > DIR_OPENING_CACHE_MAX) dirOpeningCache.clear()
  const out: Opening[] = []
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    await pause()
    const filePath = path.join(dir, name)
    let stat: fs.Stats
    try { stat = fs.statSync(filePath) } catch { continue }
    if (!stat.isFile() || stat.size === 0 || stat.mtimeMs < sinceMs) continue
    const stamp = stampOf(stat)
    const prev = dirOpeningCache.get(filePath)
    let opening: Opening | undefined
    if (prev && sameStamp(prev, stamp)) {
      opening = prev.opening
    } else {
      const head = parseClaudeHead(filePath, stat.size, true)
      opening = head.isSidechain ? undefined : openingOf(head)
      if (!head.readFailed) dirOpeningCache.set(filePath, { ...stamp, opening })
    }
    if (opening) out.push(opening)
  }
  return out
}

/**
 * Scan this host for sessions started outside Walnut. Pure host-local I/O —
 * safe to call from either daemon twin. It yields to the event loop as it
 * goes (see SLICE_MS), so a caller that must not overlap two scans serializes
 * them itself, as both daemon twins do.
 */
export async function scanExternalSessions(
  options: ScanExternalSessionsOptions,
): Promise<ScanExternalSessionsResult> {
  const homeDir = options.homeDir ?? os.homedir()
  const cutoff = Date.now() - Math.max(0, options.sinceMs)
  const known = new Set(options.knownSessionIds ?? [])
  for (const sid of walnutSpawnedIds(homeDir, options.spawnJournal).keys()) known.add(sid)
  const candidates: ExternalSessionCandidate[] = []

  const tally: ScanTally = { scanned: 0, parsed: 0 }
  const pause = createPause()
  await scanClaude(homeDir, cutoff, known, options.excludedCwds ?? [], candidates, tally, pause)
  await scanCodex(homeDir, cutoff, known, options.excludedCwds ?? [], candidates, tally, pause)

  candidates.sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt))
  const limit = options.limit ?? 200
  const truncated = candidates.length > limit
  return {
    candidates: truncated ? candidates.slice(0, limit) : candidates,
    scanned: tally.scanned,
    parsed: tally.parsed,
    truncated,
  }
}
