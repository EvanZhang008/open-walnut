/**
 * The receipts after a send (useQuickReceipts.ts): a small card per message, newest on top,
 * that says where it stands in words and, once it came, the reply's first line. Click opens the
 * whole reply with "Open chat"; a message that never went out offers "Put it back".
 */
import { createPortal } from 'react-dom';
import { staysUntilDismissed, type Receipt } from './useQuickReceipts';
import { PersonAvatar } from './PersonAvatar';

interface ReceiptsProps {
  receipts: Receipt[];
  /** Over the page: the cards float in the top right corner, portalled to <body> (the glass blurs only there). */
  floating?: boolean;
  onOpenChat: (r: Receipt) => void;
  onPutBack: (r: Receipt) => void;
  onToggle: (id: string) => void;
  onDismiss: (id: string) => void;
  onPin: (id: string, on: boolean) => void;
}

/** The status words of a receipt, as the person reads them. */
export function receiptStatus(r: Receipt): string {
  switch (r.state) {
    case 'sending': return 'Sending…';
    case 'sent': return r.started ? 'Sent · starting its session' : 'Sent · in its queue';
    case 'delivered': return 'Delivered';
    case 'thinking': return r.reply ? 'Replying…' : r.activity ? `Working · ${r.activity}` : 'Thinking…';
    case 'replied': return r.unfinished ? 'Still working · the rest is in its chat' : 'Replied';
    case 'held': return 'Not sent · it waits on your answer in its chat';
    case 'failed': return `Not sent · ${r.error ?? 'try again'}`;
    case 'lost': return `Sent · ${r.error ?? 'the reply is in its chat'}`;
  }
}

function firstLine(text: string): string {
  return text.replace(/[#*_`>]+/g, '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
}

export function QuickBarReceipts({ receipts, floating, onOpenChat, onPutBack, onToggle, onDismiss, onPin }: ReceiptsProps) {
  if (receipts.length === 0) return null;
  const list = (
    <div className="qb-receipts" aria-live="polite">
      {receipts.map((r) => {
        const live = r.state === 'sending' || r.state === 'sent' || r.state === 'delivered' || r.state === 'thinking';
        const bad = staysUntilDismissed(r);
        const line = r.reply ? firstLine(r.reply) : '';
        return (
          <div
            key={r.id}
            className={`qb-receipt wn-glass qb-receipt-${r.state}${r.open ? ' qb-receipt-open' : ''}`}
            data-state={r.state}
            onMouseEnter={() => onPin(r.id, true)}
            onMouseLeave={() => onPin(r.id, false)}
          >
            <button type="button" className="qb-receipt-head" onClick={() => onToggle(r.id)} aria-expanded={!!r.open}>
              <PersonAvatar person={r.person} size={22} />
              <span className="qb-receipt-body">
                <span className="qb-receipt-top">
                  <span className="qb-receipt-who">{r.person.title}</span>
                  <span className={`qb-receipt-status${live ? ' qb-receipt-live' : ''}${bad ? ' qb-receipt-bad' : ''}`}>
                    {live && <span className="qb-dot" />}
                    {receiptStatus(r)}
                  </span>
                </span>
                {/* Open, the reply shows whole below: the line then says what was sent. */}
                <span className={`qb-receipt-line${r.open ? ' qb-receipt-said' : ''}`}>{r.open ? `You: ${r.text}` : line || r.text}</span>
              </span>
            </button>
            {r.open && (
              <div className="qb-receipt-more">
                {r.reply && <div className="qb-receipt-reply">{r.reply}</div>}
                <div className="qb-receipt-actions">
                  {staysUntilDismissed(r) && <button type="button" className="qb-btn qb-btn-primary" onClick={() => onPutBack(r)}>Put it back</button>}
                  {r.taskId && <button type="button" className="qb-btn" onClick={() => onOpenChat(r)}>Open chat</button>}
                  <button type="button" className="qb-btn qb-btn-quiet" onClick={() => onDismiss(r.id)}>Dismiss</button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
  return floating ? createPortal(list, document.body) : list;
}
