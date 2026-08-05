/**
 * Bounded global memory store — Hermes-style hard-budget MEMORY.md.
 *
 * MEMORY.md holds ONLY behavior rules + user preferences as `## Title` markdown
 * sections ("entries"), under a hard character budget. Forgetting is forced onto
 * the write path: an over-budget add is rejected with the full current entries
 * and an instruction to consolidate (replace/remove) and retry in the same turn.
 *
 * Key semantics (ported from hermes-agent tools/memory_tool.py):
 * - add/replace/remove single ops + applyBatch (atomic, validated against the
 *   FINAL budget only — intermediate overflow is irrelevant, all-or-nothing).
 * - Per-turn consolidation circuit breaker: after 3 consecutive failures the
 *   response turns terminal ("stop retrying, reply to the user"). A successful
 *   write resets the counter. resetConsolidationFailures() is called at turn
 *   boundaries by the tool layer.
 * - Success responses are TERMINAL and do NOT echo entries — dumping them
 *   invites the model to "find more to fix" and re-issue the same batch.
 *   Entries are only shown on error paths where the model must decide what
 *   to consolidate.
 * - replace/remove match by substring against whole entries. Multiple DISTINCT
 *   matches → "be more specific"; identical duplicates → operate on the first.
 *
 * Anything before the first `## ` heading (frontmatter + `# title`) is preserved
 * verbatim as the preamble and does NOT count against the budget. A leading
 * frontmatter block is peeled off before the entry scan, so frontmatter a
 * markdown WYSIWYG round-trip collapsed into a `## ` heading stays preamble
 * instead of masquerading as an entry (see isCollapsedFrontmatterLine).
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { MEMORY_FILE, USER_FILE, agentMemoryDir } from '../constants.js';
import { computeContentHash } from '../utils/file-ops.js';
import { withFileLock } from '../utils/file-lock.js';
import { screenEntriesForPrompt, screenNewMemoryEntries } from './memory-safety.js';
import {
  MemoryPromptSnapshots,
  promptScope,
  type MemoryPromptDrift,
  type MemoryPromptPin,
} from './memory-prompt-snapshot.js';
import { atomicWriteSameDir, backupBeforeWrite } from './bounded-memory-backup.js';

/** Hard budget for the entries block (chars of all entries joined by "\n\n"). */
export const MEMORY_CHAR_BUDGET = 8_000;

/** Hard budget for USER.md — who the user is. Smaller: identity/preferences, not rules. */
export const USER_CHAR_BUDGET = 4_000;

/** Which bounded store a write targets (Hermes memory-tool parity). */
export type MemoryTarget = 'memory' | 'user';

/** Consecutive same-turn failures before the breaker trips. */
const MAX_CONSOLIDATION_FAILURES_PER_TURN = 3;

const ENTRY_JOIN = '\n\n';

const DEFAULT_PREAMBLE = `---
name: Global Memory
description: >
  Bounded behavior rules. Updated by the agent via the memory_manage tool
  (target: memory). Hard budget: ${MEMORY_CHAR_BUDGET} chars.
---

# MEMORY.md — Global
`;

const DEFAULT_USER_PREAMBLE = `---
name: User Profile
description: >
  Who the user is — identity, work, durable preferences. Updated by the agent
  via the memory_manage tool (target: user). Hard budget: ${USER_CHAR_BUDGET} chars.
---

# USER.md — User Profile
`;

// ── Result types ──

export interface BoundedMemorySuccess {
  success: true;
  /** Terminal marker: the write landed, do not repeat it. */
  done: true;
  message: string;
  /** e.g. "42% — 3,412/8,000 chars" */
  usage: string;
  entryCount: number;
  note: string;
}

export interface BoundedMemoryError {
  success: false;
  error: string;
  /** Full entries — only present when the model needs them to consolidate. */
  currentEntries?: string[];
  /** One-line previews when a substring matched multiple distinct entries. */
  matches?: string[];
  usage?: string;
  /** Breaker tripped: stop retrying this turn. */
  terminal?: boolean;
}

