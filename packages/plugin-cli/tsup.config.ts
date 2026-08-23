import { defineConfig, type Options } from 'tsup'

/**
 * Two builds, because the shebang banner is per-build and must land ONLY in the
 * bin entry: a `#!/usr/bin/env node` line at the top of `dist/index.js` would be
 * shipped to every library consumer that imports this package.
 *
 * Neither build cleans: tsup runs an array of configs with `Promise.all`, so a
 * `clean: true` on one of them races the other's output files. The package
 * `build` script removes `dist` once, before tsup starts.
 */
const shared: Options = {
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  splitting: false,
  sourcemap: false,
  clean: false,
}

export default defineConfig([
  {
    ...shared,
    entry: { cli: 'src/cli.ts' },
    banner: { js: '#!/usr/bin/env node' },
    // The bin is not importable (`exports` has no deep paths), so its types
    // would never be read. Skipping them also keeps the two parallel builds from
    // sharing a declaration chunk.
    dts: false,
  },
  {
    ...shared,
    entry: { index: 'src/index.ts' },
    dts: true,
  },
])
