/**
 * Voice-process ratchet: an isolated server starts no speech process and opens
 * no recording (src/core/stt/voice-here.ts). 2026-11-05: an isolated test server
 * whose data home was a task directory started the speech daemon on the Mac,
 * because only the model download asked whether the server was isolated; every
 * path that ran the engines, adopted the warm daemon on the shared port or
 * opened the microphone did not.
 *
 * Over the TypeScript AST of src/core/stt/*.ts and src/core/audio-*.ts:
 *
 *  1. Every call that starts a process (spawn, spawnSync, exec, execSync,
 *     execFile, execFileSync, fork from node:child_process, under any local name,
 *     destructured, or through promisify; a call on a child_process namespace;
 *     Bun.spawn; the installers' runStreaming; a dynamic import or require of
 *     child_process)
 *     is either preceded by a gate call (assertVoiceHere or voiceOffHere) in its
 *     own function, or listed in EXEMPT with why and how many calls it holds.
 *  2. Every engine's isAvailable() asks the gate, so a server that runs no
 *     voice says so, with the opt-in, instead of probing an install.
 *  3. The paths that load a model, adopt a daemon, record or start a boot job
 *     without a process call of their own (ENTRY_POINTS) ask the gate.
 *
 *  4. The words only voice code carries (VOICE_MARKERS) appear nowhere else in src/.
 *
 * What it cannot see: a process started outside these files on a voice path
 * with none of those words, and a gate call whose answer is ignored
 * (tests/core/stt-voice-here.test.ts checks the behaviour). Adding a site fails with instructions: gate it, or say
 * here why it runs no voice. Removing one: delete its entry.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const repoRoot = path.resolve(__dirname, '../..');

/** Every .ts file under `dir` (relative to the repo), subdirectories included. */
function tsFilesUnder(dir: string): string[] {
  return fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? tsFilesUnder(`${dir}/${e.name}`) : e.name.endsWith('.ts') ? [`${dir}/${e.name}`] : []);
}

const FILES = [
  ...tsFilesUnder('src/core/stt'),
  ...fs.readdirSync(path.join(repoRoot, 'src/core')).filter((f) => /^audio-.*\.ts$/.test(f)).map((f) => `src/core/${f}`),
].sort();

/**
 * Words only code that runs or records voice carries. Outside the scanned files
 * they mean a voice path the ratchet does not see: move it here, or scan it.
 */
const VOICE_MARKERS = ['avfoundation', 'PYTHON_STDIN_SCRIPT', 'llamaServerPath', 'verifyPermissions', 'getAudioApps', 'OfflineRecognizer'];

const GATES = new Set(['assertVoiceHere', 'voiceOffHere']);

/** `<file>#<function>` → how many process calls it holds, and why they run no voice. */
const EXEMPT: Record<string, { calls: number; why: string }> = {
  'src/core/stt/audio-convert.ts#probeFfmpeg': { calls: 1, why: 'ffmpeg -version: finds ffmpeg, converts nothing' },
  'src/core/stt/audio-convert.ts#convertToWav': { calls: 1, why: 'converts audio a request brought; ffmpeg loads no model and records nothing' },
  'src/core/stt/detect.ts#whichBinary': { calls: 1, why: 'detection: which' },
  'src/core/stt/detect.ts#getVersion': { calls: 1, why: 'detection: <binary> --version, which loads no model' },
  'src/core/stt/detect.ts#detectUv': { calls: 1, why: 'detection: uv --version' },
  'src/core/stt/engine-whisper-server.ts#resolveBinary': { calls: 1, why: 'which: finds the binary, runs nothing of it (isAvailable asks the gate first)' },
  'src/core/stt/engine-whisper-cpp.ts#resolveBinary': { calls: 1, why: 'which: finds the binary, runs nothing of it (isAvailable asks the gate first)' },
  'src/core/stt/setup-stream.ts#runStreaming': { calls: 1, why: 'the installers\' runner: an install runs on the auto-setup decision (auto-setup.ts) or a person\'s Install press' },
  'src/core/stt/setup.ts#installViaBrew': { calls: 3, why: 'installer: brew, run by a person\'s Install press in Settings' },
  'src/core/stt/setup-mlx.ts#pythonImportsMlxAudio': { calls: 1, why: 'install and detection check: Python imports mlx_audio and exits, loading no model' },
  'src/core/stt/setup-mlx.ts#which': { calls: 1, why: 'detection: which' },
  'src/core/stt/setup-mlx.ts#appleShimUsable': { calls: 1, why: 'detection: xcode-select -p' },
  'src/core/stt/setup-mlx.ts#pythonVersion': { calls: 1, why: 'detection: python --version' },
  'src/core/stt/setup-mlx.ts#setupMlxEnvInner': { calls: 2, why: 'installer: makes the Python env (the auto-setup decision or a person\'s Install press)' },
  'src/core/stt/setup-mlx.ts#downloadMlxModelInner': { calls: 1, why: 'installer: downloads the model files, loads none (the auto-setup decision or a person\'s Install press)' },
};

