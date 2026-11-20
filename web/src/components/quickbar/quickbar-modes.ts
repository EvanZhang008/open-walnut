/**
 * What the quick bar does with the words, Raycast style: by default they go to the person picked
 * (`send`); a keyword typed first and Tab switch to another mode, whose words are a search or a
 * question instead (2026-11-20, the user: "search task ... ask a quick question ... search
 * notes ... a keyword plus notes"). Pure, so tests/web/quickbar-modes.test.ts pins every rule.
 *
 *   task <words>   Tasks: the matching tasks, Enter opens one
 *   note <words>   Notes: the matching notes, Enter opens one
 *   ? <words>      Ask: a quick answer in the bar (no task, no session), asked again to go on
 *
 * Only Tab switches: a message may well start with "task" or "ask", and Enter still sends it.
 */

export type QuickMode = 'send' | 'tasks' | 'notes' | 'ask';

export interface ModeSpec {
  id: Exclude<QuickMode, 'send'>;
  /** The words that switch to it; the first is the one shown. */
  keywords: readonly string[];
  /** The chip's name while in it. */
  chip: string;
  /** What Tab does, said in the hint, and the mode's name in the Tab list. */
  action: string;
  /** One line under its name in the Tab list: what it gives. */
  about: string;
  placeholder: string;
}

export const MODES: readonly ModeSpec[] = [
  { id: 'tasks', keywords: ['task', 'tasks'], chip: 'Tasks', action: 'Search tasks', about: 'Find a task by its words and open its chat', placeholder: 'Search tasks…' },
  { id: 'notes', keywords: ['note', 'notes'], chip: 'Notes', action: 'Search notes', about: 'Find a note by its title or text and open it', placeholder: 'Search notes…' },
  { id: 'ask', keywords: ['?', 'ask'], chip: 'Ask', action: 'Ask a quick question', about: 'An answer right here, with no task made', placeholder: 'Ask anything…' },
];

export function modeSpec(id: QuickMode): ModeSpec | null {
  return MODES.find((m) => m.id === id) ?? null;
}

export interface ModeMatch {
  mode: ModeSpec;
  /** The words after the keyword (what the mode starts with). */
  rest: string;
  /** The keyword is typed whole (else only its start, which Tab completes). */
  whole: boolean;
}

/**
 * The mode the typed words point at: their first word is a mode's keyword ("task tile"), or the
 * start of one with nothing after it ("no" points at notes, "t" is too short). "?" needs no space
 * ("?how long"). Null when the words are a message.
 */
export function matchMode(text: string): ModeMatch | null {
  const lead = text.replace(/^\s+/, '');
  if (!lead) return null;
  if (lead.startsWith('?')) return { mode: MODES[2], rest: lead.slice(1).trimStart(), whole: true };
  const m = lead.match(/^(\S+)(\s+([\s\S]*))?$/);
  if (!m) return null;
  const word = m[1].toLowerCase();
  const after = m[2] !== undefined;
  for (const mode of MODES) {
    if (mode.keywords.some((k) => k === word)) return { mode, rest: (m[3] ?? '').trimStart(), whole: true };
  }
  // A start of a keyword, typed alone: Tab completes it ("no" + Tab is notes).
  if (after || word.length < 2) return null;
  const hit = MODES.find((mode) => mode.keywords.some((k) => k.length > word.length && k.startsWith(word)));
  return hit ? { mode: hit, rest: '', whole: false } : null;
}
