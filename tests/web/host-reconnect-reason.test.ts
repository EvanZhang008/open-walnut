/**
 * A host that is reconnecting says why it is not back yet, on every surface that draws its connect
 * steps (utils/host-connect.ts reconnectReasonOf; 2026-11-11 review F8: the found-host card read
 * "Reconnecting to demo-devbox, 0 of 7 steps complete, Connecting for 8m 10s" while the server knew
 * "Connection refused"). The words come through shownFailureSummary, never the raw error text.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { reconnectReasonOf } from '@/utils/host-connect';
import type { HostStatus } from '@/api/hosts';

const status = (s: Partial<HostStatus>): HostStatus => ({
  host: 'devbox', label: 'devbox', hostname: '127.0.0.1', connected: false, phase: 'reconnecting', phaseLabel: '',
  steps: [], phaseElapsedMs: 0, connectElapsedMs: 0, at: 0, ...s,
} as HostStatus);

describe('reconnectReasonOf', () => {
  it('names the last failure kind in words', () => {
    const reason = reconnectReasonOf(status({ lastKind: 'refused', lastError: 'ssh: connect to host 127.0.0.1 port 3460: Connection refused' }));
    expect(reason).toBeTruthy();
    expect(reason).not.toMatch(/walnut-ssh-evidence/);
  });

  it('falls back to the cleaned failure text when the kind is unknown', () => {
    const reason = reconnectReasonOf(status({ lastError: 'Connection refused [walnut-ssh-evidence: exit=255]' }));
    expect(reason).toBe('Connection refused');
  });

  it('says nothing while nothing failed, once connected, or outside a reconnect', () => {
    expect(reconnectReasonOf(status({}))).toBeUndefined();
    expect(reconnectReasonOf(status({ connected: true, lastError: 'x' }))).toBeUndefined();
    expect(reconnectReasonOf(status({ phase: 'ssh' as HostStatus['phase'] }))).toBeUndefined();
    expect(reconnectReasonOf(undefined)).toBeUndefined();
  });
});

describe('guard: no surface draws a host error raw', () => {
  it('every web file that reads a host status puts its error through shownFailureSummary', () => {
    const root = path.join(__dirname, '../../web/src');
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!/\.tsx$/.test(e.name)) continue;
        const src = fs.readFileSync(full, 'utf8');
        if (!/useHostStatus|useAllHostStatus|\bHostStatus\b/.test(src)) continue;
        src.split('\n').forEach((line, i) => {
          if (/\{[^}]*\bstatus\??\.(?:error|lastError)\b[^}]*\}/.test(line) && !line.includes('shownFailureSummary(')) {
            found.push(`${path.relative(root, full)}:${i + 1}: ${line.trim()}`);
          }
        });
      }
    };
    walk(root);
    expect(found).toEqual([]);
  });

  it('the connect steps read the reason off the status when the caller passes none', () => {
    const steps = fs.readFileSync(path.join(__dirname, '../../web/src/components/sessions/path-selector/HostConnectSteps.tsx'), 'utf8');
    expect(steps).toMatch(/const lastAttempt = lastHeadline \?\? reconnectReasonOf\(status\);/);
  });
});
