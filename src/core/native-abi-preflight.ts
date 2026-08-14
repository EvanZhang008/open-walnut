/**
 * Native-module ABI preflight + self-heal.
 *
 * `better-sqlite3` is a classic (non-N-API) native addon: `npm install` compiles
 * it against exactly ONE Node ABI, stamped as NODE_MODULE_VERSION (Node 18→108,
 * 20→115, 22→127, 24→137). Any later runtime switch — a new mise/nvm install, an
 * edited version pin, the desktop launcher picking a newer Node — leaves the
 * compiled `.node` unloadable, and the first code to touch the task store dies
 * with a cryptic `task store prewarm failed; refusing to listen`.
 *
 * The brittle fix is to pin a Node version and require the pin, the compiled
 * artifact, CI, and every launcher to agree forever — a coupling that silently
 * rots the next time any one of them moves. Instead we detect the mismatch and
 * repair it in place (`npm rebuild`), the same self-heal pattern the daemon
 * version guard uses. The version pin then becomes advisory rather than
 * load-bearing: whatever Node you happen to run, the module adapts once.
 *
 * ⚠️ ADVISORY ONLY — never exits. A failed repair must leave the real error to
 * surface downstream, exactly like `verifyDaemonBinaryVersion()`. See the
 * "crash-looped a production server 41 times" note in daemon-version-check.ts.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { log } from '../logging/index.js';

/**
 * Native addons that must load before the server accepts traffic. Only
 * `better-sqlite3` today; keep the list so a second addon (node-pty) is a
 * one-line change rather than a rewrite.
 */
const NATIVE_MODULES = ['better-sqlite3'] as const;

/**
 * Marker the desktop launcher greps for to extend its startup deadline — a
 * from-source rebuild takes far longer than the normal "listening" wait.
 * Keep in sync with REBUILD_MARKER in desktop/main.swift.
 */
const REBUILD_MARKER = 'rebuilding native module';

type ProbeResult =
  | { ok: true }
  | { ok: false; abiMismatch: boolean; message: string };

/**
 * Load a native module for real. `better-sqlite3` resolves its `.node` lazily
 * (via `bindings`) on first Database construction, so a bare `require()` passes
 * even under a mismatched ABI — the probe MUST construct to trigger dlopen.
 */
function probe(moduleName: string): ProbeResult {
  try {
    const req = createRequire(import.meta.url);
    if (moduleName === 'better-sqlite3') {
      const Database = req('better-sqlite3') as new (p: string) => { close(): void };
      new Database(':memory:').close();
    } else {
      req(moduleName);
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as NodeJS.ErrnoException | null)?.code ?? '';
    // An ABI mismatch is repairable by recompiling. Anything else (missing file,
    // corrupt install, SQLITE_CANTOPEN) is not, and must not trigger a rebuild.
    const abiMismatch =
      /NODE_MODULE_VERSION/i.test(message) ||
      /compiled against a different Node\.js version/i.test(message) ||
      code === 'ERR_DLOPEN_FAILED';
    return { ok: false, abiMismatch, message };
  }
}

/** Repo root = the parent of the `node_modules` holding the module. */
function findRepoRoot(moduleName: string): string | null {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req.resolve(`${moduleName}/package.json`);
    const nodeModules = path.dirname(path.dirname(pkg));
    if (path.basename(nodeModules) !== 'node_modules') return null;
    return path.dirname(nodeModules);
  } catch {
    return null;
  }
}

/**
 * Drop a module (and the `bindings` resolver it uses) from the CJS cache so a
 * post-rebuild probe dlopens the freshly compiled file instead of reusing the
 * cached, broken lazy loader.
 */
function purgeFromCache(moduleName: string): void {
  try {
    const req = createRequire(import.meta.url);
    for (const key of Object.keys(req.cache)) {
      if (key.includes(moduleName) || key.includes(`${path.sep}bindings${path.sep}`)) {
        delete req.cache[key];
      }
    }
  } catch {
    /* best effort — a stale cache only costs us the re-probe's accuracy */
  }
}

/**
 * Verify every native addon loads under the running Node; recompile any whose
 * ABI has drifted.
 *
 * @returns `true` when all addons load (possibly after a repair). `false` means
 *          a load still fails — callers MUST NOT exit on that; the downstream
 *          error is more specific than anything we could raise here.
 */
export function ensureNativeModulesLoadable(): boolean {
  let allOk = true;

  for (const moduleName of NATIVE_MODULES) {
    const first = probe(moduleName);
    if (first.ok) continue;

    if (!first.abiMismatch) {
      // Not an ABI problem — rebuilding would waste a minute and fix nothing.
      log.web.error('native module failed to load (not an ABI mismatch — not rebuilding)', {
        module: moduleName,
        error: first.message,
      });
      allOk = false;
      continue;
    }

    const repoRoot = findRepoRoot(moduleName);
    log.web.warn('native module ABI mismatch — attempting in-place rebuild', {
      module: moduleName,
      nodeVersion: process.versions.node,
      abi: process.versions.modules,
      repoRoot: repoRoot ?? '(not found)',
      error: first.message,
    });

    if (!repoRoot) {
      // eslint-disable-next-line no-console
      console.error(
        `\n⚠️  ${moduleName} was compiled for a different Node ABI and the repo root`
        + `\n    could not be located, so it cannot be rebuilt automatically.`
        + `\n    Fix: npm rebuild ${moduleName}\n`,
      );
      allOk = false;
      continue;
    }

    // eslint-disable-next-line no-console
    console.error(
      `\n⏳ ${REBUILD_MARKER} ${moduleName} for Node ${process.versions.node}`
      + ` (NODE_MODULE_VERSION ${process.versions.modules})…`
      + `\n   Compiling from source — this can take a minute on first run.\n`,
    );

    const res = spawnSync('npm', ['rebuild', moduleName], {
      cwd: repoRoot,
      stdio: 'inherit',
      timeout: 300_000,
    });

    if (res.status !== 0) {
      const why = res.status === null
        ? 'timed out after 300s'
        : `exited ${res.status}`;
      log.web.error('native module rebuild failed — continuing; startup will likely fail', {
        module: moduleName,
        reason: why,
      });
      // eslint-disable-next-line no-console
      console.error(
        `\n⚠️  Rebuild of ${moduleName} ${why}.`
        + `\n    Common causes: no C++ toolchain (run: xcode-select --install), or`
        + `\n    node-gyp needs network access to fetch headers for this Node version.`
        + `\n    Workaround: run the server under the Node the module was built for.\n`,
      );
      allOk = false;
      continue;
    }

    purgeFromCache(moduleName);
    const after = probe(moduleName);
    if (after.ok) {
      log.web.info('native module rebuilt and now loads', {
        module: moduleName,
        nodeVersion: process.versions.node,
        abi: process.versions.modules,
      });
      // eslint-disable-next-line no-console
      console.error(`   ✓ ${moduleName} rebuilt for Node ${process.versions.node}. Continuing startup.\n`);
      continue;
    }

    log.web.error('native module still fails to load after rebuild', {
      module: moduleName,
      error: after.message,
    });
    allOk = false;
  }

  return allOk;
}
