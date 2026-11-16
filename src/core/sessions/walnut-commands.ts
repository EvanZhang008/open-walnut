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

/**
 * The command line the CLI's raw tags stand for (`<command-name>`, `<command-args>`; both tag
 * orders exist): "/model sonnet", or "/model" with no arguments. Undefined for tags with no name;
 * any other text comes back as it is. The one reader of those tags (history-parse.ts shows a
 * command line by it too).
 */
export function commandTagLine(text: string): string | undefined {
  if (!/^<command-(name|message|args)>/.test(text)) return text;
  const name = text.match(/<command-name>([\s\S]*?)<\/command-name>/)?.[1]?.trim();
  if (!name) return undefined;
  const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
  return args ? `${name} ${args}` : name;
}

/** A command line as history shows it ("/model sonnet"), from that form or the CLI's raw tags, whitespace squashed. */
function commandLineOf(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const line = commandTagLine(text.trim());
  return line === undefined ? undefined : squash(line);
}

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
  const t = commandLineOf(text);
  if (!t) return undefined;
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

/**
 * A line the CLI writes into a session BY ITSELF when Walnut changes one of its settings through a
 * control request (2026-11-16: an agent switched a task's model with POST /api/v1/sessions/:id/model,
 * and the CLI filed `<command-name>/model</command-name>` with `claude-sonnet-5-5` as its arguments,
 * which every transcript read as the person typing "/model claude-sonnet-5-5"). The CLI files the
 * line the way it files a command typed into its own prompt, with no origin, so nothing in the row
 * says who asked; in a Walnut session nobody types into that prompt (the composer turns a bare
 * `/model` into the model picker, which sends the same control request). Whoever asked, the row is
 * a setting Walnut asked for, never anyone's words: it reads as the CLI's own line and shows as a notice.
 * A person who types `/model <model>` as text into a phone's composer (the console turns `/model`
 * into the picker) is read the same way: the safe failure, a person's line read as not his.
 *
 * Every control request Walnut sends is listed with the command lines it makes the CLI write.
 * tests/core/sessions/walnut-commands-ratchet.test.ts reads the request kinds from the source and
 * fails on one not listed here, and on a listed line that reads as the person's anywhere.
 * Claude Code 2.1.322 writes such a line for a model change only (its `/model` row, then
 * "Set model to ..."); an effort or mode change writes none.
 */
export interface ControlRequestKind {
  /** The command lines the CLI writes into the transcript for it, each with the notice shown instead. */
  rows: ReadonlyArray<{ command: string; notice: (args: string) => string }>;
  /** Why the request writes no line, or what the lines are. */
  why: string;
}

// It says what was asked, never how it ended: the CLI may keep the model ("Kept model as ...").
const MODEL_ROW = { command: '/model', notice: (model: string) => `Walnut asked Claude Code to use ${model}.` };

export const CONTROL_REQUESTS: Readonly<Record<string, ControlRequestKind>> = {
  apply_flag_settings: { rows: [MODEL_ROW], why: 'a model change files `/model <model>`; an effort change files nothing' },
  set_permission_mode: { rows: [], why: 'the CLI answers with a status event, no transcript line' },
  interrupt: { rows: [], why: 'its "[Request interrupted ...]" marker is already the CLI\'s own line' },
  stop_task: { rows: [], why: 'the stopped task reports through a task notification, hidden' },
  get_settings: { rows: [], why: 'a read' },
  side_question: { rows: [], why: 'answered beside the conversation, never filed in it' },
  rewind_files: { rows: [], why: 'restores files, files no line' },
  generate_session_title: { rows: [], why: 'a read (persist: false)' },
  mcp_set_servers: { rows: [], why: 'changes the tool list, files no line' },
};

const SETTING_ROWS = new Map(Object.values(CONTROL_REQUESTS).flatMap((k) => k.rows.map((r) => [r.command, r] as const)));

/**
 * The notice for a user line the CLI wrote for a setting Walnut changed, or undefined for anything
 * else. Takes the CLI's raw tags or the line as history shows it ("/model claude-sonnet-5-5").
 */
export function settingChangeNotice(text: string | undefined): string | undefined {
  // A control request names one value (a model id, `sonnet[1m]`); a line with words after the
  // command, or none, is something a person typed and stays his.
  const m = commandLineOf(text)?.match(/^(\/[A-Za-z][\w:-]*) ([\w.:@/[\]-]+)$/);
  const row = m ? SETTING_ROWS.get(m[1]!) : undefined;
  return row?.notice(m![2]!);
}
