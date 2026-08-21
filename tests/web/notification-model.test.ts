/**
 * Notification center derivations (web/src/contexts/notifications/).
 *
 * Two contracts are pinned here:
 *   1. The rail's classification + counts. "Needs Action" counts PENDING
 *      permissions regardless of read state — marking one read doesn't answer it,
 *      the session is still blocked — while the other sections count unread the
 *      way the bell badge does.
 *   2. Graceful degradation on LEGACY records. Every enrichment field
 *      (requestId/toolName/input/count/lastTimestamp) is optional on the wire, so
 *      a record written before the server half deployed has none of them; the
 *      permission card must still find a requestId (from dedupKey), find the tool
 *      name (from `title`, which the server writes it into too), and must never
 *      render a blanket approve for an AskUserQuestion it can't render.
 */
import { describe, it, expect } from 'vitest';
import {
  sectionOf, sectionCounts, effectiveTs, permissionDetail, requestIdOf,
  toolNameOf, isUnanswerableAsk, validAcpOptions, isRejectOption, sessionLabelOf, formatRelative,
} from '../../web/src/contexts/notifications/notification-model';
import { SHOULD_TOAST } from '../../web/src/contexts/notifications/types';
import type { Notification, NotificationKind, NotificationSeverity } from '../../web/src/contexts/notifications/types';

function n(over: Partial<Notification> & Pick<Notification, 'kind'>): Notification {
  return {
    id: `id-${over.dedupKey ?? over.kind}`,
    severity: 'info',
    title: 'Title',
    timestamp: 1_000,
    persistent: true,
    read: true,
    dedupKey: over.dedupKey ?? `key-${over.kind}`,
    ...over,
  } as Notification;
}

describe('sectionOf', () => {
  it('routes a PENDING permission to Needs Action', () => {
    expect(sectionOf(n({ kind: 'permission', dedupKey: 'perm:r1' }))).toBe('action');
  });

  it('drops a RESOLVED permission out of Needs Action (history, not a to-do)', () => {
    expect(sectionOf(n({ kind: 'permission', dedupKey: 'perm:r1', resolved: 'allowed' }))).toBe('all');
    expect(sectionOf(n({ kind: 'permission', dedupKey: 'perm:r2', resolved: 'denied' }))).toBe('all');
  });

  it('routes operation errors to Errors and automation kinds to Automation', () => {
    expect(sectionOf(n({ kind: 'operation-error' }))).toBe('errors');
    expect(sectionOf(n({ kind: 'cron' }))).toBe('automation');
    expect(sectionOf(n({ kind: 'skill' }))).toBe('automation');
    expect(sectionOf(n({ kind: 'hook' }))).toBe('automation');
  });

  it('puts the ephemeral kinds nowhere but All (they never reach the feed anyway)', () => {
    expect(sectionOf(n({ kind: 'sort', persistent: false }))).toBe('all');
    expect(sectionOf(n({ kind: 'audio-error', persistent: false }))).toBe('all');
  });
});

describe('sectionCounts', () => {
  const feed: Notification[] = [
    // Pending permissions: one read, one unread — BOTH count as action items.
    n({ kind: 'permission', dedupKey: 'perm:a', read: true }),
    n({ kind: 'permission', dedupKey: 'perm:b', read: false }),
    // Resolved permission: not an action item, but still unread → counts in All.
    n({ kind: 'permission', dedupKey: 'perm:c', read: false, resolved: 'allowed' }),
    n({ kind: 'operation-error', dedupKey: 'e1', read: false }),
    n({ kind: 'operation-error', dedupKey: 'e2', read: true }),
    n({ kind: 'cron', dedupKey: 'c1', read: false }),
    n({ kind: 'hook', dedupKey: 'h1', read: false }),
    n({ kind: 'skill', dedupKey: 's1', read: true }),
  ];

  it('counts pending permissions regardless of read state', () => {
    // Read does not mean answered: a read-but-pending ask still blocks a session,
    // so the badge has to keep showing it.
    expect(sectionCounts(feed).action).toBe(2);
  });

  it('counts UNREAD for errors and automation', () => {
    const counts = sectionCounts(feed);
    expect(counts.errors).toBe(1);
    expect(counts.automation).toBe(2); // cron + hook unread; skill is read
  });

  it('counts every unread entry for All', () => {
    // perm:b, perm:c, e1, c1, h1
    expect(sectionCounts(feed).all).toBe(5);
  });

  it('is all-zero for an empty feed', () => {
    expect(sectionCounts([])).toEqual({ action: 0, errors: 0, automation: 0, all: 0 });
  });
});