export type BoundedMemoryResult = BoundedMemorySuccess | BoundedMemoryError;

export type BoundedMemoryOperation =
  | { action: 'add'; content: string }
  | { action: 'replace'; oldText: string; content: string }
  | { action: 'remove'; oldText: string };

export interface BoundedMemorySnapshot {
  preamble: string;
  entries: string[];
  /** Chars used by the entries block. */
  usedChars: number;
  contentHash: string;
}

// ── Parsing / rendering ──

/**
 * A YAML-ish key line: ONE bare word (no spaces) followed by a colon. Used to
 * tell real frontmatter apart from body markdown that merely starts with `---`.
 * A human entry title virtually never has a single unspaced word before its
 * colon ("## Task Routing: …" has a space, so it does NOT match).
 */
const YAML_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*:(\s|$)/;

/** `## <yaml-key>: …` — the heading shape a collapsed frontmatter block takes. */
const COLLAPSED_HEAD_RE = /^## [A-Za-z_][A-Za-z0-9_.-]*:(\s|$)/;

/** A second `key:` token later in the same line (YAML lines flattened together). */
const EXTRA_YAML_KEY_RE = /\s[A-Za-z_][A-Za-z0-9_.-]*:(\s|$)/;

/** Leftovers of a markdown→HTML→markdown trip: `<`/`>`/`&` still entity-escaped. */
const HTML_ARTIFACT_RE = /&(?:lt|gt|amp|quot|#\d+);/;

/** How far to look for a closing `---` fence before giving up on frontmatter. */
const FRONTMATTER_SCAN_LIMIT = 60;

/**
 * Is this line a frontmatter block that a markdown WYSIWYG round-trip flattened
 * into a HEADING? CommonMark renders
 *
 *     ---
 *     name: X
 *     description: >
 *       prose
 *     ---
 *
 * as `<hr>` + a **setext h2** (the closing `---` underlines the YAML body as a
 * heading), so serializing that HTML back to markdown emits ONE literal
 * `## name: X description: > prose` line, with `<`/`>` left entity-escaped.
 *
 * Detection is deliberately narrow — misclassifying a real entry as frontmatter
 * would drop it on the next write. Requiring a SECOND `key:` token (or an
 * HTML-escape artifact) on the same line keeps a legitimate one-colon title like
 * `## Language: Chinese` out. `## Task Routing: …` never matches either: the RE
 * needs the colon glued to the first word.
 */
function isCollapsedFrontmatterLine(line: string): boolean {
  if (!COLLAPSED_HEAD_RE.test(line)) return false;
  const rest = line.slice(line.indexOf(':') + 1);
  return EXTRA_YAML_KEY_RE.test(rest) || HTML_ARTIFACT_RE.test(rest);
}

/**
 * Decode the HTML entities a markdown→HTML→markdown round-trip can leave behind.
 * `&lt;`/`&gt;` first, `&amp;` last, so one call peels exactly one layer
 * (`&amp;gt;` → `&gt;`) instead of over-decoding.
 */
export function decodeHtmlArtifacts(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * Peel a leading YAML frontmatter block off `lines`, returning the index of the
 * first BODY line (0 = no frontmatter). Handles both shapes:
 *
 * - well-formed `---` … `---` (a `## ` line *inside* the fence stays frontmatter)
 * - collapsed-by-WYSIWYG: opening `---`, no closing fence, and the first content
 *   line is a collapsed heading (see isCollapsedFrontmatterLine)
 */
function frontmatterEnd(lines: string[]): number {
  let open = 0;
  while (open < lines.length && lines[open].trim() === '') open++;
  if (open >= lines.length || lines[open].trim() !== '---') return 0;

  const limit = Math.min(lines.length, open + 1 + FRONTMATTER_SCAN_LIMIT);
  // First content line after the fence decides whether this is really YAML.
  let first = open + 1;
  while (first < limit && lines[first].trim() === '') first++;
  if (first >= limit) return 0;
  const firstText = lines[first].trim();

  if (YAML_KEY_RE.test(firstText)) {
    // Looks like YAML — consume through the closing fence if there is one.
    for (let i = first + 1; i < limit; i++) {
      if (lines[i].trim() === '---') return i + 1;
    }
    return 0; // unterminated YAML: leave it to the normal scan (it has no `## `)
  }

  // No YAML body: the only other legitimate shape is the collapsed heading.
  if (isCollapsedFrontmatterLine(lines[first])) return first + 1;
  return 0;
}

/**
 * Split MEMORY.md content into (preamble, entries).
 * Entries are `## Title` sections: a line starting with exactly "## " opens a
 * new entry that runs until the next such line or EOF. Note: a "## " line
 * inside a fenced code block would also split — acceptable for rule-style
 * entries (same class of limitation as Hermes' bare-§ delimiter).
 *
 * A leading frontmatter block is peeled off FIRST and is always preamble — so a
 * frontmatter block collapsed into a `## ` heading by a markdown WYSIWYG
 * round-trip can never be counted against the budget, matched by
 * replace/remove, or injected into the prompt as if it were a memory entry.
 */
export function parseMemoryContent(content: string): { preamble: string; entries: string[] } {
  const lines = content.split('\n');
  const bodyStart = frontmatterEnd(lines);
  const preambleLines: string[] = lines.slice(0, bodyStart);
  const entries: string[] = [];
  let current: string[] | null = null;

  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('## ')) {
      if (current) entries.push(current.join('\n').trim());
      current = [line];
    } else if (current) {
      current.push(line);
    } else {
      preambleLines.push(line);
    }
  }
  if (current) entries.push(current.join('\n').trim());

  return {
    preamble: preambleLines.join('\n').trimEnd(),
    entries: entries.filter((e) => e.length > 0),
  };
}

