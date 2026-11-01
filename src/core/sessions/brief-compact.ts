/**
 * The compact read of a Brief (brief_read compact:true, GET /api/v1/tasks/:id/brief?compact=1).
 * 2026-11-01: a full read cost 8 to 10k tokens (the letter, the team's three lists, and the rules
 * with those lists inside them again), and the `brief` hint asks Main and every lead to refresh
 * every few messages, so most reads paid that to learn nothing moved. The compact read carries only
 * what moved since the letter was written (each with the letter's own line, the exact text an edit
 * replaces), the live lists of the sections those moves touch, the stored rule breaks, and the
 * rules only on a session's first read of that node (or when their wording changed).
 * Nothing moved = a few lines.
 */
import { BRIEF_SECTIONS } from '../user-status.js';
import type { BriefFreshness } from './brief-fresh.js';
import { headingSection, type BriefSectionKey } from './brief-structure.js';

const REF_ID_RE = /<task-ref\b[^>]*\bid="([^"]+)"/;

/** Each task the letter names: its first line and the section it sits in. */
function letterLines(text: string): Map<string, { line: string; section: BriefSectionKey | null }> {
  const out = new Map<string, { line: string; section: BriefSectionKey | null }>();
  let current: BriefSectionKey | null = null;
  for (const line of text.split('\n')) {
    const heading = headingSection(line);
    if (heading) { current = heading; continue; }
    const id = line.match(REF_ID_RE)?.[1];
    if (id && !out.has(id)) out.set(id, { line, section: current });
  }
  return out;
}

/** The task a live section line is about: its first pill. */
function lineTaskId(line: string): string | undefined {
  return line.match(REF_ID_RE)?.[1];
}

export interface CompactBrief {
  compact: true;
  /** When it was written and how long it is; the text itself is left out (brief_read without compact has it). */
  brief: { at: string; chars: number };
  fresh: {
    stale: boolean;
    words: string;
    /** Named tasks whose status moved: the live words, and the letter's line to edit. */
    moved: Array<{ id: string; state: string; words: string; line?: string }>;
    /** Named tasks that finished: Walnut drops their lines; `line` is what it drops. */
    finished: Array<{ id: string; line?: string }>;
    /** Tasks that ask the user now and the letter leaves out: Walnut's live line for each. */
    newAsks: Array<{ id: string; line?: string }>;
  };
  /** The live lists of only the sections a move touched (where a task was and where it is now). */
  sections: Partial<Record<BriefSectionKey, string[]>>;
}

/**
 * Build the compact read from what the full read computes. `fresh` null means the letter names
 * nothing Walnut can judge yet (no marks): it reads as nothing moved.
 */
export function compactBrief(
  brief: { text: string; at: string },
  fresh: (BriefFreshness & { words: string }) | null,
  sections: Record<BriefSectionKey, string[]> | null,
  /** The live line of a task the lists left out (each stops at a cap, then "and N more"). */
  lineOf?: (id: string) => string | undefined,
): CompactBrief {
  const named = letterLines(brief.text);
  const liveLine = new Map<string, { line: string; section: BriefSectionKey }>();
  for (const { state } of BRIEF_SECTIONS) {
    for (const line of sections?.[state] ?? []) {
      const id = lineTaskId(line);
      if (id && !liveLine.has(id)) liveLine.set(id, { line, section: state });
    }
  }
  const touched = new Set<BriefSectionKey>();
  const touch = (id: string) => {
    const was = named.get(id)?.section;
    if (was) touched.add(was);
    const now = liveLine.get(id)?.section;
    if (now) touched.add(now);
  };
  const moved = (fresh?.moved ?? []).map((m) => {
    touch(m.id);
    // A move into a section the letter's line is not under always touches the live one.
    if (m.state !== 'done') touched.add(m.state as BriefSectionKey);
    const line = named.get(m.id)?.line;
    return { id: m.id, state: m.state, words: m.words, ...(line ? { line } : {}) };
  });
  const finished = (fresh?.finished ?? []).map((id) => {
    touch(id);
    const line = named.get(id)?.line;
    return { id, ...(line ? { line } : {}) };
  });
  const newAsks = (fresh?.newAsks ?? []).map((id) => {
    touched.add('needs');
    const line = liveLine.get(id)?.line ?? lineOf?.(id);
    return { id, ...(line ? { line } : {}) };
  });
  const out: Partial<Record<BriefSectionKey, string[]>> = {};
  for (const { state } of BRIEF_SECTIONS) {
    if (touched.has(state) && sections) out[state] = sections[state];
  }
  return {
    compact: true,
    brief: { at: brief.at, chars: brief.text.length },
    fresh: { stale: !!fresh?.stale, words: fresh?.words ?? '', moved, finished, newAsks },
    sections: out,
  };
}

// ── The rules, once per session ────────────────────────────────────────────────────────────────

/** Sessions remembered; past it the oldest go, and they simply get the rules once more. */
const SEEN_MAX = 500;
/** `<reader>|<node id>` -> the hash of the rules' wording that reader was given. A reader is a
 *  session as of its last compaction (the route keys it so). */
const seenRules = new Map<string, string>();

function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * Whether this read must carry the rules: a caller with no session id always gets them, a
 * session gets them on its first read of this node, again after a compaction (a new reader key)
 * and again when their wording changed
 * (`wording` is the rules without the live lists, which change every read). A server restart
 * forgets, so a session reads them once more after one.
 */
export function rulesDue(callerSid: string | undefined, nodeId: string, wording: string): boolean {
  if (!callerSid) return true;
  const key = `${callerSid}|${nodeId}`;
  return seenRules.get(key) !== hash(wording);
}

/** Record that this session was given the rules in this wording. */
export function noteRulesGiven(callerSid: string | undefined, nodeId: string, wording: string): void {
  if (!callerSid) return;
  const key = `${callerSid}|${nodeId}`;
  seenRules.delete(key);
  seenRules.set(key, hash(wording));
  while (seenRules.size > SEEN_MAX) seenRules.delete(seenRules.keys().next().value!);
}

/** Test hook. */
export function resetSeenRules(): void {
  seenRules.clear();
}
