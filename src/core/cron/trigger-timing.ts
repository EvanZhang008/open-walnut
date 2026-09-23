/**
 * How late a trigger delivery was, in the words both the envelope (what the
 * model reads) and the History row (what the human reads) use. Pure and
 * import-free, because the web bundle imports it too: the two surfaces must
 * never round the same wait to two different numbers.
 */

/**
 * Past this gap between a fire (the oldest, for a backlog) and the moment its
 * delivery started, the delivery is called late. An ordinary delivery is
 * seconds; one that needed replays can cross it, and then it IS late.
 */
export const LATE_DELIVERY_MS = 5 * 60_000;

/** "12m" / "43h" / "3d". */
export function describeSpan(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}