/** The fenced YAML block at the top of a preamble, or '' when there is none. */
function frontmatterBlockOf(preamble: string): string {
  const m = /^---\n[\s\S]*?\n---/.exec(preamble.replace(/^\s*\n/, ''));
  return m ? m[0] : '';
}

/**
 * Heal a preamble whose frontmatter a WYSIWYG round-trip collapsed: rebuild the
 * canonical fenced YAML from `fallback` and keep whatever real preamble content
 * (the `# Title`, any prose) survived, with HTML-escape artifacts decoded.
 * An already-well-formed preamble is returned untouched, so render is a no-op
 * for healthy files and parse→render→parse is stable for broken ones.
 */
function normalizePreamble(preamble: string, fallback: string): string {
  if (!preamble || !preamble.split('\n').some(isCollapsedFrontmatterLine)) {
    return preamble;
  }
  const kept: string[] = [];
  let droppedFence = false;
  for (const line of preamble.split('\n')) {
    if (isCollapsedFrontmatterLine(line)) continue;
    // The orphaned `---` the collapse left behind renders as an <hr>, not YAML.
    if (!droppedFence && line.trim() === '---') {
      droppedFence = true;
      continue;
    }
    kept.push(decodeHtmlArtifacts(line));
  }
  const rest = kept.join('\n').trim();
  const frontmatter = frontmatterBlockOf(fallback);
  if (!frontmatter) return rest;
  return rest ? `${frontmatter}\n\n${rest}` : frontmatter;
}

export function renderMemoryContent(
  preamble: string,
  entries: string[],
  fallbackPreamble = DEFAULT_PREAMBLE,
): string {
  const healed = normalizePreamble(preamble, fallbackPreamble);
  const head = (healed || fallbackPreamble.trimEnd()).trimEnd();
  if (entries.length === 0) return head + '\n';
  return head + '\n\n' + entries.join(ENTRY_JOIN) + '\n';
}

function entriesChars(entries: string[]): number {
  return entries.length === 0 ? 0 : entries.join(ENTRY_JOIN).length;
}

function formatUsage(used: number, limit = MEMORY_CHAR_BUDGET): string {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return `${pct}% — ${used.toLocaleString('en-US')}/${limit.toLocaleString('en-US')} chars`;
}

