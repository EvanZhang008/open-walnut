/**
 * Notification derivations — pure, no React, no DOM.
 *
 * The notification center groups entries by WHAT THE USER HAS TO DO, not by the
 * source that produced them: a session blocked on a permission is an action item,
 * an error is a diagnosis, a cron/skill/hook run is a receipt. This module owns
 * that classification plus the permission-detail view the cards render, so both
 * the panel and the toaster read one implementation (and it stays unit-testable).
 *
 * Every field the enriched server record carries is OPTIONAL on the wire — a
 * record written before the server half deployed has none of them. Each function
 * here degrades instead of throwing.
 */

import { parseAskUserQuestionInput, type AskQuestion } from '@/components/sessions/ask-user-question';
import type { Notification, NotificationAcpOption, NotificationKind } from './types';

export type NotificationSection = 'action' | 'inbox' | 'errors' | 'automation' | 'all';

/**
 * Which rail section an entry belongs to. Only a PENDING permission is an action
 * item — a resolved one is history, so it stays out of Needs Action (it still
 * shows under All). Same rule for a RECOVERED error: an error notification
 * describes a CONDITION, and once the operation succeeds again the condition is
 * gone, so the entry becomes history and leaves the Errors rail (without it, the
 * wall of red survived the fix and the rail stopped being worth reading).
 *
 * A letter goes to the Inbox rail. It ALSO shows in All (it is a notification),
 * but its read/pin state is owned by the letter store, not by this record — see
 * sectionCounts, which prefers the letter list when it has one.
 */
export function sectionOf(n: Notification): NotificationSection {
  if (n.kind === 'permission') return n.resolved ? 'all' : 'action';
  if (n.kind === 'letter') return 'inbox';
  if (n.kind === 'operation-error') return n.resolved ? 'all' : 'errors';
  if (n.kind === 'cron' || n.kind === 'skill' || n.kind === 'hook') return 'automation';
  return 'all';
}

/**
 * The letter an envelope notification points at.
 *
 * Prefers the first-class field; falls back to the `letter:<id>` dedupKey for a
 * record written before the server carried it (same shape as requestIdOf).
 */
export function letterIdOf(n: Notification): string | null {
  if (n.letterId) return n.letterId;
  if (n.dedupKey.startsWith('letter:')) return n.dedupKey.slice('letter:'.length) || null;
  return null;
}

/**
 * The human label for a settled notification.
 *
 * KIND-AWARE because 'expired' means two different things. On a permission it is
 * "nobody answered and nobody can" — the session ended. On an ERROR it is "this
 * condition can never be observed again": its session is dead, or the record
 * predates recoveryKey and no success signal can ever reach it. Showing "Session
 * ended" on a keyless `GET /api/ui-prefs → 500` from three days ago would be
 * simply wrong, so an expired error reads "Stale".
 *
 * Shared by the panel card and the toast so the two can't drift.
 */
export function resolvedLabelOf(
  // `resolved` is widened to string so the toaster can pass its local
  // 'stale' outcome (which is not a server value) through the same function
  // rather than keeping a second copy of these labels.
  n: { kind: NotificationKind; resolved?: string | null },
): string | null {
  switch (n.resolved) {
    case 'allowed': return 'Approved';
    case 'denied': return 'Denied';
    case 'recovered': return 'Recovered ✓';
    case 'expired': return n.kind === 'operation-error' ? 'Stale' : 'Session ended';
    // A truthy `resolved` we don't recognise: settled somewhere else and we never
    // learned which way. Neutral, never a guessed outcome.
    default: return n.resolved ? 'Already answered' : null;
  }
}

export interface SectionCounts {
  action: number;
  /** UNREAD letters — the Inbox rail badge (a letter is read one at a time, so
   *  unread is the meaningful number here, unlike the other rails). */
  inbox: number;
  /** UNREAD errors — bell-badge parity, NOT what the rail badge shows. */
  errors: number;
  /** UNREAD automation receipts. */
  automation: number;
  /** UNREAD across the whole feed (the bell badge's number). */
  all: number;
  /** Letters the Inbox rail lists (non-archived). */
  inboxTotal: number;
  /** Errors the rail actually lists: unresolved, read or not. */
  errorsTotal: number;
  /** Automation receipts the rail lists. */
  automationTotal: number;
  /** The whole feed. */
  allTotal: number;
}

