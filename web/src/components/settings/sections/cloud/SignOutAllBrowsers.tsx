/**
 * "Sign out browsers signed in with a link", the first row of Signed-in browsers: one action that
 * ends every browser signed in with a code (POST /api/devices/browser-sign-ins/revoke,
 * src/web/routes/browser-sign-in.ts). Each one needs a new sign-in link after it;
 * the Walnut extension and the phone app stay connected. Shown to the computer
 * Walnut runs on (a signed-in browser removes only itself) whenever one is
 * signed in, so the way to sign them out is always in the same place.
 */
import { useState } from 'react';
import { apiPost } from '@/api/client';
import { SettingsRow } from '../../SettingsSection';
import { SettingsButton } from '../../inputs/SettingsButton';
import { isRepeatClick } from '../../inputs/InlineConfirmButton';
import { requestFailureText } from '@/utils/request-failure';
import { log } from '@/utils/log';

const TIMEOUT_MS = 15_000;

/** The browsers this row signs out: named by routes/browser-pair.ts, never the extension (`extension-…`). */
export const SIGNED_IN_BROWSER = /^browser-[0-9a-f]{6}$/;

/** What happened, said under the list: the row itself goes with the browsers it signed out. */
export interface SignOutResult {
  line: string;
  kind: 'success' | 'error';
}

export function signedOutResult(revoked: number, problem: string | null): SignOutResult {
  const done = revoked === 1 ? 'Signed out 1 browser. It needs a new link to sign in again.'
    : revoked > 1 ? `Signed out ${revoked} browsers. Each needs a new link to sign in again.` : '';
  if (!problem) return { line: done, kind: 'success' };
  return { line: `${done ? `${done} ` : ''}Couldn't sign out: ${problem}`, kind: 'error' };
}

/** `names`: the browsers listed below it; only those are signed out, so the count asked is the count done. */
export function SignOutAllBrowsers({ names, onDone }: { names: readonly string[]; onDone: (result: SignOutResult) => Promise<void> | void }) {
  const count = names.length;
  // Asked and not answered yet: the button waits, so it never offers the same browsers twice.
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const signOutAll = async () => {
    setBusy(true);
    let revoked = 0;
    let problem: string | null = null;
    try {
      const out = await apiPost<{ revoked: string[]; refused: string[] }>('/api/devices/browser-sign-ins/revoke', { names: [...names] }, { timeoutMs: TIMEOUT_MS });
      log.info('settings', 'signed every browser out', { revoked: out.revoked.length, refused: out.refused.length });
      revoked = out.revoked.length;
      if (out.refused.length > 0) problem = `${out.refused.length} could not be signed out.`;
    } catch (err) {
      problem = requestFailureText(err, TIMEOUT_MS);
    }
    try {
      await onDone(signedOutResult(revoked, problem));
    } finally {
      setBusy(false);
    }
  };
  const one = count === 1;
  // Signing every browser out is bigger than one Remove: the first click asks, in words,
  // with Cancel beside it, and waits for the answer (no clock turns it back).
  const ask = () => setAsking(true);
  const cancel = () => setAsking(false);
  const confirm = () => { setAsking(false); void signOutAll(); };
  return (
    <SettingsRow
      label="Sign out browsers signed in with a link"
      help={asking
        ? (one
          ? 'Sign out the browser listed below? It needs a new link to sign in again.'
          : `Sign out the ${count} browsers listed below? Each needs a new link to sign in again.`)
        : one
          ? 'Signs out the browser listed below. It needs a new link to sign in again.'
          : `Signs out the ${count} browsers listed below. Each needs a new link to sign in again.`}
      data-testid="devices-sign-out-browsers-row"
      control={asking ? (
        <span className="settings-addons-inline" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } }}>
          <SettingsButton variant="text" onClick={cancel} data-testid="devices-sign-out-browsers-cancel">Cancel</SettingsButton>
          <SettingsButton variant="danger" onClick={(e) => { if (!isRepeatClick(e)) confirm(); }} autoFocus data-testid="devices-sign-out-browsers-confirm">Confirm sign out</SettingsButton>
        </span>
      ) : (
        <SettingsButton
          variant="danger"
          busy={busy}
          busyLabel="Signing out..."
          aria-label={one ? 'Sign out the browser signed in with a link' : `Sign out all ${count} browsers signed in with a link`}
          data-testid="devices-sign-out-browsers"
          onClick={ask}
        >
          Sign out all
        </SettingsButton>
      )}
    />
  );
}
