/**
 * AI summaries for the Changed tab — one ultra-short "what did this file's
 * change do, and where does it fit" blurb per changed file.
 *
 * HOW IT GENERATES — through the session's own Claude Code CLI, NOT Walnut's
 * model API. The question rides the CLI's hidden side-question channel
 * (`sessionRunner.requestTurnCompleteSelfReport`: native Claude = the
 * stream-json `side_question` control request, ACP/codex = the equivalent
 * hidden report). Why this path (product decision, 2026-08-22):
 * - The session ALREADY HAS the context: it wrote the diff, it knows why. A
 *   fresh model call has to be told everything; the session just answers.
 * - No separate API credential needed — every Walnut user has a working
 *   Claude Code login; not everyone configures Walnut's own provider key.
 *   The direct-API path (sendMessage/fastModelFor) is deliberately NOT a
 *   fallback here — it is being retired as an active path.
 * - Side questions can NOT use tools, so the question embeds the (truncated)
 *   diff as a reminder; the "why / role in the changeset" half comes from the
 *   session's own memory.
 * Consequences to keep in mind: generation needs a LIVE CLI (idle-reaped
 * sessions → 503, the UI degrades to Retry; already-cached summaries still
 * serve forever). A `--resume --fork-session` one-shot for dead sessions is a
 * known follow-up, not built yet.
 *
 * - Content-hash cached on disk (~/.open-walnut/cache/diff-summaries/), so a
 *   summary generates at most once per diff content. The cache lives in
 *   Walnut's data dir — never inside the user's repo.
 * - Best-effort: every failure path throws DiffSummaryError with an HTTP-ish
 *   status; the route degrades (the UI hides the strip) and nothing blocks.
 * - Concurrency: in-flight dedup per file + a small global gate so a user
 *   clicking through 50 files can't stampede the CLIs.
 * - Summaries always describe the SESSION-base diff (getSessionFileChange with
 *   no base param). If a git base ever gets summarized, the cache entries must
 *   grow a base component in their key or the two bases will thrash each other.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { structuredPatch } from 'diff';
import { WALNUT_HOME } from '../constants.js';
import { log } from '../logging/index.js';
import { SessionControlError } from './sessions/session-controls.js';

/** Bump when the prompt changes shape (buildDiffSummaryQuestion, buildDiffText,
 *  or the MAX_* budgets) — invalidates every cached summary. */
const PROMPT_V = 'v5';

/** Diff text budget for the question. The diff is only a REMINDER (the session
 *  has the full edit history in context), so this can stay small — a truncated
 *  patch plus a note beats a timeout. */
const MAX_DIFF_CHARS = 8_000;
const MAX_DIFF_LINES = 250;

/** Combined before+after size beyond which we skip structuredPatch entirely.
 *  Myers diff is synchronous CPU on the web server's ONE event loop; a
 *  multi-MB lockfile/minified bundle would freeze every route while it runs
 *  (the house "no sync blocking" rule). The head of the new content is a fine
 *  summary input for files that size. */
const MAX_PATCH_INPUT_CHARS = 300_000;

/** Per-stage deadlines. The side question runs on the session's own model with
 *  its full context (cold prompt-cache can be slow); the content fetch can
 *  fall through to a cold daemon compute. The route adds a 40s overall cap. */
const SIDE_QUESTION_TIMEOUT_MS = 30_000;
const FILE_FETCH_TIMEOUT_MS = 15_000;

/** Global gate: at most N side questions in flight across all sessions, and a
 *  bounded queue behind them — a click-through-everything burst gets a fast
 *  429 instead of a pile of questions the user already navigated away from. */
const MAX_CONCURRENT_CALLS = 2;
const MAX_QUEUED_CALLS = 8;

/** Extends SessionControlError so the route handles both with ONE instanceof
 *  (getSessionFileChange throws SessionControlError through this same path).
 *  `extra` rides into the response body — {code:'ai_disabled'} is the only
 *  marker the client latches on permanently; keep that code unique. */
export class DiffSummaryError extends SessionControlError {
  constructor(message: string, statusCode: number, extra?: Record<string, unknown>) {
    super(message, statusCode, extra);
    this.name = 'DiffSummaryError';
  }
}