/**
 * The letter fields the counts need — structurally satisfied by LetterEnvelope
 * (web/src/api/human-inbox.ts). Declared locally so this module stays free of
 * API-client imports and remains a pure, unit-testable derivation.
 */
export interface LetterCountable {
  type: string;
  read: boolean;
  pinned?: boolean;
  archived?: boolean;
  answered?: unknown;
}

/**
 * Rail badge counts, in two flavours because the rail and the bell ask different
 * questions.
 *
 * Needs Action counts PENDING permissions regardless of read state (marking it
 * read doesn't answer it — the session is still blocked). The `*Total` fields
 * count what each section LISTS, which is what the rail badge shows: a badge that
 * only appeared while something was unread meant a rail with four labels and one
 * number, and the user couldn't see there were nine errors sitting under a tab
 * they had already opened once. The unread fields stay for the bell badge, which
 * legitimately means "new since you looked".
 *
 * `letters` (the letter store's own list) is optional and AUTHORITATIVE when
 * given: read/pin/archive live there, and the 200-entry feed can have dropped a
 * durable letter's envelope entirely. Without it the feed's letter envelopes are
 * used as a stand-in so the Inbox badge is right before the list loads. An
 * UNANSWERED action_required letter also counts into Needs Action — it blocks
 * work exactly like a permission ask does.
 */
export function sectionCounts(feed: Notification[], letters?: LetterCountable[]): SectionCounts {
  const counts: SectionCounts = {
    action: 0, inbox: 0, errors: 0, automation: 0, all: 0,
    inboxTotal: 0, errorsTotal: 0, automationTotal: 0, allTotal: 0,
  };
  for (const n of feed) {
    counts.allTotal++;
    if (!n.read) counts.all++;
    const section = sectionOf(n);
    if (section === 'action') counts.action++;
    else if (section === 'inbox') { counts.inboxTotal++; if (!n.read) counts.inbox++; }
    else if (section === 'errors') { counts.errorsTotal++; if (!n.read) counts.errors++; }
    else if (section === 'automation') { counts.automationTotal++; if (!n.read) counts.automation++; }
  }
  if (letters && letters.length > 0) {
    counts.inbox = 0;
    counts.inboxTotal = 0;
    for (const l of letters) {
      if (l.archived) continue;
      counts.inboxTotal++;
      if (!l.read) counts.inbox++;
      if (l.type === 'action_required' && !l.answered) counts.action++;
    }
  }
  return counts;
}

/**
 * How many System-zone checks are currently unhealthy.
 *
 * The System zone has no feed entries, so its rail marker can't come from
 * sectionCounts — it comes from the two ambient signals the pane actually
 * renders. A count instead of a bare dot so the rail says "two things in here
 * are broken" rather than "something, somewhere". Falls back to the dot when
 * this is 0 but the caller still believes something is wrong.
 */
export function systemIssueCount(flags: {
  gitSyncFailing?: boolean;
  indexUnhealthy?: boolean;
}): number {
  return (flags.gitSyncFailing ? 1 : 0) + (flags.indexUnhealthy ? 1 : 0);
}

/** Sort/display timestamp: the latest occurrence for a folded record. */
export function effectiveTs(n: Notification): number {
  return n.lastTimestamp ?? n.timestamp;
}

/**
 * The tool a permission request is about.
 *
 * LEGACY RECORDS HAVE NO `toolName`: the server writes the tool name into BOTH
 * `title` and `toolName` (src/web/server.ts), and `toolName` only landed with the
 * enrichment half — so for a permission record written before that, `title` IS
 * the tool name. Every guard that keys off the tool must read it through here,
 * otherwise a legacy AskUserQuestion record slips past the guard and gets a plain
 * Approve button, which sends an allow with NO answers ("the user answered
 * nothing" bug). Non-permission kinds have no tool, and their title is prose.
 */
export function toolNameOf(n: Notification): string | undefined {
  return n.toolName ?? (n.kind === 'permission' ? n.title : undefined);
}

export type PermissionDetail =
  | { type: 'bash'; command: string; description?: string }
  | { type: 'question'; questions: AskQuestion[] }
  | { type: 'plan'; plan: string }
  | { type: 'file'; filePath: string }
  | { type: 'generic'; preview?: string };

/**
 * What a permission request is asking for, in the shape the card renders.
 * Driven by the compacted `input` the server stores (permission-detail.ts), with
 * the tool name only as a tie-breaker — a legacy record with no input at all falls
 * through to 'generic', which renders as a plain approve/deny (or, for
 * AskUserQuestion, deliberately NOT approvable — see isUnanswerableAsk).
 */
