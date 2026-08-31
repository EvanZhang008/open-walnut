/**
 * Output mode ("markdown" vs "rich HTML") prompt injection.
 *
 * The mode is a preference, but there is no control channel for a reply STYLE the
 * way there is for permission mode — the model only learns about it from the
 * conversation. Two things ride the outgoing message, exactly like plan mode in
 * web/routes/chat.ts:
 *
 *   · EDGE (the mode changed, or nothing was ever said): the FULL instruction as
 *     a PREFIX, once.
 *   · STANDING (rich holds): a one-line reminder as a SUFFIX on every later send.
 *     A one-shot instruction measurably decays — the model writes HTML for the
 *     turn that carried it and drifts back to plain markdown a turn or two later.
 *     The reminder is last thing in the message on purpose (recency) and costs
 *     ~15 tokens. Markdown mode appends NOTHING, so a session on plain markdown
 *     still pays exactly zero.
 *
 * The edge lives on the RECORD (`output_mode_injected` vs the EFFECTIVE mode),
 * not in the client, so a reload or a second tab cannot each inject their own
 * copy: the send that advances the injected marker makes every LATER send see
 * mode === injected. Note that this is a read-then-write, so it de-duplicates
 * SERIALIZED sends, not simultaneous ones — two sends that both read the record
 * before either writes it would both carry the instruction. Harmless (the model
 * reads the same sentence twice) and not worth a lock. Any send path that wants
 * the behavior calls resolveOutputModeDirective — today that is the web
 * `session:send` RPC.
 *
 * Effective mode = record.output_mode ?? config.session.output_mode ?? default.
 * A record that never overrode the mode therefore follows the config LIVE, and
 * flipping the config produces a real edge for it on the next send.
 */

import type { Config, SessionOutputMode, SessionRecord } from '../types.js';
import { DEFAULT_SESSION_OUTPUT_MODE } from '../types.js';

/** Opening literal shared by both edge instructions. The client peels the line
 *  off a rehydrated queue row by exactly this marker (useSessionSend.ts), so
 *  building the strings from it keeps emitter and stripper from drifting apart. */
export const OUTPUT_MODE_INSTRUCTION_MARKER = '[Rich output mode: ';

/** Turning rich output ON. Names the ONE routing rule the client enforces (a
 *  `<script>` needs the `html-app` fence, which renders in a sandboxed iframe) so
 *  the model doesn't have to discover it by having its output silently mangled.
 *  It deliberately does NOT say "inline <script> is stripped": a script-bearing
 *  chunk is routed to an island rather than stripped, so telling the model that
 *  would be a lie it might work around. The skill pointer keeps this line short:
 *  the component recipes are a whole document, loaded only if the model wants it. */
export const RICH_OUTPUT_MODE_ON_INSTRUCTION =
  `${OUTPUT_MODE_INSTRUCTION_MARKER}ON] When visual structure helps understanding, write HTML directly in your reply `
  + '(layout, colors, SVG diagrams, <details>, CSS-only interactivity) — the client renders it natively '
  + 'while streaming. For anything needing <script>, emit a ```html-app fenced block '
  + '(rendered in a sandboxed iframe). Plain answers stay plain markdown. '
  + 'Component recipes (steppers, SVG diagrams, animations, islands): '
  + `\`walnut tools call skill_read '{"dirName":"rich-output"}'\`.`;

/** Turning it back OFF. Deliberately terse: the model already has the context. */
export const RICH_OUTPUT_MODE_OFF_INSTRUCTION =
  `${OUTPUT_MODE_INSTRUCTION_MARKER}OFF] Return to plain markdown replies.`;

/** Opening literal of the standing reminder — the client strips a trailing line
 *  that starts with this (useSessionSend.ts). Kept separate from the edge marker
 *  so a stripper can never mistake one for the other. */
export const OUTPUT_MODE_REMINDER_MARKER = '[Rich output mode is still on';

/** The standing reminder. ONE short line, appended AFTER the user's text. */
export const RICH_OUTPUT_MODE_REMINDER =
  `${OUTPUT_MODE_REMINDER_MARKER} — reply in HTML where visual structure helps.]`;

/** The style a model uses when nothing has been said to it. Compared against the
 *  effective mode to decide whether an edge is owed — deliberately NOT
 *  DEFAULT_SESSION_OUTPUT_MODE: with the default at 'rich', treating "never told"
 *  as the default would mean a fresh session silently never hears the
 *  instruction, i.e. the default would do nothing at all. */
const MODEL_NATIVE_OUTPUT_MODE: SessionOutputMode = 'markdown';

/** Config subset this module reads. Kept structural so callers can pass a full
 *  Config, a stub, or nothing at all. */
type OutputModeConfig = Pick<Config, 'session'>;

