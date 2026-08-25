import { useRef, useState } from 'react';
import { SettingsSection, SettingsNotice } from '../SettingsSection';
import { apiGetText } from '@/api/client';
import { wsClient } from '@/api/ws';
import { getRecentEntries } from '@/utils/browser-logger';
import { getAppInfo } from '@/utils/app-info';
import { copyTextRobust } from '@/utils/clipboard';
import { redactText } from '@/utils/redact';

/**
 * Settings → Bug Report — generate a shareable diagnostic bundle anytime
 * (not just at crash): the server's scrubbed bundle (GET /api/bug-report)
 * merged with this browser's live state, so ONE artifact has everything.
 * Server unreachable? The client half still produces.
 */

const WINDOW_CHOICES = [
  { label: 'Last 15 min', mins: 15 },
  { label: 'Last 30 min', mins: 30 },
  { label: 'Last 2 hours', mins: 120 },
];

/** The client-side half — same data the crash report collects, minus the crash. */
function buildClientSection(): string {
  const lines: string[] = ['=== client ==='];
  try {
    const info = getAppInfo();
    lines.push(
      `url: ${window.location.href}`,
      `userAgent: ${navigator.userAgent}`,
      `viewport: ${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}x`,
      `secureContext: ${window.isSecureContext}`,
      `online: ${navigator.onLine}`,
      `ws: ${wsClient.state}`,
      wsClient.lastClose
        ? `ws lastClose: code=${wsClient.lastClose.code} (${wsClient.lastClose.codeDesc}) reason=${wsClient.lastClose.reason} at=${wsClient.lastClose.at}`
        : 'ws lastClose: (none this page load)',
      info ? `server (cached at boot): v${info.version ?? '?'} ${info.mode ?? '?'}` : 'server (cached at boot): unknown',
    );
  } catch (err) {
    lines.push(`(environment unavailable: ${err instanceof Error ? err.message : String(err)})`);
  }
  try {
    const entries = getRecentEntries();
    lines.push('', '=== client console (oldest first) ===');
    if (entries.length === 0) {
      lines.push('(no entries)');
    } else {
      for (const e of entries) {
        const dup = e.count && e.count > 1 ? ` (x${e.count})` : '';
        lines.push(`[${e.time.slice(11, 19)} ${e.level}] ${e.message}${e.args ? ` | ${e.args}` : ''}${dup}`);
      }
    }
  } catch (err) {
    lines.push(`(console ring unavailable: ${err instanceof Error ? err.message : String(err)})`);
  }
  return lines.join('\n');
}

export function BugReportSection() {
  const [windowMins, setWindowMins] = useState(30);
  const [report, setReport] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleGenerate = async () => {
    setGenerating(true);
    setCopyFailed(false);
    let serverText: string;
    try {
      serverText = await apiGetText('/api/bug-report', { windowMins: String(windowMins) }, { timeoutMs: 60_000 });
    } catch (err) {
      serverText = `WALNUT DIAGNOSTIC BUNDLE (server)\n(server unreachable: ${err instanceof Error ? err.message : String(err)})`;
    }
    let clientText: string;
    try {
      clientText = redactText(buildClientSection());
    } catch (err) {
      clientText = `=== client ===\n(unavailable: ${err instanceof Error ? err.message : String(err)})`;
    }
    setReport(`WALNUT BUG REPORT\ngeneratedAt: ${new Date().toISOString()}\n\n${clientText}\n\n${serverText}`);
    setGenerating(false);
  };

  const handleCopy = async () => {
    if (!report) return;
    const result = await copyTextRobust(report);
    if (result === 'failed') {
      setCopyFailed(true);
      return;
    }
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1200);
  };

  const handleDownload = () => {
    if (!report) return;
    const blob = new Blob([report], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `walnut-bug-report-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <SettingsSection
      id="bug-report"
      title="Bug Report"
      description={<>
        Generates a scrubbed diagnostic bundle: recent server logs, system health, config with
        secrets masked, and this browser&apos;s state. Paste it into an issue or chat when reporting a problem.
      </>}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          className="input"
          style={{ width: 'auto' }}
          value={windowMins}
          onChange={(e) => setWindowMins(Number(e.target.value))}
          disabled={generating}
        >
          {WINDOW_CHOICES.map((c) => (
            <option key={c.mins} value={c.mins}>{c.label}</option>
          ))}
        </select>
        <button type="button" className="btn btn-primary" onClick={handleGenerate} disabled={generating}>
          {generating ? 'Generating…' : 'Generate bundle'}
        </button>
        {report && (
          <>
            <button type="button" className="btn" onClick={handleCopy}>
              {copied ? 'Copied ✓' : 'Copy as text'}
            </button>
            <button type="button" className="btn" onClick={handleDownload}>
              Download .txt
            </button>
          </>
        )}
      </div>

      {copyFailed && (
        <SettingsNotice kind="warn">
          Clipboard unavailable in this browser context — select the text below and copy manually.
        </SettingsNotice>
      )}

      {report && (
        <textarea
          readOnly
          value={report}
          onFocus={(e) => e.currentTarget.select()}
          style={{
            width: '100%', height: '30vh', marginTop: 12, fontFamily: 'ui-monospace, monospace',
            fontSize: 11, padding: 8, whiteSpace: 'pre', boxSizing: 'border-box',
          }}
        />
      )}
    </SettingsSection>
  );
}
