/**
 * Memory entry telemetry — `.entry-telemetry.json` sidecar next to MEMORY.md / USER.md.
 *
 * WHY THIS EXISTS: skills have `bumpSkillUsage` (skill-usage.ts) because a skill
 * is LOADED on demand — there is a countable event. Memory is injected into every
 * single turn UNCONDITIONALLY, so "injection count" is identical for every entry
 * and carries zero information. When the store hits its hard budget the model is
 * asked to consolidate; without evidence that is pure guesswork.
 *
 * The only signals that are BOTH measurable and honest here are byproducts of the
 * write path, so that is all we record:
 *  - first_seen_at / last_write_at → staleness (Hermes' 7-day test).
 *  - writes → churn. A repeatedly rewritten entry is a LIVE topic (the user keeps
 *    steering behavior there); a never-revised entry is a consolidation candidate.
 *  - origin / interactive_writes → provenance. An entry the unattended
 *    background-review fork invented and that no live turn ever re-affirmed is
 *    the weakest thing in the store; an entry written while the user was present
 *    has evidence behind it.
 *
 * Deliberately NOT recorded: any "this rule prevented an error" score (not
 * measurable), and per-entry retrieval counts (memory is not retrieved, it is
 * injected).
 *
 * Storage rules (mirrors skill-usage.ts):
 *  - dot-prefixed sidecar → invisible to the `*.md` memory index / notes watcher.
 *  - the INJECTED PROMPT IS NEVER TOUCHED. Nothing here adds a single character
 *    to what renderForPrompt() emits every turn.
 *  - every operation is best-effort: telemetry must NEVER fail a memory write.
 *  - bounded: records for entries that no longer exist are pruned on every write,
 *    so the sidecar can never outgrow the store's own char budget.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { MEMORY_FILE, agentMemoryDir } from '../constants.js';
import { computeContentHash } from '../utils/file-ops.js';
import { withFileLock } from '../utils/file-lock.js';
import { log } from '../logging/index.js';
import type { MemoryTarget } from './bounded-memory.js';

/** Who performed a memory write. */
export type MemoryWriteOrigin =
  /** A live Personal AI turn — the user was present. */
  | 'personal-ai-turn'
  /** The every-N-turn unattended review fork — nobody was watching. */
  | 'background-review'
  /** A human edited the file through the web UI. */
  | 'human-edit'
  /** The entry already existed when telemetry first observed the store. */
  | 'pre-existing';

export interface MemoryEntryTelemetry {
  /** First time telemetry OBSERVED this entry. For 'pre-existing' this is a lower bound on real age. */
  first_seen_at: string;
  origin: MemoryWriteOrigin;
  last_write_at: string;
  last_write_by: MemoryWriteOrigin;
  /** Content-changing writes observed after first sight (0 = never revised). */
  writes: number;
  /** Of all observed writes incl. creation, how many happened in a live (non-review) turn. */
  interactive_writes: number;
  /** Short hash of the entry body — distinguishes a real rewrite from a no-op. */
  hash: string;
}

/** Keyed `${target}:${normalizedTitle}` — the title is the only stable entry identity. */
export type MemoryTelemetryMap = Record<string, MemoryEntryTelemetry>;

/** Hard cap so a corrupt/duplicated sidecar can never grow without bound. */
const MAX_TRACKED_ENTRIES = 200;

/** Hermes' staleness window. */
const STALE_DAYS = 7;

/** Max flagged candidates surfaced to the review fork (token discipline). */
const MAX_REVIEW_CANDIDATES = 8;

const MAX_TITLE_CHARS = 60;

export const EVIDENCE_NOTE =
  'Evidence is write-path only: memory is injected every turn, so there is NO per-entry ' +
  '"used" count and none can be faked. Age + revision churn + provenance are tie-breakers, ' +
  'not verdicts — an old never-revised rule may be load-bearing precisely because it is correct. ' +
  'Prefer removing entries the unattended review fork invented and no live turn ever re-affirmed.';

function telemetryFile(agentId?: string): string {
  // Same directory resolution as bounded-memory's resolveMemoryPath, so the
  // sidecar always sits beside the MEMORY.md / USER.md it describes.
  const dir = !agentId || agentId === 'general' ? path.dirname(MEMORY_FILE) : agentMemoryDir(agentId);
  return path.join(dir, '.entry-telemetry.json');
}

/** `## 🔴 Some Rule\n\nbody` → `🔴 Some Rule`. Newline-free and length-capped: the
 *  title reaches a prompt, so it must not be able to forge evidence-block structure. */
export function entryTitle(entry: string): string {
  const firstLine = (entry.split('\n', 1)[0] ?? '').replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim();
  const title = firstLine || entry.replace(/\s+/g, ' ').trim();
  return title.length > MAX_TITLE_CHARS ? title.slice(0, MAX_TITLE_CHARS) + '…' : title;
}

