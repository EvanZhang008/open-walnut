/**
 * Session content indexer — turns parsed session history into filtered,
 * search-friendly text for the search index.
 *
 * WHY a separate module: the JSONL→text filtering is pure and noisy to get
 * right (code blocks, tool payloads, base64, size caps). Keeping it out of
 * the session serializer makes it unit-testable in isolation. (It is also the
 * natural home for a future daemon-side filter that would let remote sessions
 * be indexed without shipping their full multi-MB JSONL over the tunnel — a
 * 14MB log filters down to ~50KB. For now only local sessions are indexed.)
 *
 * Output shape (one doc per session; the indexer chunks on `## ` headings):
 *
 *   ## Turn 1 (2026-05-05 10:00)
 *   User: ...
 *   Assistant: ...
 *   Tools: Bash, Read
 *
 * The gist block and metadata are prepended by the caller
 * (src/core/search/serializers.ts), not here — this module only handles the
 * conversation body.
 */
import type { SessionHistoryMessage } from './session-history.js';

export interface IndexedSessionContent {
  /** Filtered, heading-segmented conversation body (markdown). */
  body: string;
  /** Number of turns kept (after merging user+assistant into turns). */
  turnCount: number;
  /** Byte length of the body before the size cap was applied. */
  rawBytes: number;
  /** True if oldest turns were dropped to honor maxBytes. */
  truncated: boolean;
  /**
   * Git commit SHAs this session produced (from `git commit` Bash results),
   * extracted from the FULL history — never lost to the body's tail-keep cap.
   * The one durable commit→session→task link ("which task made commit X?"
   * was un-answerable through every search path, 2026-08-15).
   */
  commitShas: string[];
}

export interface IndexOptions {
  /** Max body size in bytes; oldest turns dropped (tail-keep) past this. Default 50_000. */
  maxBytes?: number;
  /** Max chars of a single turn's text before mid-truncation. Default 4_000. */
  maxCharsPerTurn?: number;
  /** Code blocks with more lines than this are collapsed to a placeholder. Default 20. */
  codeBlockLineThreshold?: number;
}

const DEFAULTS = {
  maxBytes: 50_000,
  maxCharsPerTurn: 4_000,
  codeBlockLineThreshold: 20,
};

const CODE_BLOCK_RE = /```(\w+)?\n([\s\S]*?)```/g;
const BASE64_DATA_URI_RE = /data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g;
/** Runs of 600+ non-whitespace chars — pasted blobs, minified data, long base64. */
const LONG_BLOB_RE = /\S{600,}/g;

/** Collapse large code blocks and strip blobs from a single message's text. */
function cleanText(text: string, codeBlockLineThreshold: number): string {
  let out = text.replace(CODE_BLOCK_RE, (match, lang: string | undefined, body: string) => {
    const lines = body.split('\n').length;
    if (lines <= codeBlockLineThreshold) return match;
    return `\`\`\`${lang ?? ''}\n<code${lang ? ` lang=${lang}` : ''} ${lines} lines omitted>\n\`\`\``;
  });
  out = out.replace(BASE64_DATA_URI_RE, '<blob omitted>');
  out = out.replace(LONG_BLOB_RE, '<blob omitted>');
  return out.trim();
}

/** Tool-input keys that carry a file path across the built-in tool set
 *  (Read/Edit/Write/NotebookEdit use file_path; Glob/Grep use path). */
const PATH_INPUT_KEYS = ['file_path', 'path', 'notebook_path'] as const;

/**
 * Compact, de-duplicated, capped tool-name footer for a turn — now WITH the
 * file paths the tools touched. Tool inputs/results stay excluded from the
 * index (secrets, sheer bulk), but paths are the one input that makes a
 * session findable: "which session edited src/core/search.ts" was
 * unanswerable when only tool NAMES survived (2026-08-15 star hunt — the
 * session was only findable because prose happened to mention the file).
 * Bash contributes its command's first line, which usually embeds the paths
 * and is also how `git commit` messages become searchable text.
 */
function toolFooter(tools: SessionHistoryMessage['tools']): string {
  if (!tools || tools.length === 0) return '';
  const names: string[] = [];
  const paths: string[] = [];
  const bashHeads: string[] = [];
  for (const t of tools) {
    if (t.name && !names.includes(t.name)) names.push(t.name);
    if (paths.length < 10) {
      for (const key of PATH_INPUT_KEYS) {
        const v = t.input?.[key];
        if (typeof v === 'string' && v && !paths.includes(v)) { paths.push(v); break; }
      }
    }
    if (t.name === 'Bash' && bashHeads.length < 3) {
      const cmd = t.input?.command;
      if (typeof cmd === 'string' && cmd.trim()) {
        const head = cmd.trim().split('\n')[0].slice(0, 200);
        if (!bashHeads.includes(head)) bashHeads.push(head);
      }
    }
    if (names.length >= 10 && paths.length >= 10 && bashHeads.length >= 3) break;
  }
  const lines: string[] = [];
  if (names.length) lines.push(`Tools: ${names.join(', ')}`);
  if (paths.length) lines.push(`Files: ${paths.join(', ')}`);
  if (bashHeads.length) lines.push(`Commands: ${bashHeads.join(' | ')}`);
  return lines.join('\n');
}