function previews(entries: string[], width = 80): string[] {
  return entries.map((e) => {
    const oneLine = e.replace(/\s+/g, ' ');
    return oneLine.length > width ? oneLine.slice(0, width) + '…' : oneLine;
  });
}

/** Entries must be self-titled sections so the file stays scannable. */
function validateEntryShape(content: string): string | null {
  if (!content) return 'Content cannot be empty.';
  if (!/^## \S/.test(content)) {
    return 'Entry must be a markdown section starting with a "## Title" heading line.';
  }
  return null;
}

// ── Store ──

function resolveMemoryPath(agentId?: string, target: MemoryTarget = 'memory'): string {
  if (!agentId || agentId === 'general') return target === 'user' ? USER_FILE : MEMORY_FILE;
  return path.join(agentMemoryDir(agentId), target === 'user' ? 'USER.md' : 'MEMORY.md');
}

export class BoundedMemoryStore {
  private readonly filePath: string;
  private readonly budget: number;
  private readonly defaultPreamble: string;
  /** Human-readable store name, used in safety-screen log lines and markers. */
  private readonly label: string;
  private consolidationFailures = 0;
  /** Frozen per-turn prompt renders + drift detection (see memory-prompt-snapshot.ts). */
  private readonly snapshots: MemoryPromptSnapshots;
  /**
   * Monotonic count of successful writes through THIS store. The drift detector
   * compares it across pins to tell "our own write" from an external edit; it is
   * never persisted, because a restart also drops every pin it could be compared
   * against.
   */
  private writeEpoch = 0;

  constructor(agentId?: string, target: MemoryTarget = 'memory') {
    this.filePath = resolveMemoryPath(agentId, target);
    this.budget = target === 'user' ? USER_CHAR_BUDGET : MEMORY_CHAR_BUDGET;
    this.defaultPreamble = target === 'user' ? DEFAULT_USER_PREAMBLE : DEFAULT_PREAMBLE;
    this.label = target === 'user' ? 'USER.md' : 'MEMORY.md';
    this.snapshots = new MemoryPromptSnapshots(this.label);
  }

  /** Call at each turn boundary — the breaker counts consecutive failures within one turn. */
  resetConsolidationFailures(): void {
    this.consolidationFailures = 0;
  }

  /** The hard char budget this store enforces (target-dependent). */
  get charBudget(): number {
    return this.budget;
  }

  /** Read current state from disk (no lock — point-in-time snapshot). */
  async read(): Promise<BoundedMemorySnapshot> {
    let raw = '';
    try {
      raw = await fsp.readFile(this.filePath, 'utf-8');
    } catch {
      // Missing file = empty store
    }
    const { preamble, entries } = parseMemoryContent(raw);
    return {
      preamble,
      entries,
      usedChars: entriesChars(entries),
      contentHash: computeContentHash(raw),
    };
  }

  /** Synchronous read for prompt building (context.ts is sync at that point). */
  readSync(): BoundedMemorySnapshot {
    let raw = '';
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch {
      // Missing file = empty store
    }
    const { preamble, entries } = parseMemoryContent(raw);
    return {
      preamble,
      entries,
      usedChars: entriesChars(entries),
      contentHash: computeContentHash(raw),
    };
  }

  /**
   * Render the entries block for system-prompt injection, with a usage header
   * so the model always knows how full memory is. Returns null when empty.
   *
   * FROZEN when `scope` names a pinned scope (see memory-prompt-snapshot.ts):
   * every render inside one turn returns the block captured at that turn's
   * boundary, even if a write landed on disk mid-turn. Unpinned / omitted scope
   * reads live from disk, so freezing stays opt-in and a caller is never
   * silently pinned to stale content just by existing.
   */
  renderForPrompt(scope?: string): string | null {
    if (scope !== undefined) {
      const pinned = this.snapshots.get(scope);
      if (pinned) return pinned.block;
    }
    return this.renderLive().block;
  }

