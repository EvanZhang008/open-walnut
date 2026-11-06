/**
 * AI-only envelopes: a `<walnut-message ... ai-only="true">` whose body reaches
 * the model and no person (a plugin's App brief, core/sessions/app-brief.ts).
 *
 * The text a session received is stored whole (the CLI's transcript, the queue
 * row), and every view a person reads is built from it: the web timeline and its
 * raw view, the phone's transcript, the queue lists, the queued event, search.
 * Each of those goes through `redactAiOnly`, which keeps the envelope (its kind,
 * from and title still parse, so a card shows that a brief went) and replaces
 * its body with one line. Pure and cheap: text with no AI-only envelope comes
 * back as the same string.
 */

const TAG = 'walnut-message';
/**
 * One block Walnut itself puts in front of a message: an envelope (its body is escaped,
 * envelope-kit escapeBody, so the first close ends it) or a message hint (a person's own
 * `<system-reminder>` is escaped before it is sent, hints/hint-format.ts). Sticky: matched only
 * where the last one ended, after blank space.
 */
const LEAD_RE = /\s*(?:<walnut-message\b([^>]*)>\n([\s\S]*?)\n<\/walnut-message>|<system-reminder>\nWalnut \([\s\S]*?\n<\/system-reminder>)/y;
const FLAG = /\sai-only="true"(\s|$)/;

interface Lead {
  start: number;
  end: number;
  attrs: string | undefined;
}

/**
 * The blocks at the head of a text, up to the first thing that is not one: only there does an
 * AI-only flag count. The App brief rides ahead of every other note (session-message-queue.ts),
 * so a flag inside a person's words, a peer's body or a native agent message is plain text.
 */
function leadingBlocks(text: string): Lead[] {
  const out: Lead[] = [];
  LEAD_RE.lastIndex = 0;
  for (let m = LEAD_RE.exec(text); m; m = LEAD_RE.exec(text)) {
    out.push({ start: m.index + (m[0].length - m[0].trimStart().length), end: LEAD_RE.lastIndex, attrs: m[1] });
    if (LEAD_RE.lastIndex >= text.length) break;
  }
  return out;
}

function aiOnlyLeads(text: string): Lead[] {
  if (!hasAiOnly(text)) return [];
  return leadingBlocks(text).filter((b) => b.attrs !== undefined && FLAG.test(b.attrs));
}

/** What a person reads in place of the body. */
export const AI_ONLY_PLACEHOLDER = 'For the AI only: Walnut keeps its text out of this view. The App shows you what it decides, when it decides.';

export function hasAiOnly(text: string): boolean {
  return typeof text === 'string' && text.includes('ai-only="true"');
}

/** The text with the body of every AI-only envelope at its head replaced by the placeholder. */
export function redactAiOnly(text: string): string {
  const leads = aiOnlyLeads(text);
  if (leads.length === 0) return text;
  let out = '';
  let at = 0;
  for (const b of leads) {
    out += text.slice(at, b.start) + `<${TAG}${b.attrs}>\n${AI_ONLY_PLACEHOLDER}\n</${TAG}>`;
    at = b.end;
  }
  return out + text.slice(at);
}

/** The AI-only envelopes at the head of a text, whole, in order. */
export function aiOnlyEnvelopes(text: string): string[] {
  return aiOnlyLeads(text).map((b) => text.slice(b.start, b.end));
}

/**
 * A queued row edited by a person: what they sent back holds the placeholder (or
 * nothing) where the brief was. The row keeps its real AI-only envelopes ahead of
 * the new words, so an edit never loses the brief or writes the placeholder over it.
 */
export function keepAiOnly(previous: string, edited: string): string {
  const kept = aiOnlyEnvelopes(previous);
  if (kept.length === 0) return edited;
  // The fold the editor saw (or a stale copy of the brief) leaves the words.
  let words = edited;
  for (const b of [...aiOnlyLeads(edited)].reverse()) words = words.slice(0, b.start) + words.slice(b.end);
  return `${kept.join('\n\n')}\n\n${words.replace(/^\s+/, '')}`;
}