describe('effectiveTs', () => {
  it('prefers lastTimestamp so a folded record sorts by its LATEST occurrence', () => {
    // timestamp stays first-seen; sorting on it would sink a still-firing error
    // below entries that stopped happening hours ago.
    expect(effectiveTs(n({ kind: 'operation-error', timestamp: 1_000, lastTimestamp: 9_000 }))).toBe(9_000);
  });

  it('falls back to timestamp for an unfolded / legacy record', () => {
    expect(effectiveTs(n({ kind: 'cron', timestamp: 4_242 }))).toBe(4_242);
  });
});

describe('permissionDetail', () => {
  it('reads a Bash ask as command + description', () => {
    const detail = permissionDetail(n({
      kind: 'permission', toolName: 'Bash',
      input: { command: 'rm -rf build', description: 'Clean the build dir' },
    }));
    expect(detail).toEqual({ type: 'bash', command: 'rm -rf build', description: 'Clean the build dir' });
  });

  it('omits a blank description rather than rendering an empty line', () => {
    const detail = permissionDetail(n({
      kind: 'permission', toolName: 'Bash', input: { command: 'ls', description: '  ' },
    }));
    expect(detail).toEqual({ type: 'bash', command: 'ls', description: undefined });
  });

  it('reads an AskUserQuestion ask as parsed questions (shared helper, one parser)', () => {
    const detail = permissionDetail(n({
      kind: 'permission', toolName: 'AskUserQuestion',
      input: {
        questions: [{
          question: 'Which database?',
          header: 'Database',
          options: [{ label: 'Postgres' }, { label: 'SQLite' }],
        }],
      },
    }));
    expect(detail.type).toBe('question');
    if (detail.type !== 'question') throw new Error('unreachable');
    expect(detail.questions).toHaveLength(1);
    expect(detail.questions[0].question).toBe('Which database?');
    expect(detail.questions[0].options.map(o => o.label)).toEqual(['Postgres', 'SQLite']);
  });

  it('reads an ExitPlanMode ask as the plan', () => {
    const detail = permissionDetail(n({
      kind: 'permission', toolName: 'ExitPlanMode', input: { plan: '1. do the thing' },
    }));
    expect(detail).toEqual({ type: 'plan', plan: '1. do the thing' });
  });

  it('still names an ExitPlanMode ask whose plan text was dropped on the way in', () => {
    // The plan can exceed the store's size ceiling; the ask is still known.
    expect(permissionDetail(n({ kind: 'permission', toolName: 'ExitPlanMode' })))
      .toEqual({ type: 'plan', plan: '' });
  });

  it('names a LEGACY ExitPlanMode ask too (tool name recovered from the title)', () => {
    expect(permissionDetail(n({
      kind: 'permission', dedupKey: 'perm:old-plan', title: 'ExitPlanMode',
    }))).toEqual({ type: 'plan', plan: '' });
  });

  it('reads a Write/Edit ask as the file path', () => {
    expect(permissionDetail(n({
      kind: 'permission', toolName: 'Write', input: { file_path: '/tmp/x.ts', content: 'hi' },
    }))).toEqual({ type: 'file', filePath: '/tmp/x.ts' });
  });

  it('reads an over-ceiling input as its preview', () => {
    expect(permissionDetail(n({
      kind: 'permission', toolName: 'Whatever', input: { preview: '{"huge":true}' },
    }))).toEqual({ type: 'generic', preview: '{"huge":true}' });
  });

  it('degrades to generic for a LEGACY record with no input at all', () => {
    expect(permissionDetail(n({ kind: 'permission', dedupKey: 'perm:old' })))
      .toEqual({ type: 'generic' });
  });

  it('degrades to generic for an unknown tool with no renderable field', () => {
    expect(permissionDetail(n({
      kind: 'permission', toolName: 'MysteryTool', input: { some_field: 'value' },
    }))).toEqual({ type: 'generic' });
  });

  it('does not mistake a Bash input for a question set', () => {
    expect(permissionDetail(n({ kind: 'permission', input: { command: 'ls' } })).type).toBe('bash');
  });
});

