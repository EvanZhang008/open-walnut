/**
 * A sender or recipient as a person reads it, where an address breaks as a unit: after its "@"
 * and nowhere else unless one half is longer than the line. The text is unchanged (a <wbr> adds
 * no character). 2026-11-22 review: "noreply@longmeadowgardensupply.org" in a list row wrapped
 * its lone ".org" to the next line under the subject, so the row read out of order.
 */
import { Fragment } from 'react';

const BARE_ADDRESS = /^[^\s@]+@[^\s@]+$/;

/** The label split where it may break: an address at its "@", anything else whole. */
export function addressParts(label: string): string[] {
  if (!BARE_ADDRESS.test(label)) return [label];
  const at = label.indexOf('@') + 1;
  return [label.slice(0, at), label.slice(at)];
}

export function AddressWords({ text }: { text: string }) {
  const parts = addressParts(text);
  return <>{parts.map((p, i) => <Fragment key={i}>{i > 0 && <wbr />}{p}</Fragment>)}</>;
}
