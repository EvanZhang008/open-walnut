/**
 * Conversation history store — SQLite FTS5 over every butler conversation.
 *
 * SCOPE: conversations ONLY (chat-history entries across all agents). Project
 * history / skill support files are md searched via QMD (memory-search.ts) —
 * they never enter this db. Claude Code sessions are excluded too: they keep
 * their own JSONL transcripts.
 *
 * The db is a DERIVED index of conversations/*.json (source of truth) — safe
 * to delete; it rebuilds from disk. Live inserts happen at the chat-history
 * persist points (addAIMessages / addUserMessage), best-effort: a failure
 * here must never break chat persistence.
 *
 * Search semantics (Hermes session_search parity):
 * - discovery: FTS5 BM25, best hit per conversation, subagent/triage HIDDEN
 *   by default, cron DEMOTED (ranked after chat, never excluded — hiding it
 *   causes recall blindness for "what did the tracker log last week").
 * - scroll: ±window messages around a hit, by conversation.
 * - browse: recent conversations, no query.
 *
 * CJK: the trigram tokenizer needs 3+ chars per term; 2-char CJK queries
 * (e.g. 放弃) fall back to a LIKE scan — verified behavior, not a guess.
 */
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { MEMORY_DIR, CONVERSATIONS_DIR } from '../constants.js';
import { log } from '../logging/index.js';

const DB_FILENAME = 'history.db';

/** Message sources hidden from discovery unless include_hidden (machine chatter). */
const HIDDEN_SOURCES = new Set(['subagent', 'triage']);
/** Sources demoted below normal chat in discovery ranking (but never excluded). */
const DEMOTED_SOURCES = new Set(['cron', 'heartbeat']);

/** Cap per-row content so a pathological blob can't bloat the index. */
const MAX_CONTENT_CHARS = 32_000;

export interface HistoryMessage {
  id: number;
  agentId: string;
  conversationId: string;
  role: 'user' | 'assistant';
  source: string;
  content: string;
  ts: string;
}

export interface HistorySearchHit extends HistoryMessage {
  snippet: string;
}

let db: DatabaseType | null = null;
let dbPath: string | null = null;

function currentDbPath(): string {
  return path.join(MEMORY_DIR, DB_FILENAME);
}

export function getHistoryDb(): DatabaseType {
  // Re-open when WALNUT_HOME changed (tests swap it via mocked constants).
  const p = currentDbPath();
  if (db && dbPath === p) return db;
  if (db) { try { db.close(); } catch { /* ignore */ } db = null; }

  fs.mkdirSync(path.dirname(p), { recursive: true });
  db = new Database(p);
  dbPath = p;
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      source TEXT NOT NULL DEFAULT 'chat',
      content TEXT NOT NULL,
      ts TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(agent_id, conversation_id, id);
    CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      content='messages',
      content_rowid='id',
      tokenize='trigram'
    );

    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
    END;
  `);
  return db;
}

/** Close the singleton (tests / shutdown). */
export function closeHistoryDb(): void {
  if (db) { try { db.close(); } catch { /* ignore */ } }
  db = null;
  dbPath = null;
}

// ── Text extraction ──

/**
 * Extract indexable text from a ChatEntry-shaped record.
 * - user rows prefer displayText (the actual typed message — model-facing
 *   content carries injected context prefixes that would poison search).
 * - only `text` blocks are indexed; thinking/tool_use/tool_result/image are
 *   machine payload, not conversation.
 */
export function extractEntryText(entry: {
  role: string;
  content: unknown;
  displayText?: string;
}): string {
  if (entry.role === 'user' && entry.displayText) return entry.displayText.trim();
  const c = entry.content;
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) {
    return c
      .filter((b): b is { type: string; text: string } =>
        !!b && typeof b === 'object' && (b as { type?: string }).type === 'text'
        && typeof (b as { text?: unknown }).text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim();
  }
  return '';
}

// ── Writing ──

export interface InsertMessageInput {
  agentId?: string;
  conversationId?: string;
  role: 'user' | 'assistant';
  source?: string;
  content: string;
  ts?: string;
}

/**
 * Insert one message. Best-effort by contract: callers on the chat persist
 * path wrap this in try/catch — never let index failures break chat.
 */
export function insertHistoryMessage(input: InsertMessageInput): void {
  const text = input.content.trim();
  if (!text) return;
  getHistoryDb()
    .prepare(
      `INSERT INTO messages (agent_id, conversation_id, role, source, content, ts)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.agentId || 'general',
      input.conversationId || 'legacy',
      input.role,
      input.source || 'chat',
      text.slice(0, MAX_CONTENT_CHARS),
      input.ts || new Date().toISOString(),
    );
}

