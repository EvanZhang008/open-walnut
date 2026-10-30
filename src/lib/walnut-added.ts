/**
 * What Walnut added to a person's message, apart from its notes in front
 * (history-walnut-riders.ts, which every client splits itself): the message
 * hints the history projection took off the text (`hints`), and the context
 * blocks Walnut put first (`[Conversation context]`, an agent profile, an ask's
 * quote: history-injected-banner.ts). Pure; the web chat and the phone
 * transcript read the same labels.
 */
import type { CarriedHint } from '../core/hints/hint-format.js';
import { splitLeadingBanners } from './history-injected-banner.js';
import { splitLeadingRiders } from './history-walnut-riders.js';

const HINT_LABELS: Record<string, string> = {
  question: 'Question',
  'rich-output': 'Rich output',
  'reply-language': 'Reply language',
  'voice-reply': 'Voice reply',
  // An ACP engine with no system prompt reads its session instructions here (acp-session.ts).
  'session-context': 'Session instructions',
};

/** "Rich output", "Question Q4": how a hint is named to the person. */
export function hintLabel(h: Pick<CarriedHint, 'kind' | 'arg'>): string {
  const base = HINT_LABELS[h.kind] ?? h.kind;
  return h.arg ? `${base} ${h.kind === 'question' ? `Q${h.arg}` : h.arg}` : base;
}

/** The question-number banner: the turn's label already shows the number, so it is no addition to show. */
const QUESTION_BANNER = /^Question Q\d{1,5}$/;

export interface WalnutAddedItem {
  kind: 'hint' | 'context';
  /** Hint kind (`rich-output`) or the context block's name (`Conversation context`). */
  name: string;
  label: string;
  text: string;
}

export interface WalnutAdded {
  items: WalnutAddedItem[];
  /** The text without the context blocks, its notes in front kept; set only when blocks came off. */
  textWithoutContext?: string;
}

/** What Walnut added to one stored user message (its `text` and `hints`). */
export function walnutAddedOf(text: string, hints?: readonly CarriedHint[]): WalnutAdded {
  const items: WalnutAddedItem[] = [];
  const riders = splitLeadingRiders(text);
  const own = riders?.body ?? text;
  const banners = splitLeadingBanners(own);
  let textWithoutContext: string | undefined;
  if (banners) {
    for (const b of banners.banners) {
      if (QUESTION_BANNER.test(b.name.trim())) continue;
      items.push({ kind: 'context', name: b.name.trim(), label: b.label, text: b.body });
    }
    textWithoutContext = text.slice(0, text.length - own.length) + banners.body;
  }
  for (const h of hints ?? []) items.push({ kind: 'hint', name: h.kind, label: hintLabel(h), text: h.text });
  return { items, ...(textWithoutContext !== undefined ? { textWithoutContext } : {}) };
}
