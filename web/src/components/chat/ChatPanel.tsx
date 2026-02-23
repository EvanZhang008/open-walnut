import { useRef, useEffect, useLayoutEffect, useCallback, type ReactNode, type MutableRefObject } from 'react';

interface ChatPanelProps {
  children: ReactNode;
  /** Number of messages — used to detect prepends and preserve scroll position */
  messageCount?: number;
  /** Ref set to true by the caller right before prepending older messages.
   *  ChatPanel resets it after adjusting scroll. This distinguishes prepend
   *  from append so scroll adjustment only fires for "load older". */
  prependedRef?: MutableRefObject<boolean>;
}

export function ChatPanel({ children, messageCount, prependedRef }: ChatPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isNearBottom = useRef(true);
  const prevScrollHeight = useRef(0);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    // Consider "near bottom" if within 80px of the end
    isNearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  const scrollRaf = useRef<number | null>(null);

  // Cancel pending rAF on unmount
  useEffect(() => () => {
    if (scrollRaf.current !== null) cancelAnimationFrame(scrollRaf.current);
  }, []);

  // After DOM mutations: if older messages were prepended, adjust scroll
  // to keep the user's viewport stable (content above grows, push scroll down).
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    if (prependedRef?.current && prevScrollHeight.current > 0) {
      const added = el.scrollHeight - prevScrollHeight.current;
      if (added > 0) {
        el.scrollTop += added;
      }
      prependedRef.current = false;
    }

    prevScrollHeight.current = el.scrollHeight;
  }, [messageCount, prependedRef]);

  // Auto-scroll to bottom when new messages arrive and user is near the end
  useEffect(() => {
    if (isNearBottom.current) {
      if (scrollRaf.current !== null) cancelAnimationFrame(scrollRaf.current);
      scrollRaf.current = requestAnimationFrame(() => {
        scrollRaf.current = null;
        const el = containerRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
  }, [children]);

  return (
    <div className="chat-panel" ref={containerRef} onScroll={handleScroll}>
      {children}
    </div>
  );
}
