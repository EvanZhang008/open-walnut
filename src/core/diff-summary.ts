/**
 * AI summaries for the Changed tab — one short "what did this file's change do,
 * and where does it fit in the overall changeset" blurb per changed file.
 *
 * Design (mirrors fork-title.ts / project-summary.ts):
 * - Cheap one-shot call via fastModelFor() — this is a labeling task, not an
 *   Opus job. NEVER a CLI session fork: a fork costs seconds-to-minutes and a
 *   whole process per summary; this is one non-streaming Haiku call.
 * - Content-hash cached on disk (~/.open-walnut/cache/diff-summaries/), so a
 *   summary regenerates only when the file's diff actually changes. The cache
 *   lives in Walnut's data dir — never inside the user's repo.
 * - Best-effort: every failure path throws DiffSummaryError with an HTTP-ish
 *   status; the route degrades (the UI hides the strip) and nothing blocks.
 * - Concurrency: in-flight dedup per file + a small global gate so a user
 *   clicking through 50 files can't stampede the provider.
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
import { fastModelFor } from './cheap-model.js';
import { SessionControlError } from './sessions/session-controls.js';

/** Bump when the prompt changes shape (diffSummarySystem, buildDiffText, or
 *  the MAX_* budgets) — invalidates every cached summary. */
const PROMPT_V = 'v4';

/** Diff text budget for the prompt. Beyond this the model gets a truncated
 *  patch plus a note — a 5000-line diff summarized from its head is still far
 *  more useful than a timeout. */
const MAX_DIFF_CHARS = 12_000;
const MAX_DIFF_LINES = 350;

/** Combined before+after size beyond which we skip structuredPatch entirely.
 *  Myers diff is synchronous CPU on the web server's ONE event loop; a
 *  multi-MB lockfile/minified bundle would freeze every route while it runs
 *  (the house "no sync blocking" rule). The head of the new content is a fine
 *  summary input for files that size. */
const MAX_PATCH_INPUT_CHARS = 300_000;

/** At most this many sibling paths ride along as changeset context. */
const MAX_CONTEXT_FILES = 60;

/** Per-stage deadlines. The model call gets LLM_TIMEOUT_MS of MODEL time (the
 *  queue slot is acquired first — queue wait must never eat the budget). The
 *  content fetch can fall through to a cold daemon compute, so it gets its own
 *  cap; siblings are optional context and get a short one. The route adds a
 *  30s overall cap on top. */
const LLM_TIMEOUT_MS = 20_000;
const FILE_FETCH_TIMEOUT_MS = 15_000;
const SIBLINGS_TIMEOUT_MS = 2_500;
const MAX_OUTPUT_TOKENS = 200;

/** Global gate: at most N model calls in flight across all sessions, and a
 *  bounded queue behind them — a click-through-everything burst gets a fast
 *  429 instead of a pile of jobs the user already navigated away from. */
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

interface ContextFile {
  relPath: string;
  status: string;
}

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

/** Content hash: same diff → same summary, forever. Includes the output
 *  language — switching languages must regenerate, not serve the old tongue.
 *  DELIBERATELY excludes the sibling list: folding it in would regenerate
 *  EVERY file's summary each time any file joins the changeset — the cache
 *  would never hit during active work. Cost: the changeset-role words can go
 *  stale as the changeset grows. Accepted trade-off. */
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

/** Filenames whose content we never ship to a model provider, even though the
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

/** The diff text the model sees. Unified patch for modifications; head of the
 *  content for pure adds/deletes (a patch of all-+ lines wastes half the budget
 *  on `+` prefixes and tells the model nothing extra). */
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

/** EXTREMELY short by design (user feedback: "几个词几句话 + 一个 simple
 *  diagram 就够了") — the reader is mid-review and wants a glance, not prose. */
export function diffSummarySystem(lang: string): string {
  const langName = LANG_NAMES[lang] ?? `the language with ISO 639-1 code '${lang}'`;
  return (
    'You caption code diffs in as FEW words as possible — the reader glances, not reads.\n' +
    'Output:\n' +
    '- Line 1: what this change does. A few words up to ONE short sentence; only a genuinely complex change may use two.\n' +
    '- Optional line 2, only for a real multi-step flow: ONE tiny arrow diagram like `parse → cache → render` (nothing else on the line).\n' +
    '- If sibling files are listed, you may end line 1 with the file\'s changeset role in ≤4 words, in parentheses, written in the SAME output language as the rest.\n' +
    `- Write in ${langName}. Keep identifiers, file names, and technical terms in their original form, in \`backticks\`.\n` +
    '- No preamble, no headings, no bullets, no code blocks.\n' +
    '- Never invent behavior not visible in the diff.'
  );
}

/** The user message for one file. `siblings === null` means the changeset list
 *  could not be fetched — say so, instead of the confidently-false "only
 *  changed file" an empty list would imply. Exported for tests. */
