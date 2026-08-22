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
  linkTargetOf, resolvedLabelOf, categoryOf, presentError, groupErrorsByCategory,
  systemIssueCount,
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

  it("drops an EXPIRED permission out of Needs Action too (the phantom fix)", () => {
    // The bug this pins: a request whose session died stayed resolved:undefined,
    // so it sat in Needs Action forever with buttons that 404. 'expired' is a
    // truthy resolved, so the existing branch handles it — asserted here so a
    // future refactor that enumerates outcomes can't drop it back to 'action'.
    expect(sectionOf(n({ kind: 'permission', dedupKey: 'perm:r3', resolved: 'expired' }))).toBe('all');
  });

  it('keeps an UNRESOLVED operation-error in the Errors rail', () => {
    expect(sectionOf(n({ kind: 'operation-error', dedupKey: 'error:live' }))).toBe('errors');
  });

  it('drops a RECOVERED operation-error out of Errors (the wall-of-red fix)', () => {
    // An error describes a CONDITION. Once the operation succeeds again the
    // condition is gone, so the entry is history — it must leave the rail rather
    // than stay red forever after the user fixed the cause.
    expect(sectionOf(n({
      kind: 'operation-error', dedupKey: 'error:git', resolved: 'recovered',
    }))).toBe('all');
  });

  it('routes operation errors to Errors and automation kinds to Automation', () => {
    expect(sectionOf(n({ kind: 'operation-error' }))).toBe('errors');
    expect(sectionOf(n({ kind: 'cron' }))).toBe('automation');
    expect(sectionOf(n({ kind: 'skill' }))).toBe('automation');
    expect(sectionOf(n({ kind: 'hook' }))).toBe('automation');
  });

  it('drops an EXPIRED operation-error out of Errors too', () => {
    // The other end of an error's lifecycle: nothing can ever recover it (its
    // session died, or it predates recoveryKey). Settled either way, so it leaves
    // the rail — a card nobody can act on is not a diagnosis.
    expect(sectionOf(n({
      kind: 'operation-error', dedupKey: 'error:stale', resolved: 'expired',
    }))).toBe('all');
  });

  it('puts the ephemeral kinds nowhere but All (they never reach the feed anyway)', () => {
    expect(sectionOf(n({ kind: 'sort', persistent: false }))).toBe('all');
    expect(sectionOf(n({ kind: 'audio-error', persistent: false }))).toBe('all');
  });
});

/**
 * resolvedLabelOf — one implementation for the panel card and the toast, and
 * KIND-AWARE because 'expired' means two different things.
 */
