/**
 * The Brief: a short letter Main or a lead keeps for the user at the top of its chat, so they read
 * where things stand instead of scrolling the conversation. The session edits it itself
 * (brief_write, src/core/sessions/brief-write.ts), in three sections: Needs you, Working, Waiting / snoozed (src/core/sessions/brief-structure.ts). This
 * view shows only that letter (2026-10-30, the user: "brief 就是 AI 写的一个 brief. That's it"):
 * each task it names carries its live status dot and sits in the section of its live status (a
 * task that moved since the letter was written moves with it), and nothing else is added under
 * it. What needs the user lives in the Task view. The user answers in the chat.
 *
 * Between rewrites its head says when it was written and how many of its lines moved since, each
 * such line marked with its task's live words, and "Updating" while the refresh turn Walnut asked
 * because the user opened a stale Brief runs (src/core/sessions/brief-fresh.ts, brief-refresh.ts).
 *
 * A path in it opens on the machine of whoever wrote the words it sits in (TaskBrief.text_sources,
 * org-brief-sources.ts), never on the owner's current session: another session, the user, or a
 * task whose ask Walnut added may have written them. An unrecorded writer opens nothing; two
 * machines for one path ask which.
 */
import { useLayoutEffect, useMemo, useRef } from 'react';
import type { Task } from '@open-walnut/core';
import { userStateOf } from '@open-walnut/org-tree';
import { checkedLine } from '@open-walnut/user-status';
import { briefSectionOf, briefSourcesOf, structureBrief } from '@open-walnut/brief-structure';
import { renderMarkdownWithRefs } from '@/utils/markdown';
import { useEntityLabelsVersion } from '@/hooks/useEntityLabels';
import { useEntityClickHandler } from '@/hooks/useEntityClickHandler';
import { timeAgo } from '@/utils/time';
import { freshnessWords, type BriefFreshness } from '@open-walnut/brief-fresh';
import { applyBriefDecorations, applyBriefMoves, type BriefMoveView } from './org-brief-model';
import { BRIEF_RENDER, useBriefFileOpener } from './useBriefFileOpener';
import '@/styles/org-brief.css';

interface Props {
  owner: Task | undefined;
  tasks: readonly Task[];
  /** The owner's name, for the empty state. */
  name: string;
  onOpenTask: (id: string) => void;
  now: number;
  /** Folded: its first lines, the rest a click away. */
  folded?: boolean;
  /** What moved since it was written (brief-fresh.ts), from the live tasks. */
  fresh?: BriefFreshness | null;
  /** A refresh turn was asked and its new letter has not landed yet (brief-fresh.ts briefUpdating). */
  updating?: boolean;
}

