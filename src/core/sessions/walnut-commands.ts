/**
 * The slash commands Walnut itself sends into a session, and how each reads in its history.
 *
 * Every other line Walnut sends is framed in an envelope (send-frame.ts), but a slash command
 * must reach the CLI byte-exact or it stops being one, so these go out raw. The CLI then files
 * the command under a uuid of its own (never the one Walnut sent the line under), so nothing
 * but the text can tell the line was not typed by the person (2026-11-05: the recovery's
 * `/compact` and the idle compaction's both showed as a user bubble, and a uuid prefix Walnut
 * relied on never reached the transcript). Each command therefore carries its own words in its
 * arguments, which the CLI records in `<command-args>` and, for `/compact`, reads as extra
 * instructions for the summary: "Walnut started this compaction ...". Every reader of a
 * transcript (session-history.ts, transcript-from-jsonl.ts) shows such a line as Walnut's notice
 * row, never as the person's message. Arguments make Claude Code skip its session-memory
 * compaction (a cheap path behind a feature flag, compact.ts in the CLI) and always summarize with
 * the model; the words read there as "Additional Instructions" and ask for nothing new.
 *
 * Pure: no I/O. tests/core/sessions/walnut-commands-ratchet.test.ts fails when a send source
 * passes text raw that is not listed here, or a listed line reads as a person's anywhere.
 */
import { IDLE_COMPACT_HISTORY_TEXT } from './prompt-cache.js';

/** The words every Walnut command's arguments start with: how a transcript line is known as Walnut's. */
export const WALNUT_COMMAND_MARK = 'Walnut started this compaction';

/** The idle compaction's line (sessions/idle-compaction.ts). */
export const IDLE_COMPACT_COMMAND = `/compact ${WALNUT_COMMAND_MARK} while the session was idle, before its prompt cache expired. Summarize as usual.`;
/** The recovery's line for a conversation that no longer fits (sessions/context-full-recovery.ts). */
export const CONTEXT_COMPACT_COMMAND = `/compact ${WALNUT_COMMAND_MARK} because the conversation no longer fit the model's context window. Summarize as usual.`;

/** The history row that stands for the recovery's command line. */
// It says what Walnut asked for, never how it ended: the compaction's own row (or its error) says that.
// Its compaction's line says what it was for ("to fit the context window"), so this says the cause.
export const CONTEXT_COMPACT_HISTORY_TEXT = 'Claude Code answered "Prompt is too long", so Walnut asked it to compact this conversation.';
/** A Walnut command line whose wording this release does not know (an older or newer Walnut wrote it). */
export const WALNUT_COMMAND_HISTORY_TEXT = 'Walnut sent /compact to compact this session.';
/**
 * Notice texts an older release put in a history row, still read as Walnut's: a cached parse keeps
 * them until HISTORY_CACHE_SCHEMA moves, and a reader older than the cache may meet one. A notice
 * text that changes moves here, and the cache schema goes up (the ratchet pins both).
 */
export const LEGACY_CONTEXT_COMPACT_HISTORY_TEXTS: readonly string[] = [
  'Walnut sent /compact because the conversation no longer fit the model\u2019s context window ("Prompt is too long"); what got no answer goes again after it.',
  'Walnut compacted this conversation because it no longer fit the model\'s context window ("Prompt is too long").',
  'Walnut asked to compact this conversation because it no longer fit the model\'s context window ("Prompt is too long").',
];

/** The same for the idle compaction's notice (HISTORY_CACHE_SCHEMA 12: "would expire", as it runs before). */
export const LEGACY_IDLE_COMPACT_HISTORY_TEXTS: readonly string[] = [
  'Walnut sent /compact while the session was idle, before its prompt cache expired, so the next message reads a summary instead of the whole conversation.',
];

export interface WalnutCommand {
  /** The send source that carries it (send-sent-by: an agent's). */
  source: string;
  /** The whole line, as sent and as the CLI records it. */
  text: string;
  /** The history row shown in its place. */
  notice: string;
}

export const WALNUT_COMMANDS: readonly WalnutCommand[] = [
  { source: 'idle-compact', text: IDLE_COMPACT_COMMAND, notice: IDLE_COMPACT_HISTORY_TEXT },
  { source: 'context-compact', text: CONTEXT_COMPACT_COMMAND, notice: CONTEXT_COMPACT_HISTORY_TEXT },
];

const squash = (s: string): string => s.trim().replace(/\s+/g, ' ');

/** The command `source` may send raw: only its own listed line, word for word. */
export function walnutCommandFor(source: string | undefined, text: string): WalnutCommand | undefined {
  const t = squash(text);
  return WALNUT_COMMANDS.find((c) => c.source === source && c.text === t);
}

/**
 * The notice for a user line that is a Walnut command, or undefined for anything else. Takes the
 * line as history shows it ("/compact <args>", the form transformInjectedUserText gives a
 * `<command-name>` line, and the text of the CLI's queue enqueue) or the CLI's raw tags.
 */
export function walnutCommandNotice(text: string | undefined): string | undefined {
  if (!text) return undefined;
  let shown = text.trim();
  if (/^<command-(name|message|args)>/.test(shown)) {
    const name = shown.match(/<command-name>([\s\S]*?)<\/command-name>/)?.[1]?.trim();
    const args = shown.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
    if (!name) return undefined;
    shown = args ? `${name} ${args}` : name;
  }
  const t = squash(shown);
  const m = t.match(/^\/compact (.*)$/);
  if (!m || !m[1]!.startsWith(WALNUT_COMMAND_MARK)) return undefined;
  return WALNUT_COMMANDS.find((c) => c.text === t)?.notice ?? WALNUT_COMMAND_HISTORY_TEXT;
}

/** A history row Walnut put in place of one of its command lines. */
export function isWalnutCommandNotice(text: string | undefined): boolean {
  return walnutNoticeKind(text) !== undefined;
}

/**
 * Which compaction a Walnut command notice stands for: `idle` (before the prompt cache expired),
 * `context` (the conversation no longer fit) or `other` (a wording this release does not know).
 * Its compaction's row is named by it ("Compacted by Walnut to fit the context window").
 */
export function walnutNoticeKind(text: string | undefined): 'idle' | 'context' | 'other' | undefined {
  if (!text) return undefined;
  if (text === IDLE_COMPACT_HISTORY_TEXT || LEGACY_IDLE_COMPACT_HISTORY_TEXTS.includes(text)) return 'idle';
  if (text === CONTEXT_COMPACT_HISTORY_TEXT || LEGACY_CONTEXT_COMPACT_HISTORY_TEXTS.includes(text)) return 'context';
  return text === WALNUT_COMMAND_HISTORY_TEXT ? 'other' : undefined;
}
