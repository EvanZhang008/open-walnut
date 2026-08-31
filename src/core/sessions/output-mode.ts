/**
 * Output mode ("markdown" vs "rich HTML") edge injection.
 *
 * The mode is a per-session preference, but there is no control channel for a
 * reply STYLE the way there is for permission mode — the model only learns
 * about it from the conversation. So the instruction is EDGE-triggered: it
 * rides the first outgoing message after the mode changed, and nothing is
 * prepended ever again while the mode holds. A session that never touches the
 * toggle therefore pays exactly zero tokens.
 *
 * The edge lives on the RECORD (`output_mode` vs `output_mode_injected`), not
 * in the client, so a reload or a second tab cannot each inject their own copy:
 * the send that advances the injected marker makes every LATER send see
 * mode === injected. Note that this is a read-then-write, so it de-duplicates
 * SERIALIZED sends, not simultaneous ones — two sends that both read the record
 * before either writes it would both carry the instruction. Harmless (the model
 * reads the same sentence twice) and not worth a lock. Any send path that wants
 * the behavior calls resolveOutputModeEdge — today that is the web `session:send`
 * RPC.
 */

import type { SessionOutputMode, SessionRecord } from '../types.js';
import { DEFAULT_SESSION_OUTPUT_MODE } from '../types.js';

/** Opening literal shared by both instructions. The client peels the line off a
 *  rehydrated queue row by exactly this marker (useSessionSend.ts), so building
 *  the strings from it keeps emitter and stripper from drifting apart. */
export const OUTPUT_MODE_INSTRUCTION_MARKER = '[Rich output mode: ';

/** Turning rich output ON. Names the ONE routing rule the client enforces (a
 *  `<script>` needs the `html-app` fence, which renders in a sandboxed iframe) so
 *  the model doesn't have to discover it by having its output silently mangled.
 *  It deliberately does NOT say "inline <script> is stripped": a script-bearing
 *  chunk is routed to an island rather than stripped, so telling the model that
 *  would be a lie it might work around. */
export const RICH_OUTPUT_MODE_ON_INSTRUCTION =
  `${OUTPUT_MODE_INSTRUCTION_MARKER}ON] When visual structure helps understanding, write HTML directly in your reply `
  + '(layout, colors, SVG diagrams, <details>, CSS-only interactivity) — the client renders it natively '
  + 'while streaming. For anything needing <script>, emit a ```html-app fenced block '
  + '(rendered in a sandboxed iframe). Plain answers stay plain markdown.';

/** Turning it back OFF. Deliberately terse: the model already has the context. */
export const RICH_OUTPUT_MODE_OFF_INSTRUCTION =
  `${OUTPUT_MODE_INSTRUCTION_MARKER}OFF] Return to plain markdown replies.`;

export interface OutputModeEdge {
  /** The mode to record as injected once the message is actually enqueued. */
  mode: SessionOutputMode;
  /** One-line instruction to prepend (a blank line separates it from the text). */
  instruction: string;
}

/**
 * The instruction this send must carry, or null when the mode did not change
 * (the overwhelmingly common case — including a fresh session on the default).
 */
export function resolveOutputModeEdge(
  record: Pick<SessionRecord, 'output_mode' | 'output_mode_injected'> | null | undefined,
): OutputModeEdge | null {
  const mode = record?.output_mode ?? DEFAULT_SESSION_OUTPUT_MODE;
  const injected = record?.output_mode_injected ?? DEFAULT_SESSION_OUTPUT_MODE;
  if (mode === injected) return null;
  return {
    mode,
    instruction: mode === 'rich' ? RICH_OUTPUT_MODE_ON_INSTRUCTION : RICH_OUTPUT_MODE_OFF_INSTRUCTION,
  };
}

/** Prepend the instruction to the text that goes to the CLI. */
export function applyOutputModeInstruction(instruction: string, message: string): string {
  return `${instruction}\n\n${message}`;
}
