/**
 * `bun scripts/components/build.ts --write` never changes the bytes of a
 * version already pinned (scripts/components/pins.ts): a published asset is what
 * every Walnut that pinned it downloads.
 */
import { describe, it, expect } from 'vitest';
import { repinProblems } from '../../scripts/components/pins.js';
import { COMPONENTS_MANIFEST } from '../../src/core/components/manifest-data.js';
import type { ComponentsManifest } from '../../src/core/components/types.js';

const clone = () => structuredClone(COMPONENTS_MANIFEST) as ComponentsManifest;
const someImagesPlatform = () => Object.keys(COMPONENTS_MANIFEST.components.images.platforms)[0] as keyof ComponentsManifest['components']['images']['platforms'];

describe('repinProblems', () => {
  it('passes the same pins, a new platform, and a new version', () => {
    expect(repinProblems(COMPONENTS_MANIFEST, clone())).toEqual([]);
    const added = clone();
    const p = someImagesPlatform();
    const only = { [p]: added.components.images.platforms[p] };
    const pinned = clone();
    pinned.components.images.platforms = only;
    expect(repinProblems(pinned, added)).toEqual([]);
    const bumped = clone();
    bumped.components.images.version = `${bumped.components.images.version}9`;
    bumped.components.images.platforms[p]!.tarSha256 = 'f'.repeat(64);
    expect(repinProblems(COMPONENTS_MANIFEST, bumped)).toEqual([]);
  });

  it('names a changed tar under a version already pinned', () => {
    const next = clone();
    const p = someImagesPlatform();
    next.components.images.platforms[p]!.tarSha256 = 'f'.repeat(64);
    const problems = repinProblems(COMPONENTS_MANIFEST, next);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`images ${COMPONENTS_MANIFEST.components.images.version} ${p}`);
  });
});
