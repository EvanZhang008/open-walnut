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
import type { Notification, NotificationAcpOption } from './types';

export type NotificationSection = 'action' | 'errors' | 'automation' | 'all';

/**
 * Which rail section an entry belongs to. Only a PENDING permission is an action
 * item — a resolved one is history, so it stays out of Needs Action (it still
 * shows under All).
 */
export function sectionOf(n: Notification): NotificationSection {
  if (n.kind === 'permission') return n.resolved ? 'all' : 'action';
  if (n.kind === 'operation-error') return 'errors';
  if (n.kind === 'cron' || n.kind === 'skill' || n.kind === 'hook') return 'automation';
  return 'all';
}

export interface SectionCounts {
  action: number;
  errors: number;
  automation: number;
  all: number;
}

/**
 * Rail badge counts. Needs Action counts PENDING permissions regardless of read
 * state (marking it read doesn't answer it — the session is still blocked); the
 * other sections count unread, matching the bell badge.
 */
export function sectionCounts(feed: Notification[]): SectionCounts {
  const counts: SectionCounts = { action: 0, errors: 0, automation: 0, all: 0 };
  for (const n of feed) {
    if (!n.read) counts.all++;
    const section = sectionOf(n);
    if (section === 'action') counts.action++;
    else if (section === 'errors') { if (!n.read) counts.errors++; }
    else if (section === 'automation') { if (!n.read) counts.automation++; }
  }
  return counts;
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