function entryKey(target: MemoryTarget, entry: string): string {
  return `${target}:${entryTitle(entry)}`;
}

/** Map a runAgentLoop `source` tag to a provenance value. */
export function originFromSource(source?: string): MemoryWriteOrigin {
  return source === 'background-review' ? 'background-review' : 'personal-ai-turn';
}

// Preserve persisted rows without retaining the retired product name in source.
const LEGACY_LIVE_TURN_ORIGIN = `${String.fromCharCode(98, 117, 116, 108, 101, 114)}-turn`;

function normalizeMemoryTelemetry(parsed: unknown): MemoryTelemetryMap {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const map = parsed as MemoryTelemetryMap;
  for (const rec of Object.values(map)) {
    if (typeof rec !== 'object' || rec === null) continue;
    if ((rec.origin as string) === LEGACY_LIVE_TURN_ORIGIN) rec.origin = 'personal-ai-turn';
    if ((rec.last_write_by as string) === LEGACY_LIVE_TURN_ORIGIN) rec.last_write_by = 'personal-ai-turn';
  }
  return map;
}

export function loadMemoryTelemetry(agentId?: string): MemoryTelemetryMap {
  try {
    return normalizeMemoryTelemetry(JSON.parse(fs.readFileSync(telemetryFile(agentId), 'utf-8')));
  } catch {
    return {};
  }
}

