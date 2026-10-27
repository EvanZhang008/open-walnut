/**
 * Output mode ("markdown" vs "rich HTML") prompt injection.
 *
 * The mode is a preference, but there is no control channel for a reply STYLE the
 * way there is for permission mode — the model only learns about it from the
 * conversation. Two things ride the outgoing message, exactly like plan mode in
 * web/routes/chat.ts:
 *
 *   · EDGE (the mode changed, or nothing was ever said): the FULL instruction,
 *     once.
 *   · STANDING (rich holds): a one-line reminder on every later send. A one-shot
 *     instruction measurably decays — the model writes HTML for the turn that
 *     carried it and drifts back to plain markdown a turn or two later. The
 *     reminder repeats the inline delivery contract even after compaction.
 *     Markdown mode appends no mode text, so a session on
 *     plain markdown pays nothing for it.
 *   · COMPACTION voids the edge: the summary does not keep the full instruction
 *     (2026-10-22: three hours of reminder-only turns, then a call-path diagram
 *     drawn as ASCII in a code fence), so the compaction recorder clears
 *     `output_mode_injected` (place-notice.ts `notePlaceCompaction`) and the next
 *     send carries the full instruction again.
 *
 * BOTH land AFTER the user's text (recency helps, and the human's words stay
 * first — user-requested 2026-08-31; the instruction used to be a prefix).
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
 *
 * The same tail carries the user's reply language (`config.session.reply_language`)
 * as one `[Reply language: …]` line on EVERY send, in either mode: the rule lived
 * only in a private CLAUDE.md, which a compacted or non-Claude session loses, and
 * long sessions drifted into the wrong language. Unset = no line.
 */

import type { Config, SessionOutputMode, SessionRecord } from '../types.js';
import { DEFAULT_SESSION_OUTPUT_MODE } from '../types.js';
import { VOICE_REPLY_MARKER, isVoiceReplyLine } from './voice-reply.js';

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
 *  the component recipes are a whole document, loaded only if the model wants it.
 *
 *  The island clause names its state and result contract (2026-10-27: a quiz island
 *  kept its progress in variables and went back to question 1 when the reply was
 *  re-rendered); the details and an example are in the skill.
 *
 *  The contrast rule earns its sentence: models reach for a pale hardcoded panel
 *  (`background:#fff5f5`) and then leave the text muted or inherited, so the panel
 *  arrives with grey-on-pink body copy that is genuinely hard to read (reported
 *  with a screenshot 2026-08-31). Stating the PAIRING rather than banning hex is
 *  deliberate: hardcoded colours are fine when the model owns both ends.
 *
 *  It opens by naming what STAYS markdown, because the failure in practice is
 *  over-reach, not under-use: told only that HTML renders, models rebuilt tables
 *  and code blocks by hand (reported 2026-09-03). Markdown is better for those on
 *  every surface — it keeps copy-as-code, highlighting, and the plain-text
 *  fallback notifications and search snippets show. So the line draws the border
 *  first, then invites HTML for the things across it.
 *
 *  The diagram rule has a threshold on purpose. "Draw every diagram as SVG"
 *  fixed the reported ASCII call path (2026-10-22) and then over-reached in the
 *  eval (scripts/rich-output-eval.mjs): SVGs for a file tree, a debounce function,
 *  a complexity table and terminal output, and fixed pixel widths that overflow a
 *  narrow column. So the instruction names what stays a code block or table, the
 *  shapes that earn an SVG, and how an SVG must be built. */
export const RICH_OUTPUT_MODE_ON_INSTRUCTION =
  `${OUTPUT_MODE_INSTRUCTION_MARKER}ON] Write markdown for what markdown does well: headings, lists, `
  + 'tables (also for a handful of numbers), and code blocks for real code, commands, terminal output, diffs '
  + 'and file trees. Mix raw HTML into the same reply (separated by a blank line) only for what markdown cannot '
  + 'express. A diagram with branches, a return path, a loop or four or more parts (a flow, a call path, a sequence '
  + 'between parties, a state machine, an architecture, a trend over time) is inline <svg>, never ASCII or '
  + 'box-drawing art in a code block and never mermaid, which does not render; a plain A -> B -> C stays a '
  + 'sentence. Give each <svg> a viewBox and width="100%" (never a fixed pixel width), short labels with any '
  + 'longer text outside it, and theme colours (var(--fg), var(--fg-muted), var(--border), var(--bg-secondary)); '
  + 'state the diagram\'s point in prose as well. HTML is also for colour that carries meaning, '
  + 'side-by-side or card layout, and interactivity (<details>, CSS :checked). The client renders it natively '
  + 'while streaming. Write visual HTML directly in your reply, not in a file, screenshot, or HTML code fence, '
  + 'unless the user asks for one. Keep each widget contiguous, without internal blank lines. '
  + 'Set text and background colour together or neither: a custom background with '
  + 'inherited or muted text loses contrast (theme vars --fg, --fg-muted, --bg-secondary, --border always fit). '
  + 'For anything needing <script>, emit a ```html-app fenced block '
  + '(rendered in a sandboxed iframe, rebuilt whenever the reply re-renders or the page reloads): keep its state in '
  + 'localStorage, which Walnut restores, and call walnut.report(text) to offer a result the user can send to you. '
  + 'A short answer needs none of this. '
  + 'Component recipes (steppers, SVG diagrams, animations, islands): '
  + `\`walnut tools call skill_read '{"dirName":"walnut-rich-output"}'\`.`;