export function permissionDetail(n: Notification): PermissionDetail {
  const input = n.input;
  const str = (v: unknown): string | undefined =>
    (typeof v === 'string' && v.trim() ? v : undefined);

  if (input) {
    const questions = parseAskUserQuestionInput(input);
    if (questions) return { type: 'question', questions };

    const plan = str(input.plan);
    if (plan) return { type: 'plan', plan };

    const command = str(input.command);
    if (command) return { type: 'bash', command, description: str(input.description) };

    const filePath = str(input.file_path);
    if (filePath) return { type: 'file', filePath };

    const preview = str(input.preview);
    if (preview) return { type: 'generic', preview };
  }

  // No usable input: ExitPlanMode still has a known ask even with the plan text
  // dropped (over the size ceiling), so name it rather than showing nothing.
  if (toolNameOf(n) === 'ExitPlanMode') return { type: 'plan', plan: '' };
  return { type: 'generic' };
}

/**
 * An AskUserQuestion whose questions we could not recover — the one permission
 * shape that must NEVER get an approve button on either surface.
 *
 * Answering an AskUserQuestion IS the response: a bare allow carries no `answers`
 * map, which tells the model the user answered nothing. So when the tool is
 * AskUserQuestion but the detail didn't parse into questions (legacy record with
 * no stored input, or input dropped over the size ceiling), the only honest
 * affordance is the session deep link. Reads the tool through toolNameOf so a
 * legacy record — title 'AskUserQuestion', no toolName — is caught too.
 */
export function isUnanswerableAsk(n: Notification, detail: PermissionDetail): boolean {
  return toolNameOf(n) === 'AskUserQuestion' && detail.type !== 'question';
}

/**
 * The provider request id needed to answer. Prefers the first-class field; falls
 * back to the `perm:<requestId>` dedupKey for records written before the server
 * carried it.
 */
export function requestIdOf(n: Notification): string | null {
  if (n.requestId) return n.requestId;
  if (n.dedupKey.startsWith('perm:')) return n.dedupKey.slice(5) || null;
  return null;
}

/**
 * The ACP options that can actually be sent back. `optionId` is what
 * POST /permission answers with, so an option missing it is a dead button —
 * narrowed away here rather than rendered disabled.
 */
export function validAcpOptions(
  n: Notification,
): Array<{ optionId: string; kind?: string; name?: string }> {
  return (n.acpOptions ?? []).filter(
    (o): o is { optionId: string; kind?: string; name?: string } => !!o.optionId,
  );
}

/**
 * Whether an ACP option means "no". The ACP wire contract is the source of these
 * values: an adapter names its refusals `reject_once` / `reject_always`
 * (see src/providers/acp-session.ts), so the `reject` prefix covers both without
 * enumerating a list that grows with the protocol.
 */
export function isRejectOption(o: NotificationAcpOption): boolean {
  return o.kind?.startsWith('reject') ?? false;
}

/**
 * Where a notification's deep link points, iPhone-style. Null → nothing to open.
 *
 * Lives here (not in a surface file) because BOTH the panel card and the
 * permission toast now offer an "Open session" affordance, and a second copy of
 * this precedence would drift: a session beats a task beats a kind-specific page
 * beats the record's own navigate action. `/sessions?id=…` is rewritten to the
 * home session columns by navigateToTarget — the shape is the link, not the route.
 */
export function linkTargetOf(n: Notification): string | null {
  if (n.sessionId) return `/sessions?id=${n.sessionId}`;
  if (n.taskId) return `/tasks/${n.taskId}`;
  if (n.kind === 'skill') return '/skills';
  if (n.action?.kind === 'navigate' && n.action.to) return n.action.to;
  return null;
}

/** Session label for the card/toast context line: friendly title, else short id. */
export function sessionLabelOf(n: Notification): string | undefined {
  if (n.sessionTitle) return n.sessionTitle;
  if (!n.sessionId) return undefined;
  return n.sessionId.length > 8 ? `${n.sessionId.slice(0, 8)}…` : n.sessionId;
}

// ── Error categories + human copy ────────────────────────────────────────────
//
// The server humanizes every NEW error record at write time
// (src/core/notifications/humanize.ts): it derives a `category`, a readable
// `title`, a one-sentence `body`, and moves the raw technical line to `detail`.
// The two functions below exist for what the server can't retroactively fix: the
// records ALREADY on disk, written before that landed, whose title is a log line
// and whose body is `[subsystem] {json}`. They are display-time only — nothing
// here is persisted — and they are in this module (not the panel) so they are
// unit-testable and shared by every surface.

