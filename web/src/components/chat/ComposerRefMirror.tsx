/**
 * Draws the composer's `@[Title]` reference tokens as task pills.
 *
 * The box is still a plain textarea (caret, IME, undo, paste and selection are
 * the browser's), so a token is text: `@[Fix the login bug]`. This overlay lies on
 * top of the textarea, click-through, and repeats the SAME text in the SAME font
 * and wrap, so every glyph lands on the glyph it repeats. While it is mounted the
 * textarea's own text is transparent (`.has-ref-tokens`), so the overlay's text
 * is the only one seen; the textarea keeps the caret and the selection highlight
 * underneath it. A token's characters stay where they are (never a different
 * width), only painted differently: the `@[` becomes the task's status dot, the
 * `]` is blank, and the label sits on a tinted pill.
 *
 * Nothing here changes what is typed or sent. It mounts only while the box holds
 * a token, so an ordinary composer never pays for it.
 */
import { useLayoutEffect, useRef, type RefObject } from 'react';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import { useSessionStatusEpoch } from '@/hooks/useSessionStatus';
import { sessionStatusStore } from '@/stores/session-status-store';
import { resolveTaskSessionId } from '@/utils/session-status';
import { taskRunState, type MentionRunState } from './mention-entities';
import type { MirrorPiece } from './composer-refs';

/** Everything that decides where a glyph falls, read off the textarea so each
 *  surface's own size and padding (session column, dock, one-line composer) is
 *  followed without this file knowing them. */
const MIRRORED_PROPS = [
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch',
  'font-feature-settings', 'font-kerning', 'font-variant-ligatures',
  'letter-spacing', 'word-spacing', 'line-height', 'text-transform', 'text-indent',
  'tab-size', 'text-rendering', 'word-break', 'overflow-wrap',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
] as const;

export interface ComposerRefMirrorProps {
  pieces: MirrorPiece[];
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  disabled?: boolean;
}

export function ComposerRefMirror({ pieces, textareaRef, disabled }: ComposerRefMirrorProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const tasksCtx = useTasksContextSafe();
  // A task that starts or stops running while a token sits in the box moves its dot.
  useSessionStatusEpoch();

  useLayoutEffect(() => {
    const ta = textareaRef.current;
    const el = rootRef.current;
    if (!ta || !el) return;
    const sync = () => {
      const cs = getComputedStyle(ta);
      for (const prop of MIRRORED_PROPS) el.style.setProperty(prop, cs.getPropertyValue(prop));
      // A classic scrollbar takes width from the textarea's lines; the overlay
      // has none, so it gives up the same width or its lines would wrap later.
      const gutter = Math.max(0, ta.offsetWidth - ta.clientWidth
        - (parseFloat(cs.borderLeftWidth) || 0) - (parseFloat(cs.borderRightWidth) || 0));
      el.style.paddingRight = `calc(${cs.paddingRight} + ${gutter}px)`;
      el.scrollTop = ta.scrollTop;
    };
    sync();
    const onScroll = () => { el.scrollTop = ta.scrollTop; };
    ta.addEventListener('scroll', onScroll, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync);
    ro?.observe(ta);
    return () => {
      ta.removeEventListener('scroll', onScroll);
      ro?.disconnect();
    };
  }, [textareaRef]);

  // The text under the caret can scroll the textarea in the same commit that
  // changes the text, before its scroll event has run.
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    const el = rootRef.current;
    if (ta && el) el.scrollTop = ta.scrollTop;
  });

  const stateOf = (kind: string, id: string): MentionRunState => {
    if (kind !== 'task') return 'idle';
    const task = tasksCtx?.tasks.find((t) => t.id === id);
    if (!task) return 'idle';
    return taskRunState(task, sessionStatusStore.getStatus(resolveTaskSessionId(task)));
  };

  return (
    <div
      ref={rootRef}
      className={`chat-input-mirror${disabled ? ' is-disabled' : ''}`}
      aria-hidden="true"
      data-testid="composer-ref-mirror"
    >
      {pieces.map((p, i) => p.ref ? (
        <span
          key={i}
          className={`chat-ref-token is-${stateOf(p.ref.kind, p.ref.id)}`}
          data-ref-kind={p.ref.kind}
          data-ref-id={p.ref.id}
        >
          <span className="chat-ref-edge chat-ref-open">@[</span>
          {p.text.slice(2, -1)}
          <span className="chat-ref-edge">]</span>
        </span>
      ) : (
        <span key={i}>{p.text}</span>
      ))}
      {'\u200b'}
    </div>
  );
}