/** Turning it back OFF. Deliberately terse: the model already has the context. */
export const RICH_OUTPUT_MODE_OFF_INSTRUCTION =
  `${OUTPUT_MODE_INSTRUCTION_MARKER}OFF] Return to plain markdown replies.`;

/** Opening literal of the standing reminder — the client strips a trailing line
 *  that starts with this (useSessionSend.ts). Kept separate from the edge marker
 *  so a stripper can never mistake one for the other. */
export const OUTPUT_MODE_REMINDER_MARKER = '[Rich output mode is still on';

/** The standing reminder. ONE short line, appended AFTER the user's text.
 *
 *  It says MARKDOWN FIRST on purpose. The old wording ("reply in HTML where
 *  visual structure helps") read as "answer in HTML", and the observed result was
 *  hand-built `<table>`s and `<pre>` blocks for content markdown expresses better
 *  — which also costs the plain-text fallback that notifications, search snippets
 *  and the phone's native text depend on. Naming what HTML is actually FOR
 *  (colour, diagrams, layout markdown has no shape for) is what makes the line
 *  steer instead of just remind (reported 2026-09-03). */
export const RICH_OUTPUT_MODE_REMINDER =
  `${OUTPUT_MODE_REMINDER_MARKER}: markdown first; code blocks for real code, output and file trees; `
  + 'a real diagram is responsive inline <svg>, never ASCII or mermaid; '
  + 'colour or layout: raw HTML directly in this reply. '
  + 'No files, screenshots or HTML fences unless requested; no blank lines in a widget.]';

/** Opening literal of the reply-language line; the strippers match lines that
 *  start with it and end with `]` (like the reminder). */
export const REPLY_LANGUAGE_MARKER = '[Reply language: ';

/** The setting is one sentence; a pasted essay would ride every message. */
export const REPLY_LANGUAGE_MAX_CHARS = 300;

/**
 * The reply-language line for this config, or null when the setting is empty.
 * Whitespace (newlines included) collapses to single spaces, so it stays ONE
 * line the line-anchored strippers can recognise.
 */
export function replyLanguageLine(config?: OutputModeConfig | null): string | null {
  const raw = config?.session?.reply_language;
  if (typeof raw !== 'string') return null;
  let text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (text.length > REPLY_LANGUAGE_MAX_CHARS) text = `${text.slice(0, REPLY_LANGUAGE_MAX_CHARS).trimEnd()}…`;
  return `${REPLY_LANGUAGE_MARKER}${text}]`;
}

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
  /** The effective mode. Persist as `output_mode_injected` once `instruction` shipped. */
  mode: SessionOutputMode;
  /** Full edge instruction to APPEND after the text (a blank line separates it),
   *  or null when the model has already been told this mode. Non-null ⇒ the
   *  caller must advance `output_mode_injected` after the text is safely queued. */
  instruction: string | null;
  /** One-line standing reminder to APPEND, or null (markdown mode / this send
   *  already carries the full instruction, which would make it redundant). */
  reminder: string | null;
  /** The reply-language line to APPEND after the mode text, or null (unset). */
  language: string | null;
}

/**
 * What this send must carry. Never null: markdown with nothing owed and no reply
 * language yields all nulls, i.e. the message is left byte-identical.
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
    instruction: edge
      ? (mode === 'rich' ? RICH_OUTPUT_MODE_ON_INSTRUCTION : RICH_OUTPUT_MODE_OFF_INSTRUCTION)
      : null,
    // The full ON instruction already says everything the reminder does, so the
    // edge send doesn't carry both.
    reminder: mode === 'rich' && !edge ? RICH_OUTPUT_MODE_REMINDER : null,
    language: replyLanguageLine(config),
  };
}

/**
 * The lines a session's HOST appends to a message it delivers itself (a peer note
 * or reply between two sessions on that host never reaches the server's queue;
 * host-slice.ts ships this, offline-host-core.ts appends it). The standing
 * reminder and the language line only: an owed edge instruction stays owed,
 * because only the server can record it as told, and ships with the next send
 * the server makes. Null when there is nothing to add.
 */
export function hostReplyTail(
  record: Pick<SessionRecord, 'output_mode' | 'output_mode_injected'> | null | undefined,
  config?: OutputModeConfig | null,
): string | null {
  const d = resolveOutputModeDirective(record, config);
  const lines = [d.reminder, d.language].filter(Boolean);
  return lines.length ? lines.join('\n\n') : null;
}

/**
 * Wrap the text that goes to the CLI. Machine text always lands AFTER the
 * user's words (and after any image preamble the caller already built): the
 * human reads their own message first, and recency serves the model better.
 * The old prefix placement also broke anything position-sensitive about the
 * start of the message — a prefixed "/compact" stopped being a slash command.
 */
export function applyOutputModeDirective(directive: OutputModeDirective, message: string): string {
  const tails = [directive.instruction ?? directive.reminder, directive.language].filter(Boolean);
  return tails.length ? `${message}\n\n${tails.join('\n\n')}` : message;
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
  // The phone's voice-reply line rides the same way (voice-reply.ts), so the one
  // display choke point strips it too.
  if (isVoiceReplyLine(t)) return true;
  if (t.startsWith(REPLY_LANGUAGE_MARKER) && t.endsWith(']')) return true;
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
  if (
    !text.includes(OUTPUT_MODE_INSTRUCTION_MARKER)
    && !text.includes(OUTPUT_MODE_REMINDER_MARKER)
    && !text.includes(VOICE_REPLY_MARKER)
    && !text.includes(REPLY_LANGUAGE_MARKER)
  ) {
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
