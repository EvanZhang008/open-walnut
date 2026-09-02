/**
 * Per-turn semantic skill prefetch (injection moment 1 of the skill system).
 *
 * Searches the skill kind of the search index with the raw user message and
 * produces ONE volatile hint line: "Possibly relevant skills: X, Y — load with
 * skill_view if applicable." The hint rides the VOLATILE injection point
 * (appendEphemeralContext → tail of the current user message) — the stable
 * system-prompt prefix stays byte-identical, so the prompt cache never busts.
 *
 * Best-effort by design: any error (index not ready, etc.) silently yields no
 * hint — a missing hint costs nothing, the full skill index is still in the
 * stable prefix.
 */
import path from 'node:path';
import { log } from '../logging/index.js';

const MAX_HINTS = 3;
/** Skip prefetch for trivial messages (greetings, "ok", etc.) — noise, not signal. */
const MIN_MESSAGE_CHARS = 8;

export async function buildSkillPrefetchHint(userMessage: string): Promise<string | null> {
  const query = (userMessage ?? '').trim();
  if (query.length < MIN_MESSAGE_CHARS) return null;

  // Keyword lane only: ~10ms warm, so the prefetch actually fits inside the
  // caller's 300ms deadline instead of losing the race almost every turn.
  try {
    const { searchV2Lane, isSearchV2Enabled } = await import('../core/search/wiring.js');
    if (!isSearchV2Enabled()) return null;
    // semanticDeadlineMs 0: this rides the user's first-token latency, and
    // keyword subword matching is the whole reason it fits the budget now.
    const hits = await searchV2Lane(query.slice(0, 500), {
      kinds: ['skill'], limit: 12, semanticDeadlineMs: 0,
    });
    // The skill kind indexes ALL md under skills/ (SKILL.md + support files
    // like references/*.md and overview history logs). The hint routes to
    // skill NAMES, and name = parent dir of SKILL.md — a support-file hit
    // would yield a junk name ("references", "history"), so only SKILL.md
    // results feed the hint. Support files still surface via memory_notes_search.
    const names = [...new Set(
      hits
        .filter((h) => path.basename(h.ref) === 'SKILL.md')
        .map((h) => path.basename(path.dirname(h.ref)))
        .filter(Boolean),
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
