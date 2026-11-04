/**
 * How to put the Walnut browser extension in Chrome or Firefox, step by step, with the download
 * this Walnut serves (/downloads/walnut-extension-<browser>.zip, built with the web app). Shared
 * by the connect page (/connect-extension) and Settings → Browser extension.
 *
 * In Chrome on the machine Walnut runs on, Set up in Chrome does everything around the two clicks
 * only the person may make (Developer mode, Load unpacked): Walnut puts the extension into a
 * folder of its own (kept up to date with every Walnut update), copies its path, and opens the
 * Extensions page (POST /api/v1/browser/extension/setup, core/browser-control/extension-install.ts).
 */
import { useState } from 'react';
import { apiPost } from '@/api/client';
import { copyTextRobust } from '@/utils/clipboard';

export type ExtBrowser = 'chrome' | 'firefox';

export function detectBrowser(): ExtBrowser {
  return /Firefox\//.test(navigator.userAgent) ? 'firefox' : 'chrome';
}

export const EXTENSION_DOWNLOAD: Record<ExtBrowser, string> = {
  chrome: '/downloads/walnut-extension-chrome.zip',
  firefox: '/downloads/walnut-extension-firefox.zip',
};

function CopyAddress({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="pw-ext-addr"
      title="Copy, then paste it in the address bar"
      onClick={() => { void copyTextRobust(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }}
    >
      <code>{text}</code>
      <span>{done ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

/** This page is served by the Walnut on this machine, so a folder Walnut makes is one this browser can load. */
export function onWalnutMachine(host = location.hostname): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
}

const isMac = () => /Mac/.test(navigator.platform || navigator.userAgent);

interface SetupResult { dir: string; copied: boolean; opened: boolean }

/** Chrome on the machine Walnut runs on: Walnut sets the folder up, the person makes the two clicks. */
function ChromeSetupSteps() {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<SetupResult | null>(null);
  const [error, setError] = useState('');
  const setup = async () => {
    setBusy(true); setError('');
    try {
      setDone(await apiPost<SetupResult>('/api/v1/browser/extension/setup', { browser: 'chrome' }, { timeoutMs: 30_000 }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ol className="pw-ext-steps" data-testid="ext-steps-chrome-setup">
      <li>
        <button type="button" className="settings-button" data-testid="ext-setup" disabled={busy} onClick={() => void setup()}>
          {busy ? 'Setting up…' : done ? 'Set up again' : 'Set up in Chrome'}
        </button>{' '}
        Walnut puts the extension in a folder on this computer{isMac() ? ', copies the folder\'s path' : ''} and opens Chrome&apos;s Extensions page.
        {done && (
          <span className="pw-ext-done" data-testid="ext-setup-done" style={{ display: 'block', marginTop: 6 }}>
            The folder: <CopyAddress text={done.dir} />{done.copied ? ' (already copied)' : ''}
            {done.opened
              ? <> Chrome opened its Extensions page (if not, open <CopyAddress text="chrome://extensions" />).</>
              : <> Open <CopyAddress text="chrome://extensions" /> in a new tab.</>}
          </span>
        )}
        {error && <span className="settings-test-result" data-kind="fail" role="alert" style={{ display: 'block' }}>{error}</span>}
      </li>
      <li>On the Extensions page, turn on <b>Developer mode</b> (the switch at the top right). A row of buttons appears: <b>Load unpacked</b>, <b>Pack extension</b>, <b>Update</b>.</li>
      <li>
        Click <b>Load unpacked</b>. In the folder window {isMac()
          ? <>press <kbd>⌘</kbd><kbd>⇧</kbd><kbd>G</kbd>, paste the folder (<kbd>⌘</kbd><kbd>V</kbd>), press <kbd>Return</kbd></>
          : <>paste the folder into the folder box</>}, then click <b>Select</b>.
      </li>
      <li>The Walnut card appears. Pin Walnut from the puzzle-piece menu, click it, then <b>Connect</b>.</li>
      <li className="pw-ext-note">Walnut keeps this folder up to date: after each Walnut update the extension reloads itself.</li>
    </ol>
  );
}

export function ExtensionInstallSteps({ browser }: { browser: ExtBrowser }) {
  if (browser === 'chrome' && onWalnutMachine()) return <ChromeSetupSteps />;
  if (browser === 'firefox') {
    return (
      <ol className="pw-ext-steps" data-testid="ext-steps-firefox">
        <li><a href={EXTENSION_DOWNLOAD.firefox} download>Download the Firefox extension</a> and unzip it.</li>
        <li>Open <CopyAddress text="about:debugging#/runtime/this-firefox" /> in a new tab.</li>
        <li>Click <b>Load Temporary Add-on…</b> and pick <code>manifest.json</code> in the unzipped folder.</li>
        <li>Click the Walnut icon in the toolbar, then <b>Connect</b>.</li>
        <li className="pw-ext-note">Firefox keeps an extension loaded this way until it quits. A signed build that stays installed comes with Walnut&apos;s store release.</li>
      </ol>
    );
  }
  return (
    <ol className="pw-ext-steps" data-testid="ext-steps-chrome">
      <li><a href={EXTENSION_DOWNLOAD.chrome} download>Download the Chrome extension</a> and unzip it.</li>
      <li>Open <CopyAddress text="chrome://extensions" /> in a new tab and turn on <b>Developer mode</b> (top right).</li>
      <li>Click <b>Load unpacked</b> and pick the unzipped folder.</li>
      <li>Pin Walnut from the puzzle-piece menu, click it, then <b>Connect</b>.</li>
      <li className="pw-ext-note">Works the same in Edge, Brave and Arc.</li>
    </ol>
  );
}
