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
/** An envelope's opening tag carrying the flag, its body, its closing tag. Bodies are escaped (envelope-kit escapeBody), so the first close ends it. */
const AI_ONLY_RE = /<walnut-message\b([^>]*\sai-only="true"[^>]*)>\n([\s\S]*?)\n<\/walnut-message>/g;

/** What a person reads in place of the body. */
export const AI_ONLY_PLACEHOLDER = 'For the AI only: Walnut keeps its text out of this view. The App shows you what it decides, when it decides.';

export function hasAiOnly(text: string): boolean {
  return typeof text === 'string' && text.includes('ai-only="true"');
}

/** The text with every AI-only envelope's body replaced by the placeholder. */
export function redactAiOnly(text: string): string {
  if (!hasAiOnly(text)) return text;
  AI_ONLY_RE.lastIndex = 0;
  return text.replace(AI_ONLY_RE, (_whole, attrs: string) => `<${TAG}${attrs}>\n${AI_ONLY_PLACEHOLDER}\n</${TAG}>`);
}

/** The AI-only envelopes of a text, whole, in order. */
export function aiOnlyEnvelopes(text: string): string[] {
  if (!hasAiOnly(text)) return [];
  AI_ONLY_RE.lastIndex = 0;
  return [...text.matchAll(AI_ONLY_RE)].map((m) => m[0]);
}

/**
 * A queued row edited by a person: what they sent back holds the placeholder (or
 * nothing) where the brief was. The row keeps its real AI-only envelopes ahead of
 * the new words, so an edit never loses the brief or writes the placeholder over it.
 */
export function keepAiOnly(previous: string, edited: string): string {
  const kept = aiOnlyEnvelopes(previous);
  if (kept.length === 0) return edited;
  AI_ONLY_RE.lastIndex = 0;
  const words = edited.replace(AI_ONLY_RE, '').replace(/^\s+/, '');
  return `${kept.join('\n\n')}\n\n${words}`;
}