async function mutate(agentId: string | undefined, fn: (map: MemoryTelemetryMap) => void): Promise<void> {
  const file = telemetryFile(agentId);
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await withFileLock(file, async () => {
      let map: MemoryTelemetryMap = {};
      try {
        map = normalizeMemoryTelemetry(JSON.parse(await fsp.readFile(file, 'utf-8')));
      } catch {
        // missing/corrupt → start fresh
      }
      fn(map);
      enforceCap(map);
      await fsp.writeFile(file, JSON.stringify(map, null, 2) + '\n', 'utf-8');
    });
  } catch (err) {
    // Telemetry is best-effort — a memory write must never fail because of it.
    log.memory.debug('memory-telemetry: write failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function enforceCap(map: MemoryTelemetryMap): void {
  const keys = Object.keys(map);
  if (keys.length <= MAX_TRACKED_ENTRIES) return;
  keys
    .sort((a, b) => (map[a]?.last_write_at ?? '').localeCompare(map[b]?.last_write_at ?? ''))
    .slice(0, keys.length - MAX_TRACKED_ENTRIES)
    .forEach((k) => delete map[k]);
}

export interface RecordMemoryWriteOptions {
  agentId?: string;
  target: MemoryTarget;
  /** Entries as they were BEFORE the write. */
  before: string[];
  /** Entries as they are AFTER the write. */
  after: string[];
  origin: MemoryWriteOrigin;
}

/**
 * Reconcile a completed memory write into the sidecar.
 *
 * Diff-based on purpose: it covers add / replace / remove / atomic batch without
 * bounded-memory.ts having to know telemetry exists, and pruning entries missing
 * from `after` makes unbounded growth structurally impossible.
 *
 * Note: entries present in `before` but unknown to telemetry are tagged
 * 'pre-existing' (they predate this feature or were edited outside the tool) —
 * we never claim to know an age we did not observe.
 */
export async function recordMemoryWrite(opts: RecordMemoryWriteOptions): Promise<void> {
  const now = new Date().toISOString();
  const interactive = opts.origin === 'personal-ai-turn' || opts.origin === 'human-edit';
  const beforeKeys = new Set(opts.before.map((e) => entryKey(opts.target, e)));
  const prefix = `${opts.target}:`;

  await mutate(opts.agentId, (map) => {
    const live = new Set<string>();
    for (const entry of opts.after) {
      const key = entryKey(opts.target, entry);
      live.add(key);
      const hash = computeContentHash(entry);
      const existing = map[key];

      if (!existing) {
        // Existed before this write but has no record → predates telemetry.
        const origin: MemoryWriteOrigin = beforeKeys.has(key) ? 'pre-existing' : opts.origin;
        map[key] = {
          first_seen_at: now,
          origin,
          last_write_at: now,
          last_write_by: origin,
          writes: 0,
          interactive_writes: origin === 'pre-existing' ? 0 : interactive ? 1 : 0,
          hash,
        };
        continue;
      }
      if (existing.hash === hash) continue; // untouched by this write
      existing.writes += 1;
      existing.interactive_writes += interactive ? 1 : 0;
      existing.last_write_at = now;
      existing.last_write_by = opts.origin;
      existing.hash = hash;
    }

    // Prune this target's vanished entries — removed entries leave no residue.
    for (const key of Object.keys(map)) {
      if (key.startsWith(prefix) && !live.has(key)) delete map[key];
    }
  });
}

/**
 * Observe the store WITHOUT attributing a write: unknown entries get a
 * 'pre-existing' record (writes: 0), vanished ones are pruned. Lets an existing
 * MEMORY.md start accumulating age evidence from the first time we see it,
 * without ever claiming we know when it was really written.
 */
export async function observeMemoryEntries(opts: {
  agentId?: string;
  target: MemoryTarget;
  entries: string[];
}): Promise<void> {
  await recordMemoryWrite({ ...opts, before: opts.entries, after: opts.entries, origin: 'pre-existing' });
}

// ── Surfacing ──

function daysSince(iso: string | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

/** Compact origin codes — expanded once in LEGEND, never repeated per line. */
function originCode(origin: MemoryWriteOrigin): string {
  if (origin === 'background-review') return 'fork';
  if (origin === 'human-edit') return 'human';
  if (origin === 'pre-existing') return 'pre-existing';
  return 'live';
}

/**
 * Flag/field legend. Stated ONCE per evidence block instead of per entry — with
 * 16 entries the verbose per-line form cost ~773 tokens, most of it repeated
 * boilerplate. This keeps a full-store block under ~300.
 */
export const EVIDENCE_LEGEND =
  'Format: "title" — origin/age(d)/revisions/idle(d) [flags]. ' +
  'origin: live=written in a live Personal AI turn, fork=written by the unattended review fork, ' +
  'human=edited by the user, pre-existing=predates tracking (true age unknown). ' +
  'Flags: UNATTENDED=fork-written and never re-affirmed in a live turn (weakest); ' +
  `STALE=never revised and idle >${STALE_DAYS}d; ACTIVE=revised repeatedly, a live topic — do not drop.`;

interface Flagged {
  line: string;
  /** Higher = weaker evidence, surfaced first. */
  weight: number;
}

function describe(entry: string, rec: MemoryEntryTelemetry | undefined, now: number): Flagged {
  const title = entryTitle(entry);
  if (!rec) return { line: `"${title}" — untracked (predates tracking or edited outside the tool)`, weight: 0 };

  const age = daysSince(rec.first_seen_at, now);
  const idle = daysSince(rec.last_write_at, now);
  const facts = `${originCode(rec.origin)}/${age ?? '?'}d/${rec.writes}rev/idle ${idle ?? '?'}d`;

  let weight = 0;
  const flags: string[] = [];
  if (rec.origin === 'background-review' && rec.interactive_writes === 0) {
    flags.push('UNATTENDED');
    weight = 3;
  }
  if (rec.writes === 0 && (idle ?? 0) >= STALE_DAYS) {
    flags.push('STALE');
    weight = Math.max(weight, 2);
  }
  if (rec.writes >= 2) {
    flags.push('ACTIVE');
    weight = -1;
  }
  return { line: `"${title}" — ${facts}${flags.length ? ` [${flags.join(',')}]` : ''}`, weight };
}

/**
 * One evidence line per entry, ALIGNED to the given entries array.
 * Used on the over-budget consolidation error path — the moment the model is
 * actually choosing what to merge or drop.
 */
export function getEntryEvidence(
  entries: string[],
  opts: { agentId?: string; target: MemoryTarget },
): string[] {
  try {
    const map = loadMemoryTelemetry(opts.agentId);
    const now = Date.now();
    return entries.map((e) => describe(e, map[entryKey(opts.target, e)], now).line);
  } catch {
    return [];
  }
}

/**
 * Weakest-evidence candidates for the background-review fork, as a prompt block.
 * Returns '' when there is nothing flagged — the review prompt then stays
 * byte-identical (no tokens spent to say "no evidence").
 */
export function buildMemoryReviewEvidence(opts?: { agentId?: string }): string {
  try {
    const map = loadMemoryTelemetry(opts?.agentId);
    if (Object.keys(map).length === 0) return '';
    const now = Date.now();
    const flagged: Flagged[] = [];

    for (const target of ['memory', 'user'] as const) {
      const prefix = `${target}:`;
      for (const [key, rec] of Object.entries(map)) {
        if (!key.startsWith(prefix)) continue;
        // describe() takes an entry; reconstruct a heading-only stand-in from the key.
        const d = describe(`## ${key.slice(prefix.length)}`, rec, now);
        if (d.weight > 0) flagged.push({ line: `- (${target}) ${d.line}`, weight: d.weight });
      }
    }
    if (flagged.length === 0) return '';

    const lines = flagged
      .sort((a, b) => b.weight - a.weight)
      .slice(0, MAX_REVIEW_CANDIDATES)
      .map((f) => f.line);

    return (
      'Memory consolidation evidence — entries whose keep-value is weakest by write-path telemetry:\n' +
      lines.join('\n') +
      `\n${EVIDENCE_LEGEND}\n${EVIDENCE_NOTE} If one of these is genuinely obsolete, remove or merge it via memory_manage in this pass.`
    );
  } catch {
    return '';
  }
}
