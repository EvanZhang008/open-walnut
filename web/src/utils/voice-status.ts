/**
 * Global voice-input status + insert-target registry.
 *
 * Why module-level: MicButton instances live inside individual chat inputs,
 * but the sidebar's persistent Voice entry needs to reflect "a transcription
 * is running" / "the last one failed" no matter which input it came from —
 * and the Voice history panel needs somewhere to insert recovered text.
 */

export interface VoiceStatus {
  /** A transcription request is in flight somewhere in the app */
  transcribing: boolean;
  /** The most recent transcription failed or came back empty */
  lastFailed: boolean;
}

let status: VoiceStatus = { transcribing: false, lastFailed: false };
let listeners: Array<(s: VoiceStatus) => void> = [];

export function getVoiceStatus(): VoiceStatus {
  return status;
}

export function setVoiceStatus(patch: Partial<VoiceStatus>): void {
  status = { ...status, ...patch };
  listeners.forEach(fn => fn(status));
}

export function subscribeVoiceStatus(fn: (s: VoiceStatus) => void): () => void {
  listeners.push(fn);
  return () => { listeners = listeners.filter(l => l !== fn); };
}

// ── Insert target ───────────────────────────────────────────────────────────
// The chat input that most recently had focus registers itself; the Voice
// panel's Insert action delivers text there. Falls back to clipboard if no
// input has registered (e.g. on a page with no composer).

type InsertFn = (text: string) => void;
let insertTarget: InsertFn | null = null;

export function registerVoiceInsertTarget(fn: InsertFn): void {
  insertTarget = fn;
}

/** Insert into the last-focused chat input. Returns false if none registered. */
export function insertVoiceText(text: string): boolean {
  if (!insertTarget) return false;
  try {
    insertTarget(text);
    return true;
  } catch {
    return false;
  }
}