/** Year-month-day hour:minute from an ISO timestamp; empty string if unparseable. */
function shortTimestamp(iso: string | undefined): string {
  if (!iso) return '';
  // ISO 8601 prefix "2026-05-05T10:00:..." → "2026-05-05 10:00"
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]}` : '';
}

function truncateTurn(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n... [truncated]';
}

/**
 * Commit SHAs from git Bash tool results. Three shapes cover the real
 * transcripts (each verified against actual session JSONLs):
 *  1. porcelain "[branch abc1234] subject" from `git commit` itself;
 *  2. `git log --oneline -1` — the standard "confirm the commit landed" probe
 *     (needed when the commit's own output was redirected to a file, which is
 *     exactly how the a00ee84c star-removal commit escaped shape 1);
 *  3. `git rev-parse [--short] HEAD` — a bare hex line.
 * Only 7-40 hex, word-bounded; `git log` without an explicit `-1` is history
 * BROWSING, not confirmation — extracting it would falsely link other
 * sessions' commits, so it is deliberately skipped.
 */
const COMMIT_RESULT_RE = /\[[^\[\]\n]+ ([0-9a-f]{7,40})\]/g;
const ONELINE_HEAD_RE = /^([0-9a-f]{7,40})(?:\s|$)/;
const GIT_LOG_SEGMENT_RE = /git\s+log\b([^|;&]*)/g;
const GIT_REV_PARSE_RE = /git\s+rev-parse\s+(?:--short(?:=\d+)?\s+)?HEAD\b/;

/** True when the command contains a `git log --oneline` limited to ONE entry
 *  (flag order agnostic). Multi-entry `git log` is history browsing — its SHAs
 *  are other commits, not this session's. */
function isSingleCommitLogProbe(command: string): boolean {
  for (const m of command.matchAll(GIT_LOG_SEGMENT_RE)) {
    const args = m[1];
    if (/--oneline\b/.test(args) && /(?:^|\s)-(?:1|n\s*1)(?:\s|$)/.test(args)) return true;
  }
  return false;
}

/** Extract commit SHAs a session created, from its tool calls. */
export function extractCommitShas(messages: SessionHistoryMessage[]): string[] {
  const shas: string[] = [];
  const seen = new Set<string>();
  const add = (sha: string) => { if (!seen.has(sha)) { seen.add(sha); shas.push(sha); } };
  for (const msg of messages) {
    for (const tool of msg.tools ?? []) {
      if (tool.name !== 'Bash' || tool.isError) continue;
      const input = typeof tool.input?.command === 'string' ? tool.input.command : '';
      const result = tool.result ?? '';
      if (/git\s+commit/.test(input)) {
        for (const m of result.matchAll(COMMIT_RESULT_RE)) add(m[1]);
      }
      if (isSingleCommitLogProbe(input) || GIT_REV_PARSE_RE.test(input)) {
        for (const line of result.split('\n')) {
          const m = ONELINE_HEAD_RE.exec(line.trim());
          if (m) add(m[1]);
        }
      }
    }
  }
  return shas;
}

/**
 * Build the filtered conversation body from parsed session history.
 * Drops thinking, tool inputs, and tool results (kept only as a tool-name
 * footer). Collapses big code blocks, strips blobs, and caps total size by
 * dropping the OLDEST turns (recent conversation is most relevant).
 *
 * Commit SHAs are extracted from the FULL history BEFORE the size cap, so a
 * commit made early in a long session survives even when its turn is dropped
 * from the body.
 */
export function buildIndexedContent(
  messages: SessionHistoryMessage[],
  options?: IndexOptions,
): IndexedSessionContent {
  const maxBytes = options?.maxBytes ?? DEFAULTS.maxBytes;
  const maxCharsPerTurn = options?.maxCharsPerTurn ?? DEFAULTS.maxCharsPerTurn;
  const codeBlockLineThreshold = options?.codeBlockLineThreshold ?? DEFAULTS.codeBlockLineThreshold;

  const commitShas = extractCommitShas(messages);

  const blocks: string[] = [];
  let turnIndex = 0;

  for (const msg of messages) {
    const role = msg.role === 'assistant' ? 'Assistant' : 'User';
    const cleaned = msg.text ? cleanText(msg.text, codeBlockLineThreshold) : '';
    const footer = toolFooter(msg.tools);

    // Skip turns with neither visible text nor tool activity.
    if (!cleaned && !footer) continue;

    turnIndex++;
    const ts = shortTimestamp(msg.timestamp);
    const lines: string[] = [`## Turn ${turnIndex}${ts ? ` (${ts})` : ''}`];
    if (cleaned) lines.push(`${role}: ${truncateTurn(cleaned, maxCharsPerTurn)}`);
    if (footer) lines.push(footer);
    blocks.push(lines.join('\n'));
  }

  let body = blocks.join('\n\n');
  const rawBytes = Buffer.byteLength(body);
  let truncated = false;

  if (rawBytes > maxBytes) {
    // Tail-keep: drop oldest turns until under cap. Recompute size each step
    // since multi-byte chars make char-count an unreliable proxy for bytes.
    while (blocks.length > 1 && Buffer.byteLength(blocks.join('\n\n')) > maxBytes) {
      blocks.shift();
    }
    body = '[...earlier turns omitted]\n\n' + blocks.join('\n\n');
    truncated = true;
  }

  return { body, turnCount: turnIndex, rawBytes, truncated, commitShas };
}
