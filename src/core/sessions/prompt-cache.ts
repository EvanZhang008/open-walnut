/**
 * What Walnut knows about a Claude Code session's prompt cache, and when an idle
 * session should compact before that cache expires. Pure: no I/O, no clock.
 *
 * Anthropic's prompt cache lives 5 minutes, or 1 hour when the request asks for
 * it (Claude Code does so on subscriptions and with ENABLE_PROMPT_CACHING_1H).
 * Every request that reads or writes the cache restarts that lifetime. The
 * request's own usage says which lifetime it wrote: `cache_creation` splits the
 * written tokens into `ephemeral_1h_input_tokens` and `ephemeral_5m_input_tokens`.
 *
 * A session left idle past its cache lifetime writes its whole context to the
 * cache again on the next message. So does a `/compact`, warm or cold (measured
 * on Claude Code 2.1.312, 2026-11-04: it read 13K of a 299K prefix): a
 * compaction saves on every message after it, never on its own. The rule
 * (Evan, 2026-11-04: "compact is user's own decision, only time we can do it
 * auto or warn is the cache almost expired"): Walnut compacts by itself only
 * while the cache is warm and about to expire, for a session near where it
 * compacts by itself (idle-compaction.ts); once the cache has expired it neither
 * compacts nor says anything.
 */

export const ONE_HOUR_MS = 60 * 60_000;
export const FIVE_MINUTES_MS = 5 * 60_000;

/**
 * The idle compaction runs only for a session this full: this share of where it compacts by itself
 * (its auto-compaction window, else the model's). Measured 2026-11-04 on Claude Code 2.1.312, a
 * `/compact` writes the whole conversation to the cache once, warm or cold, so it pays only for a
 * session that would soon compact anyway. Below 90%: the CLI keeps room for its answer and compacts
 * on its own near 93% of a 500K window, and a busy session could get there first.
 */
export const DEFAULT_IDLE_COMPACT_LIMIT_PERCENT = 85;
/**
 * The threshold stays at least this far under the limit: Claude Code compacts by itself about 33K
 * under its window (room for its answer), and one more turn can add the rest. On a 200K window
 * 85% (170K) would come after the CLI's own compaction (about 167K), so there it is 155K.
 */
export const IDLE_COMPACT_HEADROOM_TOKENS = 45_000;
/** The share a setting may name; outside it (or unset) the default holds. */
export const IDLE_COMPACT_LIMIT_PERCENT_RANGE = { min: 50, max: 99 } as const;
export function resolveIdleCompactLimitPercent(value: unknown): number {
  const { min, max } = IDLE_COMPACT_LIMIT_PERCENT_RANGE;
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : DEFAULT_IDLE_COMPACT_LIMIT_PERCENT;
}
/** The compaction is sent this long before the cache expires: enough to resume a stopped CLI. */
export const IDLE_COMPACT_LEAD_MS = 3 * 60_000;
/**
 * Only caches that live at least this long are compacted while idle. A 5-minute
 * cache would compact a session two minutes after every turn, while its user is
 * still reading the answer; compacting those is the user's call (the "+" menu).
 */
export const IDLE_COMPACT_MIN_TTL_MS = 30 * 60_000;

/** The prompt cache facts of a session's last main-loop request (SessionRecord.promptCache). */
export interface PromptCacheFacts {
  /** Tokens the next request reads before its own words: the last request's prompt plus its output. */
  tokens: number;
  /** The cache lifetime the last request wrote or refreshed, in ms. Absent when no request said. */
  ttlMs?: number;
  /** When the last main-loop request started (its message_start), ISO. */
  requestAt: string;
  /** requestAt + ttlMs, ISO. Absent when the lifetime is unknown. */
  expiresAt?: string;
  /** The context was compacted at this time and holds `tokens` since. */
  compactedAt?: string;
  /** Where this session compacts by itself, when known: its auto-compaction window, else the model's. */
  compactsAt?: number;
  /** Which of the two `compactsAt` is. */
  compactsAtSource?: CompactsAtSource;
}

