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
 *     entrypoint field alone separates "a human ran claude" from "Walnut ran
 *     claude" — no allowlist of pids or dirs needed. Title: the CLI's own
 *     `ai-title` line when present (it writes one per session), else the first
 *     user message.
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
}

export interface ScanExternalSessionsOptions {
  /** Only consider transcripts written within this window. */
  sinceMs: number
  /** Session ids the server already tracks — skipped without being parsed. */
  knownSessionIds?: string[]
  /** Cap on returned candidates (newest first). Guards a pathological host. */
  limit?: number
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

/** Temp/test locations whose programmatic sessions are throwaway debris. */
function isTempCwd(cwd: string | undefined): boolean {
  if (!cwd) return true // no cwd recorded → can't place it → not worth a task
  if (cwd === '/tmp' || cwd === '/private/tmp') return true
  if (cwd.startsWith('/tmp/') || cwd.startsWith('/private/tmp/')) return true
  if (cwd.startsWith('/var/folders/') || cwd.startsWith('/private/var/folders/')) return true
  if (cwd.includes('walnut-test-') || cwd.includes('open-walnut-test')) return true
  return false
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
/** Bytes read from the tail when hunting for the newest ai-title line. */
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

/**
 * Text of a message payload, whatever shape it takes (string, content array,
 * nested content string). Both engines nest differently and both shapes have
 * changed across CLI versions, so this is deliberately permissive.
 */
function messageText(message: unknown): string | undefined {
  if (typeof message === 'string') return message
  if (!message || typeof message !== 'object') return undefined
  const m = message as Record<string, unknown>
  if (typeof m.content === 'string') return m.content
  if (Array.isArray(m.content)) {
    for (const part of m.content) {
      if (part && typeof part === 'object') {
        const p = part as Record<string, unknown>
        if (typeof p.text === 'string' && p.text.trim()) return p.text
      }
    }
  }
  if (typeof m.text === 'string') return m.text
  return undefined
}

/**
 * True for the synthetic preambles both CLIs inject ahead of the human's real
 * first words (AGENTS.md/CLAUDE.md dumps, slash-command envelopes, resume
 * caveats). Titling a session with one of these produces 200 identical rows.
 */
function isPreamble(text: string): boolean {
  const t = text.trimStart()
  return (
    t.startsWith('# AGENTS.md') ||
    t.startsWith('# CLAUDE.md') ||
    t.startsWith('<local-command') ||
    t.startsWith('<command-message') ||
    t.startsWith('<command-name') ||
    t.startsWith('Caveat:') ||
    t.startsWith('<system-reminder')
  )
}

interface ClaudeHead {
  entrypoint?: string
  cwd?: string
  startedAt?: string
  firstUserText?: string
  messageCount: number
  isSidechain: boolean
}

function parseClaudeHead(filePath: string, size: number): ClaudeHead {
  const out: ClaudeHead = { messageCount: 0, isSidechain: false }
  walkHeadLines(filePath, size, (entry) => {
    const type = entry.type
    if (!out.startedAt && typeof entry.timestamp === 'string') out.startedAt = entry.timestamp
    if (!out.cwd && typeof entry.cwd === 'string') out.cwd = entry.cwd
    if (type === 'user' || type === 'assistant') out.messageCount++
    if (type === 'user' && !out.entrypoint) {
      out.entrypoint = typeof entry.entrypoint === 'string' ? entry.entrypoint : 'unknown'
      if (entry.isSidechain === true) out.isSidechain = true
      // A non-human entrypoint (Walnut's own sdk-cli) is rejected outright, so
      // stop immediately — this is the 97%-of-files case.
      if (!HUMAN_CLAUDE_ENTRYPOINTS.has(out.entrypoint)) return true
    }
    if (type === 'user' && !out.firstUserText) {
      const text = messageText(entry.message)
      if (text && !isPreamble(text)) out.firstUserText = text
    }
    // No "all fields found" early exit: a claude user line carries entrypoint +
    // cwd + message all at once, so exiting there would report messageCount=1
    // for a 200-message session. Accepted files read to the head budget, which
    // makes the count exact for normal transcripts and a lower bound for huge
    // ones (it is display-only either way).
    return false
  })
  return out
}

/** Newest `ai-title` in the tail chunk — the CLI's own session title. */
function findAiTitle(text: string): string | undefined {
  let found: string | undefined
  for (const line of text.split('\n')) {
    if (!line.includes('"ai-title"')) continue
    try {
      const entry = JSON.parse(line) as Record<string, unknown>
      if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string' && entry.aiTitle.trim()) {
        found = entry.aiTitle
      }
    } catch { /* partial first line of the chunk — skip */ }
  }
  return found
}

function scanClaude(
  homeDir: string,
  cutoff: number,
  known: Set<string>,
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
      if (head.isSidechain) continue
      const isHuman = HUMAN_CLAUDE_ENTRYPOINTS.has(head.entrypoint)
      // Programmatic (other SDK apps, e.g. an investigation orchestrator):
      // only with a real working directory — temp-dir ones are test debris.
      const isProgram = PROGRAMMATIC_CLAUDE_ENTRYPOINTS.has(head.entrypoint) && !isTempCwd(head.cwd)
      if (!isHuman && !isProgram) continue

      const aiTitle = findAiTitle(readChunk(filePath, stat.size, TAIL_BYTES, true))
      out.push({
        sessionId,
        engine: 'claude',
        cwd: head.cwd,
        title: toTitle(aiTitle) ?? toTitle(head.firstUserText),
        origin: head.entrypoint,
        startedAt: head.startedAt,
        lastActiveAt: new Date(stat.mtimeMs).toISOString(),
        messageCount: head.messageCount,
        transcriptPath: filePath,
      })
    }
  }
  return scanned
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
        if (text && !isPreamble(text)) out.firstUserText = text
      }
      return false
    }
    if (entry.type === 'response_item' && payload.role === 'user' && !out.firstUserText) {
      const text = messageText(payload)
      if (text && !isPreamble(text)) out.firstUserText = text
    }
    return false
  })
  return out
}

