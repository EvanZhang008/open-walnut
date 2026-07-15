/**
 * Unit tests for the bug-report bundle builder.
 *
 * Contract under test:
 *   - Produces all section headers even when every source is missing (never throws).
 *   - Seeded secrets (sk- keys, Bearer tokens) come out as [REDACTED].
 *   - The time window drops old lines but KEEPS unparseable-time lines.
 *   - Config secrets are masked ALWAYS (not just cloud mode).
 *   - Oversized log sections are middle-truncated with a marker.
 *
 * LOG_DIR/WALNUT_HOME are redirected to an isolated tmpdir via createMockConstants.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import { LOG_DIR } from '../../../src/constants.js';
import { buildBugReportText } from '../../../src/core/observability/bug-report.js';

function writeLogLine(file: string, entry: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
}

function todayLogFile(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return path.join(LOG_DIR, `open-walnut-${yyyy}-${mm}-${dd}.log`);
}

describe('buildBugReportText', () => {
  beforeEach(() => {
    fs.rmSync(LOG_DIR, { recursive: true, force: true });
    fs.mkdirSync(LOG_DIR, { recursive: true });
  });

  it('produces all section headers and never throws on an empty environment', async () => {
    const text = await buildBugReportText();
    expect(text).toContain('WALNUT DIAGNOSTIC BUNDLE (server)');
    for (const name of [
      'meta', 'system health', 'process health', 'config (secrets masked)',
      'recent server log', 'recent warnings/errors', 'browser console (forwarded)',
      'ios client logs (tail)', 'recent incidents', 'collection notes',
    ]) {
      expect(text).toContain(`=== ${name} ===`);
    }
  });

  it('redacts seeded secrets in log lines', async () => {
    const secret = 'sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    writeLogLine(todayLogFile(), {
      time: new Date().toISOString(), level: 'info', subsystem: 'web',
      message: `leaked key ${secret} and Bearer super-secret-token-value`,
    });
    const text = await buildBugReportText();
    expect(text).not.toContain(secret);
    expect(text).not.toContain('super-secret-token-value');
    expect(text).toContain('[REDACTED]');
  });

  it('window filter drops old lines but keeps unparseable-time lines', async () => {
    const oldTime = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    writeLogLine(todayLogFile(), { time: oldTime, level: 'info', subsystem: 'web', message: 'OLD_LINE_MARKER' });
    writeLogLine(todayLogFile(), { time: new Date().toISOString(), level: 'info', subsystem: 'web', message: 'FRESH_LINE_MARKER' });
    fs.appendFileSync(todayLogFile(), 'NOT_JSON_BUT_EVIDENCE\n');
    const text = await buildBugReportText({ windowMins: 30 });
    expect(text).not.toContain('OLD_LINE_MARKER');
    expect(text).toContain('FRESH_LINE_MARKER');
    expect(text).toContain('NOT_JSON_BUT_EVIDENCE');
  });

  it('includes forwarded browser lines in their own section', async () => {
    writeLogLine(todayLogFile(), {
      time: new Date().toISOString(), level: 'error', subsystem: 'browser',
      message: 'BROWSER_CRASH_MARKER',
    });
    const text = await buildBugReportText();
    const browserSection = text.split('=== browser console (forwarded) ===')[1]?.split('===')[0] ?? '';
    expect(browserSection).toContain('BROWSER_CRASH_MARKER');
  });

  it('middle-truncates an oversized server log section with a marker', async () => {
    const file = todayLogFile();
    const now = new Date().toISOString();
    // 3000 lines >> the 1200-line cap.
    const lines: string[] = [];
    for (let i = 0; i < 3000; i++) {
      lines.push(JSON.stringify({ time: now, level: 'info', subsystem: 'web', message: `line-${i}` }));
    }
    fs.writeFileSync(file, lines.join('\n') + '\n');
    const text = await buildBugReportText();
    expect(text).toContain('truncated');
    expect(text).toContain('line-0');       // head kept
    expect(text).toContain('line-2999');    // tail kept
  });

  it('masks remote-host hostname/user everywhere (config section AND log lines), keeps aliases', async () => {
    const { WALNUT_HOME } = await import('../../../src/constants.js');
    fs.mkdirSync(WALNUT_HOME, { recursive: true });
    fs.writeFileSync(
      path.join(WALNUT_HOME, 'config.yaml'),
      [
        'version: 1',
        'hosts:',
        '  mydevbox:',
        '    hostname: real-internal-host.example.corp',
        '    user: realusername',
      ].join('\n'),
    );
    // A log line that mentions the REAL hostname (ssh/daemon connect lines do).
    writeLogLine(todayLogFile(), {
      time: new Date().toISOString(), level: 'info', subsystem: 'session',
      message: 'ssh connect to real-internal-host.example.corp as realusername',
    });
    const text = await buildBugReportText();
    expect(text).toContain('mydevbox'); // alias stays — log lines reference it
    expect(text).not.toContain('real-internal-host.example.corp');
    expect(text).not.toContain('realusername');
    expect(text).toContain('[host:mydevbox]');
    expect(text).toContain('[user:mydevbox]');
  });

  it('clamps windowMins into [5, 1440]', async () => {
    const text = await buildBugReportText({ windowMins: 999999 });
    expect(text).toContain('windowMins: 1440');
    const text2 = await buildBugReportText({ windowMins: 0 });
    expect(text2).toContain('windowMins: 5');
  });
});
