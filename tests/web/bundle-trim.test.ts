/**
 * The web build leaves out code Walnut never reaches (web/bundle-trim.ts). Rollup keeps every
 * module it reads in memory, so a package pulled in and never used still costs the build its heap:
 * the drawing editor's lazy Mermaid import (about 1,600 modules) ran Node out of memory at the 2 GB
 * heap of a 7 GB CI machine, and its chunks took the published package past 200 MB.
 *
 * Each case is enumerated from the installed packages, so an editor upgrade that adds another
 * route to Mermaid, a new translation file, or a chart kind pptx-preview starts drawing fails here.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ECHARTS_SLIM, LOCALE_STUB, MERMAID_STUB, trimTarget } from '../../web/bundle-trim';

const root = path.resolve(import.meta.dirname, '../..');
const web = path.join(root, 'web');
const modules = path.join(web, 'node_modules');
const editorDist = path.join(modules, '@excalidraw/excalidraw/dist/prod');
const editorEntry = path.join(editorDist, 'index.js');
const read = (file: string) => fs.readFileSync(file, 'utf8');

function jsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const file = path.join(dir, e.name);
    return e.isDirectory() ? jsFiles(file) : e.name.endsWith('.js') ? [file] : [];
  });
}

/** Static and dynamic import specifiers of a built (minified) ES module. */
function specifiers(code: string): string[] {
  const out = new Set<string>();
  for (const m of code.matchAll(/\bfrom\s*"([^"]+)"|\bimport\s*\(\s*"([^"]+)"\s*\)|\bimport\s*"([^"]+)"/g)) out.add(m[1] ?? m[2] ?? m[3]);
  return [...out];
}

const packageName = (spec: string) => spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/');

/** Whether a package's installed dependency tree reaches `target`. */
function reaches(pkg: string, target: string, seen = new Set<string>()): boolean {
  if (pkg === target) return true;
  if (seen.has(pkg)) return false;
  seen.add(pkg);
  const manifest = path.join(modules, pkg, 'package.json');
  if (!fs.existsSync(manifest)) return false;
  const deps = Object.keys((JSON.parse(read(manifest)) as { dependencies?: Record<string, string> }).dependencies ?? {});
  return deps.some((d) => reaches(d, target, seen));
}

describe('web bundle trim', () => {
  it('the web build uses the trim plugin', () => {
    expect(read(path.join(web, 'vite.config.ts'))).toMatch(/plugins:\s*\[\s*bundleTrim\(\)/);
  });

  it('every import of the drawing editor that leads to Mermaid goes to the stub', () => {
    const toMermaid: string[] = [];
    for (const file of jsFiles(editorDist)) {
      for (const spec of specifiers(read(file))) {
        if (spec.startsWith('.') || !reaches(packageName(spec), 'mermaid')) continue;
        toMermaid.push(spec);
        expect(trimTarget(spec, file), `${spec} (imported by ${path.relative(editorDist, file)}) reaches mermaid`).toBe(MERMAID_STUB);
      }
    }
    // The enumeration itself still finds the known route.
    expect(toMermaid).toContain('@excalidraw/mermaid-to-excalidraw');
  });

  it('Walnut code never imports Mermaid itself', () => {
    const own = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const file = path.join(dir, e.name);
      return e.isDirectory() ? own(file) : /\.(ts|tsx)$/.test(e.name) ? [file] : [];
    });
    const importsMermaid = /(?:from\s*|import\s*\(\s*|import\s+)['"](?:mermaid|@mermaid-js\/[^'"]+|@excalidraw\/mermaid-to-excalidraw)(?:\/[^'"]*)?['"]/;
    expect(own(path.join(web, 'src')).filter((f) => importsMermaid.test(read(f))).map((f) => path.relative(root, f))).toEqual([]);
  });

  it('the editor keeps only its English translation', () => {
    const locales = specifiers(read(editorEntry)).filter((s) => s.startsWith('./locales/'));
    expect(locales.length).toBeGreaterThan(40);
    const kept = locales.filter((s) => trimTarget(s, editorEntry) !== LOCALE_STUB);
    expect(kept).toEqual([expect.stringMatching(/^\.\/locales\/en-[A-Z0-9]{8}\.js$/)]);
    // Walnut never chooses another language, so the files left out are never asked for.
    expect(read(path.join(web, 'src/components/drawing/ExcalidrawCanvas.tsx'))).not.toMatch(/\blangCode\b/);
  });

  it("the editor's Mermaid dialog entry is hidden and its AI is off", () => {
    const code = read(editorEntry);
    const menu = code.indexOf('App-toolbar__extra-tools-dropdown');
    const laser = code.indexOf('"data-testid":"toolbar-laser"', menu);
    const mermaid = code.indexOf('setOpenDialog({name:"ttd",tab:"mermaid"})', laser);
    expect(menu).toBeGreaterThan(-1);
    expect(laser).toBeGreaterThan(menu);
    // The Mermaid entry is in the same menu, after the laser pointer: what the CSS rule hides.
    expect(mermaid).toBeGreaterThan(laser);
    expect(mermaid - laser).toBeLessThan(1000);
    expect(read(path.join(web, 'src/components/drawing/drawing-workspace.css')))
      .toContain('.drawing-canvas-host .App-toolbar__extra-tools-dropdown [data-testid="toolbar-laser"] ~ * { display: none; }');
    expect(read(path.join(web, 'src/components/drawing/ExcalidrawCanvas.tsx'))).toContain('aiEnabled={false}');
  });

  it("pptx-preview's echarts is the slim entry, and it registers every chart part pptx-preview uses", () => {
    const pptx = path.join(modules, 'pptx-preview/dist/pptx-preview.es.js');
    const code = read(pptx);
    expect(specifiers(code)).toContain('echarts');
    expect(trimTarget('echarts', pptx)).toBe(ECHARTS_SLIM);
    expect(trimTarget('echarts', path.join(web, 'src/App.tsx'))).toBeNull();

    const slim = read(ECHARTS_SLIM);
    const names = (dir: string) => fs.readdirSync(path.join(modules, 'echarts/lib', dir)).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3));
    const charts = names('chart').filter((c) => new RegExp(`type:"${c}"`).test(code));
    expect(charts.sort()).toEqual(['bar', 'line', 'pie']);
    for (const c of charts) expect(slim).toContain(`import 'echarts/lib/chart/${c}.js';`);
    // Option keys pptx-preview sets ({title:..., legend:...}); axes need the grid.
    const components = names('component').filter((c) => new RegExp(`[{,]${c}:`).test(code));
    expect(components.length).toBeGreaterThan(0);
    for (const c of [...components, 'grid']) expect(slim).toContain(`import 'echarts/lib/component/${c}.js';`);
    expect(code).toContain('renderer:"svg"');
    expect(slim).toMatch(/use\(\[SVGRenderer\]\)/);
  });
});
