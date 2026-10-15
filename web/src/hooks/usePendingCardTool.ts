/**
 * The tool of the first prompt card the session's timeline draws unanswered
 * (`[data-prompt-pending="true"]`, PromptCards.tsx), or null. The phone's bar
 * subtitle reads it so "Stopped" never sits over a card that waits for the
 * user (N2-10): the timeline and the bar say the same thing.
 */
import { useEffect, useState } from 'react';

export function readPendingCardTool(root: ParentNode | null): string | null {
  const card = root?.querySelector<HTMLElement>('[data-prompt-pending="true"]');
  if (!card) return null;
  return card.dataset.promptTool?.trim() || 'a prompt';
}

/** The timeline says the session is gone (SessionChatHistory, N2-34). */
export function readSessionGone(root: ParentNode | null): boolean {
  return !!root?.querySelector('[data-session-gone="true"]');
}

export function usePendingCardTool(sessionId: string, active: boolean): { tool: string | null; gone: boolean } {
  const [tool, setTool] = useState<{ tool: string | null; gone: boolean }>({ tool: null, gone: false });
  useEffect(() => {
    if (!active) { setTool({ tool: null, gone: false }); return undefined; }
    const find = () => document.querySelector(`.session-panel[data-session-id="${CSS.escape(sessionId)}"]`);
    let raf = 0;
    const read = () => {
      raf = 0;
      const root = find();
      const next = { tool: readPendingCardTool(root), gone: readSessionGone(root) };
      setTool((prev) => (prev.tool === next.tool && prev.gone === next.gone ? prev : next));
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(read); };
    const mo = new MutationObserver(schedule);
    // The panel may mount after this effect: watch the body, filtered by the rAF read.
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-prompt-pending'] });
    schedule();
    return () => { mo.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, [sessionId, active]);
  return tool;
}