/** Engines whose isAvailable() need not ask the gate. */
const ENGINE_EXEMPT: Record<string, string> = {
  'src/core/stt/engine-openai.ts': 'a hosted API: no local process, no model, no microphone',
  'src/core/stt/engine-qwen.ts': 'its own isAvailable is the no-runtime branch, never available and starting nothing; the other branches return the mlx and llama engines',
};

/** Functions that run voice without a process call of their own, each of which must ask the gate. */
const ENTRY_POINTS = [
  'src/core/stt/engine-mlx.ts#createMlxEngine.startServer',          // adopts the warm daemon on the shared port
  'src/core/stt/engine-llama.ts#createLlamaEngine.start',            // adopts llama-server on its port
  'src/core/stt/engine-llama.ts#createLlamaEngine.transcribeSerial', // converts a take before it reaches start
  'src/core/stt/cleanup-mlx.ts#startDaemon',                         // adopts or retires the cleanup daemon
  'src/core/stt/engine-sherpa.ts#getRecognizer',                     // loads the model into this process
  'src/core/stt/engine-sherpa.ts#createSherpaEngine.transcribe',
  'src/core/stt/index.ts#prewarmSttEngines',                         // boot job: stt.prewarm_on_start
  'src/core/stt/voice-archive-transcribe.ts#liveRole',               // takes a take's live pieces for the local engine
  'src/core/audio-capture.ts#AudioCaptureService.start',             // records system audio and the microphone
  'src/core/audio-capture.ts#AudioCaptureService.resume',            // boot job: resumes a recording from the data home's state file
  'src/core/audio-transcriber.ts#initAudioTranscriber',              // boot job: transcribes recorded chunks
];

const CHILD_PROCESS = new Set(['node:child_process', 'child_process']);
const SPAWN_NAMES = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);

type FnNode = ts.FunctionLikeDeclaration;

interface Parsed {
  src: ts.SourceFile;
  /** `<file>#<chain>` → the function node. */
  functions: Map<string, FnNode>;
}

function nameOf(node: ts.Node, src: ts.SourceFile): string | undefined {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isClassDeclaration(node)) && node.name) return node.name.getText(src);
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.parent
    && (ts.isVariableDeclaration(node.parent) || ts.isPropertyAssignment(node.parent))) return node.parent.name.getText(src);
  return undefined;
}

/** The named functions (and classes) around `node`, outermost first. */
function chainOf(node: ts.Node, src: ts.SourceFile): string {
  const names: string[] = [];
  for (let p = node.parent; p; p = p.parent) {
    const name = nameOf(p, src);
    if (name) names.unshift(name);
  }
  return names.join('.') || '<module>';
}

/** The innermost named function around `node`. */
function scopeOf(node: ts.Node, src: ts.SourceFile): FnNode | undefined {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isFunctionLike(p) && nameOf(p, src) && (p as FnNode).body) return p as FnNode;
  }
  return undefined;
}

function parse(rel: string): Parsed {
  const src = ts.createSourceFile(rel, fs.readFileSync(path.join(repoRoot, rel), 'utf8'), ts.ScriptTarget.Latest, true);
  const functions = new Map<string, FnNode>();
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionLike(n) && (n as FnNode).body) {
      const name = nameOf(n, src);
      if (name) {
        const outer = chainOf(n, src);
        functions.set(`${rel}#${outer === '<module>' ? name : `${outer}.${name}`}`, n as FnNode);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return { src, functions };
}

/** Gate calls in `fn`'s own body (not in a function nested in it), by position. */
function gatePositions(fn: FnNode): number[] {
  const out: number[] = [];
  const visit = (n: ts.Node): void => {
    if (n !== fn && ts.isFunctionLike(n)) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && GATES.has(n.expression.text)) out.push(n.getStart());
    ts.forEachChild(n, visit);
  };
  visit(fn);
  return out;
}

const isChildProcessSpecifier = (n: ts.Node | undefined): boolean => !!n && ts.isStringLiteral(n) && CHILD_PROCESS.has(n.text);