function scanCodex(
  homeDir: string,
  cutoff: number,
  known: Set<string>,
  out: ExternalSessionCandidate[],
): number {
  const root = path.join(homeDir, '.codex', 'sessions')
  const files: Array<{ filePath: string; size: number; mtimeMs: number }> = []
  // Layout is <year>/<month>/<day>/rollout-*.jsonl — a bounded 3-level walk.
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
      if (!stat.isFile() || stat.mtimeMs < cutoff || stat.size === 0) continue
      files.push({ filePath: full, size: stat.size, mtimeMs: stat.mtimeMs })
    }
  }
  walk(root, 0)

  // Resume writes a fresh rollout file per session id — newest file wins.
  const byId = new Map<string, ExternalSessionCandidate>()
  for (const file of files) {
    const head = parseCodexHead(file.filePath, file.size)
    if (!head.sessionId || !head.originator) continue
    if (!HUMAN_CODEX_ORIGINATORS.has(head.originator)) continue
    if (known.has(head.sessionId)) continue
    const candidate: ExternalSessionCandidate = {
      sessionId: head.sessionId,
      engine: 'codex',
      cwd: head.cwd,
      title: toTitle(head.firstUserText),
      origin: head.originator,
      startedAt: head.startedAt,
      lastActiveAt: new Date(file.mtimeMs).toISOString(),
      messageCount: head.messageCount,
      transcriptPath: file.filePath,
    }
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
  scanned += scanClaude(homeDir, cutoff, known, candidates)
  scanned += scanCodex(homeDir, cutoff, known, candidates)

  candidates.sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt))
  const limit = options.limit ?? 200
  const truncated = candidates.length > limit
  return { candidates: truncated ? candidates.slice(0, limit) : candidates, scanned, truncated }
}
