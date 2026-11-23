/**
 * The words a session says when its engine's CLI on the host is not signed in, and how the
 * chat reads them back: ONE sentence the server writes (engine-sign-in.ts, acp-session.ts) and
 * the browser recognises (a failed message, a session error line) to offer "Open Settings to
 * sign in". Pure and browser-safe: the web imports this file directly.
 */
import { ENGINE_FULL_NAMES } from './engine-names.js';
import type { SessionEngine } from '../types.js';

const TAIL = ' Open Settings to sign in.';

/** "Antigravity is not signed in on devbox. Open Settings to sign in." */
export function notSignedInSentence(engine: SessionEngine, hostName: string): string {
  return `${ENGINE_FULL_NAMES[engine]} is not signed in on ${hostName}.${TAIL}`;
}

export interface NotSignedIn {
  engine: SessionEngine;
  /** The host as the sentence names it ("this Mac", a label, an alias). */
  hostName: string;
  /** The sentence without its "Open Settings" tail: what the chat shows beside its own button. */
  line: string;
}

const SENTENCE = /^(.+?) is not signed in on (.+?)\.(?: Open Settings to sign in\.)?$/;

/** The engine and host a not-signed-in sentence names, or null for any other text. */
export function parseNotSignedIn(text: string | null | undefined): NotSignedIn | null {
  if (!text) return null;
  const m = SENTENCE.exec(text.trim());
  if (!m) return null;
  const engine = (Object.keys(ENGINE_FULL_NAMES) as SessionEngine[]).find((id) => ENGINE_FULL_NAMES[id] === m[1]);
  if (!engine) return null;
  return { engine, hostName: m[2]!, line: `${m[1]} is not signed in on ${m[2]}.` };
}
