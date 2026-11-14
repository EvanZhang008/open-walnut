/**
 * The approval dialog's body (web/src/components/approvals/approval-context.tsx; 2026-11-12, the
 * user on a Git push dialog: "I just need to know which task and which path right.. this si
 * confuing"; 2026-11-14: "Broi..... I need the summary AI write"). The summary on top, in full (the
 * asker's own words, else the one Walnut wrote); then two lines, the task that asked and where it
 * acts (repo and branch, or folder, and the machine); the request's sentence when it says more; the
 * command and the signed detail in one Details fold, closed. Never the session's raw last words, the
 * task's goal, its last steps or the hook that ran the command.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from '../../web/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js';
import type { Approval } from '../../web/src/api/approvals';

vi.mock('../../web/src/components/approvals/approvals-store', () => ({ closeApproval: vi.fn(), openApproval: vi.fn() }));
vi.mock('@/utils/open-session', () => ({ openTaskOnHome: vi.fn() }));

const { MemoryRouter } = await import('../../web/node_modules/react-router-dom');
const { ApprovalContextRows, detailText, gitOperation, prettyJson, shortPath, summaryOf } = await import('../../web/src/components/approvals/approval-context');

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

// The Git gate's signed context, as the push of 2026-11-12 carried it (names neutral).
const GIT_CONTEXT = JSON.stringify({
  argv: ['git', '-C', '/home/u/.local/state/open-walnut/tasks/t-9/meta-fresh', 'push', 'origin', 'HEAD:refs/heads/mainline'],
  command: 'git -C /home/u/.local/state/open-walnut/tasks/t-9/meta-fresh push origin HEAD:refs/heads/mainline',
  commitSha: 'da21d9c6ebf95b2d1003c6af76bb17894603c207', operation: 'push', remote: 'origin',
  remoteRef: 'refs/heads/mainline', localRef: 'refs/heads/mainline',
  repository: '/local/home/u/.local/state/open-walnut/tasks/t-9/meta-fresh', version: 'walnut-git-operation-v1',
});
const gitPush = (over: Partial<Approval> = {}) => approval({
  what: 'Push commit da21d9c to origin mainline in meta-fresh',
  detail: JSON.stringify({ version: 'walnut-single-use-v1', context: GIT_CONTEXT, nonce: 'n' }), ...over,
}, { taskTitle: 'Platform Lead', command: 'git -C /home/u/.local/state/open-walnut/tasks/t-9/meta-fresh push origin HEAD:refs/heads/mainline' });

/** The text before the Details fold: what the person reads at a glance. */
const glance = (html: string) => html.split('<details')[0]!;