export interface DiffSummaryResult {
  filePath: string;
  relPath: string;
  summary: string;
  model: string;
  cached: boolean;
  hash: string;
}

interface FileForSummary {
  relPath: string;
  before: string;
  after: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  oldRelPath?: string;
  /** True when the change was reconstructed from an incomplete op stream. */
  partial?: boolean;
}

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

/** Content hash: same diff → same summary, forever. Includes the output
 *  language — switching languages must regenerate, not serve the old tongue.
 *  DELIBERATELY excludes any changeset-state signal: the session's answer
 *  about a file's role can go stale as the changeset grows, but folding
 *  changeset state in would regenerate EVERY summary on every new file — the
 *  cache would never hit during active work. Accepted trade-off. */
export function diffSummaryHash(
  file: Pick<FileForSummary, 'before' | 'after' | 'status'>,
  lang = 'en',
): string {
  return createHash('sha256')
    .update(PROMPT_V).update('\0')
    .update(lang).update('\0')
    .update(file.status).update('\0')
    .update(file.before).update('\0')
    .update(file.after)
    .digest('hex')
    .slice(0, 16);
}

/** Normalize a language hint ('zh-CN', 'ZH_Hans') to its primary subtag. */
export function normalizeLang(hint: string | undefined): string | undefined {
  const primary = (hint ?? '').trim().toLowerCase().split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(primary) ? primary : undefined;
}

const LANG_NAMES: Record<string, string> = {
  zh: 'Simplified Chinese (简体中文)',
  en: 'English',
  ja: 'Japanese (日本語)',
  ko: 'Korean (한국어)',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  pt: 'Portuguese',
};

/** Filenames whose content we never ship into a prompt, even though the
 *  session itself may have touched them. Matched on the basename. */
const SENSITIVE_BASENAME_RE = /^(\.env(\..*)?|\.npmrc|\.netrc|credentials(\..*)?|secrets?\..*|id_(rsa|ed25519|ecdsa|dsa)(\..*)?)$|\.(pem|key|p12|pfx|keystore|jks)$/i;

export function isSensitivePath(relPath: string): boolean {
  return SENSITIVE_BASENAME_RE.test(path.basename(relPath));
}

/** NUL byte in the head = binary; mojibake tells the model nothing. */
function looksBinary(file: Pick<FileForSummary, 'before' | 'after'>): boolean {
  return file.before.slice(0, 8192).includes('\0') || file.after.slice(0, 8192).includes('\0');
}

/** Truncate to both a char and a line budget, flagging the cut. */
function clip(text: string): { text: string; truncated: boolean } {
  let out = text;
  let truncated = false;
  if (out.length > MAX_DIFF_CHARS) { out = out.slice(0, MAX_DIFF_CHARS); truncated = true; }
  const lines = out.split('\n');
  if (lines.length > MAX_DIFF_LINES) { out = lines.slice(0, MAX_DIFF_LINES).join('\n'); truncated = true; }
  return { text: out, truncated };
}

/** The diff text embedded in the question. Unified patch for modifications;
 *  head of the content for pure adds/deletes (a patch of all-+ lines wastes
 *  half the budget on `+` prefixes and tells the model nothing extra). */
