/**
 * Walnut → hybrid-search adapter: serialize walnut entities into the library's
 * generic Doc shape. This is the ONLY layer that knows both walnut types and
 * the search core; the core never imports walnut code (boundary-tested).
 *
 * Field mapping philosophy (drives scoring — title 10x, summary 3x, meta 2x,
 * note 1x): the title column gets the human-named handle, summary gets curated
 * prose (descriptions, gists, plans), note gets the long body (task notes,
 * conversation transcripts, markdown bodies), meta gets project/tags/host.
 *
 * Junk filtering happens HERE (isJunkTask / isLaneSession), for the same
 * reasons the QMD sync filtered: test debris outranks real work on short
 * queries, and lane transcripts talk ABOUT every topic and shove the session
 * that did the work off the first page.
 */

import path from 'node:path';
import type { Doc } from '../../lib/hybrid-search/index.js';
import type { SessionRecord, Task } from '../types.js';
import { isLedgerJunk } from '../task-junk.js';
import { isLaneSession } from '../session-tracker.js';
import { parseFrontmatter } from '../parse-frontmatter.js';

/** Bump when any serializer changes shape: it salts every doc's content hash
 *  (via the meta field), so the next sync re-feeds everything. */
const DOC_FORMAT_VERSION = 'v1';

function toEpochMs(iso: string | undefined, fallback: number): number {
  if (!iso) return fallback;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : fallback;
}

function joinParts(parts: Array<string | undefined | null>): string {
  return parts.filter((p): p is string => Boolean(p && p.trim())).join('\n\n');
}

/** Task → Doc. Returns null for junk/test tasks (they must not enter).
 *
 *  Uses the STRICTER isLedgerJunk (probe-title heuristic included), unlike
 *  the old QMD sync which stopped at project-level rules: echo-test probes
 *  live in Inbox with no project and kept leaking into ranked results (golden
 *  junk family failed on both engines). "An exact hit must stay findable"
 *  still holds — the reference lane resolves task IDs from tasks.json, not
 *  from this index. */
export function taskToDoc(task: Task): Doc | null {
  if (isLedgerJunk(task)) return null;
  const identifiers = [
    task.id,
    task.session_id,
    ...(task.session_ids ?? []),
    task.plan_session_id,
    task.exec_session_id,
    task.external_url,
  ].filter((v): v is string => Boolean(v));
  return {
    kind: 'task',
    ref: task.id,
    title: task.title ?? '',
    summary: joinParts([task.description, task.summary]),
    note: joinParts([task.note, task.conversation_log]),
    meta: joinParts([
      `Project: ${task.project || 'Inbox'}`,
      task.tags?.length ? `Tags: ${task.tags.join(', ')}` : undefined,
      DOC_FORMAT_VERSION,
    ]),
    updatedAt: toEpochMs(task.updated_at ?? task.created_at, 0),
    identifiers: [...new Set(identifiers)],
  };
}

export interface SessionDocInput {
  session: SessionRecord;
  /** Linked task, when resolvable — enriches summary so semantic search finds
   *  sessions by task content too. */
  task?: Task;
  /** Cleaned conversation body (≤50KB, from buildIndexedContent). null/undefined
   *  = metadata-only doc. */
  body?: string | null;
  /** Commit SHAs extracted from the full history. */
  commitShas?: string[];
}

/** Session → Doc. Returns null for chat-lane sessions (never indexed) and
 *  for sessions spawned by junk/probe tasks (same title heuristic as tasks —
 *  the probe SESSION leaked into results right beside the probe task). */
export function sessionToDoc(input: SessionDocInput): Doc | null {
  const { session, task } = input;
  if (isLaneSession(session)) return null;
  if (isLedgerJunk({ project: session.project, title: session.title ?? '' })) return null;
  const identifiers = [
    session.claudeSessionId,
    ...(input.commitShas ?? session.commitShas ?? []),
  ].filter((v): v is string => Boolean(v));
  return {
    kind: 'session',
    ref: session.claudeSessionId,
    title: session.title ?? '',
    summary: joinParts([
      session.summary,
      session.description,
      session.planContent,
      task?.summary,
      task?.description,
    ]),
    note: input.body ?? '',
    meta: joinParts([
      session.project ? `Project: ${session.project}` : undefined,
      session.cwd ? `CWD: ${session.cwd}` : undefined,
      session.host ? `Host: ${session.host}` : undefined,
      DOC_FORMAT_VERSION,
    ]),
    updatedAt: toEpochMs(session.lastActiveAt ?? session.startedAt, 0),
    identifiers: [...new Set(identifiers)],
  };
}

/**
 * Markdown file → Doc, for the file-backed kinds: 'memory' (memory/ tree),
 * 'note' (notes vault), 'skill' (skills tree). `ref` is the absolute path —
 * the same handle the old QMD lanes exposed, and what agents Read directly.
 */
export function markdownToDoc(
  kind: 'memory' | 'note' | 'skill',
  absPath: string,
  raw: string,
  mtimeMs: number,
): Doc {
  const parsed = parseFrontmatter(raw);
  const frontTitle = typeof parsed.data.title === 'string' ? parsed.data.title.trim() : '';
  const frontDescription =
    typeof parsed.data.description === 'string' ? parsed.data.description.trim() : '';
  const h1 = parsed.body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const tags = Array.isArray(parsed.data.tags)
    ? parsed.data.tags.filter((t): t is string => typeof t === 'string')
    : [];
  return {
    kind,
    ref: absPath,
    title: frontTitle || h1 || path.basename(absPath, '.md'),
    summary: frontDescription,
    note: parsed.body,
    meta: joinParts([
      tags.length ? `Tags: ${tags.join(', ')}` : undefined,
      DOC_FORMAT_VERSION,
    ]),
    updatedAt: mtimeMs,
  };
}
