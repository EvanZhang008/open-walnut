import fs from 'node:fs'
import path from 'node:path'
import { WALNUT_INSTALL_DIR } from '../../constants.js'

export interface PluginSourceTree {
  /** `<root>/src/integrations` of a source checkout, or null when none is reachable. */
  srcIntegrationsDir: string | null;
  /** Where the bundle is written, so Node's resolver walks up into a real node_modules. */
  nodeModulesRoot: string;
}

/**
 * Where an external plugin's parent-relative imports (`../../core/x.js`) should land.
 *
 * The running code is not always next to a `src/` tree: a production deploy runs a
 * STAGED copy of dist/ on the temp volume (scripts/dev-prod.sh), which has no source at
 * all. The stage carries a `.walnut-source-root` marker naming the checkout it was built
 * from, and that is the first place to look; the loader used to derive the source tree
 * from its own location, fall back to `dist/integrations` (tsup bundles everything, so
 * no `dist/core/*.js` exists) and fail every import, which read as "no valid entry point".
 * Each candidate is validated by the one thing the bundler needs from it.
 */
export function resolvePluginSourceTree(
  packageRoot: string,
  installDir: string | null = WALNUT_INSTALL_DIR,
): PluginSourceTree {
  const candidates: string[] = [];
  try {
    const marker = fs.readFileSync(path.join(packageRoot, '.walnut-source-root'), 'utf8').trim();
    if (marker) candidates.push(marker);
  } catch { /* no marker: not a staged deploy */ }
  if (installDir) candidates.push(installDir);
  candidates.push(packageRoot);
  for (const root of candidates) {
    const srcIntegrationsDir = path.join(root, 'src', 'integrations');
    try {
      if (fs.statSync(srcIntegrationsDir).isDirectory()) return { srcIntegrationsDir, nodeModulesRoot: packageRoot };
    } catch { /* candidate has no source tree, try the next */ }
  }
  return { srcIntegrationsDir: null, nodeModulesRoot: packageRoot };
}