export function buildDiffText(file: FileForSummary): string {
  const caveat = file.partial ? 'NOTE: this diff was partially reconstructed and may be incomplete.\n' : '';
  if (file.status === 'added') {
    const { text, truncated } = clip(file.after);
    return `${caveat}NEW FILE (entire content added):\n${text}${truncated ? '\n…(truncated)' : ''}`;
  }
  if (file.status === 'deleted') {
    const { text, truncated } = clip(file.before);
    return `${caveat}DELETED FILE (entire content removed):\n${text}${truncated ? '\n…(truncated)' : ''}`;
  }
  // Guard the event loop BEFORE diffing — clip() below only bounds the output.
  if (file.before.length + file.after.length > MAX_PATCH_INPUT_CHARS) {
    const { text } = clip(file.after);
    return `${caveat}LARGE FILE (diff too big to compute) — head of the NEW content:\n${text}\n…(truncated)`;
  }
  let patch: string;
  let patchFailed = false;
  try {
    const p = structuredPatch(file.relPath, file.relPath, file.before, file.after, '', '', { context: 3 });
    patch = p.hunks
      .map((h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join('\n')}`)
      .join('\n');
  } catch {
    patch = '';
    patchFailed = true;
  }
  if (!patch.trim()) {
    // A failed patch is NOT "no change" — never caption content we couldn't see.
    if (patchFailed) return `${caveat}(diff computation failed — the content changed but the patch is unavailable)`;
    if (file.status === 'renamed') return `File moved from ${file.oldRelPath ?? '(unknown)'} — content unchanged.`;
    return '(no textual diff)';
  }
  const { text, truncated } = clip(patch);
  const moved = file.status === 'renamed' && file.oldRelPath ? `(moved from ${file.oldRelPath})\n` : '';
  return `${caveat}${moved}${text}${truncated ? '\n…(truncated)' : ''}`;
}

/**
 * The side question sent to the session's own CLI. The session has the full
 * edit history in context — the diff below is only a reminder/anchor. EXTREMELY
 * short output by design (user feedback: "几个词几句话 + 一个 simple diagram
 * 就够了") — the reader glances mid-review, not reads. Exported for tests.
 */
export function buildDiffSummaryQuestion(file: FileForSummary, lang: string): string {
  const langName = LANG_NAMES[lang] ?? `the language with ISO 639-1 code '${lang}'`;
  return [
    `Caption YOUR change to \`${file.relPath}\` (${file.status}) in as FEW words as possible — you made this change, so you know why.`,
    'Output (nothing else):',
    '- Line 1: what it does. A few words up to ONE short sentence; only a genuinely complex change may use two.',
    '- Optional line 2, only for a real multi-step flow: ONE tiny arrow diagram like `parse → cache → render` (nothing else on the line).',
    '- You may end line 1 with this file\'s role in the overall change, ≤4 words, in parentheses, in the SAME output language.',
    `- Write in ${langName}. Keep identifiers, file names, and technical terms in their original form, in \`backticks\`.`,
    '- No preamble, no headings, no bullets, no code blocks. Never invent behavior not in the diff.',
    '',
    'Diff (truncated reminder — you have the full history):',
    buildDiffText(file),
  ].join('\n');
}

// ── Disk cache ───────────────────────────────────────────────────────────────

interface CacheFile {
  /** Absolute filePath → entry (relPath alone collides across the repos of a
   *  multi-repo changeset). Bounded by the changeset itself. */
  entries: Record<string, { hash: string; summary: string; model: string; at: string }>;
}

function cachePath(sessionId: string, host?: string): string {
  const key = host ? `${sessionId}@${host}` : sessionId;
  const safe = key.replace(/[^a-zA-Z0-9._@-]/g, '-');
  return path.join(WALNUT_HOME, 'cache', 'diff-summaries', `${safe}.json`);
}

async function readCache(sessionId: string, host?: string): Promise<CacheFile> {
  try {
    const raw = await fs.readFile(cachePath(sessionId, host), 'utf-8');
    const parsed = JSON.parse(raw) as CacheFile;
    if (parsed && typeof parsed.entries === 'object' && parsed.entries) return parsed;
  } catch { /* absent / corrupt → start fresh */ }
  return { entries: {} };
}

let tmpSeq = 0;
async function writeCache(sessionId: string, host: string | undefined, cache: CacheFile): Promise<void> {
  const target = cachePath(sessionId, host);
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    // pid alone is NOT unique here — two summaries for the same session can
    // finish concurrently in this one process; a shared tmp name lets one
    // rename the other's half-written JSON into place.
    const tmp = `${target}.tmp-${process.pid}-${++tmpSeq}`;
    await fs.writeFile(tmp, JSON.stringify(cache), 'utf-8');
    await fs.rename(tmp, target); // atomic within the same dir
  } catch (err) {
    log.web.debug('diff-summary cache write failed (non-fatal)', {
      sessionId, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Per-cache-file update chains. Serializing the whole read-modify-write per
 *  session closes the lost-update race two concurrent finishes would otherwise
 *  hit (only this process writes these files, so in-process is enough). */
const cacheChains = new Map<string, Promise<void>>();
function queueCacheUpdate(
  sessionId: string,
  host: string | undefined,
  mutate: (cache: CacheFile) => void,
): Promise<void> {
  const target = cachePath(sessionId, host);
  const prev = cacheChains.get(target) ?? Promise.resolve();
  const run = prev.then(async () => {
    const cache = await readCache(sessionId, host);
    mutate(cache);
    await writeCache(sessionId, host, cache); // never throws (swallows inside)
  });
  cacheChains.set(target, run);
  void run.finally(() => { if (cacheChains.get(target) === run) cacheChains.delete(target); });
  return run;
}

// ── Generation ───────────────────────────────────────────────────────────────

// In-flight dedup: a double-click / two tabs asking for the same file share one
// side question instead of racing two.
const inflight = new Map<string, Promise<DiffSummaryResult>>();

// Tiny semaphore for the global call gate. Shape note: activeCalls += 1 happens
// in the WAITER after its resolve fires, not in releaseCallSlot — moving the
// increment into release double-counts (release both decrements for the leaver
// and would increment for the waiter it wakes).
let activeCalls = 0;
const waiters: Array<() => void> = [];
async function acquireCallSlot(): Promise<void> {
  if (activeCalls < MAX_CONCURRENT_CALLS) { activeCalls += 1; return; }
  if (waiters.length >= MAX_QUEUED_CALLS) {
    throw new DiffSummaryError('Too many summaries pending — try again shortly', 429);
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  activeCalls += 1;
}
function releaseCallSlot(): void {
  activeCalls -= 1;
  waiters.shift()?.();
}

/** Race a promise against a deadline. The underlying work continues past the
 *  deadline (no abort plumbing through the daemon chain) — the point is that
 *  the ROUTE answers; a later retry joins the still-running inflight entry. */
function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(onTimeout()), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/**
 * Summarize one changed file of a session, by asking THE SESSION ITSELF.
 * Cache-first; on miss, ONE hidden side question to the session's live CLI.
 * Throws DiffSummaryError / SessionControlError (404/422/429/502/503) — every
 * stage has a deadline (see the *_TIMEOUT_MS constants).
 *
 * Dedup is the OUTERMOST layer, registered synchronously: a double-click or a
 * second tab asking for the same file joins the whole pipeline (session
 * lookup, content fetch, cache read, side question) instead of repeating any
 * of it. A rejected run clears its entry in the finally, so a failure never
 * poisons later requests.
 *
 * ⚠️ Keep this wrapper non-async and keep the inflight get/set BEFORE any
 * await: an earlier version registered the entry after an await and two
 * "concurrent" callers raced past each other (caught under vitest's dynamic-
 * import interleaving, but real in production too).
 */
export function summarizeSessionFileChange(
  sessionId: string,
  filePath: string,
  opts?: { langHint?: string },
): Promise<DiffSummaryResult> {
  const key = `${sessionId}:${filePath}:${normalizeLang(opts?.langHint) ?? ''}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const run = summarizeInner(sessionId, filePath, opts?.langHint).finally(() => { inflight.delete(key); });
  inflight.set(key, run);
  return run;
}

async function summarizeInner(
  sessionId: string,
  filePath: string,
  langHint?: string,
): Promise<DiffSummaryResult> {
  const { getSessionByClaudeId } = await import('./session-tracker.js');
  const record = await getSessionByClaudeId(sessionId);
  if (!record) throw new DiffSummaryError('Session not found', 404);

  // Output language: explicit config wins, else the browser locale the client
  // sent, else English. Part of the content hash — switching regenerates.
  const { getConfig } = await import('./config-manager.js');
  const config = await getConfig();
  const lang = normalizeLang(config.agent?.language) ?? normalizeLang(langHint) ?? 'en';

  // Reuse the Changed tab's own retrieval chain (cache → daemon → compute).
  // The cold path can be a whale recompute — cap it and answer degraded.
  const { getSessionFileChange } = await import('./sessions/session-lifecycle.js');
  const fileRes = await withTimeout(
    getSessionFileChange(sessionId, filePath),
    FILE_FETCH_TIMEOUT_MS,
    () => new DiffSummaryError('File content not ready — try again', 503),
  ) as unknown as { file: FileForSummary };
  const file = fileRes.file;

  const hash = diffSummaryHash(file, lang);
  const cache = await readCache(sessionId, record.host);
  const hit = cache.entries[filePath];
  if (hit && hit.hash === hash) {
    return { filePath, relPath: file.relPath, summary: hit.summary, model: hit.model, cached: true, hash };
  }

  // Content that must never enter a prompt: secret-shaped filenames and
  // binaries. 422 = "will never summarize this file"; the client hides the
  // strip without a retry (retrying can't succeed).
  if (isSensitivePath(file.relPath)) {
    throw new DiffSummaryError('File may contain secrets — not summarized', 422);
  }
  if (looksBinary(file)) {
    throw new DiffSummaryError('Binary file — not summarized', 422);
  }

  // Degenerate diffs get a deterministic caption — a side question would spend
  // a model turn describing nothing (and could invent something). These skip
  // the AI gate below on purpose: no model is involved.
  if (file.before === file.after) {
    const summary = file.status === 'renamed' && file.oldRelPath
      ? (lang === 'zh' ? `从 \`${file.oldRelPath}\` 移动过来,内容未变。` : `Moved from \`${file.oldRelPath}\` — content unchanged.`)
      : (lang === 'zh' ? '无文本改动。' : 'No textual change to this file.');
    return { filePath, relPath: file.relPath, summary, model: 'rule-based', cached: false, hash };
  }

  // ⚠️ Order is load-bearing: the gate sits AFTER the cache read so an
  // AI-disabled environment (tests, WALNUT_DISABLE_BACKGROUND_AI) still serves
  // summaries generated earlier. Moving it to the top of the function is the
  // natural refactor and silently loses that behavior.
  const { backgroundAiDisabled } = await import('./cheap-model.js');
  if (backgroundAiDisabled()) {
    throw new DiffSummaryError('AI summaries disabled in this environment', 503, { code: 'ai_disabled' });
  }

  // Ask the session itself. getOrAttachLiveSession first: the runner's
  // in-memory map misses a genuinely-alive CLI after a server restart, and
  // requestTurnCompleteSelfReport does not attach-on-demand for native
  // sessions (it does for ACP). Attach failure is fine — the self-report call
  // below gives the authoritative "not live" error.
  const { sessionRunner } = await import('../providers/claude-code-session.js');
  try {
    await sessionRunner.getOrAttachLiveSession(sessionId);
  } catch { /* not attachable → requestTurnCompleteSelfReport reports it */ }

  await acquireCallSlot();
  let answer: string;
  try {
    answer = await sessionRunner.requestTurnCompleteSelfReport(
      sessionId,
      buildDiffSummaryQuestion(file, lang),
      SIDE_QUESTION_TIMEOUT_MS,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.web.warn('diff-summary side question failed', { sessionId, relPath: file.relPath, error: msg });
    // "No live session" = the CLI was idle-reaped; a retry after relaunching
    // the session works, so this is 503 (transient), not a hard failure.
    if (/no live session/i.test(msg)) {
      throw new DiffSummaryError('Session not running — summaries generate while it is live', 503);
    }
    throw new DiffSummaryError('Summary generation failed', 502);
  } finally {
    releaseCallSlot();
  }

  const summary = answer.trim();
  if (!summary) throw new DiffSummaryError('Session returned an empty summary', 502);

  // The session answered with its own model; mirror session-extras' precedence.
  const rec = record as { cliModel?: string; model?: string };
  const usedModel = (rec.cliModel ?? rec.model)?.trim() || 'session';
  await queueCacheUpdate(sessionId, record.host, (fresh) => {
    fresh.entries[filePath] = { hash, summary, model: usedModel, at: new Date().toISOString() };
  });

  return { filePath, relPath: file.relPath, summary, model: usedModel, cached: false, hash };
}
