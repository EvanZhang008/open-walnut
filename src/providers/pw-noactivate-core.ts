/**
 * No Playwright WebKit browser on a Mac ever becomes the frontmost app (2026-11-08: two
 * tasks' headless WebKit test browsers took the front from the person at the Mac 8 times in 8
 * seconds, and a Cmd+Q meant for another app quit one).
 *
 * A headless Playwright WebKit is an accessory app with off-screen windows, and macOS still
 * hands it the front when another app gives it up or asks for it (checked on a Mac by the system
 * log: launchservicesd's SETFRONT to the test browser, foreground=0, after
 * NSRunningApplication.activate). So the preload starts every WebKit browser it can on a Mac
 * through a small runner that loads PW_NOACTIVATE_M into it: every activation policy the browser
 * asks for becomes Prohibited (a background-only app, which macOS never brings to the front) and
 * its own requests to activate do nothing. Pages still render, take clicks and keys, and record.
 *
 * The library is compiled once per text with the Command Line Tools' clang (never through the
 * /usr/bin shim, which would put an install dialog on the person's screen), next to the preload,
 * and a launch that names its own executablePath, a non-Mac host and WALNUT_PW_ACTIVATE=1 are
 * left alone. Anything that fails leaves the launch as it was, with one warning.
 */

/** Loaded into the browser's UI process with DYLD_INSERT_LIBRARIES. */
export const PW_NOACTIVATE_M = [
  '#import <AppKit/AppKit.h>',
  '#import <objc/runtime.h>',
  'static IMP walnutSetPolicy;',
  'static BOOL walnutProhibited(id self, SEL cmd, NSApplicationActivationPolicy policy) {',
  '  return ((BOOL (*)(id, SEL, NSApplicationActivationPolicy))walnutSetPolicy)(self, cmd, NSApplicationActivationPolicyProhibited);',
  '}',
  'static void walnutNoActivate(id self, SEL cmd, BOOL flag) {}',
  'static void walnutNoActivateNow(id self, SEL cmd) {}',
  'static IMP walnutSwap(SEL sel, IMP imp) {',
  '  Method m = class_getInstanceMethod([NSApplication class], sel);',
  '  return m ? method_setImplementation(m, imp) : NULL;',
  '}',
  '__attribute__((constructor)) static void walnutQuietApp(void) {',
  '  walnutSetPolicy = walnutSwap(@selector(setActivationPolicy:), (IMP)walnutProhibited);',
  '  walnutSwap(@selector(activateIgnoringOtherApps:), (IMP)walnutNoActivate);',
  '  walnutSwap(NSSelectorFromString(@"activate"), (IMP)walnutNoActivateNow);',
  '  dispatch_async(dispatch_get_main_queue(), ^{ [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited]; });',
  '}',
  '',
].join('\n')

