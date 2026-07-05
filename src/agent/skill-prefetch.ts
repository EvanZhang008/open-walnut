/**
 * Per-turn semantic skill prefetch (injection moment 1 of the skill system).
 *
 * Searches the QMD `skill` collection with the raw user message and produces
 * ONE volatile hint line: "Possibly relevant skills: X, Y — load with
 * skill_view if applicable." The hint rides the VOLATILE injection point
 * (appendEphemeralContext → tail of the current user message) — the stable
 * system-prompt prefix stays byte-identical, so the prompt cache never busts.
 *
 * Best-effort by design: any error (store not ready, no embeddings, etc.)
 * silently yields no hint — a missing hint costs nothing, the full skill
 * index is still in the stable prefix.
 */
import { memoryNotesSearch } from '../core/memory-search.js';
import path from 'node:path';
import { log } from '../logging/index.js';

const MAX_HINTS = 3;
/** Skip prefetch for trivial messages (greetings, "ok", etc.) — noise, not signal. */
const MIN_MESSAGE_CHARS = 8;

export async function buildSkillPrefetchHint(userMessage: string): Promise<string | null> {
  const query = (userMessage ?? '').trim();
  if (query.length < MIN_MESSAGE_CHARS) return null;

  try {
    // Single natural-language query — the user message IS the query (Hermes:
    // no reformulation step; the backend decides lex/vec). Over-fetch (12, not
    // MAX_HINTS): the store searches the whole memory DB then post-filters to
    // the skill collection, so a tight limit lets daily/compaction noise crowd
    // skill hits out entirely.
    const results = await memoryNotesSearch([query.slice(0, 500)], ['memory_skill'], 12);
    if (results.length === 0) return null;

    const names = [...new Set(
      results.map((r) => path.basename(path.dirname(r.filepath))).filter(Boolean),
    )].slice(0, MAX_HINTS);
    if (names.length === 0) return null;

    return `Possibly relevant skills: ${names.join(', ')} — load with skill_view if applicable.`;
  } catch (err) {
    log.agent.debug('skill prefetch failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
