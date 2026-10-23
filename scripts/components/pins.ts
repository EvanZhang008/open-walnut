/**
 * A published component is never replaced: an asset on a release is what every
 * Walnut that pinned it downloads, so the same version must always name the same
 * bytes. A recipe change ships as a new revision (`<package version>-<revision>`
 * in recipes.ts), never as new bytes under an old one.
 */

import { COMPONENT_NAMES, PLATFORMS, type ComponentsManifest } from '../../src/core/components/types.js';

/** Every pin `next` would change under a version `pinned` already has: empty when none. */
export function repinProblems(pinned: ComponentsManifest, next: ComponentsManifest): string[] {
  const problems: string[] = [];
  for (const name of COMPONENT_NAMES) {
    const was = pinned.components[name];
    const now = next.components[name];
    if (!was || !now || was.version !== now.version) continue;
    for (const platform of PLATFORMS) {
      const a = was.platforms[platform];
      const b = now.platforms[platform];
      if (!a || !b) continue;
      if (a.tarSha256 !== b.tarSha256 || a.tarSize !== b.tarSize || a.asset !== b.asset) {
        problems.push(`${name} ${now.version} ${platform}: pinned tar ${a.tarSha256} (${a.tarSize}), built ${b.tarSha256} (${b.tarSize})`);
      }
    }
  }
  return problems;
}
