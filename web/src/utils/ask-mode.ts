/**
 * Where an Ask on a passage lands (2026-11-03, the user: "in ask here people can
 * select inline mode or tree mode for this one"): `inline` is a card beside the
 * passage in Conversation Mode, `tree` a new page one level below the page the
 * passage is on, in Tree Mode. An Ask asks in the view the reader is in unless
 * the pill's choice names the other.
 */
import type { SessionViewMode } from '@/hooks/useSessionThreads';

export type AskMode = 'inline' | 'tree';

export const ASK_MODES: readonly AskMode[] = ['inline', 'tree'];

export function askModeOf(view: SessionViewMode): AskMode {
  return view === 'stack' ? 'tree' : 'inline';
}

export const ASK_MODE_LABEL: Record<AskMode, string> = {
  inline: 'Ask inline',
  tree: 'Ask in Tree',
};

export const ASK_MODE_HINT: Record<AskMode, string> = {
  inline: 'A card beside this passage, in the conversation',
  tree: 'A new page one level below this one',
};
