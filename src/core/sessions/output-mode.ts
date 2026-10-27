/**
 * Output mode ("markdown" vs "rich HTML"): the mode a session is on and the words
 * that tell its model about it, plus the reply-language text.
 *
 * WHEN those words ride a message is no longer decided here: they are two of the
 * message hints (src/core/hints/hint-registry.ts, kinds `rich-output` and
 * `reply-language`), sent as `<system-reminder>` blocks on the schedule the hint
 * registry gives them (full instruction at session start, after a compaction and on
 * a mode change; a short reminder every few messages; the language at start, after
 * a compaction, on a change and when a reply drifts).
 *
 * Effective mode = record.output_mode ?? config.session.output_mode ?? default.
 * A record that never overrode the mode therefore follows the config LIVE, and
 * flipping the config produces a real change for it on the next send.
 *
 * The bracket lines Walnut wrote before the hint registry (`[Rich output mode: …]`,
 * `[Rich output mode is still on …]`, `[Reply language: …]`, `[Voice reply: …]`)
 * live on in old transcripts only. `stripLegacyHintLines` takes them off rows written
 * before this home first ran the registry, never off a newer row, so a person who
 * types such a line today sees it as typed.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Config, SessionOutputMode, SessionRecord } from '../types.js';
import { DEFAULT_SESSION_OUTPUT_MODE } from '../types.js';
import { WALNUT_HOME } from '../../constants.js';

/** Opening literal of the pre-registry edge instruction, kept to recognise old rows. */
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
  'rich output mode is on. Write markdown for what markdown does well: headings, lists, '
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
  'rich output mode is off. Return to plain markdown replies.';

/** Opening literal of the pre-registry standing reminder, kept to recognise old rows. */
export const OUTPUT_MODE_REMINDER_MARKER = '[Rich output mode is still on';

/** The standing reminder: ONE short line, the `rich-output` hint's periodic form.
 *
 *  It says MARKDOWN FIRST on purpose. The old wording ("reply in HTML where
 *  visual structure helps") read as "answer in HTML", and the observed result was
 *  hand-built `<table>`s and `<pre>` blocks for content markdown expresses better
 *  — which also costs the plain-text fallback that notifications, search snippets
 *  and the phone's native text depend on. Naming what HTML is actually FOR
 *  (colour, diagrams, layout markdown has no shape for) is what makes the line
 *  steer instead of just remind (reported 2026-09-03). */
export const RICH_OUTPUT_MODE_REMINDER =
  'rich output mode is still on: markdown first; code blocks for real code, output and file trees; '
  + 'a real diagram is responsive inline <svg>, never ASCII or mermaid; '
  + 'colour or layout: raw HTML directly in this reply. '
  + 'No files, screenshots or HTML fences unless requested; no blank lines in a widget.';

/** Opening literal of the pre-registry reply-language line, kept to recognise old rows. */
export const REPLY_LANGUAGE_MARKER = '[Reply language: ';

/** The setting is one sentence; a pasted essay would ride every hint. */
export const REPLY_LANGUAGE_MAX_CHARS = 300;

/**
 * The reply-language text for this config, or null when the setting is empty.
 * Whitespace (newlines included) collapses to single spaces.
 */
export function replyLanguageText(config?: OutputModeConfig | null): string | null {
  const raw = config?.session?.reply_language;
  if (typeof raw !== 'string') return null;
  let text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (text.length > REPLY_LANGUAGE_MAX_CHARS) text = `${text.slice(0, REPLY_LANGUAGE_MAX_CHARS).trimEnd()}…`;
  return text;
}

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

/**
 * Rows written before this (ms) may carry the pre-registry bracket lines; a row
 * after it never does, because the hint registry writes `<system-reminder>` blocks
 * only. It is the moment this Walnut home first ran the registry, kept in
 * `hint-registry-since.json` (loadLegacyHintCutoff, at server start). Until that
 * read lands it is this process's start, which is never earlier.
 */
let legacyHintLinesUntil = Date.now();
export const LEGACY_HINT_CUTOFF_FILE = 'hint-registry-since.json';

/** Read (or, the first time, write) when this home started the hint registry. Never throws. */
export async function loadLegacyHintCutoff(home = WALNUT_HOME, now = Date.now()): Promise<number> {
  const file = path.join(home, LEGACY_HINT_CUTOFF_FILE);
  try {
    const at = Date.parse((JSON.parse(await fs.readFile(file, 'utf8')) as { since?: string }).since ?? '');
    if (Number.isFinite(at)) return (legacyHintLinesUntil = at);
  } catch { /* first run, or unreadable: write it */ }
  try {
    await fs.writeFile(file, `${JSON.stringify({ since: new Date(now).toISOString() })}\n`, { flag: 'wx' });
    legacyHintLinesUntil = now;
  } catch {
    // Another process wrote it first: read that one.
    try {
      const at = Date.parse((JSON.parse(await fs.readFile(file, 'utf8')) as { since?: string }).since ?? '');
      if (Number.isFinite(at)) legacyHintLinesUntil = at;
    } catch { /* keep the process start */ }
  }
  return legacyHintLinesUntil;
}

/** Tests: pin the cutoff. */
export function _setLegacyHintCutoffForTesting(ms: number): void {
  legacyHintLinesUntil = ms;
}

/** The phone's pre-registry voice line. */
const VOICE_REPLY_MARKER = '[Voice reply: ';

/** Is this whole LINE one of the old bracket lines? Line-anchored, as before. */
function isLegacyHintLine(line: string): boolean {
  const t = line.trim();
  if (t.startsWith(OUTPUT_MODE_INSTRUCTION_MARKER)) return true;
  // The phone's voice-reply line rides the same way (voice-reply.ts), so the one
  // display choke point strips it too.
  if (t.startsWith(VOICE_REPLY_MARKER) && t.endsWith(']')) return true;
  if (t.startsWith(REPLY_LANGUAGE_MARKER) && t.endsWith(']')) return true;
  return t.startsWith(OUTPUT_MODE_REMINDER_MARKER) && t.endsWith(']');
}

/**
 * Take the old bracket lines off a row written before the hint registry started
 * (`at`: the row's time, ms or ISO). A newer row, or one with no time, is returned
 * as it is: the user's own words are never matched against a pattern.
 * Display-only, like the hint parse (src/core/hints/hint-format.ts).
 */
export function stripLegacyHintLines(text: string, at?: number | string | null): string {
  const ms = typeof at === 'string' ? Date.parse(at) : at;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms >= legacyHintLinesUntil) return text;
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
    if (!isLegacyHintLine(lines[i])) {
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
