import { describe, expect, it } from 'vitest';
import { processGone, processIdentity } from '../e2e/fixtures/process-identity.js';

const LINE = 'Fri Oct 24 01:23:45 2026 /usr/local/bin/node /repo/dist/daemon-binaries/acp-worker.js --flag';
const fail = (fields: Record<string, unknown>) => () => { throw Object.assign(new Error('ps failed'), fields); };

describe('E2E process identity', () => {
  it('reads start time and the full command of a running process', () => {
    expect(processIdentity(1234, () => LINE + '\n')).toEqual({ state: 'present', lstart: 'Fri Oct 24 01:23:45 2026',
      command: '/usr/local/bin/node /repo/dist/daemon-binaries/acp-worker.js --flag' });
  });
  it('calls a pid gone only on a normal "no such process" answer or a later start time', () => {
    const seen = { pid: 1234, lstart: 'Fri Oct 24 01:23:45 2026' };
    expect(processGone(seen, fail({ status: 1, stdout: '' }))).toBe(true);
    expect(processGone(seen, () => 'Fri Oct 24 02:00:00 2026 /bin/other')).toBe(true);
    expect(processGone(seen, () => LINE)).toBe(false);
  });
  it('treats a ps that fails any other way as unknown, never as gone', () => {
    const seen = { pid: 1234, lstart: 'Fri Oct 24 01:23:45 2026' };
    expect(() => processGone(seen, fail({ status: null, signal: 'SIGTERM', code: 'ETIMEDOUT' }))).toThrow(/could not tell/);
    expect(() => processGone(seen, fail({ code: 'ENOENT' }))).toThrow(/could not tell/);
    expect(() => processGone(seen, fail({ status: 1, stdout: 'garbage' }))).toThrow(/could not tell/);
    expect(() => processGone(seen, () => 'ps: illegal option')).toThrow(/unexpected/);
    // A successful ps naming nothing is not proof of absence (only exit 1 with no output is).
    expect(() => processGone(seen, () => '')).toThrow(/no output/);
    expect(() => processIdentity(1, () => LINE)).toThrow(/not a process id/);
  });
});
