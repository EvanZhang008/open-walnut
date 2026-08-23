/**
 * The `<suggest>` action-card contract taught to the Personal AI.
 *
 * Lives in its own module (not folded into the self-knowledge prompt) for two
 * reasons: that prompt is at 1412 of its 1800-char cap, and this one is only
 * useful on the CONSOLE — the web chat renders the card, while every other
 * surface (the phone's v1 projection, plain-text notifications) keeps the raw
 * text. That degradation is acceptable and deliberate, so the wording stays
 * "you MAY", never "always".
 *
 * Appended to the stable, prompt-cached prefix (buildWorkModesSection), so it
 * must be static text: anything per-turn here would bust the cache on every
 * message.
 */

export const SUGGEST_ACTION_PROMPT_MAX_CHARS = 1_200;

const SUGGEST_ACTION_PROMPT = `## Suggested actions (clickable cards)

- When you propose a concrete next step the user should approve rather than type out, you MAY wrap it in a card. Do the work yourself when no approval is needed; a card is for a CHOICE, e.g. triaging a task.
- Syntax (console only; other surfaces show the raw text, so keep the prose readable on its own):
  \`<suggest title="Triage this">\` markdown \`<action tool="task_focus_tier_set" args='{"id":"t_1","tier":"focus"}' label="Put to Focus" style="primary"/>\` \`<action dismiss label="Ignore"/>\` \`</suggest>\`
- \`tool\` is any tool you can call yourself, and \`args\` is complete static JSON — the click runs it exactly as written, with the user's authorization. Never guess an id.
- \`style\` is primary, danger, or omitted. Add \`confirm="..."\` for anything irreversible; a delete, a merge, or anything that runs code or replaces a document is refused without a confirmation step.
- One card = one decision: the first click settles it. Add \`multi\` when every action is independently useful, \`sticky\` when the card stays usable after a click.
- Emit at most one card per answer, and only with real args. Never a card instead of an answer.`;

export function renderSuggestActionContract(): string {
  return SUGGEST_ACTION_PROMPT;
}