/** `import('node:child_process')`, `await import(...)` or `require('child_process')`. */
function isChildProcessModule(n: ts.Expression): boolean {
  const e = ts.isAwaitExpression(n) ? n.expression : n;
  if (!ts.isCallExpression(e)) return false;
  return (e.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(e.expression) && e.expression.text === 'require'))
    && isChildProcessSpecifier(e.arguments[0]);
}

/** `promisify(x)` or `util.promisify(x)`. */
function promisified(n: ts.Expression): ts.Expression | undefined {
  if (!ts.isCallExpression(n)) return undefined;
  const callee = n.expression;
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
  return name === 'promisify' ? n.arguments[0] : undefined;
}

/** Every call in `src` that starts a process. */
function processCalls(src: ts.SourceFile): ts.CallExpression[] {
  const spawners = new Set<string>();
  const namespaces = new Set<string>();
  for (const st of src.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const from = st.moduleSpecifier.text;
    const clause = st.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const named = clause.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : [];
    if (CHILD_PROCESS.has(from)) {
      if (clause.name) namespaces.add(clause.name.text);
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) namespaces.add(clause.namedBindings.name.text);
      for (const el of named) if (!el.isTypeOnly && SPAWN_NAMES.has((el.propertyName ?? el.name).text)) spawners.add(el.name.text);
    }
    if (from === './setup-stream.js') for (const el of named) if ((el.propertyName ?? el.name).text === 'runStreaming') spawners.add(el.name.text);
  }
  // `const execFileAsync = promisify(execFile)`, `const cp = await import('node:child_process')`,
  // `const { spawn } = cp` and the like, until no new name turns up.
  const aliases = (n: ts.Node): boolean => {
    let grew = false;
    if (ts.isVariableDeclaration(n) && n.initializer) {
      const init = n.initializer;
      if (ts.isIdentifier(n.name)) {
        const inner = promisified(init);
        const name = n.name.text;
        if (inner && ts.isIdentifier(inner) && spawners.has(inner.text) && !spawners.has(name)) { spawners.add(name); grew = true; }
        if (inner && ts.isPropertyAccessExpression(inner) && ts.isIdentifier(inner.expression) && namespaces.has(inner.expression.text)
          && SPAWN_NAMES.has(inner.name.text) && !spawners.has(name)) { spawners.add(name); grew = true; }
        if (isChildProcessModule(init) && !namespaces.has(name)) { namespaces.add(name); grew = true; }
      } else if (ts.isObjectBindingPattern(n.name)
        && (isChildProcessModule(init) || (ts.isIdentifier(init) && namespaces.has(init.text)))) {
        for (const el of n.name.elements) {
          const prop = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : '';
          if (ts.isIdentifier(el.name) && SPAWN_NAMES.has(prop) && !spawners.has(el.name.text)) { spawners.add(el.name.text); grew = true; }
        }
      }
    }
    ts.forEachChild(n, (c) => { if (aliases(c)) grew = true; });
    return grew;
  };
  while (aliases(src)) { /* until no new alias */ }
  const out: ts.CallExpression[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      const childProcessArg = isChildProcessSpecifier(n.arguments[0]);
      if ((ts.isIdentifier(e) && spawners.has(e.text))
        || (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)
          && (namespaces.has(e.expression.text) || (e.expression.text === 'Bun' && e.name.text.startsWith('spawn'))))
        || (e.kind === ts.SyntaxKind.ImportKeyword && childProcessArg)
        || (ts.isIdentifier(e) && e.text === 'require' && childProcessArg)) {
        out.push(n);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return out;
}

const parsed = new Map(FILES.map((rel) => [rel, parse(rel)]));
const fn = (key: string): FnNode | undefined => parsed.get(key.split('#')[0])?.functions.get(key);

