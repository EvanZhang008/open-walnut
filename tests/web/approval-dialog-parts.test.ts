/**
 * The approval dialog's parts under its sentence (web/src/components/approvals/approval-context.tsx;
 * 2026-11-11, the user: "just summary ... then is command to run ... 哪一个 task 来的 ... 其他的就没必要吧";
 * then, on a Git push dialog: "what do u want?"). Only the command that runs, the task that asked
 * and a warning when the asking process is outside its session. Never the session's last words,
 * the task's goal, its last steps, the folder or the hook that ran the command: those read as noise.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from '../../web/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js';
import type { Approval } from '../../web/src/api/approvals';

vi.mock('../../web/src/components/approvals/approvals-store', () => ({ closeApproval: vi.fn(), openApproval: vi.fn() }));
vi.mock('@/utils/open-session', () => ({ openTaskOnHome: vi.fn() }));

const { MemoryRouter } = await import('../../web/node_modules/react-router-dom');
const { ApprovalContextRows, detailText, prettyJson } = await import('../../web/src/components/approvals/approval-context');

function approval(over: Partial<Approval> = {}, requester: Partial<Approval['requester']> = {}): Approval {
  return {
    id: 'apr-1', what: 'Push commit 0fa0f76 to origin cd-3-timeout?', mode: 'biometric', status: 'pending', singleUse: true,
    createdAt: '2026-11-11T00:00:00.000Z', expiresAt: '2026-11-11T00:05:00.000Z',
    requester: {
      host: 'clouddev', taskId: 't-1', taskTitle: 'Git approval live test', sessionId: 's-1',
      cwd: '/local/home/u/scratch', command: 'git -C /home/u/scratch push origin cd-3-timeout',
      ranBy: 'python3 /home/u/.claude/scripts/gate_hook.py', identity: 'verified', ...requester,
    },
    context: {
      why: 'Live test of the Git push approval gate from a real session.', whyFrom: 'session',
      goal: 'Live test of the gate', project: 'Walnut',
      steps: [{ kind: 'ran', text: 'Push cd-1-approve branch to origin' }],
    },
    ...over,
  } as Approval;
}

function render(a: Approval): string {
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ApprovalContextRows, { a, hostName: 'New big clouddev' })));
}

describe('the approval dialog shows only what the person decides on', () => {
  it('names the command that runs and the task that asked, nothing else', () => {
    const html = render(approval());
    expect(html).toContain('data-testid="approval-command">git -C /home/u/scratch push origin cd-3-timeout<');
    expect(html).toContain('data-testid="approval-task-link"');
    expect(html).toContain('Git approval live test');
    expect(html).toContain('on New big clouddev');
    // The hook that ran the command, the folder, the goal, the steps and the session's last words are left out.
    for (const noise of ['gate_hook', '/local/home/u/scratch', 'Live test of the gate', 'cd-1-approve', 'Live test of the Git push approval gate', 'Goal', 'Session', 'Just before', 'Why', 'not given', 'Open its chat']) {
      expect(html, noise).not.toContain(noise);
    }
  });

  it('shows the asker\'s own line, never the session\'s', () => {
    const own = approval({ context: { why: 'Ships the release notes to the site.', whyFrom: 'asker' } });
    expect(render(own)).toContain('data-testid="approval-why">Ships the release notes to the site.<');
  });

  it('falls back to what ran the command when the asker named none, and says when no task asked', () => {
    const html = render(approval({ context: {} }, { taskId: undefined, taskTitle: undefined, command: undefined, process: 'bash', user: 'u' }));
    expect(html).toContain('data-testid="approval-command">python3 /home/u/.claude/scripts/gate_hook.py<');
    expect(html).toContain('A script with no task on New big clouddev, run by bash as u');
    expect(html).not.toContain('approval-task-link');
  });

  it('warns only when the asking process is outside its task\'s session', () => {
    expect(render(approval())).not.toContain('approval-outside');
    const unchecked = render(approval({}, { identity: 'unverified', check: 'unchecked' }));
    expect(unchecked).not.toContain('approval-outside');
    expect(unchecked).toContain('data-testid="approval-unchecked"');
    expect(render(approval())).not.toContain('approval-unchecked');
    expect(render(approval({}, { identity: 'unverified', check: 'outside' }))).toContain('data-testid="approval-outside"');
  });

  it('shows what really started it beside a command the asker named, unless the detail is signed', () => {
    const plain = render(approval({ singleUse: false }, { command: 'git status' }));
    expect(plain).toContain('data-testid="approval-ran-by"');
    expect(plain).toContain('gate_hook.py');
    expect(render(approval({}, { command: 'git status' }))).not.toContain('approval-ran-by');
  });

  it('this computer is said as such', () => {
    expect(render(approval({}, { local: true }))).toContain('on this computer');
  });
});

describe('the signed detail reads one field per line', () => {
  it('opens the envelope and lays its JSON context out', () => {
    const context = JSON.stringify({ command: 'git push origin main', commitSha: 'abc', remote: 'origin' });
    const a = approval({ singleUse: true, detail: JSON.stringify({ version: 'walnut-single-use-v1', context, nonce: 'n' }) });
    const d = detailText(a);
    expect(d.signed).toBe(true);
    expect(d.text).toBe(JSON.stringify(JSON.parse(context), null, 2));
  });

  it('leaves plain text and broken JSON as they are', () => {
    expect(prettyJson('web: 3 files changed\nmigrations: none')).toBe('web: 3 files changed\nmigrations: none');
    expect(prettyJson('{not json}')).toBe('{not json}');
    // Nothing the signer saw is hidden: a repeated key or a big number stays as signed.
    expect(prettyJson('{"branch":"main","branch":"x"}')).toBe('{"branch":"main","branch":"x"}');
    expect(prettyJson('{"n":12345678901234567890}')).toBe('{"n":12345678901234567890}');
    expect(detailText(approval({ detail: 'notes: 4 lines' }))).toEqual({ text: 'notes: 4 lines', signed: false });
  });
});
