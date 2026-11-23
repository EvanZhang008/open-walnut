/**
 * Settings > Sessions, "<Engine> sign-in": what one host's row says and offers, from the
 * server's EngineSignInStatus (api/engine-sign-in.ts), the words of each refusal, and the deep
 * link the chat uses to open a host's sign-in here (EngineSignInNote). Pure: the group
 * (EngineSignInGroup.tsx) draws it.
 */
import { useSyncExternalStore } from 'react';
import type { NoticeTone } from '@/components/common/NoticeCard';
import type { EngineSignInStatus } from '@/api/engine-sign-in';
import { ApiError } from '@/api/api-error';
import { ENGINE_SIGN_IN_ROW_PREFIX } from '../settings-legacy-links';

/** The engines with a sign-in of their own, and how their sign-in names its two ways in. */
export const ENGINE_SIGN_IN_UI = {
  antigravity: { name: 'Antigravity', account: 'Google', keyName: 'Gemini API key' },
} as const;
export type SignInEngine = keyof typeof ENGINE_SIGN_IN_UI;

export function hasSignInUi(engine: string): engine is SignInEngine {
  return Object.hasOwn(ENGINE_SIGN_IN_UI, engine);
}

export type RowAction = 'sign-in' | 'sign-out' | 'remove-key' | 'install' | 'check';

export interface RowView {
  tone: NoticeTone;
  word: string;
  /** The row's one button, or none. */
  action: RowAction | null;
  /** Its label ("Install on devbox"). */
  actionLabel?: string;
  /** Why the row says what it says, on hover (the host's own reason). */
  title?: string;
  /** The installer command shown with Copy (not installed). */
  installCommand?: string;
}

/** One host's row at rest (no sign-in step open). */
export function rowView(s: EngineSignInStatus, engine: SignInEngine): RowView {
  const ui = ENGINE_SIGN_IN_UI[engine];
  const title = s.reason ?? undefined;
  if (s.needsDaemonUpdate) return { tone: 'warn', word: 'Daemon needs update', action: null, title: title ?? 'Its Walnut daemon updates on its next connect.' };
  if (s.state === 'signed_in') {
    if (s.method === 'api-key') {
      // A key in the host's own environment is not Walnut's to remove.
      return s.apiKey.source === 'settings'
        ? { tone: 'ok', word: 'Signed in with API key', action: 'remove-key', actionLabel: 'Remove key' }
        : { tone: 'ok', word: 'Signed in with API key', action: null, title: `The ${ui.keyName} is set in this host's own environment.` };
    }
    return { tone: 'ok', word: `Signed in with ${ui.account}`, action: 'sign-out', actionLabel: 'Sign out' };
  }
  if (s.state === 'not_signed_in') return { tone: 'muted', word: 'Not signed in', action: 'sign-in', actionLabel: `Sign in with ${ui.account}` };
  if (s.state === 'not_installed') {
    return {
      tone: 'muted', word: 'Not installed', title,
      action: s.install.canInstall ? 'install' : null, actionLabel: `Install on ${s.hostName}`,
      installCommand: s.install.command,
    };
  }
  // unknown: never dialled (the list), or the host did not answer.
  if (s.connected === false) return { tone: 'muted', word: 'Not connected', action: 'check', actionLabel: 'Check now', title };
  return { tone: 'warn', word: `Can't reach ${s.hostName} now`, action: 'check', actionLabel: 'Try again', title };
}

/** The code of a refusal (`{ error, code }`), or null. */
export function refusalCode(err: unknown): string | null {
  const code = err instanceof ApiError ? (err.body as { code?: unknown } | undefined)?.code : undefined;
  return typeof code === 'string' ? code : null;
}

export const BAD_CODE_WORDS = "That code didn't work. Open Google sign-in to get a new one.";

/** Did the refusal of a pasted code end that sign-in (a new link is needed)? */
export function codeEndsSignIn(code: string | null): boolean {
  return code === 'bad_code' || code === 'timeout' || code === 'no_sign_in' || code === 'failed';
}

/** The words a refused step shows under its row. */
export function refusalWords(err: unknown, step: 'finish' | 'start' | 'sign-out' | 'key' | 'install' | 'check', hostName: string): string {
  const code = refusalCode(err);
  const own = err instanceof Error ? err.message : String(err);
  if (step === 'finish') {
    if (code === 'bad_code' || code === 'invalid_code') return BAD_CODE_WORDS;
    if (code === 'timeout') return 'The sign-in did not finish in time. Open Google sign-in again for a new code.';
    if (code === 'no_sign_in') return 'That sign-in had already ended. Open Google sign-in again for a new code.';
  }
  if (code === 'host_unreachable' || code === 'not_connected') return `Can't reach ${hostName} now. Try again once it is connected.`;
  if (code === 'daemon_needs_upgrade') return `The Walnut daemon on ${hostName} needs an update first; it updates on its next connect.`;
  if (code === 'human_only') return 'Only you can do this, from your own Walnut window.';
  if (code === 'busy') return `${capital(own)}.`;
  if (code === 'invalid_key') return `${capital(own)}.`;
  if (step === 'start') return `Could not start the sign-in on ${hostName}: ${own}`;
  if (step === 'install') return `The install on ${hostName} failed: ${own}`;
  return own;
}

function capital(s: string): string {
  const t = s.replace(/[.\s]+$/, '');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** The row's DOM id, `engine-sign-in-<engine>-<host>` (Settings decodes its hash to it, so the host stays as it is). */
export function signInRowId(engine: string, host: string): string {
  return `${ENGINE_SIGN_IN_ROW_PREFIX}${engine}-${host}`;
}

/** The group's own anchor (a deep link that knows the engine but not the host key). */
export function signInGroupId(engine: string): string {
  return `${ENGINE_SIGN_IN_ROW_PREFIX}${engine}`;
}

// ── The chat's deep link: open Settings at a host's row and open its sign-in ──

export interface SignInRequest { engine: string; host?: string; hostName?: string; nonce: number }
let request: SignInRequest | null = null;
let nonce = 0;
const listeners = new Set<() => void>();

/** Does `req` name this row (by host key, else by the name the sentence used)? */
export function requestNames(req: Pick<SignInRequest, 'engine' | 'host' | 'hostName'>, s: Pick<EngineSignInStatus, 'engine' | 'host' | 'hostName'>): boolean {
  if (req.engine !== s.engine) return false;
  if (req.host) return req.host === s.host;
  return !!req.hostName && req.hostName.toLowerCase() === s.hostName.toLowerCase();
}

/**
 * Navigate to the host's row in Settings > Sessions and ask it to open its sign-in. The ask
 * rides a nonce, read once by the row it names (`takeSignInRequest`), so a reload of the
 * Settings page only lands on the row and never starts a sign-in by itself.
 */
export function openEngineSignIn(navigate: (to: string) => void, target: { engine: string; host?: string; hostName?: string }): void {
  request = { ...target, nonce: ++nonce };
  for (const l of listeners) l();
  navigate(`/settings#${encodeURIComponent(target.host ? signInRowId(target.engine, target.host) : signInGroupId(target.engine))}`);
}

export function useSignInRequest(): SignInRequest | null {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => request, () => request);
}

/** Take the pending ask if it names this row (it is then gone). */
export function takeSignInRequest(s: Pick<EngineSignInStatus, 'engine' | 'host' | 'hostName'>): SignInRequest | null {
  if (!request || !requestNames(request, s)) return null;
  const taken = request;
  request = null;
  return taken;
}

/** Test hook. */
export function __resetSignInRequestForTests(): void {
  request = null;
  listeners.clear();
}
