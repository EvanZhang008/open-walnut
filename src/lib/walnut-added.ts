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
import { isEnvelopeOnly, parseSessionEnvelopes } from './history-session-envelope.js';
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

/**
 * A context block's name in the "Walnut added: …" row, which already says who
 * added it: "Context", not the chat banner's "Context Walnut added".
 */
function contextLabel(name: string): string {
  if (/^conversation context$/i.test(name)) return 'Context';
  if (/^task context$/i.test(name)) return 'Task context';
  return name;
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
      items.push({ kind: 'context', name: b.name.trim(), label: contextLabel(b.name.trim()), text: b.body });
    }
    textWithoutContext = text.slice(0, text.length - own.length) + banners.body;
  }
  for (const h of hints ?? []) items.push({ kind: 'hint', name: h.kind, label: hintLabel(h), text: h.text });
  return { items, ...(textWithoutContext !== undefined ? { textWithoutContext } : {}) };
}

/** Opens the text of a hook's added context row; the row is labelled by it. */
export const HOOK_CONTEXT_PREFIX = 'Hook context';

/** A `hook_additional_context` attachment as one row's text, or null when it added nothing. */
export function hookContextText(content: unknown, hookEvent: unknown): string | null {
  const parts = (Array.isArray(content) ? content : [content])
    .filter((c): c is string => typeof c === 'string' && c.trim() !== '');
  if (!parts.length) return null;
  const event = typeof hookEvent === 'string' && /^[A-Za-z]+$/.test(hookEvent) ? hookEvent : 'a';
  return `${HOOK_CONTEXT_PREFIX} (${event} hook):\n\n${parts.join('\n\n')}`;
}

/** How a CLI-injected line is named in its one closed row ("Loaded skill walnut"). */
export function injectedContextLabel(text: string): string {
  const skillDir = text.match(/^Base directory for this skill:\s*(\S+)/)?.[1];
  if (skillDir) {
    const name = skillDir.replace(/\/+$/, '').split('/').pop() ?? skillDir;
    return `Loaded skill ${name}`;
  }
  if (text.startsWith('This session is being continued')) return 'Continuation summary';
  if (text.startsWith('[Image:')) return 'Image metadata';
  const hook = text.match(/^Hook context \((\w+) hook\):/);
  if (hook) return hook[1] === 'a' ? 'Added by a hook' : `Added by the ${hook[1]} hook`;
  return 'Injected context';
}

/**
 * A line the CLI put into the conversation itself (a loaded skill's text, a
 * hook's added context, a continuation summary), as one closed row: its label
 * and whole text. Nobody typed it, so a client never draws it as a person's
 * bubble.
 */
export interface CliAddedItem {
  kind: 'skill' | 'hook' | 'context';
  label: string;
  text: string;
}

/**
 * What a CLI-injected user line is to a reader: a `CliAddedItem`; `'message'`
 * when it is nothing but Walnut envelopes (another session's message the CLI
 * delivered as an injected line, drawn as that message); null for the CLI's
 * interrupt marker, which the chat never shows.
 */
export function cliAddedOf(text: string): CliAddedItem | 'message' | null {
  const t = text.trim();
  if (!t || /^\[Request interrupted by user( for tool use)?\]$/.test(t)) return null;
  if (isEnvelopeOnly(parseSessionEnvelopes(t))) return 'message';
  const kind = /^Base directory for this skill:/.test(t) ? 'skill'
    : t.startsWith(`${HOOK_CONTEXT_PREFIX} (`) ? 'hook' : 'context';
  // A hook's text opens with the line its label already says ("Hook context (Stop hook):").
  const shown = kind === 'hook' ? t.replace(/^Hook context \([^)\n]*\):\s*/, '') || t : t;
  return { kind, label: injectedContextLabel(t), text: shown };
}