describe('toolNameOf', () => {
  it('prefers the first-class field', () => {
    expect(toolNameOf(n({ kind: 'permission', toolName: 'Bash', title: 'Run a command' })))
      .toBe('Bash');
  });

  it('falls back to `title` for a LEGACY permission record (the server writes both)', () => {
    expect(toolNameOf(n({ kind: 'permission', dedupKey: 'perm:old', title: 'AskUserQuestion' })))
      .toBe('AskUserQuestion');
  });

  it('never reads a title as a tool name for a non-permission kind', () => {
    // 'Agent turn failed' is prose, not a tool — a fallback there would make
    // every guard keyed on the tool name fire on arbitrary error titles.
    expect(toolNameOf(n({ kind: 'operation-error', title: 'Agent turn failed' })))
      .toBeUndefined();
    expect(toolNameOf(n({ kind: 'cron', title: 'AskUserQuestion' }))).toBeUndefined();
  });
});

describe('isUnanswerableAsk (the blanket-approve guard both surfaces share)', () => {
  const legacyAsk = n({
    // Exactly what a pre-redesign server wrote: title = tool name, nothing else.
    kind: 'permission', dedupKey: 'perm:legacy-ask', title: 'AskUserQuestion',
  });

  it('catches a LEGACY AskUserQuestion with no toolName and no input', () => {
    const detail = permissionDetail(legacyAsk);
    expect(toolNameOf(legacyAsk)).toBe('AskUserQuestion');
    expect(detail.type).toBe('generic');
    // The regression this pins: keying off n.toolName alone left this record on
    // the plain Approve path, and an allow with no `answers` map tells the model
    // the user answered nothing.
    expect(legacyAsk.toolName).toBeUndefined();
    expect(isUnanswerableAsk(legacyAsk, detail)).toBe(true);
  });

  it('catches an enriched AskUserQuestion whose input was dropped over the ceiling', () => {
    const dropped = n({
      kind: 'permission', dedupKey: 'perm:big-ask', toolName: 'AskUserQuestion',
      input: { preview: '{"questions":[…]}' },
    });
    expect(isUnanswerableAsk(dropped, permissionDetail(dropped))).toBe(true);
  });

  it('lets a renderable AskUserQuestion through — the form IS the answer', () => {
    const answerable = n({
      kind: 'permission', dedupKey: 'perm:ask', toolName: 'AskUserQuestion',
      input: { questions: [{ question: 'Which?', options: [{ label: 'A' }] }] },
    });
    expect(isUnanswerableAsk(answerable, permissionDetail(answerable))).toBe(false);
  });

  it('never blocks an ordinary tool ask, legacy or enriched', () => {
    const bash = n({ kind: 'permission', dedupKey: 'perm:b', toolName: 'Bash', input: { command: 'ls' } });
    const legacyBash = n({ kind: 'permission', dedupKey: 'perm:lb', title: 'Bash' });
    expect(isUnanswerableAsk(bash, permissionDetail(bash))).toBe(false);
    expect(isUnanswerableAsk(legacyBash, permissionDetail(legacyBash))).toBe(false);
  });
});