export function OrgBrief({ owner, tasks, name, onOpenTask, now, folded, fresh, updating }: Props) {
  const brief = owner?.brief;
  const labels = useEntityLabelsVersion();
  const states = useMemo(() => new Map(tasks.map((t) => [t.id, userStateOf(t)] as const)), [tasks]);
  // Each named task's section now, as one key: the letter is put in its sections again only when
  // one of them moves, never on any other task update.
  const sectionKey = useMemo(() => {
    const ids = brief?.text ? [...brief.text.matchAll(/<task-ref\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]!) : [];
    const byId = new Map(tasks.map((t) => [t.id, t] as const));
    const named = ids.map((id) => { const t = byId.get(id); return `${id}:${t ? briefSectionOf(t) ?? '-' : '?'}`; }).join('|');
    // And every task that asks the user now with its ask: Walnut adds the ones the letter misses.
    // With who wrote each ask's words: a new writer of the same words must reshape the added line's source.
    const asks = tasks.filter((t) => briefSectionOf(t) === 'needs').map((t) => JSON.stringify([
      t.id, t.user_status?.ask ?? '', t.user_status?.waitingOn ?? '', t.user_status?.reportBy ?? '', t.user_status?.reportSessionId ?? '', t.last_words?.session_id ?? '',
      t.user_status?.waitingBy ?? '', t.user_status?.waitingSessionId ?? '', t.user_status?.askBy ?? '', t.user_status?.askSessionId ?? '',
    ])).join('|');
    return `${named}#${asks}`;
  }, [brief?.text, tasks]);
  // Held to the live state (brief-structure.ts `live`): each line in its task's section, a finished
  // task's line gone, and every task asking the user in Needs you, in its own words when missing.
  // Each part keeps its writer through the reshaping; an added ask carries its own task's writer.
  const shaped = useMemo(
    // Walnut's earlier lines are written again from the live state, in the letter's language.
    () => (brief?.text && owner ? structureBrief(brief.text, owner.id, tasks, {
      live: owner, ...(brief.added?.length ? { walnut: brief.added } : {}), ...(brief.lang ? { lang: brief.lang } : {}),
      sources: briefSourcesOf({ text: brief.text, text_sources: brief.text_sources }),
    }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [brief?.text, brief?.text_sources, owner?.id, sectionKey],
  );
  const text = shaped?.text ?? brief?.text ?? '';
  const textSources = shaped?.text_sources;
  // The letter's markup comes from its text alone; each pill's live status is set on it in place
  // below, so a task changing state rebuilds the letter only when it moves to another section.
  const markup = useMemo(
    () => (text ? renderMarkdownWithRefs(text, undefined, undefined, BRIEF_RENDER) : ''),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [text, labels],
  );
  // React 19 resets innerHTML for every new {__html} object, even with the same string, which
  // drops a selection in the letter on any task update: keep one object per string.
  const html = useMemo(() => (markup ? { __html: markup } : null), [markup]);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Before paint, so a new letter never shows a frame without its pills' status.
  useLayoutEffect(() => {
    if (bodyRef.current) applyBriefDecorations(bodyRef.current, states);
  }, [html, states]);
  // Each line whose task moved since the letter was written: marked, with its live words.
  const moves = useMemo(() => new Map<string, BriefMoveView>((fresh?.moved ?? []).map((m) => [m.id, m] as const)), [fresh]);
  // The asks Walnut added, each with when its task last checked it.
  const added = useMemo(() => {
    const byId = new Map(tasks.map((t) => [t.id, t] as const));
    return new Map((shaped?.asksAdded ?? []).map((id) => {
      const checked = checkedLine(byId.get(id)?.user_status, now);
      return [id, `Added by Walnut${checked ? ` · ${checked.text}` : ''}`] as const;
    }));
  }, [shaped, tasks, now]);
  useLayoutEffect(() => {
    if (bodyRef.current) applyBriefMoves(bodyRef.current, moves, added);
  }, [html, moves, added]);
  const onFileOpen = useBriefFileOpener(owner?.id, text, textSources, tasks);
  const onClick = useEntityClickHandler(onOpenTask, undefined, onFileOpen.open, undefined, undefined, true);

  if (!brief?.text || !html) {
    return (
      <div className="org-brief is-empty" data-testid="org-brief">
        <p className="org-muted">No brief yet. {name} writes one when its next turn ends.</p>
      </div>
    );
  }
  const moved = freshnessWords(fresh ?? null);
  return (
    <div className={`org-brief${folded ? ' is-folded' : ''}`} data-testid="org-brief" data-stale={fresh?.stale ? '1' : '0'}>
      <div className="org-brief-head" data-testid="org-brief-head">
        <span className="org-muted">Written {timeAgo(brief.at, { now })}</span>
        {moved && <span className="org-brief-moved" data-testid="org-brief-moved"> · {moved}</span>}
        {updating && <span className="org-brief-updating" data-testid="org-brief-updating"> · Updating…</span>}
      </div>
      <div ref={bodyRef} className="org-brief-body markdown-body" data-testid="org-brief-body" onClick={onClick} dangerouslySetInnerHTML={html} />
      {onFileOpen.dialog}
    </div>
  );
}
