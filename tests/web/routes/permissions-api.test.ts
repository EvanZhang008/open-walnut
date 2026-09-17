/**
 * E2E tests for /api/permissions — real HTTP through startServer.
 *
 * The report itself is platform-dependent (real TCC probes on macOS), so
 * these tests pin the CONTRACT, not the grant states: shape of the report,
 * the launcher field, cache behavior of ?force, the 404/409 guards, and that
 * the settings-only prompt refusal (Full Disk Access has no macOS prompt)
 * stays loud instead of silently no-oping.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../../src/constants.js';
import { __resetPermissionCachesForTest } from '../../../src/core/permissions/darwin.js';
import { startServer, stopServer } from '../../../src/web/server.js';

let server: HttpServer;
let port: number;

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  __resetPermissionCachesForTest();
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  await stopServer();
  // maxRetries: the server's background writers can still be flushing into
  // WALNUT_HOME as we tear down — a bare rm intermittently hits ENOTEMPTY.
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('GET /api/permissions', () => {
  it('returns a well-formed report', async () => {
    const res = await fetch(apiUrl('/api/permissions'));
    expect(res.status).toBe(200);
    const report = await res.json();
    expect(report.platform).toBe(process.platform);
    expect(typeof report.applicable).toBe('boolean');
    expect(report.launcher).toBeTruthy();
    expect(['mac-app', 'terminal', 'launchd', 'unknown']).toContain(report.launcher.kind);
    expect(Array.isArray(report.permissions)).toBe(true);
    if (report.applicable) {
      // macOS primary: both registered checks present, every row complete.
      const ids = report.permissions.map((p: { id: string }) => p.id);
      expect(ids).toContain('calendar');
      expect(ids).toContain('full-disk-access');
      // ONE row per GRANT, where a grant is (permission x identity granted TO).
      // Screen Time used to get its own row even though it is the same helper's
      // Full Disk Access, which read as Walnut asking for the same thing twice
      // and sent people to grant a path that could not fix what they were looking
      // at. A new feature that reads through the reader helper joins FDA_CONSUMERS
      // and must NOT add a row. Agent sessions do get their own row, because the
      // daemon runs under Walnut.app while the reader deliberately disclaims
      // responsibility: macOS keeps two entries, so the user really does add two
      // paths and one row could not explain both.
      expect(new Set(ids).size).toBe(ids.length);
      const fdaRows = report.permissions.filter(
        (p: { settingsUrl: string }) => /Privacy_AllFiles/.test(p.settingsUrl),
      );
      const fdaTargets = fdaRows.map((p: { grantTarget: string }) => p.grantTarget);
      expect(new Set(fdaTargets).size).toBe(fdaTargets.length);
      // A row that cannot be probed must say so, or it shows "Unknown" forever
      // and reads as a broken check.
      for (const p of fdaRows as { state: string; unverifiable?: boolean }[]) {
        if (p.state === 'unknown') expect(p.unverifiable).toBe(true);
      }
      for (const p of report.permissions) {
        expect(['granted', 'denied', 'not-determined', 'not-applicable', 'unknown']).toContain(p.state);
        expect(['prompt', 'settings-only']).toContain(p.fixKind);
        expect(p.grantTarget).toBeTruthy();
        expect(p.settingsUrl).toMatch(/^x-apple\.systempreferences:/);
        expect(p.steps.length).toBeGreaterThan(0);
      }
    } else {
      // Linux CI / cloud: nothing actionable, and nothing invented.
      expect(report.permissions).toEqual([]);
    }
  });

  it('describes session file access as optional and names Claude Code', async () => {
    const report = await (await fetch(apiUrl('/api/permissions'))).json();
    if (!report.applicable) return; // no macOS rows to describe
    const row = report.permissions.find((p: { id: string }) => p.id === 'session-full-disk-access');
    expect(row).toBeTruthy();
    // The three things the copy must do, pinned because they are the reason the
    // row exists rather than incidental wording: a user scanning the list has to
    // see that skipping it is fine, and has to recognise WHO is asking. "Session"
    // is Walnut's own noun; Claude Code is what the popups are actually about.
    expect(row.why).toMatch(/^Optional\./);
    expect(row.why).toContain('Claude Code');
    // And it stays one sentence, like the rows above it.
    expect(row.why.split('. ').length).toBe(2);
    // The reasoning belongs in `context`, which only the dialog shows.
    expect(row.context).toContain('Claude Code runs inside Walnut');
    expect(row.context).toContain('Skipping it costs nothing');
    // And the numbered list stays ACTIONS. An explanation rendered as "step 1"
    // reads as something to perform, and the user hunts for the thing to click.
    // Short enough to act on at a glance: the dialog's button does the
    // navigating and puts the path on the clipboard, so nothing here restates it.
    expect(row.steps.length).toBeLessThanOrEqual(3);
    for (const step of row.steps as string[]) {
      expect(step).not.toContain('Claude Code runs inside Walnut');
      expect(step.length).toBeLessThan(80);
    }
  });

  it('serves cached report on repeat, re-probes with ?force=1', async () => {
    const first = await (await fetch(apiUrl('/api/permissions'))).json();
    const second = await (await fetch(apiUrl('/api/permissions'))).json();
    // Same probedAt = the 30s cache answered (no re-probe per poll).
    expect(second.probedAt).toBe(first.probedAt);
    if (!first.applicable) return; // n/a reports are frozen; force is moot
    const forced = await (await fetch(apiUrl('/api/permissions?force=1'))).json();
    expect(forced.probedAt).toBeGreaterThanOrEqual(first.probedAt);
  });
});

describe('POST /api/permissions/:id guards', () => {
  it('404s open-settings for an unknown permission id', async () => {
    const res = await fetch(apiUrl('/api/permissions/nonsense/open-settings'), { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('409s request for settings-only permissions (FDA has no macOS prompt)', async () => {
    const res = await fetch(apiUrl('/api/permissions/full-disk-access/request'), { method: 'POST' });
    expect(res.status).toBe(409);
  });
});