  /**
   * Freeze the current on-disk render for `scope` and return any drift observed
   * since this scope's previous pin. Called at main-butler turn boundaries — the
   * ONLY thing that refreshes a pin besides an explicit invalidate.
   */
  beginPromptTurn(scope: string): MemoryPromptDrift | null {
    const { block, contentHash } = this.renderLive();
    return this.snapshots.pin(scope, block, contentHash, this.writeEpoch);
  }

  /**
   * Drop the frozen render for `scope` (all scopes when omitted) so the next
   * render reads disk. For writes that bypass this store AND represent explicit
   * human intent — the memory editor's full-file PUT — plus tests.
   */
  invalidatePromptSnapshot(scope?: string): void {
    this.snapshots.invalidate(scope);
  }

  /** The frozen pin for `scope`, if any. Observability + tests. */
  getPromptSnapshot(scope: string): MemoryPromptPin | undefined {
    return this.snapshots.get(scope);
  }

  /** Most recent drift observed at a pin boundary, or null. */
  lastPromptDrift(): MemoryPromptDrift | null {
    return this.snapshots.lastDrift();
  }

  /**
   * Compare the CURRENT on-disk hash against a scope's pin without re-pinning.
   * Lets a caller ask "has memory moved under this turn?" mid-turn; a pinned
   * render deliberately keeps serving the old block regardless of the answer.
   */
  detectDrift(scope: string): { drifted: boolean; pinnedHash?: string; diskHash: string } {
    const diskHash = this.readSync().contentHash;
    const pinned = this.snapshots.get(scope);
    if (!pinned) return { drifted: false, diskHash };
    return { drifted: pinned.contentHash !== diskHash, pinnedHash: pinned.contentHash, diskHash };
  }

  /** Live disk render — the pre-freeze behavior, and what a pin captures. */
  private renderLive(): { block: string | null; contentHash: string } {
    const snap = this.readSync();
    if (snap.entries.length === 0) return { block: null, contentHash: snap.contentHash };
    // Injection-time safety screen (see memory-safety.ts). Enforced HERE as well
    // as at write time because memory files also reach disk via paths that never
    // pass through mutate(): PUT /api/memory/global (the web editor's full-file
    // replacement), the data-repo sync plane, file_write on a memory path, and
    // hand edits. A flagged entry is swapped for a visible quarantine marker —
    // never dropped, and disk is never touched. Fail-open by contract: a screen
    // error returns the entries unchanged, so a bug here cannot blank memory.
    const entries = screenEntriesForPrompt(snap.entries, this.label);
    const header = `[Memory usage: ${formatUsage(snap.usedChars, this.budget)}]`;
    return { block: `${header}\n\n${entries.join(ENTRY_JOIN)}`, contentHash: snap.contentHash };
  }

  async add(content: string): Promise<BoundedMemoryResult> {
    const trimmed = (content ?? '').trim();
    const shapeError = validateEntryShape(trimmed);
    if (shapeError) return { success: false, error: shapeError };

    return this.mutate((entries) => {
      // Idempotent: exact duplicate is a success, not an error (and terminal).
      if (entries.includes(trimmed)) {
        return { kind: 'success', entries, message: 'Entry already exists (no duplicate added).' };
      }
      const next = [...entries, trimmed];
      const newTotal = entriesChars(next);
      if (newTotal > this.budget) {
        return {
          kind: 'over-budget',
          error:
            `Memory at ${formatUsage(entriesChars(entries), this.budget)}. Adding this entry ` +
            `(${trimmed.length} chars) would exceed the ${this.budget.toLocaleString('en-US')}-char limit. ` +
            `Consolidate now: 'replace' to merge overlapping entries into shorter ones, or 'remove' stale ` +
            `or less important entries (see currentEntries), then retry this add — all in this turn. ` +
            `Prefer a single 'batch' call that frees space AND adds in one step.`,
        };
      }
      return { kind: 'success', entries: next, message: 'Entry added.' };
    });
  }

