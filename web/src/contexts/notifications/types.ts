/**
 * Unified notification model — the single shape every toast/feed source maps to.
 *
 * Replaces 6 bespoke toast implementations (cron, permission, operation-error,
 * sort hint, audio error) + the ambient NotificationPanel. Sources push a
 * Notification; the provider owns dedup, lifecycle (auto-dismiss), the toast
 * stack, and the persistent feed.
 */

/** Persistent kinds land in the feed + unread count; ephemeral kinds only toast. */
export type NotificationKind =
  | 'permission' | 'cron' | 'operation-error' | 'sort' | 'audio-error' | 'skill' | 'hook'
  /** A letter an agent wrote to the human — envelope only; the body lives in the
   *  letter store and is read in the Inbox reader (docs/plan/human-inbox.md). */
  | 'letter';
export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error';

/** One option an ACP provider offered for a permission request. */
export interface NotificationAcpOption {
  optionId?: string;
  kind?: string;
  name?: string;
}

/** A deep-link or callback the toast/feed entry can offer (e.g. "Go to Session"). */
export interface NotificationAction {
  label: string;
  /** `navigate` uses react-router; `callback` invokes onAction. */
  kind: 'navigate' | 'callback';
  to?: string;
}

export interface Notification {
  id: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  body?: string;
  timestamp: number;
  /** true → feed + unread; false → toast-only (sort, audio-error). */
  persistent: boolean;
  /** feed-only; whether the user has seen it. */
  read?: boolean;
  /** stable identity for de-dup (perm:<requestId>, cron:<job>:<ts>, …). */
  dedupKey: string;
  sessionId?: string;
  /** deep-link target for task-producing notifications (e.g. cron). */
  taskId?: string;
  /** outcome once the notification settles — settled history, not an action item.
   *  permission: 'allowed'/'denied' (a human answered) or 'expired' = nobody
   *  answered and nobody can (session died, CLI withdrew the ask, superseded).
   *  operation-error: 'recovered' = the failing operation succeeded again, so the
   *  condition the error described is gone. */
  resolved?: 'allowed' | 'denied' | 'expired' | 'recovered';
  /** operation-error only — which recoverable condition the error belongs to
   *  (`plugin:<id>`, 'git', 'backup', 'disk'). Server-owned; the UI renders the
   *  `resolved` stamp, this is carried through for debugging + parity — AND as
   *  the client-side fallback for `category` on records written before the
   *  humanizer shipped (see categoryOf in notification-model.ts). */
  recoveryKey?: string;
  /** operation-error only — the ROOT CAUSE shared across conditions, shape
   *  `host:<alias>`; the Errors pane folds cards sharing an open causeKey into
   *  one group (server-owned, src/core/notifications/error-cause.ts). */
  causeKey?: string;
  /** operation-error only — the FAMILY the Errors rail groups by ('Sessions',
   *  'API', a plugin's display name, …). Server-derived
   *  (src/core/notifications/humanize.ts); absent on pre-humanizer records. */
  category?: string;
  /** operation-error only — the RAW technical line (`[subsystem] {json}`, a
   *  stack) shown behind the card's Details toggle. `body` is the human
   *  sentence; this is the developer detail that used to BE the body. */
  detail?: string;
  action?: NotificationAction;
  onAction?: () => void;
  /** emit a browser Notification when the tab is hidden (permission only). */
  browserNotify?: boolean;

  // ── Permission detail (server-enriched: enough to render + answer inline) ──
  /** the provider's request id — first-class instead of parsed out of dedupKey. */
  requestId?: string;
  /** the tool asking for approval (Bash / ExitPlanMode / AskUserQuestion / …). */
  toolName?: string;
  /** COMPACTED tool input (src/core/notifications/permission-detail.ts). */
  input?: Record<string, unknown>;
  /** the provider's decision reason, when it supplied one. */
  reason?: string;
  /** ACP providers only — the option list the adapter offered. */
  acpOptions?: NotificationAcpOption[];

  // ── Letter envelope (kind 'letter') ──
  /** Which letter this envelope points at. The record carries NO body: read
   *  state, pin, type and the thread all live in the letter store, so the row
   *  and the reader fetch by this id (fallback: the `letter:<id>` dedupKey). */
  letterId?: string;

  // ── Shared enrichment: context to act without opening the session ──
  host?: string;
  sessionTitle?: string;
  project?: string;

  // ── Occurrence folding (server-side upsert) ──
  /** occurrences folded into this record. Absent = 1. */
  count?: number;
  /** latest occurrence (epoch ms). `timestamp` stays first-seen. */
  lastTimestamp?: number;
}

/**
 * What a source passes to notify(); id/timestamp/persistent default in-provider.
 * Toast-vs-feed-only is decided by the SHOULD_TOAST policy below, not per call:
 * a per-call override existed with zero callers and only invited one source to
 * quietly disagree with the policy.
 */
export type NotificationInput = Omit<Notification, 'id' | 'timestamp' | 'read'> &
  Partial<Pick<Notification, 'id' | 'timestamp'>>;

/** Per-kind toast auto-dismiss duration (ms). Mirrors the legacy per-toast values. */
export const TOAST_DURATION_MS: Record<NotificationKind, number> = {
  permission: 15000,
  cron: 8000,
  'operation-error': 6000,
  sort: 3000,
  'audio-error': 8000,
  skill: 10000,
  hook: 8000,
  // Never toasted (see SHOULD_TOAST) — the value only satisfies the Record.
  letter: 10000,
};

/**
 * Feed body cap for entries appended live over WS. Matches MAX_BODY_CHARS in
 * src/web/routes/notifications.ts (applied server-side on GET) so an entry
 * doesn't change length after a refresh.
 */
export const MAX_FEED_BODY_CHARS = 600;

/** Whether a kind persists to the durable feed (vs toast-only). */
export const IS_PERSISTENT: Record<NotificationKind, boolean> = {
  permission: true,
  cron: true,
  'operation-error': true,
  sort: false,
  'audio-error': false,
  skill: true,
  hook: true,
  letter: true,
};

/**
 * Whether a notification should pop a toast, or land silently in the feed.
 *
 * Before this, EVERY notify() toasted — so a cron finishing and a skill landing
 * both interrupted the user with the same weight as a session blocked on a
 * permission. The policy keeps toasts for what needs a human NOW (permissions,
 * hard errors, hooks) and demotes routine automation to the feed + bell badge.
 * Ephemeral kinds (sort/audio-error) aren't in the feed at all, so a toast is
 * their only surface — always toast them.
 */
export function SHOULD_TOAST(n: { kind: NotificationKind; severity: NotificationSeverity }): boolean {
  switch (n.kind) {
    case 'permission': return true;
    case 'operation-error': return n.severity === 'error';
    case 'hook': return true;
    case 'sort': return true;
    case 'audio-error': return true;
    case 'cron': return false;
    case 'skill': return false;
    // A letter is deliberately asynchronous — it may be read on a phone days
    // later. Interrupting with a toast (which auto-dismisses) would be the
    // wrong weight AND would risk the human "seeing" it without reading it.
    // The bell badge + Inbox rail count are its surfaces.
    case 'letter': return false;
  }
}