/** 'auto-compact': the session's or host's auto-compaction window (CLAUDE_CODE_AUTO_COMPACT_WINDOW); 'model': the model's context window. */
export type CompactsAtSource = 'auto-compact' | 'model';

/** The size an idle session must reach to be compacted, or null when where it compacts is unknown (then it is never compacted). */
export function idleCompactThreshold(facts: Pick<PromptCacheFacts, 'compactsAt'> | undefined, limitPercent: number = DEFAULT_IDLE_COMPACT_LIMIT_PERCENT): number | null {
  if (!facts?.compactsAt || facts.compactsAt <= IDLE_COMPACT_HEADROOM_TOKENS) return null;
  return Math.min(Math.round(facts.compactsAt * limitPercent / 100), facts.compactsAt - IDLE_COMPACT_HEADROOM_TOKENS);
}

/** The usage counters a Claude request reports (message_start, message_delta, assistant). */
export interface ClaudeUsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: { ephemeral_1h_input_tokens?: number | null; ephemeral_5m_input_tokens?: number | null } | null;
}

/** The lifetime a request's cache write names, or undefined when it wrote nothing it named. */
export function ttlFromUsage(usage: ClaudeUsageLike | undefined): number | undefined {
  const split = usage?.cache_creation;
  if (!split) return undefined;
  // A request that wrote any 5-minute entry has a tail that goes cold in five minutes: the shorter one counts.
  if ((split.ephemeral_5m_input_tokens ?? 0) > 0) return FIVE_MINUTES_MS;
  if ((split.ephemeral_1h_input_tokens ?? 0) > 0) return ONE_HOUR_MS;
  return undefined;
}