/** Chat-history hook: index the ai-tagged entries just persisted. Never throws. */
export function indexChatEntries(
  entries: Array<{ tag: string; role: string; content: unknown; displayText?: string; source?: string; timestamp: string }>,
  agentId?: string,
  conversationId?: string,
): void {
  try {
    const d = getHistoryDb();
    const insert = d.prepare(
      `INSERT INTO messages (agent_id, conversation_id, role, source, content, ts)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const tx = d.transaction(() => {
      for (const e of entries) {
        if (e.tag !== 'ai') continue;
        if (e.role !== 'user' && e.role !== 'assistant') continue;
        const text = extractEntryText(e);
        if (!text) continue;
        insert.run(
          agentId || 'general',
          conversationId || 'legacy',
          e.role,
          e.source || 'chat',
          text.slice(0, MAX_CONTENT_CHARS),
          e.timestamp,
        );
      }
    });
    tx();
  } catch (err) {
    log.agent.warn('history-db: index insert failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Remove a deleted conversation's rows (privacy: delete means delete). */
export function deleteConversationHistory(agentId: string, conversationId: string): void {
  try {
    getHistoryDb()
      .prepare('DELETE FROM messages WHERE agent_id = ? AND conversation_id = ?')
      .run(agentId, conversationId);
  } catch (err) {
    log.agent.warn('history-db: delete failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Rebuild from source of truth ──

/**
 * Full rebuild from conversations/*.json. Wipes and re-reads everything —
 * the db is a derived index, so this is always safe.
 */
export async function rebuildHistoryDb(): Promise<{ conversations: number; messages: number }> {
  const d = getHistoryDb();
  d.exec('DELETE FROM messages;');
  let conversations = 0;
  let messages = 0;

  let agents: string[] = [];
  try {
    agents = (await fsp.readdir(CONVERSATIONS_DIR, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return { conversations, messages }; // no conversations dir yet
  }

  for (const agentId of agents) {
    const dir = path.join(CONVERSATIONS_DIR, agentId);
    let files: string[] = [];
    try {
      files = (await fsp.readdir(dir)).filter((f) => f.startsWith('conv-') && f.endsWith('.json'));
    } catch { continue; }

    for (const file of files) {
      const conversationId = file.slice('conv-'.length, -'.json'.length);
      try {
        const raw = JSON.parse(await fsp.readFile(path.join(dir, file), 'utf8')) as {
          entries?: Array<{ tag: string; role: string; content: unknown; displayText?: string; source?: string; timestamp: string }>;
        };
        const entries = raw.entries ?? [];
        if (entries.length === 0) continue;
        indexChatEntries(entries, agentId, conversationId);
        conversations++;
        messages += entries.filter((e) => e.tag === 'ai').length;
      } catch (err) {
        log.agent.warn('history-db: rebuild skipped unreadable conversation', {
          file, error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  log.agent.info('history-db: rebuild complete', { conversations, messages });
  return { conversations, messages };
}

/** Backfill on first use: if the table is empty but conversations exist on disk. */
export async function ensureHistoryDbPopulated(): Promise<void> {
  try {
    const row = getHistoryDb().prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number };
    if (row.n === 0) await rebuildHistoryDb();
  } catch (err) {
    log.agent.warn('history-db: populate check failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Searching ──

export interface HistorySearchOptions {
  agentId?: string;
  /** Include subagent/triage machine chatter. Default false. */
  includeHidden?: boolean;
  /** ISO timestamp lower/upper bounds (inclusive). */
  after?: string;
  before?: string;
  limit?: number;
}

/** Escape a user query for FTS5 MATCH: each whitespace token → quoted phrase (AND). */
function toFtsQuery(query: string): string {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
}

/** Trigram needs 3+ chars per token; find tokens that can never match. */
function shortTokens(query: string): string[] {
  return query.split(/\s+/).filter((t) => t.length > 0 && t.length < 3);
}

function buildFilters(opts: HistorySearchOptions, params: unknown[], alias = 'm'): string {
  let sql = '';
  if (opts.agentId) { sql += ` AND ${alias}.agent_id = ?`; params.push(opts.agentId); }
  if (!opts.includeHidden) {
    sql += ` AND ${alias}.source NOT IN (${[...HIDDEN_SOURCES].map(() => '?').join(',')})`;
    params.push(...HIDDEN_SOURCES);
  }
  if (opts.after) { sql += ` AND ${alias}.ts >= ?`; params.push(opts.after); }
  if (opts.before) { sql += ` AND ${alias}.ts <= ?`; params.push(opts.before); }
  return sql;
}

function rowToMessage(r: Record<string, unknown>): HistoryMessage {
  return {
    id: r.id as number,
    agentId: r.agent_id as string,
    conversationId: r.conversation_id as string,
    role: r.role as 'user' | 'assistant',
    source: r.source as string,
    content: r.content as string,
    ts: r.ts as string,
  };
}

function makeSnippet(content: string, query: string): string {
  const terms = query.split(/\s+/).filter(Boolean);
  const lower = content.toLowerCase();
  let idx = -1;
  for (const t of terms) {
    idx = lower.indexOf(t.toLowerCase());
    if (idx >= 0) break;
  }
  if (idx < 0) idx = 0;
  const start = Math.max(0, idx - 80);
  const end = Math.min(content.length, idx + 200);
  return `${start > 0 ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}`;
}

/**
 * Discovery: BM25 over all messages, deduped to the best hit per conversation.
 * Demoted sources (cron) rank after everything else regardless of BM25 score.
 * Falls back to LIKE when the query contains sub-trigram tokens (2-char CJK).
 */
export function searchHistory(query: string, opts: HistorySearchOptions = {}): HistorySearchHit[] {
  const q = query.trim();
  if (!q) return [];
  const d = getHistoryDb();
  const limit = opts.limit ?? 5;

  type Raw = Record<string, unknown> & { rank?: number };
  let rows: Raw[] = [];

  const useLike = shortTokens(q).length > 0;
  if (!useLike) {
    const params: unknown[] = [toFtsQuery(q)];
    const filters = buildFilters(opts, params);
    try {
      rows = d.prepare(
        `SELECT m.*, f.rank AS rank
         FROM messages_fts f JOIN messages m ON m.id = f.rowid
         WHERE messages_fts MATCH ?${filters}
         ORDER BY f.rank
         LIMIT 200`,
      ).all(...params) as Raw[];
    } catch (err) {
      log.agent.warn('history-db: FTS query failed, falling back to LIKE', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (rows.length === 0) {
    // LIKE fallback: sub-trigram CJK terms, or FTS syntax edge cases.
    // AND across tokens, newest first (no relevance rank available).
    const tokens = q.split(/\s+/).filter(Boolean);
    const params: unknown[] = tokens.map((t) => `%${t}%`);
    const likeClauses = tokens.map(() => 'm.content LIKE ?').join(' AND ');
    const filters = buildFilters(opts, params);
    rows = d.prepare(
      `SELECT m.* FROM messages m
       WHERE ${likeClauses}${filters}
       ORDER BY m.ts DESC
       LIMIT 200`,
    ).all(...params) as Raw[];
  }

  // Dedup: best (first-seen, since rows are rank-ordered) hit per conversation.
  const byConv = new Map<string, Raw>();
  for (const r of rows) {
    const key = `${r.agent_id}:${r.conversation_id}`;
    if (!byConv.has(key)) byConv.set(key, r);
  }

  const hits = [...byConv.values()].map((r) => ({
    ...rowToMessage(r),
    snippet: makeSnippet(r.content as string, q),
  }));

  // Demote cron/heartbeat below organic chat, preserve relative order otherwise.
  const tier = (h: HistorySearchHit) => (DEMOTED_SOURCES.has(h.source) ? 1 : 0);
  hits.sort((a, b) => tier(a) - tier(b));

  return hits.slice(0, limit);
}

/** Scroll: the ±window messages around one message in its conversation. */
export function scrollHistory(
  agentId: string,
  conversationId: string,
  aroundMessageId: number,
  window = 6,
): HistoryMessage[] {
  const d = getHistoryDb();
  const rows = d.prepare(
    `SELECT * FROM messages
     WHERE agent_id = ? AND conversation_id = ? AND id BETWEEN ? AND ?
     ORDER BY id`,
  ).all(agentId, conversationId, aroundMessageId - window, aroundMessageId + window) as Record<string, unknown>[];
  return rows.map(rowToMessage);
}

export interface RecentConversation {
  agentId: string;
  conversationId: string;
  lastTs: string;
  messageCount: number;
  lastSnippet: string;
}

/** Browse: recent conversations, newest activity first. */
export function browseHistory(opts: HistorySearchOptions = {}): RecentConversation[] {
  const d = getHistoryDb();
  const limit = opts.limit ?? 10;
  const params: unknown[] = [];
  const filters = buildFilters(opts, params).replace(/^ AND /, '');
  const where = filters ? `WHERE ${filters}` : '';
  const rows = d.prepare(
    `SELECT m.agent_id, m.conversation_id,
            MAX(m.ts) AS last_ts, COUNT(*) AS n,
            (SELECT content FROM messages m2
              WHERE m2.agent_id = m.agent_id AND m2.conversation_id = m.conversation_id
              ORDER BY m2.id DESC LIMIT 1) AS last_content
     FROM messages m
     ${where}
     GROUP BY m.agent_id, m.conversation_id
     ORDER BY last_ts DESC
     LIMIT ?`,
  ).all(...params, limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    agentId: r.agent_id as string,
    conversationId: r.conversation_id as string,
    lastTs: r.last_ts as string,
    messageCount: r.n as number,
    lastSnippet: ((r.last_content as string) ?? '').slice(0, 200),
  }));
}
