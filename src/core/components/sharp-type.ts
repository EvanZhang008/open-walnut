/**
 * The type of sharp's main export, the one name every caller uses for it.
 *
 * sharp 0.34 declares `export = sharp` and 0.35 `export default sharp`; a default
 * type import (with esModuleInterop) means the function under both, while
 * `typeof import('sharp')` is the module under one and `.default` exists under the
 * other only. A checkout whose node_modules still holds the older sharp then fails
 * its type check on code that is right for the lockfile (2026-11-15).
 * tests/core/components/sharp-type-ratchet.test.ts keeps every caller on this.
 */
import type sharp from 'sharp';

export type SharpFn = typeof sharp;