  async replace(oldText: string, content: string): Promise<BoundedMemoryResult> {
    const needle = (oldText ?? '').trim();
    const trimmed = (content ?? '').trim();
    if (!needle) return { success: false, error: 'oldText cannot be empty.' };
    if (!trimmed) {
      return { success: false, error: "content cannot be empty. Use 'remove' to delete entries." };
    }
    const shapeError = validateEntryShape(trimmed);
    if (shapeError) return { success: false, error: shapeError };

    return this.mutate((entries) => {
      const match = this.matchOne(entries, needle);
      if ('error' in match) return match;

      const next = [...entries];
      next[match.index] = trimmed;
      const newTotal = entriesChars(next);
      if (newTotal > this.budget) {
        return {
          kind: 'over-budget',
          error:
            `Replacement would put memory at ${formatUsage(newTotal, this.budget)} — over the limit. ` +
            `Shorten the new content, or 'remove' other stale entries to make room ` +
            `(see currentEntries), then retry — all in this turn.`,
        };
      }
      return { kind: 'success', entries: next, message: 'Entry replaced.' };
    });
  }

  async remove(oldText: string): Promise<BoundedMemoryResult> {
    const needle = (oldText ?? '').trim();
    if (!needle) return { success: false, error: 'oldText cannot be empty.' };

    return this.mutate((entries) => {
      const match = this.matchOne(entries, needle);
      if ('error' in match) return match;
      const next = entries.filter((_, i) => i !== match.index);
      return { kind: 'success', entries: next, message: 'Entry removed.' };
    });
  }

  /**
   * Apply a sequence of add/replace/remove ops atomically.
   * Validated against the FINAL budget only — free space and add new entries in
   * ONE call instead of a multi-turn consolidate-then-retry dance. All-or-nothing:
   * if any op is malformed, doesn't match, or the net result exceeds the budget,
   * nothing is written.
   */
  async applyBatch(operations: BoundedMemoryOperation[]): Promise<BoundedMemoryResult> {
    if (!operations || operations.length === 0) {
      return { success: false, error: 'operations list is empty.' };
    }

    return this.mutate((entries) => {
      const working = [...entries];

      for (let i = 0; i < operations.length; i++) {
        const op = operations[i] ?? ({} as BoundedMemoryOperation);
        const pos = `Operation ${i + 1} (${(op as { action?: string }).action ?? 'unknown'})`;

        if (op.action === 'add') {
          const content = (op.content ?? '').trim();
          const shapeError = validateEntryShape(content);
          if (shapeError) return { kind: 'batch-error', error: `${pos}: ${shapeError}` };
          if (working.includes(content)) continue; // idempotent — skip duplicate, don't fail the batch
          working.push(content);
        } else if (op.action === 'replace') {
          const needle = (op.oldText ?? '').trim();
          const content = (op.content ?? '').trim();
          if (!needle) return { kind: 'batch-error', error: `${pos}: oldText is required.` };
          const shapeError = validateEntryShape(content);
          if (shapeError) return { kind: 'batch-error', error: `${pos}: ${shapeError}` };
          const match = this.matchInWorking(working, needle, pos);
          if (typeof match !== 'number') return match;
          working[match] = content;
        } else if (op.action === 'remove') {
          const needle = (op.oldText ?? '').trim();
          if (!needle) return { kind: 'batch-error', error: `${pos}: oldText is required.` };
          const match = this.matchInWorking(working, needle, pos);
          if (typeof match !== 'number') return match;
          working.splice(match, 1);
        } else {
          return {
            kind: 'batch-error',
            error: `${pos}: unknown action. Use add, replace, or remove.`,
          };
        }
      }

      const newTotal = entriesChars(working);
      if (newTotal > this.budget) {
        return {
          kind: 'over-budget',
          error:
            `After applying all ${operations.length} operation(s), memory would be at ` +
            `${formatUsage(newTotal, this.budget)} — over the limit. Remove or shorten more entries in the ` +
            `same batch (see currentEntries), then retry.`,
        };
      }
      return { kind: 'success', entries: working, message: `Applied ${operations.length} operation(s).` };
    });
  }

  // ── Internals ──

