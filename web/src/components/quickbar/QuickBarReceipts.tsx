/**
 * The receipts after a send (useQuickReceipts.ts): a notice card (NoticeCard) per message, newest at the bottom,
 * that says where it stands in words and, once it came, the reply's first line. Click opens the
 * whole reply with "Open chat"; a message that never went out offers "Put it back". Each has its ×.
 */
import { CORNER_ORDER, CornerSlot } from '@/components/common/corner-stack';
import { NoticeCard, type NoticeTone } from '@/components/common/NoticeCard';
import { AgentText } from '@/components/common/AgentText';
import { staysUntilDismissed, type Receipt } from './useQuickReceipts';

interface ReceiptsProps {
  receipts: Receipt[];
  /** Over the page: the cards go into the window's one notice stack (bottom left), with every other notice. */
  floating?: boolean;
  onOpenChat: (r: Receipt) => void;
  onPutBack: (r: Receipt) => void;
  /** Send the words again as they were (a failed or held send). */
  onResend: (id: string) => void;
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

/** The tone of a receipt's dot: on its way (live), replied (ok), never sent (warn), muted otherwise. */
export function receiptTone(r: Pick<Receipt, 'state'>): NoticeTone {
  switch (r.state) {
    case 'sending': case 'sent': case 'delivered': case 'thinking': return 'live';
    case 'replied': return 'ok';
    case 'held': case 'failed': return 'warn';
    case 'lost': return 'muted';
  }
}

export function QuickBarReceipts({ receipts, floating, onOpenChat, onPutBack, onResend, onToggle, onDismiss, onPin }: ReceiptsProps) {
  if (receipts.length === 0) return null;
  const list = (
    <div className="qb-receipts" aria-live="polite">
      {/* Newest nearest the corner (the bottom), as every notice in the stack. */}
      {[...receipts].reverse().map((r) => {
        const line = r.reply ? firstLine(r.reply) : '';
        return (
          <NoticeCard
            key={r.id}
            className={`qb-receipt qb-receipt-${r.state}${r.open ? ' qb-receipt-open' : ''}`}
            data={{ state: r.state }}
            onMouseEnter={() => onPin(r.id, true)}
            onMouseLeave={() => onPin(r.id, false)}
            avatar={{ person: r.person }}
            who={r.person.title}
            status={{ tone: receiptTone(r), text: receiptStatus(r) }}
            // Open, the reply shows whole below: the line then says what was sent.
            line={r.open ? `You: ${r.text}` : line || r.text}
            onOpen={() => onToggle(r.id)}
            onClose={() => onDismiss(r.id)}
            expanded={!!r.open}
            parts={{ open: 'qb-receipt-head', who: 'qb-receipt-who', status: 'qb-receipt-status', line: `qb-receipt-line${r.open ? ' qb-receipt-said' : ''}`, body: 'qb-receipt-more' }}
          >
            {r.open && (
              <>
                {r.reply && <AgentText text={r.reply} className="qb-receipt-reply" {...(r.sessionId ? { sessionId: r.sessionId } : { unknownSource: true })} compact />}
                <div className="qb-receipt-actions">
                  {staysUntilDismissed(r) && <button type="button" className="btn btn-sm btn-primary" onClick={() => onResend(r.id)}>Send again</button>}
                  {staysUntilDismissed(r) && <button type="button" className="btn btn-sm" onClick={() => onPutBack(r)}>Put it back</button>}
                  {r.taskId && <button type="button" className="btn btn-sm" onClick={() => onOpenChat(r)}>Open chat</button>}
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => onDismiss(r.id)}>Dismiss</button>
                </div>
              </>
            )}
          </NoticeCard>
        );
      })}
    </div>
  );
  // Over the page, the cards go where every notice goes: the one corner stack at the bottom left.
  return floating ? <CornerSlot order={CORNER_ORDER.receipts} className="corner-slot-receipts">{list}</CornerSlot> : list;
}
