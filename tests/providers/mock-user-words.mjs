/**
 * The person's words of a prompt the mock ACP agent received: Walnut's hint blocks
 * (src/core/hints/hint-format.ts, a `<system-reminder>` opening `Walnut (<kind>):`) are
 * context the model reads, not what the user said, so the mock's echo and its keyword
 * triggers leave them out. 2026-10-30: the session context every non-Codex engine's
 * first prompt carries made each echo the whole system prompt, and 7 browser specs
 * waited for a reply text that never came. Plain JS: the mock runs under node too.
 * tests/providers/mock-user-words.test.ts checks it against the real composer.
 */
export function userWords(raw) {
  return raw.replace(/<system-reminder>\s*Walnut \([^)\n]*\):[\s\S]*?<\/system-reminder>\s*/g, '').trim();
}
