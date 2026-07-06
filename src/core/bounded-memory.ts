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
 * verbatim as the preamble and does NOT count against the budget.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { MEMORY_FILE, USER_FILE, agentMemoryDir } from '../constants.js';
import { computeContentHash } from '../utils/file-ops.js';
import { withFileLock } from '../utils/file-lock.js';

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
 * Split MEMORY.md content into (preamble, entries).
 * Entries are `## Title` sections: a line starting with exactly "## " opens a
 * new entry that runs until the next such line or EOF. Note: a "## " line
 * inside a fenced code block would also split — acceptable for rule-style
 * entries (same class of limitation as Hermes' bare-§ delimiter).
 */
export function parseMemoryContent(content: string): { preamble: string; entries: string[] } {
  const lines = content.split('\n');
  const preambleLines: string[] = [];
  const entries: string[] = [];
  let current: string[] | null = null;

  for (const line of lines) {
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

function renderMemoryContent(preamble: string, entries: string[], fallbackPreamble = DEFAULT_PREAMBLE): string {
  const head = (preamble || fallbackPreamble.trimEnd()).trimEnd();
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
  private consolidationFailures = 0;

  constructor(agentId?: string, target: MemoryTarget = 'memory') {
    this.filePath = resolveMemoryPath(agentId, target);
    this.budget = target === 'user' ? USER_CHAR_BUDGET : MEMORY_CHAR_BUDGET;
    this.defaultPreamble = target === 'user' ? DEFAULT_USER_PREAMBLE : DEFAULT_PREAMBLE;
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
   */
  renderForPrompt(): string | null {
    const snap = this.readSync();
    if (snap.entries.length === 0) return null;
    const header = `[Memory usage: ${formatUsage(snap.usedChars, this.budget)}]`;
    return `${header}\n\n${snap.entries.join(ENTRY_JOIN)}`;
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
        const rendered = renderMemoryContent(preamble, outcome.entries, this.defaultPreamble);
        await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
        await fsp.writeFile(this.filePath, rendered, 'utf-8');
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
