/**
 * Ask router: under the reader's route line, the way to talk to the router about this one mail (why
 * it went where it went, or where it should go instead). It opens the same Talk to box as the
 * toolbar's Talk to CEO (CeoComposer), addressed to the router of the mail's area, with the mail and
 * the router's decision attached (mail-content-item.ts); the person can still pick the CEO or a VP
 * in its To row. Shown only when the mail's area has a router of its own to ask.
 */
import { useEffect, useState } from 'react';
import type { MailMessageDto } from '@/api/mail';
import { closeCeoComposer, fetchContentTargets, openCeoComposer, routerOfArea } from '@/utils/content-actions';
import { mailContentItem } from './mail-content-item';

export function MailAskRouter({ message, bodyText }: { message: MailMessageDto; bodyText: string | null }) {
  const areaId = message.route?.areaId || message.routingArea?.id || '';
  const [hasRouter, setHasRouter] = useState(false);
  const [writing, setWriting] = useState(false);
  useEffect(() => {
    if (!areaId) return undefined;
    let live = true;
    void fetchContentTargets().then((list) => { if (live) setHasRouter(!!routerOfArea(list, areaId)); });
    return () => { live = false; };
  }, [areaId]);
  if (!areaId || !hasRouter) return null;
  return (
    <div className="mail-route-foot mail-ask-router" data-testid="mail-reader-ask-router-row">
      <button
        type="button"
        className="mail-router-link"
        data-testid="mail-reader-ask-router"
        title="Ask the router about this mail: why it went here, or where it should go"
        aria-haspopup="dialog"
        aria-expanded={writing}
        onClick={(event) => {
          event.stopPropagation();
          // A second press closes the box, as the toolbar's Talk to CEO does.
          if (writing) { closeCeoComposer(); return; }
          const r = event.currentTarget.getBoundingClientRect();
          setWriting(true);
          void openCeoComposer(mailContentItem(message, bodyText), { x: r.left, y: r.bottom }, event.currentTarget, { areaId })
            .catch(() => { /* no app shell */ })
            .finally(() => setWriting(false));
        }}
      >
        Ask the router about this mail
      </button>
    </div>
  );
}
