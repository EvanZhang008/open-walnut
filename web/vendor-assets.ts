import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { Plugin } from 'vite';

/**
 * A package's own runtime files (fonts, character maps, wasm) served under
 * `<prefix>/<version>/...` by the dev server and emitted into the build as they are, so the
 * page loads them from this Walnut and never from a CDN. The version in the path keeps an
 * open window's old files apart from a new build's.
 */
/**
 * The folder of an installed package. Node refuses `<pkg>/package.json` when the package's
 * "exports" do not list it (@excalidraw/excalidraw does not), so start from its main entry and
 * walk up to the package.json that names it.
 */
function packageRoot(require: NodeRequire, pkg: string): string {
  let dir = path.dirname(require.resolve(pkg));
  for (;;) {
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest) && (JSON.parse(fs.readFileSync(manifest, 'utf8')) as { name?: string }).name === pkg) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`Could not find the package.json of ${pkg}`);
    dir = parent;
  }
}

function packageAssets(name: string, pkg: string, prefix: string, dirs: string[]): { plugin: Plugin; version: string } {
  const require = createRequire(import.meta.url);
  const root = packageRoot(require, pkg);
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
  const assets = new Map<string, string>();
  const walk = (dir: string, rel: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file, `${rel}/${entry.name}`);
      else if (entry.isFile()) assets.set(`${prefix}/${version}/${rel}/${entry.name}`, file);
    }
  };
  for (const dir of dirs) walk(path.join(root, dir), dir.split('/').pop()!);
  const contentType = (file: string) => file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream';
  return {
    version,
    plugin: {
      name,
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          let name: string;
          try { name = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\//, ''); } catch { return next(); }
          const file = assets.get(name);
          if (!file) return next();
          res.setHeader('Content-Type', contentType(file));
          const stream = fs.createReadStream(file);
          stream.on('error', next);
          stream.pipe(res);
        });
      },
      generateBundle() {
        for (const [fileName, file] of assets) this.emitFile({ type: 'asset', fileName, source: fs.readFileSync(file) });
      },
    },
  };
}

export function pdfAssets(): Plugin {
  const { plugin } = packageAssets('pdf-assets', 'pdfjs-dist', 'pdf-assets', ['cmaps', 'standard_fonts', 'wasm']);
  return plugin;
}

/**
 * The drawing editor's fonts (about 13 MB, mostly the CJK hand-drawn font split by Unicode
 * range; a page loads only the ranges its text uses). `window.EXCALIDRAW_ASSET_PATH` points at
 * them (components/drawing/excalidraw-assets.ts, through `__EXCALIDRAW_ASSET_PATH__`), so the
 * editor never falls back to its CDN while they load.
 */
export function excalidrawAssets(): Plugin {
  const { plugin, version } = packageAssets('excalidraw-assets', '@excalidraw/excalidraw', 'excalidraw-assets', ['dist/prod/fonts']);
  return {
    ...plugin,
    config: () => ({ define: { __EXCALIDRAW_ASSET_PATH__: JSON.stringify(`/excalidraw-assets/${version}/`) } }),
  };
}
