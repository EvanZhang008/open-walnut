// Bundles the main process and the preload into out/ (Electron loads them from there).
import { build } from 'esbuild'

const common = { bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], sourcemap: false, logLevel: 'info' }
await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'out/main.js', external: ['electron', 'electron-updater'] })
await build({ ...common, entryPoints: ['src/preload.ts'], outfile: 'out/preload.js' })
