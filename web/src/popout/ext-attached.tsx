/**
 * What a message took from the page, drawn in the person's bubble (UserRowAttachmentsContext): the
 * page it went with, and the text it took from the page, quoted. Known by the panel for a message
 * it just sent (by its context id, or by its words for a conversation's first question), else read
 * back from the context the message carried (pageContextBlock).
 */
import type { ReactNode } from 'react';
import { OBJECT_CONTEXT_HINT } from '@/components/chat/ask-object-session';
import type { UserRowHints } from '@/components/sessions/user-row-attachments';
import { pageOfContext, selectionOfContext } from './ext-panel-model';

/** `page`: the page went with the message; `from`: the page a selection alone was taken from. */
export interface Attached { page?: { title: string; host: string }; sel?: string; from?: string }

export function attachedView(row: UserRowHints, byId: ReadonlyMap<string, Attached>, byWords: ReadonlyMap<string, Attached>): ReactNode {
  const id = row.requestedHints?.[OBJECT_CONTEXT_HINT]?.arg;
  const hint = row.hints?.find((h) => h.kind === OBJECT_CONTEXT_HINT)?.text;
  const known = (id ? byId.get(id) : undefined)
    ?? (!id && !row.hints?.length && row.text ? byWords.get(row.text.trim()) : undefined);
  const sel = known?.sel || selectionOfContext(hint);
  const named = known ? null : pageOfContext(hint);
  // A page chip only for a page that went; a selection alone names its page in its caption.
  const pg = known ? known.page : named?.sent ? named : undefined;
  const from = known ? known.from : named && !named.sent ? named.title : undefined;
  if (!sel && !pg) return null;
  const site = pg?.host; // the page's web address, never a Walnut host
  return <>
    {pg && <span className="ext-panel-attached-page" data-testid="ext-panel-attached-page"><span aria-hidden="true">▤</span> {pg.title} · {site}</span>}
    {sel && <figure className="ext-panel-attached" data-testid="ext-panel-attached">
      <figcaption>{!pg && from ? `From ${from}` : 'From the page'}</figcaption>
      <blockquote>{sel}</blockquote>
    </figure>}
  </>;
}
