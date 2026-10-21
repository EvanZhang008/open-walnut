import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { Plugin } from 'vite';

export function pdfAssets(): Plugin {
  const require = createRequire(import.meta.url);
  const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
  const assets = new Map<string, string>();
  for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
    for (const name of fs.readdirSync(path.join(root, dir))) {
      const file = path.join(root, dir, name);
      if (fs.statSync(file).isFile()) assets.set(`pdf-assets/${version}/${dir}/${name}`, file);
    }
  }
  return {
    name: 'pdf-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const file = assets.get((req.url ?? '').split('?')[0].replace(/^\//, ''));
        if (!file) return next();
        res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
        const stream = fs.createReadStream(file);
        stream.on('error', next);
        stream.pipe(res);
      });
    },
    generateBundle() {
      for (const [fileName, file] of assets) this.emitFile({ type: 'asset', fileName, source: fs.readFileSync(file) });
    },
  };
}
