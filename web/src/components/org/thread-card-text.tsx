/**
 * The words on a thread card (OrgThreads.tsx): its summary, whole (CardWords); the node's answer as
 * its chat shows it and his own words, each folded to a few lines with the rest one click away
 * (common/TextFold.tsx). A long path or address in any of them reads as a short name, the whole
 * one its tooltip (utils/short-link-labels.ts; tests/web/thread-card-words-guard.test.ts).
 */
import { useCallback, useMemo, type ReactNode } from 'react';
import { RichMarkdown } from '@/components/chat/RichBlocks';
import { TextFold } from '@/components/common/TextFold';
import { AgentText } from '@/components/common/AgentText';
import { MessageAbout, rowAbout } from '@/components/sessions/message-about';
import { stripTurnMarker } from '@/utils/turn-end-marker';
import { stripQuestionTag } from '@/utils/question-tag';
import { useEntityClickHandler } from '@/hooks/useEntityClickHandler';
import { useAgentFileOpener } from '@/hooks/useAgentFileOpener';
import type { AgentTextSource } from '@/utils/agent-text-source';
import type { OrgThreadMessage } from '@/api/org-threads';
import { clockTime, pointInTime } from '@/utils/time';
import { THREAD_WORDS_SOURCE } from './thread-text-source';

/** A clock time today, a day and time before: when an answer came, the way a chat shows it. */
function clock(at: string, now: number): string {
  const words = pointInTime(at, { now });
  return words.startsWith('today ') ? clockTime(at) : words;
}

/** Long words fold to a few lines, the toggle under them at the left (org-threads.css cuts them). */
function Fold({ children, className, testId }: { children: ReactNode; className: string; testId: string }) {
  return <TextFold className={`org-thread-fold ${className}`} testId={testId} toggleClassName="org-thread-toggle">{children}</TextFold>;
}

/**
 * A card's own words (the node's summary, Walnut's stand-in for it, a held ask's question and
 * reply), shown whole: never a line clamp and never a fold (2026-11-20, the user: "the threa over
 * here shoud show all , not just 2 line only the one show on top"). A long path or address in them
 * reads short (shortLinks), which is what keeps a long card short (2026-11-22, UI audit). Every
 * card body goes through here (tests/web/thread-card-words-guard.test.ts).
 */
export function CardWords({ children, testId, className = '', data }: {
  children: ReactNode; testId: string; className?: string; data?: Record<`data-${string}`, string | undefined>;
}) {
  return <div className={`org-thread-summary${className ? ` ${className}` : ''}`} data-testid={testId} {...data}>{children}</div>;
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
        <RichMarkdown text={body} shortLinks cwd={file.render.cwd} host={file.render.host} inlineImages={file.render.images} onClick={onClick} />
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
      <AgentText text={text} className="org-thread-words" shortLinks {...THREAD_WORDS_SOURCE} />
    </Fold>
  );
}