export function buildDiffSummaryPrompt(file: FileForSummary, siblings: ContextFile[] | null): string {
  let contextBlock: string;
  if (siblings === null) {
    contextBlock = '  (changeset context unavailable — omit the changeset-role words)';
  } else {
    const others = siblings.filter((s) => s.relPath !== file.relPath);
    const shown = others.slice(0, MAX_CONTEXT_FILES);
    const hidden = others.length - shown.length;
    contextBlock = shown.map((s) => `  ${s.status.padEnd(8)} ${s.relPath}`).join('\n')
      || '  (none — this is the only changed file)';
    if (hidden > 0) contextBlock += `\n  …and ${hidden} more files`;
  }
  return [
    `File: ${file.relPath} (${file.status})`,
    '',
    'Other files in this changeset:',
    contextBlock,
    '',
    'Diff:',
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
// model call instead of racing two.
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
 * Summarize one changed file of a session. Cache-first; on miss, ONE cheap
 * model call. Throws DiffSummaryError / SessionControlError (404/422/429/
 * 502/503) — every stage has a deadline (see the *_TIMEOUT_MS constants).
 *
 * Dedup is the OUTERMOST layer, registered synchronously: a double-click or a
 * second tab asking for the same file joins the whole pipeline (session
 * lookup, content fetch, cache read, model call) instead of repeating any of
 * it. A rejected run clears its entry in the finally, so a failure never
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
  const { getSessionFileChange, getSessionChanges } = await import('./sessions/session-lifecycle.js');
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

  // Content the model must never see: secret-shaped filenames and binaries.
  // 422 = "will never summarize this file"; the client hides the strip without
  // a retry (retrying can't succeed).
  if (isSensitivePath(file.relPath)) {
    throw new DiffSummaryError('File may contain secrets — not summarized', 422);
  }
  if (looksBinary(file)) {
    throw new DiffSummaryError('Binary file — not summarized', 422);
  }

  // Degenerate diffs get a deterministic caption — a model call would spend
  // money to describe nothing (and could invent something). These skip the AI
  // gate below on purpose: no model is involved.
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

  // Sibling list for the "where does it fit" half — best-effort, short
  // deadline (optional context must not stall the summary). null = unknown;
  // the prompt distinguishes that from a genuinely-single-file changeset.
  let siblings: ContextFile[] | null = null;
  try {
    const list = await withTimeout(
      getSessionChanges(sessionId, { light: true, swr: true }),
      SIBLINGS_TIMEOUT_MS,
      () => new Error('sibling list timed out'),
    ) as unknown as { groups?: Array<{ files: Array<{ relPath: string; status: string }> }> };
    siblings = (list.groups ?? []).flatMap((g) => g.files.map((f) => ({ relPath: f.relPath, status: f.status })));
  } catch (err) {
    log.web.debug('diff-summary sibling list unavailable (context omitted)', {
      sessionId, error: err instanceof Error ? err.message : String(err),
    });
  }

  const model = fastModelFor(config); // undefined → sendMessage uses main_model

  const { sendMessage } = await import('../agent/model.js');
  // Slot FIRST, then the abort timer: queue wait behind the 2-call gate must
  // not eat the model's 20s budget (a queued job would otherwise reach
  // sendMessage with an already-aborted signal and 502 for no reason).
  await acquireCallSlot();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  let result;
  try {
    result = await sendMessage({
      system: diffSummarySystem(lang),
      messages: [{ role: 'user', content: buildDiffSummaryPrompt(file, siblings) }],
      // Small cap keeps this a fast NON-streaming call (the catalog default of
      // 64K trips the SDK's "streaming required" rejection — see fork-title.ts).
      config: { maxTokens: MAX_OUTPUT_TOKENS, ...(model ? { model } : {}) },
      signal: controller.signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.web.warn('diff-summary model call failed', { sessionId, relPath: file.relPath, error: msg });
    throw new DiffSummaryError('Summary generation failed', 502);
  } finally {
    clearTimeout(timer);
    releaseCallSlot();
  }

  const summary = (result.content ?? [])
    .map((b) => (b.type === 'text' && 'text' in b ? (b as { text: string }).text : ''))
    .join('')
    .trim();
  if (!summary) throw new DiffSummaryError('Model returned an empty summary', 502);

  const usedModel = model ?? config.agent?.main_model ?? 'default';
  // A max_tokens stop means the text ends mid-sentence — show it once but
  // never cache it under a valid hash (it would serve truncated forever).
  if (result.stopReason !== 'max_tokens') {
    await queueCacheUpdate(sessionId, record.host, (fresh) => {
      fresh.entries[filePath] = { hash, summary, model: usedModel, at: new Date().toISOString() };
    });
  }

  return { filePath, relPath: file.relPath, summary, model: usedModel, cached: false, hash };
}