describe('the approval dialog leads with the task and the path', () => {
  const SUMMARY = 'Pushes the two progress-table commits to the shared repo, so the team sees today\'s numbers before the review.';

  it('a Git push reads as Walnut\'s summary, then Task and Repo with its branch and machine; the rest is folded', () => {
    const html = render(gitPush({ context: { ...approval().context, summary: SUMMARY } }));
    const top = glance(html);
    // The summary comes first, in full, and says who wrote it.
    expect(top.indexOf('data-testid="approval-ai-summary"')).toBeLessThan(top.indexOf('data-testid="approval-task"'));
    expect(top).toContain(`>${SUMMARY.replace("'", '&#x27;')}<`);
    expect(top).toContain('Walnut’s summary of the task’s session, not signed');
    expect(top).toContain('data-testid="approval-task-link"');
    expect(top).toContain('Platform Lead');
    expect(top).toContain('>Repo<');
    expect(top).toContain('~/.local/state/open-walnut/tasks/t-9/meta-fresh → mainline (New big clouddev)');
    // The sentence repeats the Repo line, the command and the JSON are in Details, closed.
    expect(top).not.toContain('Push commit');
    expect(top).not.toContain('git -C');
    expect(top).not.toContain('argv');
    expect(html).toMatch(/<details class="approval-detail approval-details" data-testid="approval-detail"><summary>Details<\/summary>/);
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).toContain('data-testid="approval-command">git -C /home/u/.local/state/open-walnut/tasks/t-9/meta-fresh push');
    expect(html).toContain('Signed detail');
    expect(html.match(/<details/g)).toHaveLength(1);
  });

  it('until Walnut\'s summary arrives (or if it is never written) the request\'s own line is on top', () => {
    const top = glance(render(gitPush()));
    expect(top).toContain('data-testid="approval-asks">Push commit da21d9c to origin mainline in meta-fresh<');
    expect(top.indexOf('data-testid="approval-asks"')).toBeLessThan(top.indexOf('data-testid="approval-task"'));
    expect(top).not.toContain('approval-summary-by');
    expect(top).toContain('>Repo<');
  });

  it('under Walnut\'s summary, a request line that says more stays in sight', () => {
    const top = glance(render(approval({ what: 'Send the weekly report to the team?', singleUse: false, context: { summary: SUMMARY } })));
    expect(top).toContain('data-testid="approval-ai-summary"');
    expect(top).toContain('>Asks<');
    expect(top).toContain('data-testid="approval-asks">Send the weekly report to the team?<');
  });

  it('any other request keeps its own sentence on top, with the folder it ran in', () => {
    const html = render(approval({ what: 'Send the weekly report to the team?', singleUse: false, detail: 'notes: 4 lines' }, { command: 'release.sh' }));
    const top = glance(html);
    expect(top).toContain('>Folder<');
    expect(top).toContain('/local/home/u/scratch'.replace('/local/home/u', '~') + ' (New big clouddev)');
    expect(top).toContain('data-testid="approval-asks"');
    expect(top).toContain('Send the weekly report to the team?');
    expect(top).not.toContain('release.sh');
    expect(html).toContain('data-testid="approval-command">release.sh<');
  });

  it('never shows the session\'s last words, the goal, the steps or the hook', () => {
    const html = render(gitPush());
    for (const noise of ['gate_hook', 'Live test of the gate', 'cd-1-approve', 'Live test of the Git push approval gate', 'Goal', 'Session', 'Just before', 'Why', 'not given', 'Open its chat']) {
      expect(html, noise).not.toContain(noise);
    }
  });

  it('shows the asker\'s own line and its own why on top, in full, and never a summary over them', () => {
    const why = 'Ships the release notes to the site, which the launch post links to; '.repeat(4).trim();
    const a = approval({ what: 'Publish the release notes?', context: { why, whyFrom: 'asker', summary: 'A summary that must not show' } });
    const top = glance(render(a));
    expect(top).toContain('data-testid="approval-asks">Publish the release notes?<');
    expect(top).toContain(`data-testid="approval-why">${why}<`);
    expect(top).not.toContain('must not show');
    expect(summaryOf(a)).toEqual({ text: 'Publish the release notes?', by: 'asker', why });
    // The session's last words are never the asker's why.
    expect(summaryOf(approval({ what: 'X?' }))).toEqual({ text: 'X?', by: 'asker' });
  });

  it('falls back to what ran the command when the asker named none, and says when no task asked', () => {
    const html = render(approval({ context: {} }, { taskId: undefined, taskTitle: undefined, command: undefined, process: 'bash', user: 'u' }));
    expect(html).toContain('data-testid="approval-command">python3 /home/u/.claude/scripts/gate_hook.py<');
    expect(html).toContain('A script with no task, run by bash as u');
    expect(html).not.toContain('approval-task-link');
  });

  it('warns only when the asking process is outside its task\'s session, above the fold', () => {
    expect(render(approval())).not.toContain('approval-outside');
    const unchecked = render(approval({}, { identity: 'unverified', check: 'unchecked' }));
    expect(unchecked).not.toContain('approval-outside');
    expect(glance(unchecked)).toContain('data-testid="approval-unchecked"');
    expect(render(approval())).not.toContain('approval-unchecked');
    expect(glance(render(approval({}, { identity: 'unverified', check: 'outside' })))).toContain('data-testid="approval-outside"');
  });

  it('a push whose sentence is not the gate\'s own keeps it in sight (a force push, words of the asker\'s own)', () => {
    const forced = glance(render(gitPush({ what: 'Force push commit da21d9c to origin mainline in meta-fresh' })));
    expect(forced).toContain('data-testid="approval-asks"');
    expect(forced).toContain('Force push commit da21d9c');
    expect(forced).toContain('>Repo<');
  });

  it('shows what really started it beside a command the asker named, above the fold, unless the detail is signed', () => {
    const plain = render(approval({ singleUse: false }, { command: 'git status' }));
    expect(glance(plain)).toContain('data-testid="approval-ran-by"');
    expect(plain).toContain('gate_hook.py');
    expect(render(approval({}, { command: 'git status' }))).not.toContain('approval-ran-by');
  });

  it('a downgraded request says so in the dialog', () => {
    expect(glance(render(approval({ downgraded: 'No device signs approvals yet, so this one is a tap.' })))).toContain('data-testid="approval-downgraded"');
  });

  it('this computer is said as such, and a request with no folder names only the machine', () => {
    expect(render(gitPush({ requester: { ...gitPush().requester, local: true } }))).toContain('meta-fresh → mainline (this computer)');
    const noCwd = glance(render(approval({}, { cwd: undefined })));
    expect(noCwd).toContain('>Host<');
    expect(noCwd).toContain('New big clouddev');
  });
});

describe('the paths read short and the Git fields come only from a signed Git context', () => {
  it('says each home folder as ~', () => {
    expect(shortPath('/Users/u/work/x')).toBe('~/work/x');
    expect(shortPath('/home/u/x')).toBe('~/x');
    expect(shortPath('/local/home/u/x')).toBe('~/x');
    expect(shortPath('/root/x')).toBe('~/x');
    expect(shortPath('/srv/u/x')).toBe('/srv/u/x');
    expect(shortPath('/home/u')).toBe('~');
    // Not a person's home.
    expect(shortPath('/Users/Shared/x')).toBe('/Users/Shared/x');
    expect(shortPath('/Users/Guest/x')).toBe('/Users/Guest/x');
    expect(shortPath('/home/linuxbrew/.linuxbrew/bin')).toBe('/home/linuxbrew/.linuxbrew/bin');
  });

  it('reads repository, branch and commit from the Git gate\'s context, nothing from plain text', () => {
    expect(gitOperation(gitPush())).toEqual({ repository: '/local/home/u/.local/state/open-walnut/tasks/t-9/meta-fresh', operation: 'push', remote: 'origin', branch: 'mainline', commitSha: 'da21d9c6ebf95b2d1003c6af76bb17894603c207' });
    // Unsigned, or not the Git gate's version: no Repo line.
    expect(gitOperation(gitPush({ singleUse: false }))).toBeNull();
    expect(gitOperation(approval({ detail: JSON.stringify({ version: 'walnut-single-use-v1', context: '{"repository":"/x"}' }) }))).toBeNull();
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
