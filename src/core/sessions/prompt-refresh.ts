/**
 * A cold resume replays the prompt the session was spawned with, byte for byte, so the
 * prompt cache of the conversation behind it still reads (types.ts appliedAppendSystemPrompt).
 * When that cache has expired the replay buys nothing (the whole prefix is written again
 * either way), so a stored prompt that lacks any of the current default instructions is
 * replaced by the current one. A warm cache is never given up for it: writing a large
 * conversation again costs far more than the notice the old prompt needs.
 *
 * Why (2026-11-06, the org reflection): every compaction restates what the stored prompt
 * lacks (the post-compaction hook, then the instruction notice in front of the next message,
 * instruction-notice.ts). A VP spawned 2026-10-24 on a 3 KB prompt got 28 KB of it after each
 * compaction, about a fifth of everything it read in 12 hours, and its session never started
 * on a newer prompt. After a refresh the session holds the current words and is told only
 * what changes from then on (the notice and place bookkeeping key on the prompt's hash).
 */
import type { SessionRecord, Task } from '../types.js';
import { isAcpEngine, resolveEngine } from '../agents/engine-registry.js';
import { WALNUT_PROMPT_MARK, defaultInstructions } from './session-context.js';
import { dueChanges, parseInstructions, renderDue } from './instruction-diff.js';
import { currentUserProfile } from './user-profile-context.js';
import { isCompanion, isFollower } from '../server-role.js';

/** How the session start joins a caller's own prompt and Walnut's (claude-code-session.ts handleStart). */
export const TASK_CONTEXT_JOIN = '\n\n---\n\n## Task Context\n\n';
/** The spawn argv's prompt cap (claude-code-session.ts): a larger prompt is never stored, so never replayed. */
const PROMPT_MAX_BYTES = 65_536;

export type RefreshRecord = Pick<SessionRecord, 'appliedAppendSystemPrompt' | 'engine'> & Partial<Pick<SessionRecord, 'taskId' | 'lane' | 'promptCache'>>;
/** The longest prompt cache lifetime there is: no entry of the last request outlives it. */
const MAX_CACHE_TTL_MS = 3_600_000;

/**
 * The replay would read nothing back: the session's prompt cache has expired, and its last request
 * is older than the longest lifetime (a request that wrote some 5-minute entries reads as 5 minutes,
 * while its 1-hour ones, the prompt among them, still hold). The facts are stored at every turn's
 * result, an errored or cut-off one included (idle-compaction.ts); only a turn the process died in
 * leaves them older than its requests, and that costs one rewrite.
 */
export function replayBuysNothing(facts: SessionRecord['promptCache'], now = Date.now()): boolean {
  if (!facts?.expiresAt || Date.parse(facts.expiresAt) > now) return false;
  return Date.parse(facts.requestAt) + MAX_CACHE_TTL_MS <= now;
}

/** Bytes of the instruction notice the stored prompt needs to read as the current default instructions. */
export function promptDebtBytes(record: Pick<SessionRecord, 'appliedAppendSystemPrompt'>, task: Parameters<typeof defaultInstructions>[0]): number {
  const prompt = record.appliedAppendSystemPrompt;
  if (!prompt?.includes(WALNUT_PROMPT_MARK)) return 0;
  // USER.md lines past its budget are still in force: not a difference (as instruction-notice.ts dueFor).
  const cut = currentUserProfile().cut;
  const due = dueChanges(parseInstructions(defaultInstructions(task)), parseInstructions(prompt), new Set(), {}, cut?.length ? { 'user-profile': new Set(cut) } : {});
  return due ? Buffer.byteLength(renderDue(due), 'utf8') : 0;
}

/** True when the next spawn of this session should run on the current prompt (sync). */
export function refreshOnResume(record: RefreshRecord, task: Parameters<typeof defaultInstructions>[0], now = Date.now()): boolean {
  if (process.env.WALNUT_PROMPT_REFRESH === '0') return false;
  if (!record.taskId || record.lane || isAcpEngine(resolveEngine(record.engine))) return false;
  if (!replayBuysNothing(record.promptCache, now)) return false;
  // A replica builds a thinner prompt (no Reply language, no fleet line): the Mac's stays.
  if (isCompanion() || isFollower()) return false;
  return promptDebtBytes(record, task) > 0;
}

/**
 * The prompt a cold resume of this session should run on: the current one when
 * refreshOnResume says so, else null (replay the stored one). Only a prompt Walnut
 * built is rebuilt: Walnut's alone, or a caller's own prompt followed by Walnut's.
 */
export async function freshResumePrompt(record: RefreshRecord & Partial<Pick<SessionRecord, 'cwd' | 'host'>>, now = Date.now()): Promise<string | null> {
  const stored = record.appliedAppendSystemPrompt;
  if (!stored || !record.taskId || process.env.WALNUT_PROMPT_REFRESH === '0') return null;
  // The cheap facts first: most resumes replay, and this runs before each of their spawns.
  if (record.lane || isAcpEngine(resolveEngine(record.engine)) || !replayBuysNothing(record.promptCache, now)) return null;
  const join = stored.indexOf(TASK_CONTEXT_JOIN);
  const callerPrompt = join >= 0 ? stored.slice(0, join) : null;
  if (callerPrompt === null && !stored.startsWith(WALNUT_PROMPT_MARK)) return null;
  const { listTasksByIds } = await import('../task-manager.js');
  const [task] = await listTasksByIds([record.taskId]) as Task[];
  if (!task) return null;
  // The default instructions read the user's profile and Reply language from their copies: read them now.
  const [{ refreshUserProfile }, { refreshReplyLanguage }] = await Promise.all([import('./user-profile-context.js'), import('./reply-language-context.js')]);
  await Promise.all([refreshUserProfile(), refreshReplyLanguage()]);
  if (!refreshOnResume(record, task, now)) return null;
  const { buildSessionContext } = await import('./session-context.js');
  const ctx = await buildSessionContext(record.taskId, record.cwd ?? undefined, record.host ?? undefined);
  if (!ctx.systemPrompt) return null;
  const fresh = callerPrompt !== null ? `${callerPrompt}${TASK_CONTEXT_JOIN}${ctx.systemPrompt}` : ctx.systemPrompt;
  return Buffer.byteLength(fresh, 'utf8') <= PROMPT_MAX_BYTES && fresh !== stored ? fresh : null;
}
