/**
 * How to put the Walnut browser extension in Chrome or Firefox, step by step, with the download
 * this Walnut serves (/downloads/walnut-extension-<browser>.zip, built with the web app). Shared
 * by the connect page (/connect-extension) and Settings → Passwords.
 */
import { useState } from 'react';
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

export function ExtensionInstallSteps({ browser }: { browser: ExtBrowser }) {
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
