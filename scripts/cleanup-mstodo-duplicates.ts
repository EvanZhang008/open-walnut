#!/usr/bin/env npx tsx
/**
 * Cleanup: merge duplicate MS To-Do task copies without losing session links.
 *
 * The old version of this script grouped REMOTE tasks by title, deleted the
 * "extras" remotely, and rewrote local ext ids — transferring nothing. When
 * duplicate LOCAL tasks existed, whichever copy held the session links could
 * be deleted, orphaning its sessions (the H-1B RFE incident, 2026-08).
 *
 * This version works on the LOCAL store through task-manager:
 *   1. Groups local ms-todo tasks by (project, normalized title).
 *   2. Picks ONE survivor per group: most session links, then oldest.
 *   3. mergeTaskInto() every victim → session_ids unioned, sessions.task_id
 *      re-pointed, victim ledgered as deleted (task_remote_links), remote twin
 *      deletion retried by the sync tick until confirmed.
 *
 * Usage:
 *   npx tsx scripts/cleanup-mstodo-duplicates.ts --dry-run       # preview (default)
 *   npx tsx scripts/cleanup-mstodo-duplicates.ts --live          # actually merge
 *   npx tsx scripts/cleanup-mstodo-duplicates.ts --live --title "Session: walnut"
 */

import path from 'node:path';

const WALNUT_HOME = process.env.OPEN_WALNUT_HOME ?? path.join(process.env.HOME!, '.open-walnut');

// Guard: refuse to run in a test environment against production data
const isTestEnv = !!(process.env.VITEST || process.env.VITEST_WORKER_ID || process.env.NODE_ENV === 'test');
if (isTestEnv && WALNUT_HOME === path.join(process.env.HOME!, '.open-walnut')) {
  console.error('SAFETY: refusing to run cleanup script against production ~/.open-walnut/ in test environment');
  process.exit(1);
}

const live = process.argv.includes('--live');
const titleFlagIdx = process.argv.indexOf('--title');
const onlyTitle = titleFlagIdx >= 0 ? process.argv[titleFlagIdx + 1]?.toLowerCase().trim() : undefined;

interface TaskLite {
  id: string;
  title: string;
  project?: string;
  source: string;
  created_at?: string;
  session_ids: string[];
  session_id?: string;
  plan_session_id?: string;
  exec_session_id?: string;
  ext?: Record<string, unknown>;
}

function sessionLinkCount(t: TaskLite): number {
  return new Set([
    ...(t.session_ids ?? []),
    t.session_id, t.plan_session_id, t.exec_session_id,
  ].filter(Boolean)).size;
}

async function main() {
  console.log(`\n=== MS To-Do duplicate merge ${live ? '(LIVE)' : '(DRY RUN — pass --live to apply)'} ===\n`);

  const { listTasks, mergeTaskInto } = await import('../src/core/task-manager.js');
  const tasks = (await listTasks()) as unknown as TaskLite[];

  const msTodo = tasks.filter((t) => {
    if (t.source !== 'ms-todo') return false;
    return !onlyTitle || t.title.toLowerCase().trim() === onlyTitle;
  });

  // Pass 1 groups: several LOCAL tasks holding the SAME remote id — literal
  // identity duplicates (identity says so, whatever the titles say).
  const byRemoteId = new Map<string, TaskLite[]>();
  for (const t of msTodo) {
    const rid = (t.ext?.['ms-todo'] as Record<string, unknown> | undefined)?.id as string | undefined;
    if (!rid) continue;
    if (!byRemoteId.has(rid)) byRemoteId.set(rid, []);
    byRemoteId.get(rid)!.push(t);
  }

  // Pass 2 groups: same (project, normalized title) — the fork copies, each
  // wearing a DIFFERENT remote id because each fork pushed its own remote twin.
  const groups = new Map<string, TaskLite[]>();
  const seenInPass1 = new Set<string>();
  for (const members of byRemoteId.values()) {
    if (members.length > 1) for (const m of members) seenInPass1.add(m.id);
  }
  for (const t of msTodo) {
    if (seenInPass1.has(t.id)) continue; // pass 1 handles those first
    const key = `${(t.project ?? '').toLowerCase()}::${t.title.toLowerCase().trim()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }
  for (const [rid, members] of byRemoteId) {
    if (members.length > 1) groups.set(`remote-id::${rid}`, members);
  }

  let groupsMerged = 0;
  let victimsMerged = 0;
  let linksMoved = 0;

  for (const [, members] of groups) {
    if (members.length <= 1) continue;

    // Survivor: most session links wins; tie → oldest created_at; tie → lowest id.
    const sorted = [...members].sort((a, b) =>
      sessionLinkCount(b) - sessionLinkCount(a)
      || (a.created_at ?? '9999').localeCompare(b.created_at ?? '9999')
      || a.id.localeCompare(b.id),
    );
    const [survivor, ...victims] = sorted;

    console.log(`\n[${survivor.project || 'Inbox'}] "${survivor.title}" — ${members.length} copies`);
    console.log(`  KEEP  ${survivor.id} (${sessionLinkCount(survivor)} session links, created ${survivor.created_at ?? '?'})`);
    for (const v of victims) {
      console.log(`  MERGE ${v.id} (${sessionLinkCount(v)} session links, created ${v.created_at ?? '?'})`);
      if (live) {
        try {
          const { sessionsRelinked } = await mergeTaskInto(survivor.id, v.id);
          linksMoved += sessionsRelinked;
          victimsMerged++;
        } catch (err) {
          console.error(`  ✗ merge failed for ${v.id}: ${err instanceof Error ? err.message : err}`);
        }
      } else {
        victimsMerged++;
      }
    }
    groupsMerged++;
  }

  console.log(`\n--- Summary ---`);
  console.log(`Duplicate groups: ${groupsMerged}`);
  console.log(`Victims ${live ? 'merged' : 'to merge'}: ${victimsMerged}`);
  if (live) console.log(`Session rows re-pointed: ${linksMoved}`);
  console.log(live
    ? 'Remote twins of merged victims are ledgered for deletion; the sync tick retries until confirmed.'
    : 'Dry run only — nothing was changed.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
