/**
 * The Brief: a short letter Main or a lead keeps for the user at the top of its chat, so they read
 * where things stand instead of scrolling the conversation. The session writes it at the end of
 * every turn (FOR_USER_BRIEF in its self-report, src/core/session-hooks/builtins.ts), in three
 * sections: Needs you, Working, Waiting / snoozed (src/core/sessions/brief-structure.ts). This
 * view shows only that letter (2026-10-30, the user: "brief 就是 AI 写的一个 brief. That's it"):
 * each task it names carries its live status dot and sits in the section of its live status (a
 * task that moved since the letter was written moves with it), and nothing else is added under
 * it. What needs the user lives in the Task view. The user answers in the chat.
 */
import { useLayoutEffect, useMemo, useRef } from 'react';
import type { Task } from '@open-walnut/core';
import { userStateOf } from '@open-walnut/org-tree';
import { briefSectionOf, structureBrief } from '@open-walnut/brief-structure';
import { renderMarkdownWithRefs } from '@/utils/markdown';
import { useEntityLabelsVersion } from '@/hooks/useEntityLabels';
import { timeAgo } from '@/utils/time';
import { applyBriefDecorations } from './org-brief-model';
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
}

export function OrgBrief({ owner, tasks, name, onOpenTask, now, folded }: Props) {
  const brief = owner?.brief;
  const labels = useEntityLabelsVersion();
  const states = useMemo(() => new Map(tasks.map((t) => [t.id, userStateOf(t)] as const)), [tasks]);
  // Each named task's section now, as one key: the letter is put in its sections again only when
  // one of them moves, never on any other task update.
  const sectionKey = useMemo(() => {
    const ids = brief?.text ? [...brief.text.matchAll(/<task-ref\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]!) : [];
    const byId = new Map(tasks.map((t) => [t.id, t] as const));
    return ids.map((id) => { const t = byId.get(id); return `${id}:${t ? briefSectionOf(t) ?? '-' : '?'}`; }).join('|');
  }, [brief?.text, tasks]);
  const text = useMemo(
    () => (brief?.text && owner ? structureBrief(brief.text, owner.id, tasks).text : brief?.text ?? ''),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [brief?.text, owner?.id, sectionKey],
  );
  // The letter's markup comes from its text alone; each pill's live status is set on it in place
  // below, so a task changing state rebuilds the letter only when it moves to another section.
  const markup = useMemo(
    () => (text ? renderMarkdownWithRefs(text) : ''),
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
  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('[data-task-id]');
    if (!a) return;
    e.preventDefault();
    onOpenTask(a.getAttribute('data-task-id')!);
  };

  if (!brief?.text || !html) {
    return (
      <div className="org-brief is-empty" data-testid="org-brief">
        <p className="org-muted">No brief yet. {name} writes one when its next turn ends.</p>
      </div>
    );
  }
  return (
    <div className={`org-brief${folded ? ' is-folded' : ''}`} data-testid="org-brief">
      <div ref={bodyRef} className="org-brief-body markdown-body" data-testid="org-brief-body" onClick={onClick} dangerouslySetInnerHTML={html} />
      <div className="org-brief-foot" data-testid="org-brief-foot">
        <span className="org-muted">Written {timeAgo(brief.at, { now })}</span>
      </div>
    </div>
  );
}