describe('validAcpOptions / isRejectOption', () => {
  it('drops options with no optionId — there is nothing to answer with', () => {
    expect(validAcpOptions(n({
      kind: 'permission',
      acpOptions: [{ optionId: 'allow-once', name: 'Allow once' }, { name: 'Broken' }],
    }))).toEqual([{ optionId: 'allow-once', name: 'Allow once' }]);
  });

  it('is empty (not undefined) for a record with no options', () => {
    expect(validAcpOptions(n({ kind: 'permission' }))).toEqual([]);
  });

  it('treats every `reject*` kind as a no, and everything else as a yes', () => {
    expect(isRejectOption({ kind: 'reject_once' })).toBe(true);
    expect(isRejectOption({ kind: 'reject_always' })).toBe(true);
    expect(isRejectOption({ kind: 'allow_once' })).toBe(false);
    // No kind at all is not a refusal — the adapter just didn't classify it.
    expect(isRejectOption({ optionId: 'x' })).toBe(false);
  });
});

describe('sessionLabelOf', () => {
  it('prefers the friendly title', () => {
    expect(sessionLabelOf(n({ kind: 'permission', sessionTitle: 'Fix the build', sessionId: 'abcdefghij' })))
      .toBe('Fix the build');
  });

  it('shortens a long session id and leaves a short one whole', () => {
    expect(sessionLabelOf(n({ kind: 'permission', sessionId: 'abcdefghij' }))).toBe('abcdefgh…');
    expect(sessionLabelOf(n({ kind: 'permission', sessionId: 'abcdefgh' }))).toBe('abcdefgh');
  });

  it('is undefined with no session at all (the chip row disappears)', () => {
    expect(sessionLabelOf(n({ kind: 'cron' }))).toBeUndefined();
  });
});

describe('formatRelative', () => {
  it('accepts epoch ms directly (no Date→ISO→Date round-trip at the call sites)', () => {
    expect(formatRelative(Date.now() - 5_000)).toBe('5s ago');
    expect(formatRelative(Date.now() - 3 * 60_000)).toBe('3m ago');
    expect(formatRelative(Date.now() - 5 * 3_600_000)).toBe('5h ago');
    expect(formatRelative(Date.now() - 2 * 86_400_000)).toBe('2d ago');
  });

  it('still accepts an ISO string (the git-sync lastCommitAt is one)', () => {
    expect(formatRelative(new Date(Date.now() - 90_000).toISOString())).toBe('1m ago');
  });

  it('renders nothing for an unparseable timestamp', () => {
    expect(formatRelative('not a date')).toBe('');
  });
});

describe('requestIdOf', () => {
  it('prefers the first-class field', () => {
    expect(requestIdOf(n({ kind: 'permission', requestId: 'req-9', dedupKey: 'perm:req-1' }))).toBe('req-9');
  });

  it('recovers the id from a legacy `perm:<requestId>` dedupKey', () => {
    expect(requestIdOf(n({ kind: 'permission', dedupKey: 'perm:req-1' }))).toBe('req-1');
  });

  it('returns null when there is nothing to answer with', () => {
    // A non-permission key, and a malformed `perm:` with no id: both mean the
    // card can only offer the session deep link, never dead buttons.
    expect(requestIdOf(n({ kind: 'operation-error', dedupKey: 'agent-error:x' }))).toBeNull();
    expect(requestIdOf(n({ kind: 'permission', dedupKey: 'perm:' }))).toBeNull();
  });
});

describe('SHOULD_TOAST policy', () => {
  const table: Array<[NotificationKind, NotificationSeverity, boolean]> = [
    // Needs a human NOW → interrupt.
    ['permission', 'warning', true],
    ['hook', 'info', true],
    ['operation-error', 'error', true],
    // A warning-level operation error is feed-only: it doesn't mean every
    // subsequent turn fails, so it isn't worth an interruption.
    ['operation-error', 'warning', false],
    ['operation-error', 'info', false],
    // Routine automation receipts: bell badge, no toast.
    ['cron', 'info', false],
    ['skill', 'success', false],
    // Ephemeral kinds have no feed entry — a toast is their only surface.
    ['sort', 'info', true],
    ['audio-error', 'error', true],
  ];

  for (const [kind, severity, expected] of table) {
    it(`${kind}/${severity} → ${expected ? 'toast' : 'feed only'}`, () => {
      expect(SHOULD_TOAST({ kind, severity })).toBe(expected);
    });
  }
});
