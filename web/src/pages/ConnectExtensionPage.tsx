/**
 * /connect-extension: the page the Walnut browser extension opens to connect itself. It finds
 * the extension through its content script (window.postMessage, this page's own origin only),
 * and on the person's click mints a browser sign-in code (POST /api/devices/browser-code, which
 * only the person at this machine may) and hands it over; the extension trades it for its own
 * device token. The extension answers only on a tab it opened itself, so another page cannot
 * pair a browser behind the person's back. With no extension found, it shows how to install one.
 *
 * It leads with what the extension is for: Walnut's Ask beside the page and agents in this
 * browser; passwords come with it. Whether agents may use this browser is asked here once, as a
 * checkbox on by default, and goes with the code (the extension applies it at this connect only).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiPost } from '@/api/client';
import { saveErrorMessage } from '@/components/settings/settings-pane-context';
import { ExtensionInstallSteps, detectBrowser } from '@/components/passwords/ExtensionInstall';
import '@/styles/passwords.css';

type Phase = 'looking' | 'missing' | 'ready' | 'connecting' | 'connected' | 'already' | 'error';

interface ExtMessage { source?: string; type?: string; connected?: boolean; device?: string; message?: string }

/** Walnut's Ask: a speech bubble (the extension's own first screen shows the same). */
const ASK_ICON = (
  <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" /><path d="M9 11h.01" /><path d="M12 11h.01" /><path d="M15 11h.01" />
  </svg>
);

export function ConnectExtensionPage() {
  const [phase, setPhase] = useState<Phase>('looking');
  const [error, setError] = useState<string | null>(null);
  const [device, setDevice] = useState<string | null>(null);
  /** Let Walnut agents use this browser: the person's choice, on by default here. */
  const [agents, setAgents] = useState(true);
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
      window.postMessage({ source: 'walnut-connect-page', type: 'code', code: res.code, agents }, location.origin);
    } catch (err) {
      setError(saveErrorMessage(err));
      setPhase('error');
    }
  }, [agents]);

  return (
    <div className="pw-ext-page" data-testid="connect-extension">
      <div className="pw-ext-card">
        <div className="pw-ext-icon" aria-hidden="true">{ASK_ICON}</div>
        {phase === 'looking' && (
          <>
            <h1>Looking for the Walnut extension…</h1>
            <p>One moment.</p>
          </>
        )}
        {(phase === 'ready' || phase === 'connecting' || phase === 'error') && (
          <>
            <h1>Connect this browser to Walnut?</h1>
            <p>Ask a quick question about the page you are on from the browser's side panel, and let your Walnut agents work in this browser. It also fills and saves passwords from your vault, after you unlock it with your master password.</p>
            <label className="pw-ext-choice" data-testid="connect-extension-agents-row">
              <input type="checkbox" checked={agents} onChange={(e) => setAgents(e.target.checked)} disabled={phase === 'connecting'} data-testid="connect-extension-agents" />
              <span>
                <span className="pw-ext-choice-title">Let Walnut agents use this browser</span>
                <span className="pw-ext-choice-note">They open their own tabs in a separate window, signed in as you, and ask you before they send, buy, post or delete anything. You can change this in the extension's Settings.</span>
              </span>
            </label>
            <button type="button" className="pw-btn pw-btn-primary pw-ext-go" data-testid="connect-extension-go" disabled={phase === 'connecting'} onClick={() => void connect()}>
              {phase === 'connecting' ? 'Connecting…' : 'Connect'}
            </button>
            {error && <p className="pw-ext-err" role="alert">{error}</p>}
            <p className="pw-ext-fine">You can remove it any time in Settings, Browser extension.</p>
          </>
        )}
        {phase === 'connected' && (
          <>
            <h1 data-testid="connect-extension-done">Connected</h1>
            <p>{device ? `${device} is connected.` : 'The extension is connected.'} Click the Walnut icon in the toolbar to ask a quick question about any page{agents ? ', and your agents can now use this browser' : ''}. Your passwords are behind the key in its header. You can close this tab.</p>
          </>
        )}
        {phase === 'already' && (
          <>
            <h1>Already connected</h1>
            <p>The Walnut extension in this browser is connected to this Walnut. Click its icon in the toolbar to ask a quick question about the page you are on.</p>
          </>
        )}
        {phase === 'missing' && (
          <>
            <h1>Install the Walnut extension</h1>
            <p>Ask a quick question about any page, let your agents work in this browser, and fill passwords from your own Walnut. Then come back to this page.</p>
            <div className="pw-ext-install"><ExtensionInstallSteps browser={browser} /></div>
            <p className="pw-ext-fine">Already installed? Click the Walnut icon in the toolbar and press Connect there: it opens this page ready to connect.</p>
          </>
        )}
      </div>
    </div>
  );
}