  private matchOne(
    entries: string[],
    needle: string,
  ): { index: number } | { kind: 'no-match'; error: string } | { kind: 'ambiguous'; error: string; matches: string[] } {
    const matches = entries
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.includes(needle));
    if (matches.length === 0) {
      return {
        kind: 'no-match',
        error: `No entry matched '${needle}'. Check currentEntries and retry with the exact text of the entry you want to change.`,
      };
    }
    if (matches.length > 1) {
      const unique = new Set(matches.map((m) => m.e));
      if (unique.size > 1) {
        return {
          kind: 'ambiguous',
          error: `Multiple entries matched '${needle}'. Be more specific.`,
          matches: previews(matches.map((m) => m.e)),
        };
      }
      // All identical duplicates — operate on the first.
    }
    return { index: matches[0].i };
  }

  private matchInWorking(
    working: string[],
    needle: string,
    pos: string,
  ): number | { kind: 'batch-error'; error: string } {
    const matches = working
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.includes(needle));
    if (matches.length === 0) {
      return { kind: 'batch-error', error: `${pos}: no entry matched '${needle}'.` };
    }
    if (new Set(matches.map((m) => m.e)).size > 1) {
      return {
        kind: 'batch-error',
        error: `${pos}: '${needle}' matched multiple distinct entries — be more specific.`,
      };
    }
    return matches[0].i;
  }

  /**
   * Locked read-modify-write. The mutator receives the live entries (re-read
   * from disk under the lock, picking up writes from other processes) and
   * returns either a success (new entries to commit) or an error outcome.
   */
  private async mutate(
    fn: (entries: string[]) =>
      | { kind: 'success'; entries: string[]; message: string }
      | { kind: 'over-budget'; error: string }
      | { kind: 'batch-error'; error: string }
      | { kind: 'no-match'; error: string }
      | { kind: 'ambiguous'; error: string; matches: string[] },
  ): Promise<BoundedMemoryResult> {
    return withFileLock(this.filePath, async () => {
      let raw = '';
      try {
        raw = await fsp.readFile(this.filePath, 'utf-8');
      } catch {
        // Missing file = empty store
      }
      const { preamble, entries } = parseMemoryContent(raw);
      const outcome = fn(entries);

      if (outcome.kind === 'success') {
        // Write-time safety screen — the single enforcement point for every
        // mutation path (add/replace/remove/batch all funnel here). Only entries
        // NEW relative to what is on disk are screened, so an already-poisoned
        // entry never blocks unrelated writes (including the remove that deletes
        // it). Rejection is a plain error: nothing is written, existing memory is
        // untouched. Deliberately BEFORE backupBeforeWrite — a rejected write
        // must not burn a backup generation. Fail-open by contract (returns null
        // on internal error), so a screen bug can never cost a real write.
        const screenError = screenNewMemoryEntries(entries, outcome.entries, this.label);
        if (screenError) {
          // NOT a consolidation failure — retrying will not help, so it must not
          // consume the breaker budget that guards genuine over-budget retries.
          return { success: false, error: screenError, terminal: true };
        }
        const rendered = renderMemoryContent(preamble, outcome.entries, this.defaultPreamble);
        await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
        // Snapshot the state we are about to overwrite. Best-effort by contract
        // (never throws) — a lost safety net must not cost us the write. See
        // bounded-memory-backup.ts for the retention policy and why it exists.
        await backupBeforeWrite(this.filePath, raw, rendered);
        await atomicWriteSameDir(this.filePath, rendered);
        return this.successResponse(outcome.entries, outcome.message);
      }

      if (outcome.kind === 'ambiguous') {
        // Ambiguity is a precision problem, not a consolidation failure — no breaker.
        return { success: false, error: outcome.error, matches: outcome.matches };
      }

      // over-budget / no-match / batch-error all count as consolidation failures:
      // the model is expected to fix and retry within the turn, but the breaker
      // stops an infinite retry loop from eating the turn budget.
      return this.consolidationFailure({
        success: false,
        error:
          outcome.kind === 'batch-error'
            ? outcome.error + ' No operations were applied (batch is all-or-nothing).'
            : outcome.error,
        currentEntries: entries,
        usage: formatUsage(entriesChars(entries), this.budget),
      });
    });
  }

  private successResponse(entries: string[], message: string): BoundedMemorySuccess {
    // Progress made — the per-turn failure budget counts CONSECUTIVE failures.
    this.consolidationFailures = 0;
    // Mark that a write went through THIS store, so the next pin boundary can
    // tell our own change from an external edit. Deliberately does NOT invalidate
    // any pin: durability is immediate (the bytes are already on disk), but the
    // prompt view stays frozen for the rest of the turn — that is the whole point
    // of the Hermes pattern (no same-turn re-learn of what we just wrote).
    this.writeEpoch += 1;
    return {
      success: true,
      done: true,
      message,
      usage: formatUsage(entriesChars(entries), this.budget),
      entryCount: entries.length,
      note: 'Write saved. This update is complete — do not repeat it.',
    };
  }

  private consolidationFailure(response: BoundedMemoryError): BoundedMemoryError {
    this.consolidationFailures += 1;
    if (this.consolidationFailures <= MAX_CONSOLIDATION_FAILURES_PER_TURN) {
      return response;
    }
    // Breaker tripped: stop the consolidate-retry loop from suppressing the
    // user's reply (Hermes issue #42405). Terminal — no entries echoed.
    return {
      success: false,
      terminal: true,
      error:
        `Memory consolidation failed ${this.consolidationFailures} times this turn. ` +
        `STOP retrying memory operations now and reply to the user. ` +
        `You can consolidate memory in a future turn.`,
    };
  }
}

