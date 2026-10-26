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
// input has registered (e.g. on a page with no composer). An input that goes
// away hands the target back to the one before it: a closed question card
// used to keep it, and Insert reported success into a box nobody could see.
// A box that names itself (`box`) takes the target only when the user focuses
// it, never by mounting: with a mic on every reply box, the inbox letter or a
// Board card that happened to render last would otherwise take the composer's.

type InsertFn = (text: string) => void;
interface InsertTarget { fn: InsertFn; box?: () => Element | null }
let insertTargets: InsertTarget[] = [];

function onFocusIn(e: FocusEvent): void {
  const el = e.target;
  if (!(el instanceof Node)) return;
  let hit = insertTargets.find((t) => t.box?.()?.contains(el));
  // Typing anywhere else (the composer, which names no box) gives Insert back to
  // the newest composer, not to a box that was focused earlier.
  if (!hit && isEditable(el)) hit = [...insertTargets].reverse().find((t) => !t.box);
  if (!hit || insertTargets[insertTargets.length - 1] === hit) return;
  insertTargets = [...insertTargets.filter((t) => t !== hit), hit];
}
function isEditable(el: Node): boolean {
  const e = el as Partial<HTMLElement> & { tagName?: string };
  return e.tagName === 'TEXTAREA' || e.tagName === 'INPUT' || e.isContentEditable === true;
}
let listening = false;

/** Returns the unregister, for the input's unmount. */
export function registerVoiceInsertTarget(fn: InsertFn, box?: () => Element | null): () => void {
  const target: InsertTarget = { fn, box };
  if (box) {
    insertTargets.unshift(target);
    if (!listening && typeof document !== 'undefined') {
      document.addEventListener('focusin', onFocusIn, true);
      listening = true;
    }
  } else {
    insertTargets.push(target);
  }
  return () => { insertTargets = insertTargets.filter((t) => t !== target); };
}

/** Insert into the last-focused chat input. Returns false if none registered. */
export function insertVoiceText(text: string): boolean {
  const insertTarget = insertTargets[insertTargets.length - 1];
  if (!insertTarget) return false;
  try {
    insertTarget.fn(text);
    return true;
  } catch {
    return false;
  }
}
