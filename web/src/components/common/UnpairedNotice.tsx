/**
 * Shown when the server refuses this browser for lack of a credential: a browser
 * on another device, or one whose device token was revoked. Without it the app
 * renders an empty board, which reads as lost data. See api/unpaired.ts.
 *
 * Portalled to <body> for the same reason as StaleBuildPill: a `contain: paint`
 * ancestor turns `position: fixed` into "fixed inside that box".
 */
import { useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { getUnpairedState, subscribeUnpaired } from '@/api/unpaired';
import '@/styles/unpaired-notice.css';

export function UnpairedNotice() {
  const state = useSyncExternalStore(subscribeUnpaired, getUnpairedState);
  if (state === 'ok') return null;
  const port = window.location.port || '3456';
  return createPortal(
    <div className="unpaired-notice" role="alert" data-testid="unpaired-notice">
      <div className="unpaired-notice-title">
        {state === 'revoked' ? 'This device is no longer paired' : 'This device is not paired with Walnut'}
      </div>
      <p className="unpaired-notice-body">
        Walnut answers only the computer it runs on and the devices you pair. On that computer,
        open <code>http://localhost:{port}</code>. From another computer, forward the port
        over SSH (<code>ssh -L {port}:localhost:{port} &lt;that computer&gt;</code>) and open the
        same address. For a phone, pair the Walnut app in Settings &gt; Phones &amp; Cloud.
      </p>
    </div>,
    document.body,
  );
}
