/**
 * /connect-extension: the page the Walnut browser extension opens to connect itself. It finds
 * the extension through its content script (window.postMessage, this page's own origin only),
 * and on the person's click mints a browser sign-in code (POST /api/devices/browser-code, which
 * only the person at this machine may) and hands it over; the extension trades it for its own
 * device token. The extension answers only on a tab it opened itself, so another page cannot
 * pair a browser behind the person's back. With no extension found, it shows how to install one.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiPost } from '@/api/client';
import { saveErrorMessage } from '@/components/settings/settings-pane-context';
import { ExtensionInstallSteps, detectBrowser } from '@/components/passwords/ExtensionInstall';
import '@/styles/passwords.css';

type Phase = 'looking' | 'missing' | 'ready' | 'connecting' | 'connected' | 'already' | 'error';

interface ExtMessage { source?: string; type?: string; connected?: boolean; device?: string; message?: string }

export function ConnectExtensionPage() {
  const [phase, setPhase] = useState<Phase>('looking');
  const [error, setError] = useState<string | null>(null);
  const [device, setDevice] = useState<string | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const browser = detectBrowser();

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window || e.origin !== location.origin) return;
      const d = e.data as ExtMessage | null;
      if (!d || d.source !== 'walnut-extension') return;
      if (d.type === 'present') {
        if (phaseRef.current === 'looking' || phaseRef.current === 'missing') setPhase(d.connected ? 'already' : 'ready');
      } else if (d.type === 'connected') {
        setDevice(d.device ?? null);
        setPhase('connected');
      } else if (d.type === 'error') {
        setError(d.message ?? 'The extension could not connect.');
        setPhase('error');
      }
    };
    window.addEventListener('message', onMessage);
    // The content script may load after this page: ask a few times.
    let n = 0;
    const hello = () => window.postMessage({ source: 'walnut-connect-page', type: 'hello' }, location.origin);
    hello();
    const t = window.setInterval(() => {
      n += 1;
      hello();
      if (n === 6 && phaseRef.current === 'looking') setPhase('missing');
      if (n >= 40) window.clearInterval(t);
    }, 500);
    return () => { window.removeEventListener('message', onMessage); window.clearInterval(t); };
  }, []);

  const connect = useCallback(async () => {
    setError(null);
    setPhase('connecting');
    try {
      const res = await apiPost<{ code: string }>('/api/devices/browser-code');
      window.postMessage({ source: 'walnut-connect-page', type: 'code', code: res.code }, location.origin);
    } catch (err) {
      setError(saveErrorMessage(err));
      setPhase('error');
    }
  }, []);

  return (
    <div className="pw-ext-page" data-testid="connect-extension">
      <div className="pw-ext-card">
        <div className="pw-ext-icon" aria-hidden="true">
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="15" r="4" /><path d="M10.85 12.15 19 4" /><path d="m18 5 2 2" /><path d="m15 8 2 2" /></svg>
        </div>
        {phase === 'looking' && (
          <>
            <h1>Looking for the Walnut extension…</h1>
            <p>One moment.</p>
          </>
        )}
        {(phase === 'ready' || phase === 'connecting' || phase === 'error') && (
          <>
            <h1>Connect this browser to Walnut?</h1>
            <p>The Walnut extension will fill and save passwords from your vault on the sites you visit. It still asks for your master password before it shows any.</p>
            <button type="button" className="pw-btn pw-btn-primary pw-ext-go" data-testid="connect-extension-go" disabled={phase === 'connecting'} onClick={() => void connect()}>
              {phase === 'connecting' ? 'Connecting…' : 'Connect'}
            </button>
            {error && <p className="pw-ext-err" role="alert">{error}</p>}
            <p className="pw-ext-fine">You can remove it any time in Settings, Passwords.</p>
          </>
        )}
        {phase === 'connected' && (
          <>
            <h1 data-testid="connect-extension-done">Connected</h1>
            <p>{device ? `${device} is connected.` : 'The extension is connected.'} Click the Walnut icon in the toolbar to unlock it, then sign in to any site. You can close this tab.</p>
          </>
        )}
        {phase === 'already' && (
          <>
            <h1>Already connected</h1>
            <p>The Walnut extension in this browser is connected to this Walnut. Click its icon in the toolbar to unlock it.</p>
          </>
        )}
        {phase === 'missing' && (
          <>
            <h1>Install the Walnut extension</h1>
            <p>Fill and save passwords on every site, from your own Walnut. Then come back to this page.</p>
            <div className="pw-ext-install"><ExtensionInstallSteps browser={browser} /></div>
            <p className="pw-ext-fine">Already installed? Click the Walnut icon in the toolbar and press Connect there: it opens this page ready to connect.</p>
          </>
        )}
      </div>
    </div>
  );
}
