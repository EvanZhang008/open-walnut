/**
 * Which pairing address the Phones & Cloud picker falls back to and which one a
 * re-pair QR carries. Pure, so the choices are unit-tested
 * (tests/web/pair-targets.test.ts) apart from the React section.
 *
 * A phone paired through ANY address learns the others by itself, so these only
 * pick the address that goes in the QR: the one reachable from the most places.
 */
import type { PairTargetKind } from './usePairDevice';

/** Best-first: cloud works off any network, a tailnet wherever both ends run it, Wi-Fi at home. */
const REACH_ORDER: readonly PairTargetKind[] = ['cloud', 'tailnet', 'lan'];

/**
 * The picker's pick when its current one is not offered (this network is the
 * first pick whenever it is): the address that works from the most places.
 */
export function bestOfferedKind(offered: readonly PairTargetKind[]): PairTargetKind {
  return REACH_ORDER.find((k) => offered.includes(k)) ?? offered[0] ?? 'lan';
}

/**
 * Which address a re-pair QR carries. Cloud when the phone already holds a cloud
 * credential, else the tailnet when this machine offers one, else this network.
 * A tailnet pairing is minted on this machine like a Wi-Fi one, so re-pairing
 * through it rotates the same local credential.
 */
export function preferredKind(rowKinds: readonly PairTargetKind[], offered: readonly PairTargetKind[]): PairTargetKind {
  if (rowKinds.includes('cloud')) return 'cloud';
  if (offered.includes('tailnet')) return 'tailnet';
  return 'lan';
}

