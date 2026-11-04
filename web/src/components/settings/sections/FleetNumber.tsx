/**
 * One number on the fleet Overview (a card's sessions or spend, a summary tile). With no
 * number it shows "?" and, always beside it, why in words (host-fleet-dashboard-model.ts
 * says why): a bare "?" told the user nothing (2026-11-04: "why sesison is ?"). This is the
 * one place the Overview may draw "?" (tests/web/host-fleet-unknown-ratchet.test.ts).
 */
import type { Unknown } from './host-fleet-dashboard-model';

export const UNKNOWN_MARK = '?';

export function FleetNumber({ value, unknown, className }: { value: string | number | null; unknown: Unknown | null; className: string }) {
  if (value !== null && !unknown) return <span className={className} data-num="known">{value}</span>;
  const why = unknown?.why ?? 'not known';
  return (
    <>
      <span className={className} data-num="unknown" title={unknown?.title}>{UNKNOWN_MARK}</span>
      <span className="hf-why" data-testid="host-fleet-why">{why}</span>
    </>
  );
}
