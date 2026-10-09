/**
 * Shown when the server refuses this browser for lack of a credential: a browser
 * on another device, or one whose device token was revoked. Without it the app
 * renders an empty board, which reads as lost data. See api/unpaired.ts.
 *
 * It takes a sign-in code (api/browser-pair.ts): the person at the computer
 * Walnut runs on makes one in Settings > Phones & Cloud. A `#pair=` link fills it
 * in and signs in on its own; when that code fails, the form shows why.
 *
 * Portalled to <body> for the same reason as StaleBuildPill: a `contain: paint`
 * ancestor turns `position: fixed` into "fixed inside that box".
 */
import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { getUnpairedState, subscribeUnpaired } from '@/api/unpaired';
import {
  exchangeBrowserCode, getFragmentPairState, subscribeFragmentPair, type FragmentPairState,
} from '@/api/browser-pair';
import '@/styles/unpaired-notice.css';

export function UnpairedNotice() {
  const state = useSyncExternalStore(subscribeUnpaired, getUnpairedState);
  const fragment = useSyncExternalStore(subscribeFragmentPair, getFragmentPairState);
  if (state === 'ok') return null;
  const port = window.location.port || '3456';
  return createPortal(
    <div className="unpaired-notice" role="alert" data-testid="unpaired-notice">
      <div className="unpaired-notice-title">
        {state === 'revoked' ? 'This device is no longer paired' : 'This device is not paired with Walnut'}
      </div>
      <p className="unpaired-notice-body">
        Walnut answers only the computer it runs on and the devices you sign in. To sign in this
        browser, make a code in Walnut on that computer (Settings &gt; Phones &amp; Cloud) and enter it here.
      </p>
      <CodeForm fragment={fragment} />
      <p className="unpaired-notice-body unpaired-notice-more">
        On that computer itself, open <code>http://localhost:{port}</code>; from another computer you can
        also forward the port over SSH (<code>ssh -L {port}:localhost:{port} &lt;that computer&gt;</code>).
        For a phone, pair the Walnut app in Settings &gt; Phones &amp; Cloud.
      </p>
    </div>,
    document.body,
  );
}

function CodeForm({ fragment }: { fragment: FragmentPairState }) {
  const [code, setCode] = useState(fragment.phase === 'idle' ? '' : fragment.code);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(fragment.phase === 'failed' ? fragment.message : null);
  useEffect(() => {
    if (fragment.phase !== 'failed') return;
    setCode(fragment.code);
    setError(fragment.message);
  }, [fragment]);

  const pending = busy || fragment.phase === 'pending';
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const typed = code.trim();
    if (pending || !typed) return;
    setBusy(true);
    setError(null);
    const result = await exchangeBrowserCode(typed);
    if (result.ok) {
      // Every request and the WebSocket start over with the new token.
      window.location.reload();
      return;
    }
    setBusy(false);
    setError(result.message);
  };

  return (
    <form className="unpaired-notice-pair" onSubmit={(e) => { void submit(e); }} data-testid="unpaired-code-form">
      <label className="unpaired-notice-label" htmlFor="unpaired-code">Sign-in code</label>
      <div className="unpaired-notice-pair-row">
        <input
          id="unpaired-code"
          className="unpaired-notice-input"
          value={code}
          onChange={(e) => { setCode(e.target.value); setError(null); }}
          placeholder="XXXX-XXXX"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          maxLength={20}
          disabled={pending}
          data-testid="unpaired-code-input"
        />
        <button type="submit" className="btn btn-primary btn-sm" disabled={pending || !code.trim()} data-testid="unpaired-code-submit">
          {pending ? 'Signing in...' : 'Sign in'}
        </button>
      </div>
      {error && <p className="unpaired-notice-error" role="status" data-testid="unpaired-code-error">{error}</p>}
    </form>
  );
}