describe('voice-process ratchet', () => {
  it('the scanner finds every way of starting a process', () => {
    const code = [
      "import { spawn as run, execFile, type ChildProcess } from 'node:child_process';",
      "import * as cp from 'child_process';",
      "import util from 'node:util';",
      "import { runStreaming } from './setup-stream.js';",
      'const execAsync = util.promisify(execFile);',
      'const viaNs = util.promisify(cp.execFile);',
      'const { fork, spawnSync: s2 } = cp;',
      'async function f() {',
      "  run('a'); execFile('b'); execAsync('c'); viaNs('d'); cp.exec('e'); fork('g'); s2('h');",
      "  Bun.spawn(['i']); runStreaming('j');",
      "  const late = await import('node:child_process'); late.execSync('k');",
      "  const { execFileSync } = require('child_process'); execFileSync('l');",
      "  await import('node:child_process'); require('child_process');",
      '}',
    ].join('\n');
    const src = ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true);
    expect(processCalls(src).map((c) => c.getText(src))).toEqual([
      "run('a')", "execFile('b')", "execAsync('c')", "viaNs('d')", "cp.exec('e')", "fork('g')", "s2('h')",
      "Bun.spawn(['i'])", "runStreaming('j')",
      "import('node:child_process')", "late.execSync('k')",
      "require('child_process')", "execFileSync('l')",
      "import('node:child_process')", "require('child_process')",
    ]);
  });

  it('scans the voice code', () => {
    expect(FILES).toContain('src/core/stt/engine-mlx.ts');
    expect(FILES).toContain('src/core/audio-capture.ts');
    expect(FILES).toContain('src/core/stt/voice-here.ts');
  });

  it('every process call asks the voice gate first, or is listed as running no voice', () => {
    const unguarded: string[] = [];
    const exemptSeen = new Map<string, number>();
    let gated = 0;
    for (const [rel, { src }] of parsed) {
      for (const call of processCalls(src)) {
        const key = `${rel}#${chainOf(call, src)}`;
        const line = src.getLineAndCharacterOfPosition(call.getStart()).line + 1;
        if (EXEMPT[key]) { exemptSeen.set(key, (exemptSeen.get(key) ?? 0) + 1); continue; }
        const scope = scopeOf(call, src);
        if (scope && gatePositions(scope).some((pos) => pos < call.getStart())) { gated++; continue; }
        unguarded.push(`${rel}:${line} ${call.expression.getText(src)}(...) in ${key}`);
      }
    }
    expect(unguarded, [
      'A process call on a voice path that does not ask src/core/stt/voice-here.ts first.',
      'Call assertVoiceHere() (or check voiceOffHere()) in the same function before it, so an isolated',
      'server starts, adopts and records nothing; if it runs no voice (detection, an installer), add it',
      'to EXEMPT in this file with why.',
    ].join('\n')).toEqual([]);
    const counts = Object.fromEntries(Object.keys(EXEMPT).map((k) => [k, exemptSeen.get(k) ?? 0]));
    expect(counts, 'EXEMPT counts must match the source: lower or remove an entry whose calls went away, and never raise one to fit a voice process').toEqual(
      Object.fromEntries(Object.entries(EXEMPT).map(([k, v]) => [k, v.calls])),
    );
    // The gated sites this rule exists for are still found (a scanner that sees nothing passes nothing).
    expect(gated).toBeGreaterThanOrEqual(11);
  });

  it('every engine says it is not available on a server that runs no voice', () => {
    const missing: string[] = [];
    const engines: string[] = [];
    for (const [rel, { src, functions }] of parsed) {
      if (!/\/engine-[^/]+\.ts$/.test(rel)) continue;
      engines.push(rel);
      if (ENGINE_EXEMPT[rel]) continue;
      const checks = [...functions].filter(([key]) => key.endsWith('.isAvailable'));
      if (checks.length === 0) missing.push(`${rel}: no isAvailable found`);
      for (const [key, node] of checks) if (gatePositions(node).length === 0) missing.push(`${key} (${src.fileName})`);
    }
    expect(engines.length).toBeGreaterThanOrEqual(7);
    expect(missing, 'An engine whose isAvailable() does not ask voiceOffHere(): answer { available: false, error } with its reason first').toEqual([]);
    for (const rel of Object.keys(ENGINE_EXEMPT)) expect(parsed.has(rel), `${rel} is listed in ENGINE_EXEMPT but gone`).toBe(true);
  });

  it.each(ENTRY_POINTS)('%s asks the voice gate', (key) => {
    const node = fn(key);
    expect(node, `${key} is not in the source any more: update ENTRY_POINTS`).toBeDefined();
    expect(gatePositions(node!).length, `${key} must call assertVoiceHere() or voiceOffHere()`).toBeGreaterThan(0);
  });

  it('no file outside the scanned ones carries the words of voice code', () => {
    const scanned = new Set(FILES);
    const found: string[] = [];
    for (const rel of tsFilesUnder('src')) {
      if (scanned.has(rel)) continue;
      const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      for (const word of VOICE_MARKERS) if (text.includes(word)) found.push(`${rel}: ${word}`);
    }
    expect(found, 'Voice code outside src/core/stt and src/core/audio-*.ts: gate it through voice-here.ts and add its file to FILES').toEqual([]);
  });

  it('the gate reads the same isolation rule as the model install', () => {
    const autoSetup = fn('src/core/stt/auto-setup.ts#isIsolatedServer');
    expect(autoSetup?.getText(parsed.get('src/core/stt/auto-setup.ts')!.src)).toContain('isolatedHere()');
  });
});
