/**
 * The text of a model's answer: its text blocks, joined and trimmed. Its own module, so a test
 * that replaces model.js's sendMessage keeps it.
 */
export function replyText(result: { content?: ReadonlyArray<{ type: string }> }): string {
  return (result.content ?? []).map((b) => (b.type === 'text' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('').trim();
}
