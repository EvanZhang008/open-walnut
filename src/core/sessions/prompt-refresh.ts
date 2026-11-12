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
 *
 * A warm cache gives way too when the refresh pays for itself (`refreshPays`, 2026-11-11, the
 * org review): a long-lived node never reached an expired cache (the Walnut VP's cold resumes
 * all came within the hour) and was restated about 33 KB after each of its 4 to 6 compactions a
 * day. The refresh rewrites the conversation once; the restatement is written again at every
 * compaction. Right after a compaction the conversation is at its smallest, so that is where the
 * respawn on the current prompt is tried (prompt-refresh-respawn.ts), and a cold resume that
 * comes then takes it too.
 */
import type { SessionRecord, Task } from '../types.js';
import { isAcpEngine, resolveEngine } from '../agents/engine-registry.js';
import { WALNUT_PROMPT_MARK, defaultInstructions } from './session-context.js';
import { dueChanges, parseInstructions, renderDue } from './instruction-diff.js';
import { currentUserProfile } from './user-profile-context.js';
import { isFollower } from '../server-role.js';
import { isOrgNode } from '../org/org-enabled.js';
import { ONE_HOUR_MS, type PromptCacheFacts } from './prompt-cache.js';

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

/**
 * A refresh on a warm cache waits for a debt this large: below it the restatement is a few
 * lines, and a respawn is not worth its churn.
 */
export const MIN_REFRESH_DEBT_BYTES = 8_192;
/**
 * How many more compactions a refresh may take to pay for itself. An org node (Main, a VP, a lead)
 * lives for weeks (the Walnut VP: 103 compactions from 2026-10-24 to 11-11), so 30 of them, about
 * a week of a busy node; any other session is counted on for one more only.
 */
export const ORG_NODE_REFRESH_HORIZON = 30;
const OTHER_REFRESH_HORIZON = 1;
/** Prompt prices relative to plain input (Anthropic: a 1-hour cache write 2x, a 5-minute one 1.25x, a read 0.1x). */
const CACHE_READ = 0.1;
const cacheWrite = (ttlMs: number | undefined) => (ttlMs !== undefined && ttlMs >= ONE_HOUR_MS ? 2 : 1.25);
/** About this many bytes of Walnut's English prose per token. */
const BYTES_PER_TOKEN = 4;

/** Nothing has read the context since the compaction: the next request writes it whole either way. */
export function nothingReadSinceCompaction(facts: PromptCacheFacts | undefined): boolean {
  return !!facts?.compactedAt && facts.requestAt === facts.compactedAt;
}

/**
 * Whether running on the current prompt costs less than restating its debt (pure). In plain-input
 * tokens: a refresh on a warm cache writes again the conversation and the old prompt it would have
 * read (none of the conversation when nothing read it since a compaction); the lines the old prompt
 * lacks cost the same either way, in the system prompt or in the notice due now. Not refreshing writes
 * the restatement again at every compaction, `horizon` of them counted. An expired cache gives the
 * conversation nothing to read, so any debt pays. Unknown facts never refresh a warm session.
 */
export function refreshPays(input: {
  facts: PromptCacheFacts | undefined; debtBytes: number; storedPromptBytes: number; horizon: number; now?: number;
}): boolean {
  const { facts, debtBytes } = input;
  if (debtBytes <= 0) return false;
  if (replayBuysNothing(facts, input.now ?? Date.now())) return true;
  if (!facts || debtBytes < MIN_REFRESH_DEBT_BYTES) return false;
  const write = cacheWrite(facts.ttlMs);
  const rewritten = (nothingReadSinceCompaction(facts) ? 0 : facts.tokens) + input.storedPromptBytes / BYTES_PER_TOKEN;
  return rewritten * (write - CACHE_READ) <= input.horizon * (debtBytes / BYTES_PER_TOKEN) * write;
}

/** How many compactions this session's refresh may take to pay back (`refreshPays`). */
export function refreshHorizon(task: { org_role?: string } | null | undefined): number {
  return isOrgNode(task) ? ORG_NODE_REFRESH_HORIZON : OTHER_REFRESH_HORIZON;
}

/** Whether the session's prompt can be rebuilt here at all: a Claude Code task session on the Mac, prompt refresh on. */
export function promptRefreshable(record: Pick<RefreshRecord, 'taskId' | 'lane' | 'engine'>): boolean {
  if (process.env.WALNUT_PROMPT_REFRESH === '0') return false;
  if (!record.taskId || record.lane || isAcpEngine(resolveEngine(record.engine))) return false;
  // A replica builds a thinner prompt (no Reply language, no fleet line): the Mac's stays.
  return !isFollower();
}

/**
 * True when the next spawn of this session should run on the current prompt (sync). `facts`: the
 * cache facts to judge by, when the caller holds newer ones than the record (the live runner's).
 */
export function refreshOnResume(
  record: RefreshRecord, task: Parameters<typeof defaultInstructions>[0] & { org_role?: string }, now = Date.now(), facts = record.promptCache,
): boolean {
  if (!promptRefreshable(record)) return false;
  if (!facts) return false;
  const debtBytes = promptDebtBytes(record, task);
  return refreshPays({
    facts, debtBytes, storedPromptBytes: Buffer.byteLength(record.appliedAppendSystemPrompt ?? '', 'utf8'), horizon: refreshHorizon(task), now,
  });
}

/**
 * The prompt a cold resume of this session should run on: the current one when
 * refreshOnResume says so, else null (replay the stored one). Only a prompt Walnut
 * built is rebuilt: Walnut's alone, or a caller's own prompt followed by Walnut's.
 */
export async function freshResumePrompt(
  record: RefreshRecord & Partial<Pick<SessionRecord, 'cwd' | 'host'>>, now = Date.now(), facts = record.promptCache,
): Promise<string | null> {
  const stored = record.appliedAppendSystemPrompt;
  // The cheap facts first: this runs before each resume spawn.
  if (!stored || !facts || !record.taskId || !promptRefreshable(record)) return null;
  const join = stored.indexOf(TASK_CONTEXT_JOIN);
  const callerPrompt = join >= 0 ? stored.slice(0, join) : null;
  if (callerPrompt === null && !stored.startsWith(WALNUT_PROMPT_MARK)) return null;
  const { listTasksByIds } = await import('../task-manager.js');
  const [task] = await listTasksByIds([record.taskId]) as Task[];
  if (!task) return null;
  // The default instructions read the user's profile and Reply language from their copies: read them now.
  const [{ refreshUserProfile }, { refreshReplyLanguage }] = await Promise.all([import('./user-profile-context.js'), import('./reply-language-context.js')]);
  await Promise.all([refreshUserProfile(), refreshReplyLanguage()]);
  if (!refreshOnResume(record, task, now, facts)) return null;
  const { buildSessionContext } = await import('./session-context.js');
  const ctx = await buildSessionContext(record.taskId, record.cwd ?? undefined, record.host ?? undefined);
  if (!ctx.systemPrompt) return null;
  const fresh = callerPrompt !== null ? `${callerPrompt}${TASK_CONTEXT_JOIN}${ctx.systemPrompt}` : ctx.systemPrompt;
  return Buffer.byteLength(fresh, 'utf8') <= PROMPT_MAX_BYTES && fresh !== stored ? fresh : null;
}
