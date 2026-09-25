/**
 * Settings › Remote hosts shows one line per readiness problem of a CONNECTED
 * host. The reader must say nothing (never throw) for an older server or a
 * daemon without 'preflight-v1', which send no readiness at all.
 */
import { describe, it, expect } from 'vitest';
import type { HostStatus } from '@/api/hosts';
import { hostReadinessCheck, hostReadinessProblems } from '@/utils/host-readiness';

const base: HostStatus = {
  host: 'devbox', label: 'devbox', hostname: 'devbox.example.test', connected: true, phase: 'connected',
  phaseLabel: 'Connected', steps: [], phaseElapsedMs: 0, connectElapsedMs: 0, at: 1,
};
const withReadiness = (readiness: unknown, extra: Partial<HostStatus> = {}) => ({ ...base, ...extra, readiness }) as HostStatus;

describe('hostReadinessProblems', () => {
  it('reads the server problems in order, keeping only string commands', () => {
    const status = withReadiness({
      problems: [
        { kind: 'claude_needs_node', message: 'Claude Code here is the npm build.', commands: ['curl -fsSL https://claude.ai/install.sh | bash'] },
        { kind: 'compiler_missing', message: 'No C compiler.', commands: ['sudo yum install -y gcc', 7, '', 'sudo apt-get install -y gcc'] },
      ],
    });
    expect(hostReadinessProblems(status)).toEqual([
      { kind: 'claude_needs_node', message: 'Claude Code here is the npm build.', commands: ['curl -fsSL https://claude.ai/install.sh | bash'] },
      { kind: 'compiler_missing', message: 'No C compiler.', commands: ['sudo yum install -y gcc', 'sudo apt-get install -y gcc'] },
    ]);
  });

  it('says nothing for no readiness, a fine host, junk, or a host that is not connected', () => {
    expect(hostReadinessProblems(base)).toEqual([]);
    expect(hostReadinessProblems(undefined)).toEqual([]);
    expect(hostReadinessProblems(withReadiness({ problems: [] }))).toEqual([]);
    expect(hostReadinessProblems(withReadiness({ problems: 'nope' }))).toEqual([]);
    expect(hostReadinessProblems(withReadiness({ problems: [null, { kind: 'x' }, { kind: 'y', message: '' }] }))).toEqual([]);
    expect(hostReadinessProblems(withReadiness(
      { problems: [{ kind: 'claude_missing', message: 'Not installed.', commands: [] }] },
      { connected: false, phase: 'failed' },
    ))).toEqual([]);
  });
});

describe('hostReadinessCheck', () => {
  it('reads when the host was last asked and whether that ask failed', () => {
    expect(hostReadinessCheck(withReadiness({ checkedAt: 42, problems: [] }))).toEqual({ checkedAt: 42 });
    expect(hostReadinessCheck(withReadiness({ checkedAt: 43, checkError: 'daemon command timeout' })))
      .toEqual({ checkedAt: 43, checkError: 'daemon command timeout' });
    // Old server / old daemon: no readiness at all reads as "never asked".
    expect(hostReadinessCheck(base)).toEqual({ checkedAt: 0 });
    expect(hostReadinessCheck(withReadiness({ checkedAt: 'soon', checkError: '' }))).toEqual({ checkedAt: 0 });
  });
});
