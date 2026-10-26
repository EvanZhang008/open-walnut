/**
 * The first module the compiled Walnut file evaluates (src/binary/main.ts
 * imports it before anything else, and it imports nothing of Walnut's that
 * reads a path).
 *
 * Walnut reads many of its own files from disk: express.static serves the web
 * app, skills and hook templates come from src/data, plugin manifests from
 * dist/integrations, daemon sidecars are uploaded to hosts. The file carries
 * them as one archive (asset-archive.ts) and unpacks it once per build into
 *
 *   <OPEN_WALNUT_HOME or ~/.open-walnut>/local/runtime/<version>-<hash>/
 *
 * (`local/` never syncs; WALNUT_RUNTIME_DIR replaces `.../local/runtime`), laid out
 * like an installed package: package.json, dist/data, dist/web/static, ... The
 * build defines `import.meta.url` as `globalThis.__WALNUT_BUNDLE_URL__`, set
 * here to `<root>/dist/cli.js`, which is where a tsup build would put the code,
 * so every resolver that walks up from its bundle finds the same tree.
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ASSETS_ARCHIVE, ASSETS_ID, DAEMON_VERSION } from 'walnut-binary:assets'
import { BUNDLED_MODULES } from './bundled-modules.js'
import { ensureRuntime } from './runtime-tree.js'
import { fileIdentity, setSingleFile } from '../lib/single-file.js'

export const runtimeRoot = ensureRuntime(ASSETS_ARCHIVE, ASSETS_ID)
;(globalThis as Record<string, unknown>).__WALNUT_BUNDLE_URL__ = pathToFileURL(path.join(runtimeRoot, 'dist', 'cli.js')).href
// The file as it is now, before an update can replace it (execFileReplaced).
setSingleFile({ root: runtimeRoot, daemonVersion: DAEMON_VERSION, modules: BUNDLED_MODULES, execId: fileIdentity(process.execPath) })
