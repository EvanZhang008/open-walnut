/**
 * Chat-lab oracles — the two properties EVERY scenario is judged by, stated
 * once so no scenario can water them down.
 *
 * 1. REFRESH EQUIVALENCE (the user's own definition of the bug family):
 *    "一刷新他就没了" — the artifact disappears on refresh, i.e. the live view
 *    shows something a fresh mount would not. At QUIESCENCE (no turn streaming,
 *    no event in flight, history synced) the projected timeline must equal the
 *    projection of a fresh client that full-fetched the same server. Anything
 *    extra in the live view is exactly a "stale thing pinned at the bottom".
 *
 * 2. NEVER VANISH: content the user watched generate must stay visible until
 *    its persisted twin renders. Checked as: every canonical assistant text is
 *    present in the projection (as history or as a still-visible block).
 *
 * DESIGNED RESIDUALS (allowed, by explicit allowlist only):
 *  · redacted thinking — history never preserves it; the streamed copy staying
 *    visible is the documented design (render-filter.ts allBlocksAbsorbed doc).
 */

import { expect } from 'vitest';
import type { HeadlessChatClient, VisibleItem } from './headless-client';
import { HeadlessChatClient as Client } from './headless-client';
import type { ScriptedServer } from './scripted-server';

export interface QuiescenceOptions {
  /** Item-label predicates for DESIGNED residuals (e.g. redacted thinking). */
  allowResiduals?: (item: VisibleItem) => boolean;
}

/** Oracle 1 — refresh equivalence at quiescence. Returns the residual items so
 *  REPRODUCE-mode scenarios can assert the artifact exists pre-fix. */
export function refreshResiduals(
  client: HeadlessChatClient,
  server: ScriptedServer,
  opts?: QuiescenceOptions,
): VisibleItem[] {
  const fresh = new Client(server);
  fresh.reload();
  const freshLabels = new Set(fresh.project().map(i => `${i.kind}|${i.label}`));
  return client.project()
    // History rows are exempt: a live whale client legitimately holds MORE
    // history than a fresh windowed mount (the window evicted the head — the
    // live client keeping it is strictly better, not an artifact). History
    // integrity is covered by expectNothingVanished + the merge guards. The
    // artifact family the user reports is always in the NON-history kinds:
    // bubbles, blocks, task/orphan groups pinned below the last message.
    .filter(i => i.kind !== 'history')
    .filter(i => !freshLabels.has(`${i.kind}|${i.label}`))
    .filter(i => !(opts?.allowResiduals?.(i) ?? false));
}

export function expectRefreshEquivalent(
  client: HeadlessChatClient,
  server: ScriptedServer,
  opts?: QuiescenceOptions,
): void {
  const residuals = refreshResiduals(client, server, opts);
  expect(residuals, 'live view shows items a refresh would clear (the pinned-at-bottom family)').toEqual([]);
}

/** Oracle 2 — never vanish: every canonical assistant text must be visible. */
export function expectNothingVanished(client: HeadlessChatClient, server: ScriptedServer): void {
  const projected = client.project().map(i => i.label).join('\n');
  for (const m of server.canonical) {
    if (m.role !== 'assistant' || !m.text) continue;
    // The projection truncates labels at 40 chars; match on the same prefix.
    expect(projected, `assistant content vanished: "${m.text.slice(0, 40)}"`).toContain(m.text.slice(0, 40));
  }
}
