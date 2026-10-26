/**
 * Which CLI-injected user lines render as an InjectedContextRow (SessionMessage)
 * and fold with the steps beside them (process-fold.ts). Pure, so the session
 * timeline can ask on every frame and a test can pin it without a DOM.
 */
import { isEnvelopeOnly, parseSessionEnvelopes } from '@open-walnut/history-session-envelope';
import type { SessionHistoryMessage } from '@/types/session';

/**
 * A CLI-injected user line that renders as an InjectedContextRow: `'skill'` for a
 * loaded skill's text, `'context'` for any other (a re-invocation note, a
 * continuation summary, image metadata), `null` for every other row. The session
 * timeline folds a run of these with its neighbouring steps (process-fold.ts).
 */
export function injectedContextKind(message: SessionHistoryMessage): 'skill' | 'context' | null {
  // Read once per message: the timeline asks on every streaming frame, and a
  // skill's text is long enough that parsing it each time shows.
  const known = contextKindCache.get(message);
  if (known !== undefined) return known;
  const kind = readInjectedContextKind(message);
  contextKindCache.set(message, kind);
  return kind;
}
const contextKindCache = new WeakMap<SessionHistoryMessage, 'skill' | 'context' | null>();
function readInjectedContextKind(message: SessionHistoryMessage): 'skill' | 'context' | null {
  const text = message.text;
  if (message.role !== 'user' || !text) return null;
  // Belt-and-suspenders prefix check catches histories parsed before the
  // server learned the injected flag (stale cache / old transcript exports).
  if (!message.injected && !text.startsWith('Base directory for this skill:')) return null;
  if (/^\[Request interrupted by user( for tool use)?\]$/.test(text.trim())) return null;
  // Claude Code delivers another session's message as an INJECTED line. A line
  // that is nothing but envelopes is no special row, so the bubble renders it
  // and the card gets the same wrapper, click delegation (task/session/file
  // links) and context menu every other envelope has. Nothing-but is the test:
  // a skill dump that quotes an envelope still has its own prose and stays
  // collapsed. Parsing is pure (no hook, this is called from a branch).
  if (isEnvelopeOnly(parseSessionEnvelopes(text))) return null;
  return /^Base directory for this skill:/.test(text) ? 'skill' : 'context';
}
