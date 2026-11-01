/**
 * What Walnut added to a person's message, apart from its notes in front
 * (history-walnut-riders.ts, which every client splits itself): the context
 * blocks Walnut put first (`[Conversation context]`, an agent profile, an ask's
 * quote: history-injected-banner.ts). Its message hints are not shown in any chat
 * (2026-11-01): they are for the model, and the session's "Raw input & output"
 * shows them. Pure; the web chat and the phone transcript read the same labels.
 */
import { parseHinted, replaceHintBlocks } from '../core/hints/hint-format.js';
import { splitLeadingBanners } from './history-injected-banner.js';
import { isEnvelopeOnly, parseSessionEnvelopes } from './history-session-envelope.js';
import { splitLeadingRiders } from './history-walnut-riders.js';

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
  /**
   * Only `context` is made now. `hint` items (a message hint, `name` its kind) were sent
   * from 2026-10-29 to 2026-11-01 and are no longer: no chat draws a message hint
   * (2026-11-01, the user: "just remove this, no idea why we need this"). Older clients
   * still decode the kind.
   */
  kind: 'hint' | 'context';
  /** The context block's name (`Conversation context`). */
  name: string;
  label: string;
  text: string;
}

export interface WalnutAdded {
  items: WalnutAddedItem[];
  /** The text without the context blocks, its notes in front kept; set only when blocks came off. */
  textWithoutContext?: string;
}

/**
 * What Walnut added to one stored user message that a reader may open: the context
 * blocks it put first. Its message hints are not among them: they are for the model,
 * and only the session's "Raw input & output" shows them.
 */
export function walnutAddedOf(text: string): WalnutAdded {
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
  // The post-compaction hook restates the hints as Walnut blocks: they are for the
  // model, so the row leaves them out, and a context of only hints is no row.
  const shown = withoutHintBlocks(parts.join('\n\n'));
  return shown ? `${HOOK_CONTEXT_PREFIX} (${event} hook):\n\n${shown}` : null;
}

/** Text a reader sees with Walnut's hint blocks taken out, its own words exactly as they were. */
function withoutHintBlocks(raw: string): string {
  const out = replaceHintBlocks(raw, () => '');
  return out === raw ? raw.trim() : out.replace(/\n{3,}/g, '\n\n').trim();
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
  const raw = text.trim();
  if (!raw || /^\[Request interrupted by user( for tool use)?\]$/.test(raw)) return null;
  // A Walnut message the CLI delivered carries its hint blocks: without them it is the message.
  if (isEnvelopeOnly(parseSessionEnvelopes(parseHinted(raw).text))) return 'message';
  // Anything else is shown without its hint blocks, which are for the model.
  const t = withoutHintBlocks(raw);
  if (!t) return null;
  const kind = /^Base directory for this skill:/.test(t) ? 'skill'
    : t.startsWith(`${HOOK_CONTEXT_PREFIX} (`) ? 'hook' : 'context';
  // A hook's text opens with the line its label already says ("Hook context (Stop hook):").
  const shown = kind === 'hook' ? t.replace(/^Hook context \([^)\n]*\):\s*/, '') || t : t;
  return { kind, label: injectedContextLabel(t), text: shown };
}
