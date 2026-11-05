/**
 * The line a session an engine switch started with when the user wrote nothing (the picker closed
 * on another engine): Walnut's note asking the new engine for a ready line
 * (src/core/sessions/engine-switch.ts switchReadyNote). The chat draws it as one quiet
 * "Switched to Pi" row, never a card: it is a setting the user changed, not a message to read.
 */
import type { SessionEnvelope } from '@open-walnut/history-session-envelope';

const READY_NOTE = /^The user switched this task to (.+?) and has not written anything yet\./;

/** The engine a switch's ready note names, or null for any other envelope. */
export function engineSwitchNoteEngine(envelope: Pick<SessionEnvelope, 'kind' | 'peer' | 'body'>): string | null {
  if (envelope.kind !== 'peer-note' || envelope.peer.title !== 'Walnut (engine switch)') return null;
  return READY_NOTE.exec((envelope.body ?? '').trim())?.[1] ?? null;
}