/**
 * The mode a session is actually on: its own override, else the configured
 * default, else the built-in one. THE one resolution — every reader (send path,
 * anything reporting the mode) goes through here so a record and the UI can
 * never disagree about what "unset" means.
 */
export function resolveEffectiveOutputMode(
  record: Pick<SessionRecord, 'output_mode'> | null | undefined,
  config?: OutputModeConfig | null,
): SessionOutputMode {
  return record?.output_mode ?? config?.session?.output_mode ?? DEFAULT_SESSION_OUTPUT_MODE;
}

export interface OutputModeDirective {
  /** The effective mode. Persist as `output_mode_injected` once `prefix` shipped. */
  mode: SessionOutputMode;
  /** Full instruction to PREPEND (a blank line separates it from the text), or
   *  null when the model has already been told this mode. Non-null ⇒ the caller
   *  must advance `output_mode_injected` after the text is safely queued. */
  prefix: string | null;
  /** One-line reminder to APPEND, or null (markdown mode / this send already
   *  carries the full instruction, which would make the reminder redundant). */
  suffix: string | null;
}

/**
 * What this send must carry. Never null: markdown with nothing owed yields
 * `{ prefix: null, suffix: null }`, i.e. the message is left byte-identical.
 */
export function resolveOutputModeDirective(
  record: Pick<SessionRecord, 'output_mode' | 'output_mode_injected'> | null | undefined,
  config?: OutputModeConfig | null,
): OutputModeDirective {
  const mode = resolveEffectiveOutputMode(record, config);
  const told = record?.output_mode_injected ?? MODEL_NATIVE_OUTPUT_MODE;
  const edge = mode !== told;
  return {
    mode,
    prefix: edge
      ? (mode === 'rich' ? RICH_OUTPUT_MODE_ON_INSTRUCTION : RICH_OUTPUT_MODE_OFF_INSTRUCTION)
      : null,
    // The full ON instruction already says everything the reminder does, so the
    // edge send doesn't carry both.
    suffix: mode === 'rich' && !edge ? RICH_OUTPUT_MODE_REMINDER : null,
  };
}

/**
 * Wrap the text that goes to the CLI. The prefix lands OUTSIDE any image
 * preamble the caller already built (the attachment block stays adjacent to the
 * user's own words); the reminder lands after everything.
 */
export function applyOutputModeDirective(directive: OutputModeDirective, message: string): string {
  let out = message;
  if (directive.prefix) out = `${directive.prefix}\n\n${out}`;
  if (directive.suffix) out = `${out}\n\n${directive.suffix}`;
  return out;
}

/** Is this whole LINE one of ours? Line-anchored on purpose: a human sentence
 *  that merely mentions the mode ("what does [Rich output mode: ON] do?") does
 *  not START with the marker, so it survives. A line that IS the literal machine
 *  text is machine text no matter where it sits — which is what makes a MERGED
 *  batch (two sends joined into one echo, each carrying its own reminder)
 *  strippable at all. */
function isOutputModeLine(line: string): boolean {
  const t = line.trim();
  if (t.startsWith(OUTPUT_MODE_INSTRUCTION_MARKER)) return true;
  return t.startsWith(OUTPUT_MODE_REMINDER_MARKER) && t.endsWith(']');
}

/**
 * Undo the wrapping for DISPLAY. The CLI echoes what it received into its JSONL,
 * so every surface built from a history parse (web bubbles, phone, notification
 * previews, search snippets, auto-titles) would otherwise show the machine text
 * as part of what the human typed — and with a reminder on EVERY message that is
 * constant noise, not an occasional oddity. Applied at the history projection
 * choke point (core/session-history.ts) and to the `dedupText` the send RPC hands
 * back, so the optimistic bubble matches on the basis history actually renders.
 *
 * Display-only: it never changes what the CLI receives (the queue row keeps the
 * augmented text) and it never touches the image preamble, which is genuine
 * information about the message.
 */
export function stripOutputModeWrappers(text: string): string {
  // Fast path: the overwhelming majority of lines have neither marker, and this
  // runs per user message of every parse (a whale JSONL has thousands).
  if (!text.includes(OUTPUT_MODE_INSTRUCTION_MARKER) && !text.includes(OUTPUT_MODE_REMINDER_MARKER)) {
    return text;
  }

  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isOutputModeLine(lines[i])) {
      out.push(lines[i]);
      continue;
    }
    // Also swallow the ONE blank line we wrote next to it, preferring the one
    // BEFORE so two of the user's own paragraphs never fuse into one.
    if (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
    else if (lines[i + 1]?.trim() === '') i++;
  }
  const stripped = out.join('\n').trim();
  // Never strip a message down to NOTHING: our wrapper always accompanies the
  // user's own words, so an "all wrapper" message is someone quoting the literal
  // text at us — showing it is right, deleting their message is not.
  return stripped === '' ? text : stripped;
}
