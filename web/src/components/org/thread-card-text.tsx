/**
 * The words on a thread card (OrgThreads.tsx): the node's answer as its chat shows it and his own
 * words, each folded to a few lines with the rest one click away. Moved out of OrgThreads.tsx whole.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { useCutOff } from '@/hooks/useCutOff';
import { RichMarkdown } from '@/components/chat/RichBlocks';
import { DisclosureButton } from '@/components/controls';
import { AgentText } from '@/components/common/AgentText';
import { MessageAbout, rowAbout } from '@/components/sessions/message-about';
import { stripTurnMarker } from '@/utils/turn-end-marker';
import { stripQuestionTag } from '@/utils/question-tag';
import { useEntityClickHandler } from '@/hooks/useEntityClickHandler';
import { useAgentFileOpener } from '@/hooks/useAgentFileOpener';
import type { AgentTextSource } from '@/utils/agent-text-source';
import type { OrgThreadMessage } from '@/api/org-threads';
import { THREAD_WORDS_SOURCE } from './thread-text-source';

/** A clock time today, a date and time before: when an answer came, the way a chat shows it. */
function clock(at: string, now: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return new Date(now).toDateString() === d.toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

/**
 * Long words fold to a few lines. The toggle sits on the text itself, at its left, and a click on
 * the folded text opens it too (a link or a pill inside still does its own thing).
 */
function Fold({ children, className, testId }: { children: React.ReactNode; className: string; testId: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [whole, setWhole] = useState(false);
  const long = useCutOff(box, { whole, slack: 4 });
  const folded = long && !whole;
  return (
    <>
      <div
        ref={box}
        className={`org-thread-fold ${className}${whole ? ' is-whole' : ''}${folded ? ' is-folded' : ''}`}
        data-testid={testId}
        onClick={folded ? (e) => {
          // A link, a picture, a pill, a disclosure or a selection keeps its own click.
          if ((e.target as HTMLElement).closest('a, button, img, summary, details, input, [data-source], [data-lightbox-src]')) return;
          if (window.getSelection()?.isCollapsed === false) return;
          setWhole(true);
        } : undefined}
      >
        {children}
      </div>
      {(long || whole) && (
        <DisclosureButton expanded={whole} className="org-thread-toggle" data-testid={`${testId}-more`} onClick={() => setWhole(!whole)}>
          {whole ? 'Collapse' : 'Expand'}
        </DisclosureButton>
      )}
    </>
  );
}

/**
 * The node's answer as its chat shows it, folded to a few lines with the rest one click away. A
 * path or a picture in it is its writer's (`source`): this block opens and loads from that machine
 * itself and keeps the click, so nothing around it opens the same link a second time.
 */
export function Answer({ text, about, at, by, known, now, testId = 'org-thread-answer', re, source }: {
  text: string; about?: string[]; at: string; by: string; known: boolean; now: number; testId?: string;
  /** His words it answers, one line, on a card (the conversation shows them in full instead). */
  re?: string;
  /** Who wrote these words (./thread-text-source.ts); unknownSource when Walnut did not record it. */
  source: AgentTextSource;
}) {
  const body = useMemo(() => stripTurnMarker(stripQuestionTag(text)), [text]);
  const ids = useMemo(() => rowAbout(about, text), [about, text]);
  // Its own opener: the session record is read on a click, never on mount; a lookup still in
  // flight is dropped when the source changes or the block unmounts (useAgentFileOpener).
  const file = useAgentFileOpener(source);
  // An unknown writer refuses a relative path too, as AgentText does (never a search of every host).
  const onEntityClick = useEntityClickHandler(undefined, file.onFileOpen, file.fileHost, file.fileSessionId, file.refusesAll);
  const onClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    onEntityClick(e);
    // Handled here: the list around it must not handle the same link again.
    if ((e.target as HTMLElement).closest('a')) e.stopPropagation();
  }, [onEntityClick]);
  return (
    <div className={`org-thread-answer${known ? '' : ' is-news'}`} data-testid={testId} data-known={known ? 'true' : 'false'} data-text-source={sourceAttr(source)}>
      {/* New to him: a dot before who wrote it, never a coloured guide line (2026-11-20). */}
      <div className="org-thread-answer-by" data-tone={known ? undefined : 'live'}>{!known && <span className="wn-dot" aria-hidden="true" />}{by} · {clock(at, now)}</div>
      {re && <div className="org-thread-re" data-testid="org-thread-re">{re}</div>}
      <Fold className="org-thread-answer-body" testId="org-thread-answer-body">
        <RichMarkdown text={body} cwd={file.render.cwd} host={file.render.host} inlineImages={file.render.images} onClick={onClick} />
      </Fold>
      {ids.length > 0 && <MessageAbout ids={ids} />}
    </div>
  );
}

/** For tests and logs: which kind of writer a block names ('host', 'session' or 'unknown'). */
function sourceAttr(s: AgentTextSource): string {
  return s.unknownSource ? 'unknown' : s.host !== undefined ? 'host' : 'session';
}

export function Words({ m }: { m: OrgThreadMessage }) {
  // Pictures render as the chat renders them: a path on its own line becomes the image. His words
  // and pictures are his own, on this machine (the primary), whatever host the node runs on.
  const text = [m.text, ...(m.images ?? [])].filter(Boolean).join('\n\n');
  return (
    <Fold className="org-thread-words-fold" testId="org-thread-words">
      <AgentText text={text} className="org-thread-words" {...THREAD_WORDS_SOURCE} />
    </Fold>
  );
}