// ── Module-level store cache (one instance per agent+target, breaker state lives here) ──

const stores = new Map<string, BoundedMemoryStore>();

export function getBoundedMemory(agentId?: string, target: MemoryTarget = 'memory'): BoundedMemoryStore {
  const key = resolveMemoryPath(agentId, target);
  let store = stores.get(key);
  if (!store) {
    store = new BoundedMemoryStore(agentId, target);
    stores.set(key, store);
  }
  return store;
}

// ── Turn-boundary freeze for the two always-injected global stores ──
//
// These helpers operate on the GENERAL stores only — the ones buildMemoryContext
// injects and memory_manage writes, whatever agent is running. The agentId is
// only ever part of the SCOPE KEY (one pin per agent+conversation), never a store
// selector: pinning a per-agent store while the prompt reads the general one
// would freeze nothing at all.
//
// Both global stores freeze and thaw TOGETHER: they are rendered into adjacent
// sections of one prompt block, so a turn that pinned one and read the other
// live would be a self-inflicted inconsistency.

/** The two always-injected global stores, in prompt order. */
function globalStores(): BoundedMemoryStore[] {
  return [getBoundedMemory(), getBoundedMemory(undefined, 'user')];
}

/**
 * Freeze both global stores' prompt renders for this conversation's scope. Call
 * ONCE at a main-butler turn boundary, before building the prompt. Returns any
 * drift observed since that scope's previous turn (see memory-prompt-snapshot.ts
 * for the refresh policy and the self-vs-external attribution rule).
 */
export function beginMemoryPromptTurn(
  agentId?: string,
  conversationId?: string,
): { scope: string; drift: MemoryPromptDrift[] } {
  const scope = promptScope(agentId, conversationId);
  const drift: MemoryPromptDrift[] = [];
  for (const store of globalStores()) {
    const observed = store.beginPromptTurn(scope);
    if (observed) drift.push(observed);
  }
  return { scope, drift };
}

/**
 * Drop both global stores' frozen renders for one scope, or for EVERY scope when
 * called with no arguments. For the human-facing memory editor, whose full-file
 * PUT is explicit intent to change what the butler believes RIGHT NOW rather
 * than at the next turn — and for tests.
 */
export function invalidateMemoryPromptSnapshots(
  agentId?: string,
  conversationId?: string,
): void {
  const scope = agentId === undefined && conversationId === undefined
    ? undefined
    : promptScope(agentId, conversationId);
  for (const store of globalStores()) {
    store.invalidatePromptSnapshot(scope);
  }
}

export { promptScope, type MemoryPromptDrift, type MemoryPromptPin };
