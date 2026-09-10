/**
 * The first message of a repair session started from an error notification.
 *
 * Server-side (not in the web client) for the same reason as the Fix-Walnut
 * briefing in routes/sessions.ts: every client (web, iOS, CLI) gets one text,
 * and the copy iterates without a frontend redeploy. Unlike that briefing,
 * this one cannot assume the session runs inside the code the server was
 * built from: an npm install repairs in a separate clone, and the session
 * must be told that the running Walnut is NOT what it is editing, or the
 * repo's own CLAUDE.md ("deploy with dev:prod") would send it to restart a
 * server that was never served from that tree.
 */

import type { NotificationRecord } from '../notifications/store.js';
import type { WalnutSource } from './walnut-source.js';

export interface FixBriefingContext {
  source: WalnutSource;
  /** Running server version (getVersion()). */
  version: string;
  /** Directory of the running package (checkout, npm install dir, or bundle). */
  packageRoot: string | null;
  /** WALNUT_HOME */
  dataDir: string;
  /** LOG_DIR: where open-walnut-<date>.log lands. */
  logDir: string;
  repoUrl: string;
  /** This request created the clone (first repair on an npm install). */
  cloned: boolean;
}

const TITLE_MAX = 80;

/** Task title for the repair: the notification's title behind a `Fix:` prefix. */
export function fixTaskTitle(n: Pick<NotificationRecord, 'title'>): string {
  const flat = n.title.replace(/\s+/g, ' ').trim() || 'error notification';
  const title = `Fix: ${flat}`;
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title;
}

function iso(ts: number | undefined): string {
  return ts ? new Date(ts).toISOString() : 'unknown';
}

function errorSection(n: NotificationRecord): string[] {
  const lines = ['## The error', `Title: ${n.title}`];
  const meta = [n.category ? `Category: ${n.category}` : null, `Severity: ${n.severity}`].filter(Boolean);
  lines.push(meta.join(' · '));
  if (n.body) lines.push(`Message: ${n.body}`);
  if (n.detail) lines.push(`Details: ${n.detail}`);
  const count = n.count ?? 1;
  lines.push(count > 1
    ? `Occurrences: ${count} (first ${iso(n.timestamp)}, last ${iso(n.lastTimestamp ?? n.timestamp)})`
    : `Occurred: ${iso(n.timestamp)}`);
  if (n.resolved) lines.push(`Status: ${n.resolved}${n.resolvedAt ? ` at ${iso(n.resolvedAt)}` : ''} (the condition cleared at least once, but it keeps coming back)`);
  if (n.recoveryKey) lines.push(`Condition key: ${n.recoveryKey} (the producer's recoveryKey; grep src/ for it to find where this is raised)`);
  if (n.causeKey) lines.push(`Cause key: ${n.causeKey}`);
  const ctx = [
    n.sessionId ? `session ${n.sessionId}${n.sessionTitle ? ` ("${n.sessionTitle}")` : ''}` : null,
    n.taskId ? `task ${n.taskId}` : null,
    n.host ? `host ${n.host}` : null,
    n.project ? `project ${n.project}` : null,
  ].filter(Boolean);
  if (ctx.length) lines.push(`Context: ${ctx.join(', ')}`);
  return lines;
}

function whereSection(ctx: FixBriefingContext): string[] {
  const logs = `Structured logs: ${ctx.logDir}/open-walnut-<date>.log (UTC timestamps in a local-date filename, so an early-morning event may be in the previous day's file).`;
  if (ctx.source.kind === 'running') {
    return [
      '## Where you are',
      `You are in Walnut's source checkout at ${ctx.source.dir}. The running server (v${ctx.version}) was built from this checkout, so a fix here is a fix to the app that raised the error. Data dir: ${ctx.dataDir}.`,
      `${logs} \`scripts/walnut-logs.sh errors\` and \`scripts/walnut-logs.sh diagnose\` are the fastest way in; CLAUDE.md documents the toolkit and the build, verify and deploy workflow.`,
    ];
  }
  const origin = ctx.source.kind === 'clone'
    ? (ctx.cloned ? 'cloned just now for this repair' : 'the local clone Walnut keeps for repairs')
    : 'the checkout the user pointed Walnut at';
  return [
    '## Where you are',
    `You are in a git checkout of Walnut's source at ${ctx.source.dir} (${origin}; upstream ${ctx.repoUrl}). The RUNNING Walnut is NOT this tree: it is the installed package open-walnut@${ctx.version}${ctx.packageRoot ? ` at ${ctx.packageRoot}` : ''} (compiled dist only, no sources), with data dir ${ctx.dataDir}.`,
    `${logs} The checkout's HEAD may be newer than the installed version: check \`git log\` and CHANGELOG.md, and compare against what the logs show before assuming the code paths match.`,
    'Setup: run `npm install` here first if node_modules is missing. Build with `npm run web:build`; run the quick tests with `npm run test:quick`.',
    'Important: the repo\'s CLAUDE.md describes the maintainer\'s own deploy flow (`npm run dev:prod`, port 3456). Do NOT run it, and do NOT kill or restart the user\'s running Walnut: it is not served from this tree. To apply the fix locally, run `npm run web:build && npm install -g .` in this checkout and ask the user to restart Walnut. If the fix is general, offer to open a pull request upstream.',
  ];
}

export function buildNotificationFixMessage(n: NotificationRecord, ctx: FixBriefingContext): string {
  return [
    'Walnut (this app) recorded an error in its notification center, and the user clicked "Ask AI to fix" on it. Fix it end to end.',
    '',
    ...errorSection(n),
    '',
    ...whereSection(ctx),
    '',
    '## What to do',
    '1. Locate the producer: grep src/ for the title text or the condition key, then read the logs around the last occurrence to see what actually happened.',
    '2. Find the root cause. Fix causes, not the message.',
    '3. Implement the fix, build, and verify. Add a regression test where one is practical.',
    '4. Summarize: root cause, what changed, how you verified it, and whether this notification will clear on its own.',
  ].join('\n');
}