/** The preload's part: `quietWebkit(core)` points every WebKit launch of one library at the runner. */
export function pwNoActivatePreloadPart(): string {
  return [
    '// A Mac WebKit test browser never becomes the frontmost app (src/providers/pw-noactivate-core.ts).',
    'const NOACT_M = ' + JSON.stringify(PW_NOACTIVATE_M) + ';',
    "const QUIET = Symbol.for('walnut.pwSilence.noActivate');",
    'let noActWarned = false;',
    'function noActWarn(e) {',
    '  if (noActWarned) return;',
    '  noActWarned = true;',
    "  console.warn('[pw-silence-preload] a WebKit test browser may come to the front: ' + (e && e.message || e));",
    '}',
    '',
    '/** A clang and its macOS SDK from the Command Line Tools or Xcode, or null (never the /usr/bin shim: with no tools it shows an install dialog). */',
    'function clangPath() {',
    "  const fs = require('node:fs');",
    '  const tools = [',
    "    ['/Library/Developer/CommandLineTools/usr/bin/clang', '/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk'],",
    "    ['/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang', '/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk'],",
    '  ];',
    '  for (const t of tools) if (fs.existsSync(t[0]) && fs.existsSync(t[1])) return t;',
    '  return null;',
    '}',
    '',
    '/** A runner script that starts this WebKit build with the no-activation library loaded, or null. */',
    'function quietRunner(pwRun) {',
    "  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');",
    '  const dir = path.dirname(pwRun);',
    "  const app = path.join(dir, 'Playwright.app', 'Contents', 'MacOS', 'Playwright');",
    '  if (!fs.existsSync(app)) return null;',
    "  const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);",
    "  let base = path.join(path.dirname(__filename), 'pw-noactivate');",
    "  try { fs.mkdirSync(base, { recursive: true }); fs.accessSync(base, fs.constants.W_OK); } catch (e) {",
    "    base = path.join(os.tmpdir(), 'walnut-pw-noactivate-' + process.getuid());",
    '    fs.mkdirSync(base, { recursive: true, mode: 0o700 });',
    '  }',
    "  const lib = path.join(base, 'noactivate-' + hash(NOACT_M) + '.dylib');",
    '  if (!fs.existsSync(lib)) {',
    '    const clang = clangPath();',
    "    if (!clang) throw new Error('no Command Line Tools clang to build the no-activation library');",
    "    const tmp = lib + '.' + process.pid;",
    "    fs.writeFileSync(tmp + '.m', NOACT_M);",
    '    try {',
    "      require('node:child_process').execFileSync(clang[0], ['-isysroot', clang[1], '-dynamiclib', '-fobjc-arc', '-arch', 'arm64', '-arch', 'x86_64', '-framework', 'AppKit', '-o', tmp, tmp + '.m'], { stdio: 'pipe', timeout: 120000 });",
    '      fs.renameSync(tmp, lib);',
    "    } finally { fs.rmSync(tmp + '.m', { force: true }); fs.rmSync(tmp, { force: true }); }",
    '  }',
    "  const q = (s) => \"'\" + s.replace(/'/g, \"'\\\\''\") + \"'\";",
    '  // The DYLD_ variables are set here, past /bin/bash, which drops any it inherits.',
    "  const body = '#!/bin/bash\\nDYLD_FRAMEWORK_PATH=' + q(dir) + ' DYLD_LIBRARY_PATH=' + q(dir) + ' DYLD_INSERT_LIBRARIES=' + q(lib) + ' exec ' + q(app) + ' \"$@\"\\n';",
    "  const sh = path.join(base, 'webkit-' + hash(body) + '.sh');",
    '  if (!fs.existsSync(sh)) {',
    "    const tmp = sh + '.' + process.pid;",
    '    fs.writeFileSync(tmp, body, { mode: 0o755 });',
    '    fs.renameSync(tmp, sh);',
    '  }',
    '  return sh;',
    '}',
    '',
    '/** Every WebKit launch of this library (launch, a persistent context, a server) on a Mac starts through the runner. */',
    'function quietWebkit(core) {',
    "  if (process.platform !== 'darwin' || process.env.WALNUT_PW_ACTIVATE === '1') return false;",
    '  const wk = core && core.webkit;',
    "  if (!wk || typeof wk !== 'object' || wk[QUIET]) return false;",
    '  wk[QUIET] = true;',
    "  for (const name of ['launch', 'launchPersistentContext', 'launchServer']) {",
    '    const orig = wk[name];',
    "    if (typeof orig !== 'function') continue;",
    '    wk[name] = function () {',
    '      const args = Array.prototype.slice.call(arguments);',
    "      const at = name === 'launchPersistentContext' ? 1 : 0;",
    '      try {',
    '        const options = Object.assign({}, args[at]);',
    '        if (!options.executablePath) {',
    '          const run = quietRunner(this.executablePath());',
    '          if (run) { options.executablePath = run; args[at] = options; }',
    '        }',
    '      } catch (e) { noActWarn(e); }',
    '      return orig.apply(this, args);',
    '    };',
    '  }',
    '  return true;',
    '}',
  ].join('\n')
}
