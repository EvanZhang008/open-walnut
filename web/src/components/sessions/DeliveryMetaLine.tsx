/**
 * The delivery line under a just-sent message, on a phone (delivery-meta.ts
 * holds the rules). The desktop keeps its own badges: this renders nothing
 * outside phone layout.
 */
import { useEffect, useRef, useState } from 'react';
import { usePhoneLayout } from '@/hooks/usePhoneLayout';
import { ageOf, deliveryMeta, DELIVERED_FADE_AFTER_MS, STARTING_AFTER_MS, type DeliveryStatus } from './delivery-meta';

export function DeliveryMetaLine({ status, timestamp, turnRunning, onRetry }: {
  status: DeliveryStatus;
  timestamp?: string;
  turnRunning: boolean;
  onRetry?: () => void;
}) {
  const phone = usePhoneLayout();
  const [now, setNow] = useState(() => Date.now());
  const deliveredAt = useRef<number | null>(null);
  if (status === 'delivered' && deliveredAt.current === null) deliveredAt.current = Date.now();
  if (status !== 'delivered') deliveredAt.current = null;

  const age = ageOf(timestamp, now);
  // One timer to the next moment the line changes (5 s "starting", 2 s fade).
  useEffect(() => {
    if (!phone) return undefined;
    let wait: number | null = null;
    if ((status === 'pending' || status === 'received') && age < STARTING_AFTER_MS) wait = STARTING_AFTER_MS - age;
    if (status === 'delivered' && deliveredAt.current !== null) {
      const left = DELIVERED_FADE_AFTER_MS - (Date.now() - deliveredAt.current);
      if (left > 0) wait = left;
    }
    if (wait === null) return undefined;
    const t = setTimeout(() => setNow(Date.now()), wait + 20);
    return () => clearTimeout(t);
  }, [phone, status, age]);

  if (!phone) return null;
  const meta = deliveryMeta({
    status,
    turnRunning,
    ageMs: age,
    deliveredForMs: deliveredAt.current === null ? 0 : now - deliveredAt.current,
  });
  if (!meta) return null;
  if (meta.retry && onRetry) {
    return (
      <button type="button" className="session-delivery-meta is-failed" data-delivery={meta.kind} onClick={onRetry}>
        {meta.text}
      </button>
    );
  }
  return (
    <div
      className={`session-delivery-meta is-${meta.kind}${meta.fading ? ' is-fading' : ''}`}
      data-delivery={meta.kind}
      role="status"
    >
      {meta.text}
    </div>
  );
}
