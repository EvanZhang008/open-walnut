import { useState } from 'react';
import { copyTextRobust } from '@/utils/clipboard';
import type { InboxItemPlan } from '@/api/human-inbox-items';

export function ItemOperationDetails({ plan, previous }: { plan: InboxItemPlan; previous?: InboxItemPlan }) {
  const [copied, setCopied] = useState('');
  const text = JSON.stringify({ source: plan.source, taskId: plan.taskId, input: plan.input,
    messageId: plan.messageId, idempotencyKey: plan.idempotencyKey, launch: plan.launch,
    ops: plan.ops, planId: plan.id, version: plan.version,
    ...(previous ? { previousLaunch: previous.launch } : {}) }, null, 2);
  return <details className="hii-operation-details">
    <summary>Operation details</summary>
    <pre tabIndex={0}>{text}</pre>
    <button type="button" className="hib-row-btn" onClick={() => {
      void copyTextRobust(text).then(result => setCopied(result === 'failed' ? 'Could not copy. Select the source text instead.' : 'Copied'));
    }}>Copy operation details</button>
    {copied && <p>{copied}</p>}
  </details>;
}
