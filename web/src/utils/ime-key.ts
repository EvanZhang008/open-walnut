/** Is this key part of an IME composition? WebKit reports the key that ENDS a
 *  composition (Esc cancelling a pinyin candidate, Enter committing a word) with
 *  isComposing false and keyCode 229, the same rule ChatInput applies. Kept apart
 *  from the hooks so pure models (the topic composer's @ keys) can use it. */
export function isImeKey(e: { isComposing: boolean; keyCode?: number }): boolean {
  return e.isComposing || e.keyCode === 229;
}
