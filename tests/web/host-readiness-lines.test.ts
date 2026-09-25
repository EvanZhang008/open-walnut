/**
 * Settings › Remote hosts shows one line per readiness problem of a CONNECTED
 * host. The reader must say nothing (never throw) for an older server or a
 * daemon without 'preflight-v1', which send no readiness at all.
 */
import { describe, it, expect } from 'vitest';
import type { HostStatus } from '@/api/hosts';
import { FIX_NOTE_MS, hostReadinessCheck, hostReadinessNotes, hostReadinessProblems } from '@/utils/host-readiness';

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

describe('automatic fixes on the lines', () => {
  const claudeLine = { kind: 'claude_needs_node', message: 'npm build.', commands: ['curl -fsSL https://claude.ai/install.sh | bash'] };

  it('reads a running or failed fix on a problem, and drops a malformed one', () => {
    const status = withReadiness({
      problems: [
        { ...claudeLine, fix: { action: 'install-claude-native', state: 'running', text: 'Installing Claude Code' } },
        {
          kind: 'compiler_missing', message: 'No C compiler.', commands: ['sudo apt-get install -y gcc libc6-dev'],
          fix: { action: 'install-compiler', state: 'failed', text: 'Could not install gcc automatically (sudo needs a password)', needsPassword: true, detail: 'sudo: a password is required' },
        },
        { kind: 'claude_error', message: 'Crashed.', commands: [], fix: { action: 'x', state: 'exploded', text: 'no' } },
      ],
    });
    expect(hostReadinessProblems(status).map((p) => p.fix)).toEqual([
      { action: 'install-claude-native', state: 'running', text: 'Installing Claude Code' },
      { action: 'install-compiler', state: 'failed', text: 'Could not install gcc automatically (sudo needs a password)', needsPassword: true, detail: 'sudo: a password is required' },
      undefined,
    ]);
  });

  it('notes: a running fix no problem carries (dtach), and recent successes, once each', () => {
    const status = withReadiness({
      problems: [],
      dtach: { found: false },
      fixing: { action: 'build-dtach', startedAt: 1, text: 'Installing dtach' },
      fixes: [
        { action: 'install-claude-native', ok: false, finishedAt: 1, ageMs: 60_000, text: 'Could not install Claude Code automatically (the connection to the host dropped)' },
        { action: 'install-claude-native', ok: true, finishedAt: 2, ageMs: 1000, text: 'Installed Claude Code 2.1.280' },
        { action: 'install-compiler', ok: true, finishedAt: 3, ageMs: 2000, text: 'Installed gcc' },
      ],
    });
    expect(hostReadinessNotes(status)).toEqual([
      { key: 'fixing-build-dtach', kind: 'running', text: 'Installing dtach' },
      { key: 'done-install-claude-native', kind: 'done', text: 'Installed Claude Code 2.1.280', expiresInMs: FIX_NOTE_MS - 1000 },
      { key: 'done-install-compiler', kind: 'done', text: 'Installed gcc', expiresInMs: FIX_NOTE_MS - 2000 },
    ]);
  });

  it('notes age by the server\'s ageMs plus the time since the answer arrived, never by comparing clocks', () => {
    // finishedAt is a server timestamp an hour in this browser's future: it must not matter.
    const status = withReadiness({
      problems: [], dtach: { found: true },
      fixes: [{ action: 'install-compiler', ok: true, finishedAt: Date.now() + 3_600_000, ageMs: 1000, text: 'Installed gcc' }],
    });
    expect(hostReadinessNotes(status, 60_000)).toEqual([
      { key: 'done-install-compiler', kind: 'done', text: 'Installed gcc', expiresInMs: FIX_NOTE_MS - 61_000 },
    ]);
    expect(hostReadinessNotes(status, FIX_NOTE_MS - 1000)).toEqual([]);
    // A negative "since" (a clock step back) is read as zero.
    expect(hostReadinessNotes(status, -5000)[0]!.expiresInMs).toBe(FIX_NOTE_MS - 1000);
    // An older server sends no ageMs: no note, rather than a guess.
    const old = withReadiness({ problems: [], dtach: { found: true }, fixes: [{ action: 'install-compiler', ok: true, finishedAt: Date.now(), text: 'Installed gcc' }] });
    expect(hostReadinessNotes(old)).toEqual([]);
  });

  it('notes stay quiet for what a problem line already says, old or skipped fixes, and a failure whose problem went away', () => {
    const status = withReadiness({
      problems: [{ ...claudeLine, fix: { action: 'install-claude-native', state: 'running', text: 'Installing Claude Code' } }],
      dtach: { found: true },
      fixing: { action: 'install-claude-native', startedAt: 1, text: 'Installing Claude Code' },
      fixes: [
        { action: 'install-compiler', ok: true, finishedAt: 1, ageMs: FIX_NOTE_MS + 1, text: 'Installed gcc' },
        { action: 'build-dtach', ok: false, finishedAt: 2, ageMs: 1000, text: 'Could not install dtach automatically (the compiler failed)' },
      ],
    });
    expect(hostReadinessNotes(status)).toEqual([]);
    const skipped = withReadiness({ problems: [], fixes: [{ action: 'install-compiler', ok: true, skipped: true, finishedAt: 1, ageMs: 0, text: 'A C compiler is installed' }] });
    expect(hostReadinessNotes(skipped)).toEqual([]);
  });

  it('a dtach install that failed while dtach is still missing gets a muted line; a disconnected host none', () => {
    const readiness = {
      problems: [], dtach: { found: false },
      fixes: [{ action: 'build-dtach', ok: false, finishedAt: 1, ageMs: 1000, text: 'Could not install dtach automatically (the compiler failed)', detail: 'pty.h' }],
    };
    expect(hostReadinessNotes(withReadiness(readiness))).toEqual([
      { key: 'failed-build-dtach', kind: 'failed', text: 'Could not install dtach automatically (the compiler failed)', detail: 'pty.h', expiresInMs: FIX_NOTE_MS - 1000 },
    ]);
    expect(hostReadinessNotes(withReadiness(readiness, { connected: false, phase: 'failed' }))).toEqual([]);
    expect(hostReadinessNotes(base)).toEqual([]);
  });
});
