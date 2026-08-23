/**
 * Shared render path for assistant text that may contain `<suggest>` cards.
 *
 * Extracted from ChatMessage so the SESSION timeline gets the same cards the
 * Personal AI chat has: whoever wrote the card, the same parser reads it, clicks
 * go to the same `/api/v1/actions/invoke`, and receipts land in the same
 * localStorage store. Three consumers, one behaviour — a second copy would drift.
 *
 * Rendering is deliberately independent of who was TAUGHT the syntax. Nothing
 * here assumes the author had the contract in its prompt: a coding session that
 * picked the syntax up on demand, or a replayed old message, renders identically.
 *
 * Two rules this module exists to keep in ONE place:
 *
 * 1. A card is a SIBLING of the markdown around it, never HTML inside it. Only a
 *    real component can hold per-button running/confirming/receipt state, and
 *    DOMPurify would otherwise reduce the card to loose prose ("Put to Focus
 *    Ignore") — silently wrong rather than visibly broken.
 * 2. The flip from "plain html" to "segments" happens MID-STREAM, the moment a
 *    card's closing tag lands. React cannot turn a dangerouslySetInnerHTML node
 *    into a children node in place, so the two branches carry distinct keys and
 *    the host remounts instead.
 *
 * Streaming is safe by construction: splitSuggestSegments hides an unterminated
 * card to end-of-text, so a growing message renders its prose and NO card until
 * the closer arrives. Callers only have to re-run the split as the text grows,
 * which the hook does (memoized on the text, so a settled message parses once).
 *
 * That hiding is only real if the caller renders SEGMENTS. Handing the raw string
 * to the markdown renderer instead throws it away: DOMPurify drops the unknown
 * `<suggest>`/`<action>` tags but KEEPS the text between them, so a half-arrived
 * card leaked its body ("It looks stale — put it in Focus?") into the answer as a
 * stray line, which then vanished when the closer landed and the real card
 * replaced it. Hence `needsSegments`, which is true for BOTH reasons.
 */
import { useMemo } from 'react';
import { renderMarkdownWithRefs } from '@/utils/markdown';
import { SuggestCard } from './SuggestCard';
import {
  splitSuggestSegments, hasCardSegment, needsSegments, type SuggestSegment,
} from '@/utils/suggest-parse';

/**
 * Split `text` once per change, and say how it must be rendered.
 *
 * `useSegments` is the answer the caller needs: true when the segment list is the
 * only faithful render (a card to mount, or a hidden region the raw-string path
 * would leak). False keeps the cheap `renderMarkdownWithRefs(text)` fast path,
 * which is the overwhelmingly common case.
 *
 * `scope` is the stable per-message id that keys the card's receipt — see
 * splitSuggestSegments. Pass the same value live and after a reload, or none.
 */
export function useSuggestSegments(text: string, scope?: string): {
  segments: SuggestSegment[];
  hasCard: boolean;
  useSegments: boolean;
} {
  const segments = useMemo(() => splitSuggestSegments(text, scope), [text, scope]);
  return { segments, hasCard: hasCardSegment(segments), useSegments: needsSegments(segments, text) };
}

/** Ordered markdown runs + `<suggest>` action cards. */
export function SuggestSegments({ segments, cwd, onClick }: {
  segments: SuggestSegment[];
  /** Session cwd, so relative file paths in the prose stay clickable. */
  cwd?: string;
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
}) {
  return (
    <>
      {segments.map((seg, i) => seg.kind === 'card' ? (
        <SuggestCard key={`${seg.card.id}-${i}`} card={seg.card} onContentClick={onClick} />
      ) : (
        <div
          key={i}
          className="markdown-body"
          onClick={onClick}
          dangerouslySetInnerHTML={{ __html: renderMarkdownWithRefs(seg.text, cwd) }}
        />
      ))}
    </>
  );
}
