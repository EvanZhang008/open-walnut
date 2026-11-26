/** The word every option row shows on its recommended choice, at the row's right end. */
export const RECOMMENDED_WORD = 'Recommended';

const TRAILING_MARK = /\s*\(recommended\)\s*$/i;

/**
 * The words an option shows for its label, and whether the label carried its own trailing
 * "(Recommended)" (an agent's AskUserQuestion writes it so). A label that is only the mark keeps
 * its words. Only what is shown changes: the answer sent back is still the caller's own label.
 * The phone does the same (ios-native WalnutOptionLabel.shown), and a Threads card's choice says
 * "Recommended" the same way, so one option row reads alike everywhere (2026-11-26).
 */
export function shownOptionLabel(label: string): { text: string; recommended: boolean } {
  const m = TRAILING_MARK.exec(label);
  if (!m) return { text: label, recommended: false };
  const text = label.slice(0, m.index).trim();
  return text ? { text, recommended: true } : { text: label, recommended: false };
}