/** A plugin id / subsystem root as a display name: `plugin-a` → `Plugin A`. */
function titleizeId(id: string): string {
  return id
    .split(/[-_.]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * The family an error belongs to.
 *
 * Prefers the server's value; for a pre-humanizer record it mirrors the server's
 * recoveryKey→category mapping (the key SHAPES are the contract between the two
 * implementations — `categoryFromRecoveryKey` in humanize.ts is the original, and
 * both must be extended together). Anything unkeyed lands in 'Other', which is
 * honest: a keyless legacy record genuinely has no signal to classify it by.
 */
export function categoryOf(n: Notification): string {
  if (n.category) return n.category;
  const key = n.recoveryKey;
  if (key) {
    if (key.startsWith('plugin:')) {
      const id = key.slice('plugin:'.length).trim();
      if (id) return titleizeId(id);
    }
    if (key.startsWith('session:') || key.startsWith('task:')) return 'Sessions';
    if (key.startsWith('route:')) return 'API';
    if (key.startsWith('bus:')) return 'Internal';
    if (key === 'git' || key === 'git:compaction' || key === 'backup' || key === 'disk') {
      return 'Data & Sync';
    }
    if (key === 'server-lifecycle') return 'Server';
    if (key === 'task-db-writers') return 'Internal';
    if (key === 'send-path') return 'Cloud';
  }
  return 'Other';
}

/** A raw log-meta body: `[web] {"reqId":…}` — the shape the old cards showed. */
const RAW_META_BODY_RE = /^\[[\w/@.-]+\]\s*[{[]/;

export interface PresentedError {
  title: string;
  /** The human sentence, or empty when the title says everything. */
  body: string;
  /** Raw technical line for the Details toggle, or undefined when there is none. */
  detail?: string;
}

/**
 * What an error card renders: `{ title, body, detail }`.
 *
 * A new record passes through untouched (the server already humanized it). An OLD
 * record gets the one repair that can be done client-side without guessing: its
 * `[subsystem] {json}` body is MOVED into the Details toggle, so the card shows a
 * title and a quiet "Details" affordance instead of a wall of JSON. The title is
 * left as the producer wrote it — inventing human copy for a legacy record would
 * mean shipping the whole rule table twice, and the record will be rewritten with
 * real copy the next time its condition fires (`category`/`detail` are
 * refreshable in the store).
 */
export function presentError(n: Notification): PresentedError {
  const body = n.body ?? '';
  if (n.detail || !RAW_META_BODY_RE.test(body.trim())) {
    return { title: n.title, body, ...(n.detail ? { detail: n.detail } : {}) };
  }
  return { title: n.title, body: '', detail: body };
}

export interface ErrorCategoryGroup {
  category: string;
  items: Notification[];
}

/**
 * Errors grouped by category, categories ordered by most-recent activity.
 *
 * Recency rather than a fixed category order: the rail is read top-down when
 * something just broke, and a static alphabetical list would bury the live
 * failure under a quiet family. Items keep the caller's order (the panel hands
 * them in newest-first), so this is a stable partition, not a re-sort.
 */
export function groupErrorsByCategory(items: Notification[]): ErrorCategoryGroup[] {
  const byCategory = new Map<string, Notification[]>();
  for (const n of items) {
    const category = categoryOf(n);
    const list = byCategory.get(category);
    if (list) list.push(n);
    else byCategory.set(category, [n]);
  }
  const groups = [...byCategory.entries()].map(([category, list]) => ({ category, items: list }));
  return groups.sort((a, b) => {
    const recency = (g: ErrorCategoryGroup) => Math.max(...g.items.map(effectiveTs));
    return recency(b) - recency(a);
  });
}

/**
 * Short relative age for card timestamps ("12s ago" … "3d ago"). Accepts epoch ms
 * directly — feed timestamps ARE epoch ms, and the old string-only signature
 * forced every caller through a number→Date→ISO→Date round-trip per render.
 * Lives here (not in a surface file) because the panel and the System pane both
 * need it and neither should import the other.
 */
export function formatRelative(at: string | number): string {
  const then = typeof at === 'number' ? at : new Date(at).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.floor((Date.now() - then) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