describe('resolvedLabelOf', () => {
  it('labels an expired PERMISSION "Session ended"', () => {
    // Nobody answered and nobody can: the session died or the CLI withdrew the
    // ask. The one thing it must not read as is a decision the user made.
    expect(resolvedLabelOf(n({ kind: 'permission', resolved: 'expired' }))).toBe('Session ended');
  });

  it('labels an expired ERROR "Stale", not "Session ended"', () => {
    // A keyless `GET /api/ui-prefs → 500` from three days ago has no session at
    // all — "Session ended" would be simply false. It is stale: unresolvable, and
    // nobody is going to act on it.
    expect(resolvedLabelOf(n({ kind: 'operation-error', resolved: 'expired' }))).toBe('Stale');
  });

  it('never shows the GREEN recovered wording for an expiry', () => {
    // The distinction the user acts on: 'recovered' means someone fixed it,
    // 'expired' means nobody ever will. Conflating them would tell the user a
    // broken thing is working.
    expect(resolvedLabelOf(n({ kind: 'operation-error', resolved: 'recovered' }))).toBe('Recovered ✓');
    expect(resolvedLabelOf(n({ kind: 'operation-error', resolved: 'expired' })))
      .not.toBe(resolvedLabelOf(n({ kind: 'operation-error', resolved: 'recovered' })));
  });

  it('keeps the permission decisions as they were', () => {
    expect(resolvedLabelOf(n({ kind: 'permission', resolved: 'allowed' }))).toBe('Approved');
    expect(resolvedLabelOf(n({ kind: 'permission', resolved: 'denied' }))).toBe('Denied');
  });

  it('returns null for an unresolved record (nothing to show)', () => {
    expect(resolvedLabelOf(n({ kind: 'operation-error' }))).toBeNull();
    expect(resolvedLabelOf(n({ kind: 'permission' }))).toBeNull();
  });

  it('falls back to a NEUTRAL label for an outcome it does not know', () => {
    // The toaster's local 'stale' state and any future server value: never a
    // guessed outcome.
    expect(resolvedLabelOf({ kind: 'permission', resolved: 'stale' })).toBe('Already answered');
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
    expect(sectionCounts([])).toEqual({
      action: 0, errors: 0, automation: 0, all: 0,
      errorsTotal: 0, automationTotal: 0, allTotal: 0,
    });
  });

  it('an EXPIRED permission stops inflating the Needs Action badge', () => {
    const withExpired = [
      ...feed,
      n({ kind: 'permission', dedupKey: 'perm:d', read: false, resolved: 'expired' }),
    ];
    // Still 2 (perm:a + perm:b) — the dead one is history, not a to-do.
    expect(sectionCounts(withExpired).action).toBe(2);
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

describe('linkTargetOf (the click-through both permission surfaces share)', () => {
  it('prefers the session — a permission always came from one', () => {
    // This is the whole point of the affordance: a permission notification must be
    // openable in the session that is blocked on it, panel card and toast alike.
    expect(linkTargetOf(n({ kind: 'permission', dedupKey: 'perm:r1', sessionId: 'sess-1' })))
      .toBe('/sessions?id=sess-1');
  });

  it('offers the session link for a SETTLED permission too, not just a pending one', () => {
    // Reading the transcript afterwards is exactly as useful as answering — the
    // affordance is navigation, and navigation is never a decision.
    expect(linkTargetOf(n({
      kind: 'permission', dedupKey: 'perm:r2', sessionId: 'sess-2', resolved: 'allowed',
    }))).toBe('/sessions?id=sess-2');
  });

  it('falls back to the task, then a kind-specific page, then the record action', () => {
    expect(linkTargetOf(n({ kind: 'cron', taskId: 'task-9' }))).toBe('/tasks/task-9');
    expect(linkTargetOf(n({ kind: 'skill' }))).toBe('/skills');
    expect(linkTargetOf(n({
      kind: 'operation-error',
      action: { label: 'Open Settings', kind: 'navigate', to: '/settings' },
    }))).toBe('/settings');
  });

  it('prefers the session over both the task and the action', () => {
    expect(linkTargetOf(n({
      kind: 'permission', dedupKey: 'perm:r3', sessionId: 'sess-3', taskId: 'task-3',
      action: { label: 'Open Settings', kind: 'navigate', to: '/settings' },
    }))).toBe('/sessions?id=sess-3');
  });

  it('is null when there is nowhere to go (no affordance rendered at all)', () => {
    expect(linkTargetOf(n({ kind: 'operation-error' }))).toBeNull();
    // A callback action is not a navigation target, and a navigate with no `to`
    // is malformed — neither may produce an "Open session" button that does nothing.
    expect(linkTargetOf(n({ kind: 'cron', action: { label: 'Do', kind: 'callback' } }))).toBeNull();
    expect(linkTargetOf(n({ kind: 'cron', action: { label: 'Go', kind: 'navigate' } }))).toBeNull();
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

/**
 * Rail badge totals — the second half of sectionCounts.
 *
 * Opening the panel marks the whole feed read, so an unread-only badge went to
 * zero the moment the user glanced at it: a rail with nine errors one click away
 * showed no number at all. The `*Total` fields count what each tab LISTS; the
 * unread fields stay for the bell badge, which legitimately means "new".
 */
describe('sectionCounts totals (rail badges)', () => {
  const feed: Notification[] = [
    n({ kind: 'permission', dedupKey: 'perm:a', read: true }),
    n({ kind: 'operation-error', dedupKey: 'e1', read: true }),
    n({ kind: 'operation-error', dedupKey: 'e2', read: true }),
    // Resolved errors leave the Errors rail, so they must not inflate its badge.
    n({ kind: 'operation-error', dedupKey: 'e3', read: true, resolved: 'recovered' }),
    n({ kind: 'cron', dedupKey: 'c1', read: true }),
    n({ kind: 'skill', dedupKey: 's1', read: false }),
  ];

  it('counts what the Errors tab lists, read or not', () => {
    const counts = sectionCounts(feed);
    expect(counts.errorsTotal).toBe(2); // e1 + e2; the recovered one is history
    expect(counts.errors).toBe(0);      // …and nothing is unread
  });

  it('counts what the Automation tab lists', () => {
    expect(sectionCounts(feed).automationTotal).toBe(2); // cron + skill
  });

  it('counts the whole feed for All', () => {
    expect(sectionCounts(feed).allTotal).toBe(6);
    expect(sectionCounts(feed).all).toBe(1); // only s1 is unread
  });
});

describe('systemIssueCount', () => {
  it('counts each unhealthy ambient signal', () => {
    expect(systemIssueCount({})).toBe(0);
    expect(systemIssueCount({ gitSyncFailing: true })).toBe(1);
    expect(systemIssueCount({ gitSyncFailing: true, indexUnhealthy: true })).toBe(2);
  });
});

/**
 * Error categories — what the Errors rail groups by. The server derives these at
 * write time; these tests cover the CLIENT fallback for records already on disk.
 */
describe('categoryOf', () => {
  it("prefers the server's value", () => {
    expect(categoryOf(n({ kind: 'operation-error', dedupKey: 'e', category: 'Sessions' }))).toBe('Sessions');
  });

  it("beats a recoveryKey that would say something else", () => {
    // The server may have classified by an explicit RULE; the key is only the
    // structural fallback, so it must not override the shipped value.
    expect(categoryOf(n({
      kind: 'operation-error', dedupKey: 'e', category: 'Acme', recoveryKey: 'git',
    }))).toBe('Acme');
  });

  it('mirrors every server recoveryKey shape for a pre-humanizer record', () => {
    const c = (recoveryKey: string) =>
      categoryOf(n({ kind: 'operation-error', dedupKey: `e-${recoveryKey}`, recoveryKey }));
    expect(c('plugin:plugin-a')).toBe('Plugin A');
    expect(c('session:s-1')).toBe('Sessions');
    expect(c('task:t-1')).toBe('Sessions');
    expect(c('route:GET /api/x')).toBe('API');
    expect(c('bus:main-ai:task:updated')).toBe('Internal');
    expect(c('git')).toBe('Data & Sync');
    expect(c('git:compaction')).toBe('Data & Sync');
    expect(c('backup')).toBe('Data & Sync');
    expect(c('disk')).toBe('Data & Sync');
    expect(c('server-lifecycle')).toBe('Server');
    expect(c('task-db-writers')).toBe('Internal');
    expect(c('send-path')).toBe('Cloud');
  });

  it("falls back to 'Other' when there is nothing to classify by", () => {
    expect(categoryOf(n({ kind: 'operation-error', dedupKey: 'e' }))).toBe('Other');
    expect(categoryOf(n({ kind: 'operation-error', dedupKey: 'e', recoveryKey: 'brand-new-shape' })))
      .toBe('Other');
  });
});

describe('presentError', () => {
  it('passes a humanized record through untouched', () => {
    const rec = n({
      kind: 'operation-error', dedupKey: 'e',
      title: "Couldn't start a session",
      body: 'The working folder no longer exists: /data/gone',
      detail: '[session] {"cwd":"/data/gone"}',
    });
    expect(presentError(rec)).toEqual({
      title: "Couldn't start a session",
      body: 'The working folder no longer exists: /data/gone',
      detail: '[session] {"cwd":"/data/gone"}',
    });
  });

  it('MOVES a legacy raw-json body into the Details block', () => {
    // The screenshot case: the card's only text was a log dump. Nothing can
    // invent human copy client-side, but the JSON can stop being the message.
    const rec = n({
      kind: 'operation-error', dedupKey: 'e',
      title: 'SECOND WRITER on the task database',
      body: '[web] {"holders":[{"pid":22198,"command":"node"}],"dbFile":"/data/x"}',
    });
    const out = presentError(rec);
    expect(out.body).toBe('');
    expect(out.detail).toBe('[web] {"holders":[{"pid":22198,"command":"node"}],"dbFile":"/data/x"}');
    expect(out.title).toBe('SECOND WRITER on the task database');
  });

  it('leaves a legacy PROSE body as the message', () => {
    const rec = n({
      kind: 'operation-error', dedupKey: 'e',
      title: 'Data Backup Failing',
      body: 'Git auto-commit has failed 3+ times consecutively.',
    });
    const out = presentError(rec);
    expect(out.body).toBe('Git auto-commit has failed 3+ times consecutively.');
    expect(out.detail).toBeUndefined();
  });

  it('never moves the body when the server already sent a detail', () => {
    // Belt and braces: with both present the body is authoritative, even if it
    // happens to look bracket-ish.
    const rec = n({
      kind: 'operation-error', dedupKey: 'e', title: 'T',
      body: '[web] {"a":1}', detail: 'raw line',
    });
    expect(presentError(rec)).toEqual({ title: 'T', body: '[web] {"a":1}', detail: 'raw line' });
  });

  it('handles a record with no body at all', () => {
    const out = presentError(n({ kind: 'operation-error', dedupKey: 'e', title: 'Just a title' }));
    expect(out).toEqual({ title: 'Just a title', body: '' });
  });
});

describe('groupErrorsByCategory', () => {
  const err = (dedupKey: string, category: string, ts: number) =>
    n({ kind: 'operation-error', dedupKey, category, timestamp: ts });

  it('groups by category and orders categories by most-recent activity', () => {
    const groups = groupErrorsByCategory([
      err('e1', 'Sessions', 1_000),
      err('e2', 'API', 5_000),
      err('e3', 'Sessions', 9_000),
      err('e4', 'Data & Sync', 3_000),
    ]);
    expect(groups.map(g => g.category)).toEqual(['Sessions', 'API', 'Data & Sync']);
    expect(groups[0].items.map(i => i.dedupKey)).toEqual(['e1', 'e3']);
  });

  it('orders by the LATEST occurrence of a folded record, not first-seen', () => {
    // A still-firing error keeps an hours-old `timestamp`; sorting on that would
    // sink the live problem below a family that stopped happening.
    const groups = groupErrorsByCategory([
      n({ kind: 'operation-error', dedupKey: 'live', category: 'API', timestamp: 1_000, lastTimestamp: 90_000 }),
      err('quiet', 'Sessions', 50_000),
    ]);
    expect(groups.map(g => g.category)).toEqual(['API', 'Sessions']);
  });

  it('keeps the caller item order inside a group (stable partition)', () => {
    const groups = groupErrorsByCategory([
      err('newest', 'API', 9_000), err('older', 'API', 2_000),
    ]);
    expect(groups[0].items.map(i => i.dedupKey)).toEqual(['newest', 'older']);
  });

  it('groups pre-humanizer records by their recoveryKey fallback', () => {
    // The three-cards-are-one-problem case, for records already on disk.
    const groups = groupErrorsByCategory([
      n({ kind: 'operation-error', dedupKey: 'a', recoveryKey: 'plugin:acme', timestamp: 3_000 }),
      n({ kind: 'operation-error', dedupKey: 'b', recoveryKey: 'plugin:acme', timestamp: 2_000 }),
      n({ kind: 'operation-error', dedupKey: 'c', recoveryKey: 'plugin:acme', timestamp: 1_000 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ category: 'Acme' });
    expect(groups[0].items).toHaveLength(3);
  });

  it('is empty for an empty list', () => {
    expect(groupErrorsByCategory([])).toEqual([]);
  });
});