function promptTokens(usage: ClaudeUsageLike): number {
  return (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
}

function withExpiry(facts: PromptCacheFacts): PromptCacheFacts {
  const at = Date.parse(facts.requestAt);
  const { expiresAt: _drop, ...rest } = facts;
  return facts.ttlMs && Number.isFinite(at) ? { ...rest, expiresAt: new Date(at + facts.ttlMs).toISOString() } : rest;
}

/**
 * The facts after a main-loop request reported usage. `newRequest` is true at the
 * request's first report (message_start, or an assistant line with no stream
 * before it): the request time moves to `nowMs`. Later reports of the same
 * request (message_delta, the consolidated assistant line) only fill in counts.
 * A request that only read the cache refreshed it with the lifetime it had, so a
 * missing split keeps the earlier lifetime. Returns `prev` when the usage holds
 * no prompt tokens (a stream that reports usage only at its end starts at zero).
 */
export function noteRequestUsage(
  prev: PromptCacheFacts | undefined,
  usage: ClaudeUsageLike | undefined,
  nowMs: number,
  newRequest: boolean,
): PromptCacheFacts | undefined {
  if (!usage) return prev;
  const prompt = promptTokens(usage);
  const ttl = ttlFromUsage(usage) ?? prev?.ttlMs;
  if (prompt <= 0) {
    if (!newRequest || !prev) return prev;
    // The request started; its counts come later. Its time is known now.
    return withExpiry({ tokens: prev.tokens, ...(ttl ? { ttlMs: ttl } : {}), requestAt: new Date(nowMs).toISOString() });
  }
  const requestAt = newRequest || !prev ? new Date(nowMs).toISOString() : prev.requestAt;
  return withExpiry({
    tokens: prompt + (usage.output_tokens ?? 0),
    ...(ttl ? { ttlMs: ttl } : {}),
    requestAt,
  });
}

/** The facts after a compaction left `postTokens` in context (compact_boundary). */
export function noteCompaction(prev: PromptCacheFacts | undefined, postTokens: number | undefined, nowMs: number): PromptCacheFacts {
  const at = new Date(nowMs).toISOString();
  return withExpiry({
    tokens: postTokens && postTokens > 0 ? postTokens : 0,
    ...(prev?.ttlMs ? { ttlMs: prev.ttlMs } : {}),
    ...(prev?.compactsAt ? { compactsAt: prev.compactsAt, ...(prev.compactsAtSource ? { compactsAtSource: prev.compactsAtSource } : {}) } : {}),
    requestAt: at,
    compactedAt: at,
  });
}

export interface IdleCompactionWindow {
  /** When to send the compaction, epoch ms. */
  fireAtMs: number;
  /** When the cache expires, epoch ms: a compaction after this pays the full read. */
  expiresAtMs: number;
}

/**
 * When an idle session with these facts should compact, or null when it should
 * not: below its share of where it compacts by itself (or that is unknown),
 * already compacted since, a lifetime unknown or too short to be worth it, or a
 * cache that has expired already.
 */
export function idleCompactionWindow(
  facts: PromptCacheFacts | undefined,
  nowMs: number,
  opts: { limitPercent?: number; leadMs?: number; minTtlMs?: number } = {},
): IdleCompactionWindow | null {
  if (!facts || facts.compactedAt) return null;
  const threshold = idleCompactThreshold(facts, opts.limitPercent);
  if (threshold === null || facts.tokens < threshold) return null;
  if (!facts.ttlMs || facts.ttlMs < (opts.minTtlMs ?? IDLE_COMPACT_MIN_TTL_MS)) return null;
  const expiresAtMs = Date.parse(facts.expiresAt ?? '');
  if (!Number.isFinite(expiresAtMs) || nowMs >= expiresAtMs) return null;
  return { fireAtMs: expiresAtMs - (opts.leadMs ?? IDLE_COMPACT_LEAD_MS), expiresAtMs };
}

/**
 * The idle compaction's `/compact` goes out under a user uuid with this prefix (still a valid v4
 * uuid), and the CLI files the command line under it. History reads such a line as Walnut's own
 * compaction (session-history.ts), not as something the user typed.
 */
export const IDLE_COMPACT_UUID_PREFIX = 'cc0a1d1e-';
export function idleCompactLineUuid(random: string): string {
  return IDLE_COMPACT_UUID_PREFIX + random.slice(IDLE_COMPACT_UUID_PREFIX.length);
}
/** Why one idle compaction ran: kept on the session record (idleCompactionLog), shown on its row. */
export interface IdleCompactReason {
  /** Context tokens when it was sent. */
  tokens: number;
  /** The size it had to reach: limitPercent of compactsAt, or IDLE_COMPACT_HEADROOM_TOKENS under it when that is lower. */
  threshold: number;
  limitPercent: number;
  compactsAt: number;
  source: CompactsAtSource;
}

function shortTokens(n: number): string {
  return n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : `${Math.round(n / 1000)}K`;
}

/** "400K tokens, past 85% (383K) of the 450K auto-compaction window this session uses". */
export function idleCompactReasonText(r: IdleCompactReason): string {
  const base = r.source === 'auto-compact'
    ? `the ${shortTokens(r.compactsAt)} auto-compaction window this session uses`
    : `the model's ${shortTokens(r.compactsAt)} context window (no auto-compaction window is set)`;
  const share = Math.round(r.compactsAt * r.limitPercent / 100);
  if (r.threshold < share) {
    return `${shortTokens(r.tokens)} tokens, past ${shortTokens(r.threshold)}, which is ${shortTokens(r.compactsAt - r.threshold)} below ${base}. (${r.limitPercent}% would be ${shortTokens(share)}, after the point where Claude Code compacts by itself.)`;
  }
  return `${shortTokens(r.tokens)} tokens, past ${r.limitPercent}% (${shortTokens(r.threshold)}) of ${base}`;
}

/** The history row that stands for the idle compaction's command line. */
export const IDLE_COMPACT_HISTORY_TEXT = 'Walnut sent /compact while the session was idle, before its prompt cache expired, so the next message reads a summary instead of the whole conversation.';
/** Walnut's own lines about an idle compaction: the live note (idle-compaction.ts) and the history row. */
export function isIdleCompactLine(text: string | undefined): boolean {
  // The first wording too: history cached by the first release still holds it.
  return !!text && (text.startsWith('Walnut sent /compact while the session was idle') || text.startsWith('Compacting this idle session')
    || text.startsWith('Compacted by Walnut while the session was idle'));
}

